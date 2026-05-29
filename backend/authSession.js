const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

/**
 * PHOENIX AUTH SESSION MODULE
 * 
 * Handles automated login to target web applications (e.g., DVWA, custom PHP apps).
 * Extracts session cookies and creates a pre-authenticated Axios instance that
 * automatically re-authenticates when sessions expire.
 * 
 * Usage:
 *   const { createAuthenticatedSession } = require('./authSession');
 *   const session = await createAuthenticatedSession('http://target.com', {
 *       username: 'admin',
 *       password: 'password'
 *   });
 *   // session.axios — pre-authenticated Axios instance
 *   // session.cookies — raw cookie object { PHPSESSID: '...', security: '...' }
 */

// ─── Default Configuration ─────────────────────────────────────
const DEFAULT_LOGIN_PATH = '/login.php';
const DEFAULT_CREDENTIALS = { username: 'admin', password: 'password' };
const DEFAULT_SECURITY_LEVEL = 'low';  // DVWA security level
const MAX_REAUTH_ATTEMPTS = 3;

/**
 * Parse Set-Cookie headers into a key-value object.
 * Handles both single string and array formats.
 * 
 * @param {string|string[]} setCookieHeaders - Raw Set-Cookie header value(s)
 * @returns {object} - Parsed cookie object { name: value }
 */
function parseCookies(setCookieHeaders) {
    const cookies = {};

    if (!setCookieHeaders) return cookies;

    // Normalize to array
    const headerArray = Array.isArray(setCookieHeaders)
        ? setCookieHeaders
        : [setCookieHeaders];

    for (const header of headerArray) {
        // Each Set-Cookie header: "name=value; Path=/; HttpOnly; ..."
        // We only need the first part (name=value)
        const cookiePart = header.split(';')[0].trim();
        const eqIndex = cookiePart.indexOf('=');
        if (eqIndex > 0) {
            const name = cookiePart.substring(0, eqIndex).trim();
            const value = cookiePart.substring(eqIndex + 1).trim();
            cookies[name] = value;
        }
    }

    return cookies;
}

/**
 * Serialize a cookie object into a Cookie header string.
 * 
 * @param {object} cookies - { PHPSESSID: 'abc123', security: 'low' }
 * @returns {string} - "PHPSESSID=abc123; security=low"
 */
function serializeCookies(cookies) {
    return Object.entries(cookies)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

/**
 * Perform an automated login to the target application.
 * 
 * Steps:
 *   1. GET the login page to obtain an initial PHPSESSID
 *   2. POST credentials as application/x-www-form-urlencoded
 *   3. Extract and merge session cookies from both responses
 * 
 * @param {string} targetBaseUrl - Base URL of the target (e.g., http://localhost/dvwa)
 * @param {object} options
 * @param {string} options.loginPath - Path to login endpoint (default: /login.php)
 * @param {string} options.username - Username credential
 * @param {string} options.password - Password credential
 * @param {string} options.securityLevel - DVWA security level (default: low)
 * @param {number} options.timeout - Request timeout in ms (default: 10000)
 * @returns {object} - { success: boolean, cookies: object, message: string }
 */
async function performLogin(targetBaseUrl, options = {}) {
    const loginPath = options.loginPath || DEFAULT_LOGIN_PATH;
    const username = options.username || DEFAULT_CREDENTIALS.username;
    const password = options.password || DEFAULT_CREDENTIALS.password;
    const securityLevel = options.securityLevel || DEFAULT_SECURITY_LEVEL;
    const timeout = options.timeout || 10000;

    // Robust URL resolution: Ensure base URL ends with / if it doesn't have an extension
    let base = targetBaseUrl;
    if (!base.endsWith('/') && !base.split('/').pop().includes('.')) {
        base += '/';
    }
    const loginUrl = new URL(loginPath.startsWith('/') ? loginPath.substring(1) : loginPath, base).href;

    console.log(`[Auth] 🔐 Attempting automatic login: ${loginUrl}`);

    const sessionCookies = {};

    try {
        // ─── Step 1: GET the login page to analyze the form ───────────────
        const getResponse = await axios.get(loginUrl, {
            timeout,
            headers: { 'User-Agent': 'Phoenix/1.0 (Graduation Project)' },
            maxRedirects: 5, 
            validateStatus: () => true
        });

        const html = typeof getResponse.data === 'string' ? getResponse.data : '';
        const $ = cheerio.load(html);
        
        // Extract initial cookies
        const getCookies = parseCookies(getResponse.headers['set-cookie']);
        Object.assign(sessionCookies, getCookies);

        // ─── Step 2: Dynamic Form Analysis ───────────────────────────────
        // This looks for a form with a password field and maps fields automatically
        const formInfo = findLoginForm($, loginUrl);
        const postData = new URLSearchParams();
        let targetLoginUrl = loginUrl;

        if (formInfo) {
            console.log(`[Auth] 📝 Detected login form at ${formInfo.action} with ${formInfo.inputs.length} fields`);
            
            for (const field of formInfo.inputs) {
                if (field.type === 'password') {
                    postData.append(field.name, password);
                } else if (field.isUserField) {
                    postData.append(field.name, username);
                } else {
                    // Automatically include hidden fields (CSRF tokens) and buttons
                    postData.append(field.name, field.value || '');
                }
            }
            targetLoginUrl = formInfo.action;
        } else {
            // Fallback for very simple apps or if discovery fails
            console.log(`[Auth] ⚠️ No complex form detected — using standard fallback fields`);
            postData.append('username', username);
            postData.append('password', password);
            postData.append('Login', 'Login');
        }

        // ─── Step 3: POST login credentials ───────────────────────────────
        const postResponse = await axios.post(targetLoginUrl, postData, {
            timeout,
            headers: {
                'User-Agent': 'Phoenix/1.0 (Graduation Project)',
                'Content-Type': 'application/x-www-form-urlencoded',
                'Cookie': serializeCookies(sessionCookies),
                'Referer': loginUrl
            },
            maxRedirects: 0,
            validateStatus: () => true
        });

        // Extract and merge final cookies
        const postCookies = parseCookies(postResponse.headers['set-cookie']);
        Object.assign(sessionCookies, postCookies);

        // ─── Step 3: Set security level cookie (DVWA-specific) ────────────
        sessionCookies['security'] = securityLevel;

        // ─── Step 4: Validate login success ───────────────────────────────
        const status = postResponse.status;
        let detectedCheckUrl = null;

        if ((status === 302 || status === 301) && postResponse.headers['location']) {
            const location = postResponse.headers['location'];
            if (!location.includes('login')) {
                detectedCheckUrl = new URL(location, targetLoginUrl).href;
            }
        }

        // Fallback check URL: replace login page with index.php
        if (!detectedCheckUrl) {
            try {
                detectedCheckUrl = new URL('index.php', base).href;
            } catch (e) { }
        }

        const isRedirectToIndex = (status === 302 || status === 301)
            && postResponse.headers['location']
            && !postResponse.headers['location'].includes('login');

        const isSuccess = status === 200 || isRedirectToIndex;

        if (isSuccess && sessionCookies['PHPSESSID']) {
            console.log(`[Auth] ✅ Login successful! Session: PHPSESSID=${sessionCookies['PHPSESSID'].substring(0, 8)}...`);
            console.log(`[Auth] Cookies: ${Object.keys(sessionCookies).join(', ')}`);

            let loggedInIndicator = null;
            if (detectedCheckUrl) {
                loggedInIndicator = await detectLoggedInIndicator(detectedCheckUrl, sessionCookies, timeout);
                if (loggedInIndicator) {
                    console.log(`[Auth] 🎯 Session validation: URL=${detectedCheckUrl}, indicator="${loggedInIndicator}"`);
                } else {
                    console.log(`[Auth] ⚠️ Could not auto-detect logged-in indicator on ${detectedCheckUrl}`);
                }
            }

            return { success: true, cookies: sessionCookies, message: 'Login successful', sessionCheckUrl: detectedCheckUrl, loggedInIndicator };
        }

        // If we got a 200 but no redirect, check response body for failure indicators
        if (status === 200) {
            const body = typeof postResponse.data === 'string' ? postResponse.data : '';
            if (body.includes('Login failed') || body.includes('login.php') || body.includes('Invalid')) {
                console.log(`[Auth] ❌ Login failed: invalid credentials or login page returned`);
                return { success: false, cookies: sessionCookies, message: 'Login failed — invalid credentials', sessionCheckUrl: null, loggedInIndicator: null };
            }
            if (sessionCookies['PHPSESSID']) {
                console.log(`[Auth] ✅ Login appears successful (HTTP 200 with session cookie)`);

                let loggedInIndicator = null;
                if (detectedCheckUrl) {
                    loggedInIndicator = await detectLoggedInIndicator(detectedCheckUrl, sessionCookies, timeout);
                    if (loggedInIndicator) {
                        console.log(`[Auth] 🎯 Session validation: URL=${detectedCheckUrl}, indicator="${loggedInIndicator}"`);
                    }
                }

                return { success: true, cookies: sessionCookies, message: 'Login successful (200 OK)', sessionCheckUrl: detectedCheckUrl, loggedInIndicator };
            }
        }

        console.log(`[Auth] ⚠️ Login response: HTTP ${status} — could not confirm success`);
        return {
            success: !!sessionCookies['PHPSESSID'],
            cookies: sessionCookies,
            message: `Login returned HTTP ${status}`,
            sessionCheckUrl: detectedCheckUrl,
            loggedInIndicator: null
        };

    } catch (error) {
        console.error(`[Auth] ❌ Login error: ${error.message}`);
        return { success: false, cookies: {}, message: error.message, sessionCheckUrl: null, loggedInIndicator: null };
    }
}

/**
 * Create a pre-authenticated Axios instance with session cookies applied globally.
 * 
 * Features:
 *   - All requests automatically include session cookies
 *   - Response interceptor detects expired sessions (302 to login, 401, 403)
 *   - Automatic re-authentication with retry on session expiry
 * 
 * @param {string} targetBaseUrl - Base URL of the target
 * @param {object} options
 * @param {string} options.loginPath - Login endpoint path
 * @param {string} options.username - Username
 * @param {string} options.password - Password
 * @param {string} options.securityLevel - DVWA security level
 * @param {number} options.timeout - Request timeout
 * @returns {object} - { axios: AxiosInstance, cookies: object, reauth: Function }
 */
async function createAuthenticatedSession(targetBaseUrl, options = {}) {
    // ─── Perform initial login or use static cookies ──────────────────
    let loginResult = { success: false, cookies: {}, message: '', sessionCheckUrl: null, loggedInIndicator: null };

    if (options.cookies) {
        console.log(`[Auth] Using raw session cookies provided by user.`);
        const rawCookies = {};
        options.cookies.split(';').forEach(part => {
            const splitIndex = part.indexOf('=');
            if (splitIndex !== -1) {
                const key = part.substring(0, splitIndex).trim();
                const val = part.substring(splitIndex + 1).trim();
                if (key && val) rawCookies[key] = val;
            }
        });
        loginResult = { success: true, cookies: rawCookies, message: 'Using provided static cookies', sessionCheckUrl: null, loggedInIndicator: null };
    } else {
        loginResult = await performLogin(targetBaseUrl, options);

        if (!loginResult.success) {
            console.warn(`[Auth] Initial login failed — creating unauthenticated session`);
            console.warn(`[Auth] Reason: ${loginResult.message}`);
        }
    }

    let currentCookies = { ...loginResult.cookies };

    // Force the specified security level (vital for DVWA to avoid defaulting to impossible)
    if (options.securityLevel) {
        currentCookies['security'] = options.securityLevel;
        console.log(`[Auth] Enforced security cookie: security=${options.securityLevel}`);
    }

    // ─── Session Validation Config (Burp Suite-style) ────────────────
    // Manual overrides take precedence over auto-detected values
    let sessionCheckUrl = options.sessionCheckUrl || loginResult.sessionCheckUrl || null;
    let loggedInIndicator = options.loggedInIndicator || loginResult.loggedInIndicator || null;

    if (sessionCheckUrl && loggedInIndicator) {
        console.log(`[Auth] ✅ Session validation active: URL=${sessionCheckUrl}, indicator="${loggedInIndicator}"`);
    } else if (sessionCheckUrl) {
        console.log(`[Auth] ⚠️ Session check URL set (${sessionCheckUrl}) but no indicator detected — using status-code checks only`);
    } else {
        console.log(`[Auth] ℹ️ No session validation URL configured — using status-code checks only`);
    }

    let reauthInProgress = null;
    let reauthCount = 0;
    let lastSessionCheckTime = 0;
    const SESSION_CHECK_INTERVAL_MS = 30000;

    // ─── Create Axios instance with default cookie headers ────────
    const instance = axios.create({
        timeout: options.timeout || 10000,
        headers: {
            'User-Agent': 'Phoenix/1.0 (Graduation Project)',
            'Cookie': serializeCookies(currentCookies)
        },
        maxRedirects: 5,
        validateStatus: () => true
    });

    /**
     * Re-authenticate: perform a fresh login and update the instance cookies.
     */
    async function reauthenticate() {
        if (options.cookies) {
            console.error(`[Auth] ❌ Session expired, but using static cookies. Cannot auto re-authenticate.`);
            return false;
        }

        if (reauthInProgress) {
            return reauthInProgress;
        }

        reauthCount++;
        if (reauthCount > MAX_REAUTH_ATTEMPTS) {
            console.error(`[Auth] ❌ Max re-authentication attempts (${MAX_REAUTH_ATTEMPTS}) exceeded`);
            return false;
        }

        console.log(`[Auth] 🔄 Session expired — re-authenticating (attempt ${reauthCount}/${MAX_REAUTH_ATTEMPTS})...`);

        reauthInProgress = (async () => {
            try {
                const result = await performLogin(targetBaseUrl, options);
                if (result.success) {
                    currentCookies = { ...result.cookies };
                    instance.defaults.headers['Cookie'] = serializeCookies(currentCookies);
                    if (result.sessionCheckUrl) sessionCheckUrl = result.sessionCheckUrl;
                    if (result.loggedInIndicator) loggedInIndicator = result.loggedInIndicator;
                    console.log(`[Auth] ✅ Re-authentication successful`);
                    return true;
                }
                console.warn(`[Auth] ❌ Re-authentication failed: ${result.message}`);
                return false;
            } catch (err) {
                console.error(`[Auth] ❌ Re-authentication error: ${err.message}`);
                return false;
            } finally {
                reauthInProgress = null;
            }
        })();

        return reauthInProgress;
    }

    // ─── Request Interceptor: Ensure cookies are always fresh ─────
    instance.interceptors.request.use((config) => {
        config.headers['Cookie'] = serializeCookies(currentCookies);
        return config;
    });

    // ─── Response Interceptor: Detect session expiry ──────────────
    instance.interceptors.response.use(async (response) => {
        const now = Date.now();
        const status = response.status;
        const isSuspiciousStatus = (status === 401 || status === 403 || status === 302 || status === 301);

        // Only do the full session validation URL fetch periodically to avoid doubling traffic
        const shouldFullCheck = isSuspiciousStatus || (now - lastSessionCheckTime > SESSION_CHECK_INTERVAL_MS);

        let needsReauth = false;
        if (shouldFullCheck) {
            needsReauth = await isSessionExpired(response, {
                sessionCheckUrl,
                loggedInIndicator,
                cookies: currentCookies,
                timeout: options.timeout || 10000
            });
            lastSessionCheckTime = now;
        } else {
            needsReauth = await isSessionExpired(response, {});
        }

        if (needsReauth) {
            console.log(`[Auth] ⚠️ Session expiry detected on ${response.config.url} (HTTP ${response.status})`);

            const success = await reauthenticate();
            if (success) {
                // Retry the original request with refreshed cookies
                const retryConfig = { ...response.config };
                retryConfig.headers['Cookie'] = serializeCookies(currentCookies);
                // Remove the _retry flag to prevent infinite loops
                if (retryConfig._retried) {
                    return response;  // Already retried once — return as-is
                }
                retryConfig._retried = true;
                return instance(retryConfig);
            }
        }

        // Merge any new cookies from the response (session rotation)
        const newCookies = parseCookies(response.headers['set-cookie']);
        if (Object.keys(newCookies).length > 0) {
            Object.assign(currentCookies, newCookies);
            instance.defaults.headers['Cookie'] = serializeCookies(currentCookies);
        }

        return response;
    });

    return {
        axios: instance,
        cookies: currentCookies,
        reauth: reauthenticate,
        getCookieString: () => serializeCookies(currentCookies),
        getCookies: () => ({ ...currentCookies })
    };
}

/**
 * Check if a response indicates an expired / invalid session.
 *
 * Uses a Burp Suite-style approach:
 *   1. Check for explicit auth failure status codes (401, 403)
 *   2. Check for redirect to login page (302/301)
 *   3. If a session validation URL + indicator are configured,
 *      fetch the check URL and verify the indicator is present.
 *   4. If no session validation configured, rely on status codes only.
 *
 * @param {object} response - Axios response object
 * @param {object} validationConfig
 * @param {string} validationConfig.sessionCheckUrl - URL to fetch for session check
 * @param {string} validationConfig.loggedInIndicator - Pattern to search for
 * @param {object} validationConfig.cookies - Current session cookies
 * @param {number} validationConfig.timeout - Request timeout
 * @returns {Promise<boolean>}
 */
async function isSessionExpired(response, validationConfig = {}) {
    const status = response.status;
    const url = response.config.url || '';

    if (url.includes('login.php') && response.config.method === 'POST') {
        return false;
    }

    if (status === 401 || status === 403) {
        return true;
    }

    if (status === 302 || status === 301) {
        const location = (response.headers['location'] || '').toLowerCase();
        if (location.includes('login') || location.includes('signin') || location.includes('auth')) {
            return true;
        }
    }

    const { sessionCheckUrl, loggedInIndicator, cookies, timeout } = validationConfig;

    if (sessionCheckUrl && loggedInIndicator && cookies) {
        try {
            const checkResponse = await axios.get(sessionCheckUrl, {
                timeout: timeout || 10000,
                headers: {
                    'User-Agent': 'Phoenix/1.0 (Graduation Project)',
                    'Cookie': serializeCookies(cookies)
                },
                maxRedirects: 5,
                validateStatus: () => true
            });

            if (checkResponse.status === 302 || checkResponse.status === 301) {
                const loc = (checkResponse.headers['location'] || '').toLowerCase();
                if (loc.includes('login') || loc.includes('signin') || loc.includes('auth')) {
                    return true;
                }
            }

            const body = typeof checkResponse.data === 'string' ? checkResponse.data : '';
            let indicatorFound = false;
            try {
                indicatorFound = new RegExp(loggedInIndicator, 'i').test(body);
            } catch (e) {
                indicatorFound = body.toLowerCase().includes(loggedInIndicator.toLowerCase());
            }

            if (!indicatorFound) {
                console.log(`[Auth] Session check: indicator "${loggedInIndicator}" not found on ${sessionCheckUrl}`);
                return true;
            }

            return false;
        } catch (err) {
            console.warn(`[Auth] Session check request failed: ${err.message} — assuming session valid`);
            return false;
        }
    }

    return false;
}

/**
 * Find and analyze the most likely login form on a page.
 */
function findLoginForm($, pageUrl) {
    let bestForm = null;
    let maxConfidence = 0;

    $('form').each((i, el) => {
        const inputs = [];
        let confidence = 0;
        let hasPassword = false;
        let hasUserField = false;

        $(el).find('input, textarea, select').each((j, input) => {
            const name = $(input).attr('name');
            const type = ($(input).attr('type') || 'text').toLowerCase();
            const value = $(input).attr('value') || '';

            if (!name) return;

            // Detect username-like fields
            const isUser = /user|email|login|account|phone/i.test(name) && type !== 'hidden' && type !== 'submit';
            const isPass = type === 'password' || /pass/i.test(name);

            if (isPass) hasPassword = true;
            if (isUser) hasUserField = true;

            inputs.push({ name, type, value, isUserField: isUser });
        });

        // Score this form: must have a password to be a login form
        if (hasPassword) {
            confidence += 50;
            if (hasUserField) confidence += 30;
            if ($(el).attr('id')?.toLowerCase().includes('login')) confidence += 10;
            if ($(el).attr('action')?.toLowerCase().includes('login')) confidence += 10;
        }

        if (confidence > maxConfidence) {
            maxConfidence = confidence;
            const action = $(el).attr('action') || pageUrl;
            bestForm = {
                action: new URL(action, pageUrl).href,
                inputs: inputs
            };
        }
    });

    return maxConfidence >= 50 ? bestForm : null;
}

/**
 * Auto-detect a "logged-in indicator" by fetching a page with session cookies
 * and searching for common patterns that only appear when authenticated.
 *
 * @param {string} checkUrl - URL to fetch (typically the post-login landing page)
 * @param {object} cookies - Session cookies to send
 * @param {number} timeout - Request timeout in ms
 * @returns {string|null} - The matched indicator text, or null if none found
 */
async function detectLoggedInIndicator(checkUrl, cookies, timeout) {
    const INDICATOR_PATTERNS = [
        /logout/i,
        /log\s*out/i,
        /sign\s*out/i,
        /signout/i,
        /my\s*account/i,
        /welcome\s+\w+/i,
        /dashboard/i
    ];

    try {
        const response = await axios.get(checkUrl, {
            timeout: timeout || 10000,
            headers: {
                'User-Agent': 'Phoenix/1.0 (Graduation Project)',
                'Cookie': serializeCookies(cookies)
            },
            maxRedirects: 5,
            validateStatus: () => true
        });

        const body = typeof response.data === 'string' ? response.data : '';
        if (!body) return null;

        for (const pattern of INDICATOR_PATTERNS) {
            const match = body.match(pattern);
            if (match) {
                return match[0];
            }
        }

        const $ = cheerio.load(body);
        const logoutLink = $('a[href*="logout"], a[href*="signout"], a[href*="log_out"]');
        if (logoutLink.length > 0) {
            const text = logoutLink.first().text().trim();
            return text || 'logout';
        }

        return null;
    } catch (err) {
        console.warn(`[Auth] Could not detect logged-in indicator: ${err.message}`);
        return null;
    }
}

// Public API — Only expose what external consumers need (ISP compliance)
// Internal helpers (parseCookies, serializeCookies, findLoginForm, 
// detectLoggedInIndicator, isSessionExpired) remain module-private.
module.exports = {
    performLogin,
    createAuthenticatedSession,
};
