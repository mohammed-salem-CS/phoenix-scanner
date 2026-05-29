/**
 * PHOENIX SCANNER UTILITIES
 * 
 * Shared helper functions used by multiple scanner modules.
 * Consolidates pushResult, sleep, and injectPayload into a single location.
 */

/**
 * Push scan results into a report, with deduplication.
 * 
 * @param {object} report     - The scan report object with a `vulnerabilities` array
 * @param {object} result     - Scanner result { vulnerabilities: [], scoreDeduction: number }
 * @param {string} type       - Label for logging (e.g. 'SQLi', 'XSS')
 * @param {boolean} [log]     - Whether to log findings to console
 */
function pushResult(report, result, type, log = false) {
    if (result && result.vulnerabilities && result.vulnerabilities.length > 0) {
        if (log) console.log(`[Phoenix Engine]  VULNERABILITY FOUND: ${type}`);
        for (const vuln of result.vulnerabilities) {
            const isDuplicate = report.vulnerabilities.some(
                existing => existing.type === vuln.type && existing.name === vuln.name && existing.location === vuln.location
            );
            if (!isDuplicate) {
                report.vulnerabilities.push(vuln);
            }
        }
    }
}

/**
 * Async sleep utility for rate limiting and timing.
 * 
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Inject a payload into all non-submit fields of a data object.
 * 
 * @param {object} originalData - Original form data key-value pairs
 * @param {string} payload      - The attack payload string
 * @returns {object}            - New data object with payload injected
 */
function injectPayload(originalData, payload) {
    const newData = { ...originalData };
    for (const key in newData) {
        if (newData[key] === 'Submit' || newData[key] === 'submit') continue;
        newData[key] = payload;
    }
    return newData;
}

/**
 * Parse URL into base URL and query parameters.
 * 
 * @param {string} url - Full URL with possible query string
 * @returns {{ baseUrl: string, originalParams: object }}
 */
function parseUrlParams(url) {
    let baseUrl = url;
    const originalParams = {};
    try {
        const urlObj = new URL(url);
        baseUrl = urlObj.origin + urlObj.pathname;
        for (const [key, value] of urlObj.searchParams) {
            originalParams[key] = value;
        }
    } catch (e) { /* return as-is */ }
    return { baseUrl, originalParams };
}

module.exports = { pushResult, sleep, injectPayload, parseUrlParams };
