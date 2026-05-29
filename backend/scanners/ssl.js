/**
 * SSL/TLS Scanner — Checks for HTTPS enforcement and mixed content
 */

const axios = require('axios');
const { URL } = require('url');

async function checkSSL(targetUrl) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    let urlObj;
    try {
        urlObj = new URL(targetUrl);
    } catch (e) {
        return { vulnerabilities, scoreDeduction };
    }

    // 1. Check if site is HTTP-only (no HTTPS)
    if (urlObj.protocol === 'http:') {
        // Try HTTPS version
        const httpsUrl = targetUrl.replace('http://', 'https://');
        try {
            await axios.get(httpsUrl, {
                timeout: 5000,
                validateStatus: () => true,
                maxRedirects: 0,
            });
            // HTTPS works but site is using HTTP
            vulnerabilities.push({
                type: 'SSL/TLS Issue',
                name: 'HTTPS Available But Not Enforced',
                severity: 'Medium',
                location: targetUrl,
                description: 'The site supports HTTPS but is being accessed over HTTP. Users may be exposed to man-in-the-middle attacks.'
            });
            scoreDeduction += 10;
        } catch (e) {
            // HTTPS not available at all
            vulnerabilities.push({
                type: 'SSL/TLS Issue',
                name: 'No HTTPS Support',
                severity: 'High',
                location: targetUrl,
                description: 'The site does not support HTTPS. All traffic is sent in plain text, exposing sensitive data to interception.'
            });
            scoreDeduction += 20;
        }
    }

    // 2. Check HTTP to HTTPS redirect
    if (urlObj.protocol === 'https:') {
        const httpUrl = targetUrl.replace('https://', 'http://');
        try {
            const response = await axios.get(httpUrl, {
                timeout: 5000,
                validateStatus: () => true,
                maxRedirects: 0,
            });

            if (response.status < 300 || response.status >= 400) {
                vulnerabilities.push({
                    type: 'SSL/TLS Issue',
                    name: 'HTTP Does Not Redirect to HTTPS',
                    severity: 'Medium',
                    location: httpUrl,
                    description: 'HTTP version of the site does not redirect to HTTPS. Users accessing via HTTP are not protected.'
                });
                scoreDeduction += 8;
            } else if (response.status >= 300 && response.status < 400) {
                const location = response.headers.location || '';
                if (!location.startsWith('https://')) {
                    vulnerabilities.push({
                        type: 'SSL/TLS Issue',
                        name: 'HTTP Redirects to Non-HTTPS',
                        severity: 'Medium',
                        location: httpUrl,
                        description: `HTTP redirects to "${location}" which is not HTTPS.`
                    });
                    scoreDeduction += 8;
                }
            }
        } catch (e) {
            // HTTP version not reachable, that's actually fine
        }
    }

    // 3. Check for mixed content (fetch main page and look for http:// resources)
    try {
        const response = await axios.get(targetUrl, {
            timeout: 8000,
            validateStatus: () => true,
        });

        if (urlObj.protocol === 'https:' && response.data) {
            const body = String(response.data);
            const mixedContentPatterns = [
                /src\s*=\s*["']http:\/\//gi,
                /href\s*=\s*["']http:\/\/[^"']*\.(js|css|json)/gi,
                /action\s*=\s*["']http:\/\//gi,
            ];

            for (const pattern of mixedContentPatterns) {
                if (pattern.test(body)) {
                    vulnerabilities.push({
                        type: 'SSL/TLS Issue',
                        name: 'Mixed Content Detected',
                        severity: 'Medium',
                        location: targetUrl,
                        description: 'HTTPS page loads resources over HTTP, which can be intercepted or tampered with.'
                    });
                    scoreDeduction += 8;
                    break;
                }
            }
        }
    } catch (e) { }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkSSL };
