/**
 * PHOENIX TECHNOLOGY FINGERPRINTING SERVICE
 * 
 * Extensible technology detection from HTTP headers and cookies.
 * Replaces 3 duplicate implementations across scannerEngine.js, aiScanner.js,
 * and specialized_agents.py.
 */

// ─── Technology Signature Registry ──────────────────────────────────────────
const COOKIE_SIGNATURES = [
    { pattern: 'PHPSESSID',    tech: 'PHP' },
    { pattern: 'JSESSIONID',   tech: 'Java' },
    { pattern: 'connect.sid',  tech: 'Express/Node.js' },
    { pattern: 'ASP.NET',      tech: 'ASP.NET' },
    { pattern: 'rack.session', tech: 'Ruby/Rails' },
    { pattern: 'laravel_session', tech: 'Laravel (PHP)' },
    { pattern: 'django',       tech: 'Django (Python)' },
];

/**
 * Detect technologies from HTTP response headers.
 * 
 * @param {object} headers - HTTP response headers (lowercase keys)
 * @returns {string[]} - List of detected technology strings
 */
function detectTechnologies(headers) {
    const technologies = [];

    // Server header
    const server = headers['server'];
    if (server) technologies.push(`Server: ${server}`);

    // X-Powered-By header
    const poweredBy = headers['x-powered-by'];
    if (poweredBy) technologies.push(`Powered By: ${poweredBy}`);

    // Cookie-based detection
    const setCookie = headers['set-cookie'] || [];
    const cookiesStr = Array.isArray(setCookie) ? setCookie.join(' ') : String(setCookie);

    for (const sig of COOKIE_SIGNATURES) {
        if (cookiesStr.includes(sig.pattern)) {
            technologies.push(sig.tech);
        }
    }

    return technologies;
}

/**
 * Extract discovery metadata from crawl results.
 * 
 * @param {object} crawlResult - { pages: Array, forms: Array, errors: Array }
 * @returns {{ endpoints: string[], parameters: string[], technologies: string[] }}
 */
function extractCrawlMetadata(crawlResult) {
    const pages = crawlResult.pages || [];

    const endpoints = Array.from(new Set(pages.map(p => p.url))).slice(0, 50);
    const parameters = Array.from(
        new Set(pages.flatMap(p => (p.params || []).map(param => param.key)))
    ).slice(0, 50);

    // Detect technologies from the first page's headers
    const headers = (pages.length > 0 && pages[0].headers) ? pages[0].headers : {};
    const technologies = detectTechnologies(headers);

    return { endpoints, parameters, technologies };
}

module.exports = { detectTechnologies, extractCrawlMetadata, COOKIE_SIGNATURES };
