const axios = require('axios');
const { URL } = require('url');

// 1. Redirect Payloads
const REDIRECT_PAYLOADS = [
    "http://google.com",
    "https://example.com",
    "http://evil.com",
    "//evil.com",
    "//google.com",
    "/\\evil.com",
    "//evil.com%2f%2f",
    "https:evil.com",
    "////evil.com",
    "http://evil.com@target.com",
    "//evil%2Ecom",
    "/\t/evil.com",
    "http://evil.com#target.com",
];

const EVIL_DOMAINS = ['google.com', 'example.com', 'evil.com'];

async function scanForOpenRedirect(url, method = 'GET', data = {}, locationDescription, contentType = 'form', httpClient) {
    const vulnerabilities = [];
    let scoreDeduction = 0;
    const client = httpClient || axios;

    let baseUrl = url;
    let originalParams = {};
    try {
        const urlObj = new URL(url);
        baseUrl = urlObj.origin + urlObj.pathname;
        for (const [key, value] of urlObj.searchParams) {
            originalParams[key] = value;
        }
    } catch (e) { }

    for (const payload of REDIRECT_PAYLOADS) {
        let attackData = { ...originalParams, ...data };
        for (let key in data) {
            if (data[key] === 'Submit' || data[key] === 'submit') continue;
            attackData[key] = payload;
        }

        try {
            const config = {
                validateStatus: () => true,
                maxRedirects: 0,
                timeout: 5000,
                headers: { 'User-Agent': 'Phoenix/1.0' }
            };

            let response;
            if (method === 'GET') {
                config.params = attackData;
                response = await client.get(baseUrl, config);
            } else {
                if (contentType === 'json') {
                    config.headers['Content-Type'] = 'application/json';
                    response = await client.post(url, attackData, config);
                } else {
                    config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                    response = await client.post(url, new URLSearchParams(attackData), config);
                }
            }

            const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data);

            // A. Check Location header redirect (3xx)
            if (response.status >= 300 && response.status < 400) {
                const locationHeader = response.headers.location || response.headers.Location;
                if (locationHeader && EVIL_DOMAINS.some(d => locationHeader.includes(d))) {
                    vulnerabilities.push({
                        type: 'Open Redirection',
                        name: `Header-Based Redirect [${contentType.toUpperCase()}]`,
                        severity: 'Medium',
                        location: locationDescription,
                        description: `Server redirects to external site. Payload: ${payload}`
                    });
                    scoreDeduction += 10;
                    return { vulnerabilities, scoreDeduction };
                }
            }

            // B. Check Meta Refresh redirect
            const metaRegex = /<meta[^>]*http-equiv\s*=\s*["']refresh["'][^>]*content\s*=\s*["'][^"']*url\s*=\s*([^"'\s>]+)/i;
            const metaMatch = body.match(metaRegex);
            if (metaMatch && EVIL_DOMAINS.some(d => metaMatch[1].includes(d))) {
                vulnerabilities.push({
                    type: 'Open Redirection',
                    name: `Meta Refresh Redirect [${contentType.toUpperCase()}]`,
                    severity: 'Medium',
                    location: locationDescription,
                    description: `Meta refresh redirect to external site. Payload: ${payload}`
                });
                scoreDeduction += 10;
                return { vulnerabilities, scoreDeduction };
            }

            // C. Check JavaScript redirect
            const jsPatterns = [
                /window\.location\s*=\s*["']([^"']+)["']/i,
                /window\.location\.href\s*=\s*["']([^"']+)["']/i,
                /document\.location\s*=\s*["']([^"']+)["']/i,
                /location\.replace\s*\(\s*["']([^"']+)["']\s*\)/i,
                /location\.assign\s*\(\s*["']([^"']+)["']\s*\)/i,
            ];
            for (const pattern of jsPatterns) {
                const jsMatch = body.match(pattern);
                if (jsMatch && EVIL_DOMAINS.some(d => jsMatch[1].includes(d))) {
                    vulnerabilities.push({
                        type: 'Open Redirection',
                        name: `JavaScript Redirect [${contentType.toUpperCase()}]`,
                        severity: 'Medium',
                        location: locationDescription,
                        description: `JS redirect to external site. Payload: ${payload}`
                    });
                    scoreDeduction += 10;
                    return { vulnerabilities, scoreDeduction };
                }
            }

        } catch (err) { }
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { scanForOpenRedirect };
