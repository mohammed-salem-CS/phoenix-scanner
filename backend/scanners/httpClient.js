/**
 * PHOENIX SHARED HTTP CLIENT
 * 
 * Single implementation of HTTP request helpers used by ALL scanner modules.
 * Eliminates 5 duplicate makeRequest/sendRequest/axiosHelper/fetchPage functions.
 * 
 * The HTTP client (Axios instance) is always injected — never defaulted internally.
 */
const { URLSearchParams } = require('url');
const { USER_AGENT, SCAN_TIMEOUTS } = require('../config');

/**
 * Send an HTTP request with payload data (for active scanning).
 * 
 * @param {object} httpClient   - Axios instance (authenticated or plain)
 * @param {object} options
 * @param {string} options.url          - Target URL
 * @param {string} options.method       - HTTP method (GET|POST|PUT|DELETE)
 * @param {object} options.data         - Key-value payload data
 * @param {string} options.contentType  - 'form' | 'json'
 * @param {number} [options.timeout]    - Request timeout in ms
 * @param {number} [options.maxRedirects] - Max redirects to follow
 * @returns {Promise<{body: string, status: number, headers: object}>}
 */
async function sendRequest(httpClient, { url, method = 'GET', data = {}, contentType = 'form', timeout, maxRedirects }) {
    const config = {
        method,
        url,
        timeout: timeout || SCAN_TIMEOUTS.default,
        validateStatus: () => true,
        headers: { 'User-Agent': USER_AGENT },
        maxRedirects: maxRedirects !== undefined ? maxRedirects : 5,
    };

    if (method.toUpperCase() === 'GET') {
        config.params = data;
    } else {
        if (contentType === 'json') {
            config.headers['Content-Type'] = 'application/json';
            config.data = data;
        } else {
            config.headers['Content-Type'] = 'application/x-www-form-urlencoded';
            config.data = new URLSearchParams(data);
        }
    }

    const response = await httpClient(config);
    return {
        body: typeof response.data === 'string' ? response.data : JSON.stringify(response.data),
        status: response.status,
        headers: response.headers || {},
    };
}

/**
 * Fetch a page's HTML body (simple GET).
 * 
 * @param {object} httpClient - Axios instance
 * @param {string} url        - Page URL
 * @param {number} [timeout]  - Request timeout in ms
 * @returns {Promise<string>} - Response body as string
 */
async function fetchPage(httpClient, url, timeout) {
    const res = await httpClient.get(url, {
        timeout: timeout || SCAN_TIMEOUTS.default,
        headers: { 'User-Agent': USER_AGENT },
        validateStatus: () => true,
        maxRedirects: 5,
    });
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
}

module.exports = { sendRequest, fetchPage };
