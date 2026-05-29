const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

// Extensions to skip (static assets, not interesting for vulnerability scanning)
const SKIP_EXTENSIONS = new Set([
    '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.gz',
    '.mp3', '.mp4', '.avi', '.mov', '.webp', '.bmp'
]);

// Patterns to avoid (logout, external auth, app reset pages etc.)
const SKIP_PATTERNS = [/logout/i, /signout/i, /sign-out/i, /log-out/i, /delete.*account/i, /setup/i];

class Crawler {
    /**
     * @param {string} seedUrl - The starting URL to crawl
     * @param {object} options
     * @param {number} options.maxDepth - Maximum crawl depth (default: 3)
     * @param {number} options.maxPages - Maximum pages to crawl (default: 50)
     * @param {number} options.concurrency - Concurrent requests (default: 5)
     * @param {number} options.delayMs - Delay between batches in ms (default: 100)
     * @param {number} options.timeout - Request timeout in ms (default: 10000)
     * @param {function} options.onPageCrawled - Callback(url, depth, totalCrawled)
     */
    constructor(seedUrl, options = {}) {
        this.seedUrl = seedUrl;
        this.seedHostname = new URL(seedUrl).hostname;
        this.maxDepth = options.maxDepth ?? 3;
        this.maxPages = options.maxPages ?? 50;
        this.concurrency = options.concurrency ?? 5;
        this.delayMs = options.delayMs ?? 100;
        this.timeout = options.timeout ?? 10000;
        this.onPageCrawled = options.onPageCrawled || null;
        this.respectRobotsTxt = options.respectRobotsTxt ?? false;

        // Authenticated Axios instance (optional — from authSession module)
        // When provided, all requests carry session cookies for authenticated crawling
        this.httpClient = options.authSession || axios;

        // Internal state
        this.visited = new Set();          // normalized URLs already visited
        this.disallowedPaths = [];         // from robots.txt
        this.pages = [];                   // { url, params: [{key, value}] }
        this.forms = [];                   // { pageUrl, action, method, inputs: {name: type} }
        this.seenForms = new Set();        // dedup key: "action|method|inputNames"
        this.errors = [];                  // { url, error }
    }

    // ─── Public API ────────────────────────────────────────────

    /**
     * Start crawling from the seed URL.
     * @returns {{ pages: Array, forms: Array, errors: Array }}
     */
    async crawl() {
        // 1. Fetch and parse robots.txt (only if respecting it)
        if (this.respectRobotsTxt) {
            await this._fetchRobotsTxt();
        } else {
            console.log(`[Crawler] robots.txt ignored (security scanner mode)`);
        }

        // 2. BFS crawl
        let queue = [{ url: this.seedUrl, depth: 0 }];

        while (queue.length > 0 && this.visited.size < this.maxPages) {
            // Take a batch up to concurrency limit
            const batch = queue.splice(0, this.concurrency);
            const nextLinks = await Promise.all(
                batch.map(item => this._processPage(item.url, item.depth))
            );

            // Flatten discovered links and add to queue
            for (const links of nextLinks) {
                for (const link of links) {
                    if (this.visited.size >= this.maxPages) break;
                    queue.push(link);
                }
            }

            // Rate limiting: delay between batches
            if (queue.length > 0 && this.delayMs > 0) {
                await this._sleep(this.delayMs);
            }
        }

        console.log(`[Crawler] Finished: ${this.pages.length} pages, ${this.forms.length} forms, ${this.errors.length} errors`);
        return {
            pages: this.pages,
            forms: this.forms,
            errors: this.errors
        };
    }

    // ─── Private Methods ───────────────────────────────────────

    /**
     * Fetch and parse robots.txt to find disallowed paths.
     */
    async _fetchRobotsTxt() {
        try {
            const robotsUrl = new URL('/robots.txt', this.seedUrl).href;
            const res = await this.httpClient.get(robotsUrl, {
                timeout: 5000,
                headers: { 'User-Agent': 'Phoenix/1.0 (Graduation Project)' },
                validateStatus: status => status < 400
            });

            if (typeof res.data === 'string') {
                const lines = res.data.split('\n');
                let relevantAgent = false;

                for (const rawLine of lines) {
                    const line = rawLine.trim();
                    if (line.toLowerCase().startsWith('user-agent:')) {
                        const agent = line.split(':')[1].trim();
                        relevantAgent = (agent === '*' || agent.toLowerCase().includes('phoenix'));
                    } else if (relevantAgent && line.toLowerCase().startsWith('disallow:')) {
                        const path = line.split(':').slice(1).join(':').trim();
                        if (path) this.disallowedPaths.push(path);
                    }
                }

                if (this.disallowedPaths.length > 0) {
                    console.log(`[Crawler] robots.txt: ${this.disallowedPaths.length} disallowed path(s) loaded`);
                }
            }
        } catch (err) {
            console.log(`[Crawler] robots.txt not found or inaccessible — proceeding without restrictions`);
        }
    }

    /**
     * Process a single page: fetch it, extract links and forms.
     * @returns {Array<{url, depth}>} - New links to crawl
     */
    async _processPage(url, depth) {
        const normalized = this._normalizeUrl(url);
        if (!normalized) return [];
        if (this.visited.has(normalized)) return [];
        if (this.visited.size >= this.maxPages) return [];

        // Mark as visited
        this.visited.add(normalized);

        // Check robots.txt
        if (this._isDisallowed(normalized)) {
            console.log(`[Crawler] Skipped (robots.txt): ${normalized}`);
            return [];
        }

        // Fetch the page — use the ORIGINAL url (not normalized) to preserve
        // trailing slashes needed for correct relative URL resolution
        let fetchUrl = url;
        let html, headers, finalUrl;
        try {
            const res = await this.httpClient.get(fetchUrl, {
                timeout: this.timeout,
                headers: { 'User-Agent': 'Phoenix/1.0 (Graduation Project)' },
                maxRedirects: 3,
                validateStatus: status => status < 400
            });
            html = typeof res.data === 'string' ? res.data : '';
            headers = res.headers;
            // Use the final URL after redirects as the base for relative resolution
            finalUrl = res.request?.res?.responseUrl || res.config?.url || fetchUrl;
        } catch (err) {
            const msg = err.response ? `HTTP ${err.response.status}` : err.message;
            console.log(`[Crawler] Failed to fetch: ${fetchUrl} (${msg})`);
            this.errors.push({ url: fetchUrl, error: msg });
            return [];
        }

        // Record the page with its query parameters
        const urlObj = new URL(finalUrl);
        const params = Array.from(new URLSearchParams(urlObj.search)).map(([key, value]) => ({ key, value }));
        this.pages.push({ url: finalUrl, params, headers });

        // Progress callback
        if (this.onPageCrawled) {
            try {
                this.onPageCrawled(finalUrl, depth, this.visited.size);
            } catch (e) { }
        }

        // Don't go deeper if at max depth
        if (depth >= this.maxDepth) return [];

        // Parse HTML
        const $ = cheerio.load(html);

        // IMPORTANT: Use finalUrl (with trailing slash preserved) as the base
        // for resolving relative URLs in forms and links. This ensures that
        // action="process.php" resolves to /mohamed/process.php not /process.php
        this._extractForms($, finalUrl);

        return this._extractLinks($, finalUrl, depth);
    }

    /**
     * Extract all forms from a page.
     */
    _extractForms($, pageUrl) {
        $('form').each((_, form) => {
            try {
                const action = $(form).attr('action') || pageUrl;
                const method = ($(form).attr('method') || 'GET').toUpperCase();
                const targetUrl = new URL(action, pageUrl).href;

                const inputs = {};
                $(form).find('input, textarea, select').each((_, el) => {
                    const name = $(el).attr('name');
                    if (name) {
                        inputs[name] = {
                            type: $(el).attr('type') || 'text',
                            value: $(el).attr('value') || ''
                        };
                    }
                });

                if (Object.keys(inputs).length > 0) {
                    // Deduplicate: same action + method + input names = same form
                    const formKey = `${targetUrl}|${method}|${Object.keys(inputs).sort().join(',')}`;
                    if (this.seenForms.has(formKey)) return;
                    this.seenForms.add(formKey);

                    this.forms.push({
                        pageUrl,
                        action: targetUrl,
                        method,
                        inputs
                    });
                }
            } catch (e) { }
        });
    }

    /**
     * Extract links from a page and return new ones to crawl.
     * @returns {Array<{url, depth}>}
     */
    _extractLinks($, pageUrl, currentDepth) {
        const newLinks = [];
        const seen = new Set(); // avoid duplicates within this page

        $('a[href]').each((_, el) => {
            try {
                const href = $(el).attr('href');
                if (!href) return;

                const fullUrl = new URL(href, pageUrl);

                // Stay within the same host
                if (fullUrl.hostname !== this.seedHostname) return;

                const normalized = this._normalizeUrl(fullUrl.href);
                if (!normalized) return;

                // Skip if already visited or queued from this page
                if (this.visited.has(normalized)) return;
                if (seen.has(normalized)) return;

                // Skip static files
                if (this._isStaticFile(normalized)) return;

                // Skip dangerous patterns (logout, etc.)
                if (this._matchesSkipPattern(normalized)) return;

                seen.add(normalized);
                newLinks.push({ url: normalized, depth: currentDepth + 1 });
            } catch (e) { }
        });

        return newLinks;
    }

    // ─── URL Utilities ─────────────────────────────────────────

    /**
     * Normalize a URL for dedup: remove fragments, sort query params.
     * Trailing slashes are preserved to avoid breaking relative URL resolution.
     */
    _normalizeUrl(rawUrl) {
        try {
            const urlObj = new URL(rawUrl);
            // Remove fragment
            urlObj.hash = '';
            // Sort query parameters for consistent dedup
            const params = new URLSearchParams(urlObj.search);
            const sorted = new URLSearchParams([...params].sort());
            urlObj.search = sorted.toString();
            // NOTE: We intentionally do NOT strip trailing slashes.
            // Stripping /mohamed/ to /mohamed breaks relative URL resolution:
            //   new URL('process.php', 'http://host/mohamed') = http://host/process.php  (WRONG)
            //   new URL('process.php', 'http://host/mohamed/') = http://host/mohamed/process.php (CORRECT)
            return urlObj.href;
        } catch (e) {
            return null;
        }
    }

    /**
     * Check if a URL matches robots.txt disallowed paths.
     */
    _isDisallowed(url) {
        try {
            const pathname = new URL(url).pathname;
            return this.disallowedPaths.some(disallowed => pathname.startsWith(disallowed));
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a URL points to a static file (by extension).
     */
    _isStaticFile(url) {
        try {
            const pathname = new URL(url).pathname.toLowerCase();
            const lastDot = pathname.lastIndexOf('.');
            if (lastDot === -1) return false;
            const ext = pathname.substring(lastDot);
            return SKIP_EXTENSIONS.has(ext);
        } catch (e) {
            return false;
        }
    }

    /**
     * Check if a URL matches any skip pattern (logout, signout, etc.).
     */
    _matchesSkipPattern(url) {
        return SKIP_PATTERNS.some(pattern => pattern.test(url));
    }

    /**
     * Sleep utility for rate limiting.
     */
    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = { Crawler };
