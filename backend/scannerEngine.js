const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { Crawler } = require('./crawler');
const { createAuthenticatedSession } = require('./authSession');
const { ScanLogger } = require('./utils/logger');
const { extractCrawlMetadata } = require('./services/techFingerprint');
const { pushResult } = require('./scanners/utils');
const { USER_AGENT, CRAWLER_DEFAULTS } = require('./config');

// 1. Import Scanner Modules
const headerScanner = require('./scanners/headers');
const clickjackingScanner = require('./scanners/clickjacking');
const infoScanner = require('./scanners/infoDisclosure');
const corsScanner = require('./scanners/cors');
const sqliScanner = require('./scanners/sqli');
const xssScanner = require('./scanners/xss');
const lfiScanner = require('./scanners/lfi');
const cmdScanner = require('./scanners/cmdInjection');
const redirectScanner = require('./scanners/openRedirect');
const dirsearchScanner = require('./scanners/dirsearch');
const csrfScanner = require('./scanners/csrf');
const cookieScanner = require('./scanners/insecureCookies');
const sslScanner = require('./scanners/ssl');

// 2. Main Engine Logic
async function scanTarget(url, authOptions = {}, emitProgress = null) {
    // Capture engine logs via a dedicated logger (not by overriding console.log)
    const logger = new ScanLogger();

    // Helper to emit progress (no-op if no callback)
    const progress = (phase, message, percent) => {
        if (emitProgress) emitProgress(phase, message, percent);
    };

    logger.log(`\n[Phoenix Engine]  Initializing Advanced Scan for: ${url}`);
    progress('init', 'Initializing Phoenix Engine...', 5);

    const report = {
        target: url,
        timestamp: new Date(),
        vulnerabilities: []
    };

    try {
        // Phase 0: Initialize Authenticated Session Management
        logger.log(`[Phoenix Engine]  Phase 0: Initializing Session Management...`);
        progress('session', 'Initializing session management...', 8);
        const sessionInfo = await createAuthenticatedSession(url, {
            loginPath: authOptions.loginPath || '/login.php',
            username: authOptions.username,
            password: authOptions.password,
            securityLevel: authOptions.securityLevel || 'low',
            cookies: authOptions.cookies,
            sessionCheckUrl: authOptions.sessionCheckUrl,
            loggedInIndicator: authOptions.loggedInIndicator
        });

        const httpClient = sessionInfo.axios;
        logger.log(`[Phoenix Engine]  ✅ Session management active (Auto-Login enabled)`);

        // 1. Initial Request
        const response = await httpClient.get(url, {
            timeout: 15000,
            headers: { 'User-Agent': USER_AGENT }
        });

        const html = typeof response.data === 'string' ? response.data : '';
        const headers = response.headers;
        const $ = cheerio.load(html);


        // Phase 1: Passive Analysis & Infrastructure Check

        logger.log(`[Phoenix Engine]  Phase 1: Passive Analysis & Config Check...`);
        progress('passive', 'Analyzing security headers & configuration...', 15);

        // A. Security Headers
        const headerResult = headerScanner.checkSecurityHeaders(headers);
        pushResult(report, headerResult, 'Security Headers');

        // B. Clickjacking
        const clickResult = clickjackingScanner.checkClickjacking(headers);
        pushResult(report, clickResult, 'Clickjacking Protection');

        // C. Information Disclosure
        const infoResult = infoScanner.checkSensitiveInfo(html, url);
        pushResult(report, infoResult, 'Sensitive Information');

        // D. CORS Configuration
        logger.log(`[Phoenix Engine]  Checking CORS Policies...`);
        const corsResult = await corsScanner.checkCORS(url);
        pushResult(report, corsResult, 'CORS Misconfiguration');

        // E. Insecure Cookies
        const cookieResult = cookieScanner.checkInsecureCookies(headers);
        pushResult(report, cookieResult, 'Insecure Cookies');

        // F. SSL/TLS Check
        logger.log(`[Phoenix Engine]  Checking SSL/TLS...`);
        const sslResult = await sslScanner.checkSSL(url);
        pushResult(report, sslResult, 'SSL/TLS');

        //  G. Dirsearch Discovery 
        logger.log(`[Phoenix Engine]  Enumerating Directories with Dirsearch...`);
        progress('dirsearch', 'Enumerating directories...', 25);
        const dirResult = await dirsearchScanner.runDirsearch(url);
        pushResult(report, dirResult, 'Directory Brute-force');


        // Phase 2: Deep Crawling
        logger.log(`[Phoenix Engine]  Phase 2: Deep Crawling...`);
        progress('crawling', 'Deep crawling website pages...', 35);
        const crawler = new Crawler(url, {
            maxDepth: CRAWLER_DEFAULTS.maxDepth,
            maxPages: CRAWLER_DEFAULTS.maxPages,
            concurrency: CRAWLER_DEFAULTS.concurrency,
            delayMs: CRAWLER_DEFAULTS.delayMs,
            authSession: httpClient,  // Pass authenticated Axios instance to crawler
            onPageCrawled: (pageUrl, depth, total) => {
                logger.log(`[Phoenix Engine]  Crawled [depth=${depth}] (${total} total): ${pageUrl}`);
            }
        });
        const crawlResult = await crawler.crawl();
        logger.log(`[Phoenix Engine]  Crawling complete: ${crawlResult.pages.length} pages, ${crawlResult.forms.length} forms discovered`);

        // Phase 2.5: Post-crawl passive scans
        // A. CSRF check on all discovered forms
        const csrfResult = csrfScanner.checkCSRF(crawlResult.forms, headers['set-cookie']);
        pushResult(report, csrfResult, 'CSRF');

        // B. Info Disclosure on all crawled pages
        for (const page of crawlResult.pages) {
            try {
                const pageRes = await httpClient.get(page.url, { timeout: 5000, validateStatus: () => true });
                const pageBody = typeof pageRes.data === 'string' ? pageRes.data : '';
                if (pageBody) {
                    const pageInfoResult = infoScanner.checkSensitiveInfo(pageBody, page.url);
                    pushResult(report, pageInfoResult, 'Info Disclosure (Crawled)');
                }
            } catch (e) { /* skip unavailable pages */ }
        }

        // Phase 3: Active Attacks (Reflected / Immediate)
        logger.log(`[Phoenix Engine]  Phase 3: Active Attacks (Dual-Mode: Form & JSON)...`);
        progress('attacks', 'Running active attack suite (SQLi, XSS, LFI, CMD)...', 55);
        const scanPromises = [];

        // A. Attack discovered pages that have query parameters
        for (const page of crawlResult.pages) {
            if (page.params.length > 0) {
                scanPromises.push(scanLinkParallel(page.url, report, httpClient));
            }
        }

        // B. Attack discovered forms — test each parameter individually
        for (const form of crawlResult.forms) {
            const inputNames = Object.keys(form.inputs);
            if (inputNames.length === 0) continue;

            for (const paramName of inputNames) {
                const inputInfo = form.inputs[paramName];
                if (inputInfo && inputInfo.type === 'submit') continue;

                const data = {};
                for (const [name, info] of Object.entries(form.inputs)) {
                    if (name === paramName) {
                        data[name] = 'payload_placeholder';
                    } else if (info.type === 'submit') {
                        data[name] = info.value || 'Submit';
                    } else {
                        data[name] = info.value || 'test';
                    }
                }
                const desc = `Parameter: "${paramName}" in form at ${form.action}`;

                scanPromises.push(
                    launchAttackSuite(form.action, form.method, data, desc, 'form', report, httpClient)
                );
                if (form.method === 'POST' || form.method === 'PUT') {
                    scanPromises.push(
                        launchAttackSuite(form.action, form.method, data, desc, 'json', report, httpClient)
                    );
                }
            }
        }

        await Promise.all(scanPromises);


        // Phase 4: Stored Vulnerability Scanning (NEW)
        logger.log(`[Phoenix Engine]  Phase 4: Stored Vulnerability Scanning...`);
        progress('stored', 'Scanning for stored vulnerabilities...', 75);
        const storedScanPromises = [];

        for (const form of crawlResult.forms) {
            // Only test forms that have inputs and use POST/PUT (forms that store data)
            if (Object.keys(form.inputs).length === 0) continue;

            // Build the list of pages to verify after injection
            const verifyUrls = buildVerifyUrls(form, crawlResult.pages);
            if (verifyUrls.length === 0) continue;

            logger.log(`[Phoenix Engine]  Testing stored vulns for form at ${form.action} → checking ${verifyUrls.length} display pages`);

            // Run stored XSS and stored SQLi scans sequentially per form
            // (to avoid race conditions from concurrent injections)
            storedScanPromises.push(
                (async () => {
                    try {
                        await xssScanner.scanForStoredXSS(form, verifyUrls, report, httpClient);
                    } catch (e) {
                        logger.log(`[Phoenix Engine]  Stored XSS scan error for ${form.action}: ${e.message}`);
                    }
                    try {
                        await sqliScanner.scanForStoredSQLi(form, verifyUrls, report, httpClient);
                    } catch (e) {
                        logger.log(`[Phoenix Engine]  Stored SQLi scan error for ${form.action}: ${e.message}`);
                    }
                })()
            );
        }

        // Run stored scans (each form is independent, so we can parallelize across forms)
        await Promise.all(storedScanPromises);

        // Phase 5: Collect Discovery Data — delegate to techFingerprint service
        report.crawlData = extractCrawlMetadata(crawlResult);

        logger.log(`[Phoenix Engine]  Scan Completed. ${report.vulnerabilities.length} vulnerabilities found.`);
        progress('finalizing', `Scan complete! ${report.vulnerabilities.length} vulnerabilities found.`, 90);
        
        // Attach captured logs to report (no console.log restore needed)
        report.agentLogs = logger.getLogs();
        
        return report;

    } catch (error) {
        console.error(`[Phoenix Engine] FATAL ERROR: ${error.message}`);
        logger.capture(`FATAL ERROR: ${error.message}`);
        return { error: true, message: error.message, agentLogs: logger.getLogs() };
    }
}


// 3. Worker Functions

async function scanLinkParallel(url, report, httpClient) {
    try {
        const urlObj = new URL(url);
        const params = new URLSearchParams(urlObj.search);

        if (Array.from(params).length === 0) return;

        const attackPromises = [];
        for (const [key, value] of params) {
            const data = { [key]: 'test' };
            attackPromises.push(
                launchAttackSuite(url, 'GET', data, `Link Param: ${key} at ${url}`, 'form', report, httpClient)
            );
        }
        await Promise.all(attackPromises);
    } catch (err) { }
}


// 4. Build Verify URLs for Stored Vulnerability Checking
// Determines which pages should be checked after a form submission to detect stored payloads.
function buildVerifyUrls(form, crawledPages) {
    const verifySet = new Set();

    // A. Always check the page where the form was found (the display page)
    if (form.pageUrl) {
        verifySet.add(form.pageUrl);
    }

    // B. Always check the form action URL itself
    verifySet.add(form.action);

    // C. Check pages in the same directory/path as the form action
    try {
        const actionUrl = new URL(form.action);
        const actionDir = actionUrl.pathname.split('/').slice(0, -1).join('/');

        for (const page of crawledPages) {
            try {
                const pageUrl = new URL(page.url);
                const pageDir = pageUrl.pathname.split('/').slice(0, -1).join('/');

                // Same directory or parent directory
                if (pageDir === actionDir || actionDir.startsWith(pageDir)) {
                    verifySet.add(page.url);
                }
            } catch (e) { }
        }
    } catch (e) { }

    // D. Check common "display" pages that often show stored content
    try {
        const baseUrl = new URL(form.action);
        const commonDisplayPaths = [
            'guestbook.php', 'comments.php', 'feedback.php', 'reviews.php',
            'messages.php', 'posts.php', 'list.php', 'view.php', 'index.php',
            'guestbook', 'comments', 'feedback', 'reviews', 'messages', 'posts'
        ];

        for (const path of commonDisplayPaths) {
            const displayUrl = new URL(path, baseUrl.origin + '/').href;
            // Only add if we actually crawled this page (confirmed it exists)
            for (const page of crawledPages) {
                if (page.url === displayUrl || page.url.includes(path)) {
                    verifySet.add(page.url);
                }
            }
        }
    } catch (e) { }

    // Limit to max 5 URLs to reduce scan time
    return Array.from(verifySet).slice(0, 5);
}


// 5. Unified Attack Suite (Reflected/Immediate attacks)
async function launchAttackSuite(url, method, data, desc, contentType, report, httpClient) {
    await Promise.all([
        sqliScanner.scanForSQLi(url, method, data, desc, contentType, httpClient)
            .then(res => pushResult(report, res, `SQLi (${contentType})`, true)),

        xssScanner.scanForXSS(url, method, data, desc, contentType, httpClient)
            .then(res => pushResult(report, res, `XSS (${contentType})`, true)),

        lfiScanner.scanForLFI(url, method, data, desc, contentType, httpClient)
            .then(res => pushResult(report, res, `LFI (${contentType})`, true)),

        cmdScanner.scanForCmdInjection(url, method, data, desc, contentType, httpClient)
            .then(res => pushResult(report, res, `Command Injection (${contentType})`, true)),

        redirectScanner.scanForOpenRedirect(url, method, data, desc, contentType, httpClient)
            .then(res => pushResult(report, res, `Open Redirect (${contentType})`, true))
    ]);
}


// 6. Reporting Helper — Imported from scanners/utils.js (shared pushResult)

module.exports = { scanTarget };