const SECURITY_HEADERS = [
    'Strict-Transport-Security',
    'Content-Security-Policy',
    'X-Frame-Options',
    'X-Content-Type-Options',
    'Referrer-Policy',
    'Permissions-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
];

function checkSecurityHeaders(headers) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    // 1. Check for missing headers
    SECURITY_HEADERS.forEach(header => {
        if (!headers[header.toLowerCase()]) {
            vulnerabilities.push({
                type: 'Missing Security Header',
                name: header,
                severity: 'Low',
                location: 'HTTP Response Header',
                description: `The website is missing the '${header}' header.`
            });
            scoreDeduction += 5;
        }
    });

    // 2. Check header values for weak configurations
    const csp = headers['content-security-policy'];
    if (csp) {
        if (csp.includes("'unsafe-inline'")) {
            vulnerabilities.push({
                type: 'Weak Security Header',
                name: 'CSP allows unsafe-inline',
                severity: 'Medium',
                location: 'Content-Security-Policy',
                description: `CSP includes 'unsafe-inline', which weakens XSS protection significantly.`
            });
            scoreDeduction += 8;
        }
        if (csp.includes("'unsafe-eval'")) {
            vulnerabilities.push({
                type: 'Weak Security Header',
                name: 'CSP allows unsafe-eval',
                severity: 'Medium',
                location: 'Content-Security-Policy',
                description: `CSP includes 'unsafe-eval', which allows execution of eval() and similar functions.`
            });
            scoreDeduction += 8;
        }
        if (csp.includes('*')) {
            vulnerabilities.push({
                type: 'Weak Security Header',
                name: 'CSP contains wildcard source',
                severity: 'Medium',
                location: 'Content-Security-Policy',
                description: `CSP contains wildcard (*) source, which is overly permissive.`
            });
            scoreDeduction += 5;
        }
    }

    const hsts = headers['strict-transport-security'];
    if (hsts) {
        const maxAgeMatch = hsts.match(/max-age=(\d+)/);
        if (maxAgeMatch && parseInt(maxAgeMatch[1]) < 31536000) {
            vulnerabilities.push({
                type: 'Weak Security Header',
                name: 'HSTS max-age too short',
                severity: 'Low',
                location: 'Strict-Transport-Security',
                description: `HSTS max-age is ${maxAgeMatch[1]}s (< 1 year). Recommended: at least 31536000 (1 year).`
            });
            scoreDeduction += 3;
        }
        if (!hsts.includes('includeSubDomains')) {
            vulnerabilities.push({
                type: 'Weak Security Header',
                name: 'HSTS missing includeSubDomains',
                severity: 'Low',
                location: 'Strict-Transport-Security',
                description: `HSTS does not include 'includeSubDomains' directive. Subdomains are not protected.`
            });
            scoreDeduction += 3;
        }
    }

    // 3. Check for server version disclosure in headers
    const server = headers['server'];
    if (server && /[\d.]+/.test(server)) {
        vulnerabilities.push({
            type: 'Information Disclosure',
            name: 'Server Version Exposed',
            severity: 'Low',
            location: 'Server Header',
            description: `Server header discloses version: "${server}". This helps attackers identify vulnerabilities.`
        });
        scoreDeduction += 3;
    }

    const xPoweredBy = headers['x-powered-by'];
    if (xPoweredBy) {
        vulnerabilities.push({
            type: 'Information Disclosure',
            name: 'X-Powered-By Header Exposed',
            severity: 'Low',
            location: 'X-Powered-By Header',
            description: `X-Powered-By header exposes technology: "${xPoweredBy}". Remove this header.`
        });
        scoreDeduction += 3;
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkSecurityHeaders };