/**
 * PHOENIX SCAN SERVICE
 * 
 * Orchestrates scan execution, result sanitization, and DB persistence.
 * Contains business logic extracted from the /scan route handler.
 * Now supports real-time progress emission via Socket.IO.
 */
const Scan = require('../models/Scan');
const { executeScan } = require('./scanStrategies');
const { VALID_SEVERITIES, VALID_SCAN_MODES } = require('../config');
const { registerScan, unregisterScan } = require('./scanRegistry');

/**
 * Build authentication options from request body fields.
 * 
 * @param {object} body - Request body
 * @returns {object}    - Normalized auth options
 */
function buildAuthOptions(body) {
    const {
        targetUsername, targetPassword, loginPath, securityLevel,
        sessionCookies, sessionCheckUrl, loggedInIndicator,
    } = body;

    const authOptions = {};

    if (sessionCookies) {
        authOptions.cookies = sessionCookies;
        if (sessionCheckUrl) authOptions.sessionCheckUrl = sessionCheckUrl;
        if (loggedInIndicator) authOptions.loggedInIndicator = loggedInIndicator;
        console.log(`[Server] Authenticated scan requested using raw cookies.`);
    } else if (targetUsername && targetPassword) {
        authOptions.username = targetUsername;
        authOptions.password = targetPassword;
        authOptions.loginPath = loginPath || '/login.php';
        authOptions.securityLevel = securityLevel || 'low';
        if (sessionCheckUrl) authOptions.sessionCheckUrl = sessionCheckUrl;
        if (loggedInIndicator) authOptions.loggedInIndicator = loggedInIndicator;
        console.log(`[Server] Authenticated scan requested (user: ${targetUsername}, login: ${authOptions.loginPath})`);
    }

    return authOptions;
}

/**
 * Sanitize vulnerability objects to match the DB schema.
 * 
 * @param {Array} vulnerabilities - Raw vulnerability list from scanner
 * @param {string} fallbackUrl    - Fallback location URL
 * @returns {Array}               - Cleaned vulnerability objects
 */
function sanitizeVulnerabilities(vulnerabilities, fallbackUrl) {
    return vulnerabilities.map(v => ({
        type: v.type || 'Unknown',
        name: v.name || v.type || 'Unknown',
        severity: VALID_SEVERITIES.includes(v.severity) ? v.severity : 'Info',
        location: v.location || fallbackUrl,
        description: v.description || '',
        evidence: v.evidence || '',
    }));
}

/**
 * Execute a scan, sanitize results, and persist to database.
 * Emits real-time progress events via Socket.IO if an emitter is provided.
 * 
 * @param {string} url         - Target URL
 * @param {string} scanMode    - Scan mode ('script', 'ai', 'hybrid')
 * @param {object} authOptions - Auth configuration
 * @param {string} userEmail   - Requesting user's email
 * @param {object} [io]        - Socket.IO server instance for progress events
 * @param {string} [socketId]  - Socket ID of the requesting client
 * @returns {Promise<{scanResult: object, scanId: string|null, mode: string, duration: string}>}
 */
async function runAndPersistScan(url, scanMode, authOptions, userEmail, io, socketId) {
    const mode = VALID_SCAN_MODES.includes(scanMode) ? scanMode : 'script';
    const startTime = Date.now();

    // Create an AbortController so this scan can be canceled
    const abortController = new AbortController();
    registerScan(url, abortController, mode);

    // Helper to emit progress to the specific client
    const emitProgress = (phase, message, percent) => {
        if (io && socketId) {
            io.to(socketId).emit('scan:progress', { phase, message, percent, url });
        }
    };

    emitProgress('init', `Starting ${mode} scan for ${url}...`, 5);

    let scanResult;
    try {
        // Execute via strategy pattern — pass AbortController signal
        scanResult = await executeScan(mode, url, authOptions, emitProgress, abortController.signal);
    } catch (execErr) {
        unregisterScan(url);
        // If aborted, return a clean "canceled" response instead of an error
        if (abortController.signal.aborted) {
            emitProgress('canceled', 'Scan was canceled by user.', 100);
            return {
                scanResult: {
                    target: url,
                    timestamp: new Date(),
                    vulnerabilities: [],
                    aiAnalysis: 'Scan was canceled by user.'
                },
                scanId: null,
                mode,
                duration: '0m 0s',
                canceled: true
            };
        }
        throw execErr;
    }

    const durationMs = Date.now() - startTime;
    const duration = `${Math.floor(durationMs / 60000)}m ${Math.floor((durationMs % 60000) / 1000)}s`;

    unregisterScan(url);

    emitProgress('saving', 'Saving results to database...', 95);

    if (scanResult.error) {
        emitProgress('error', scanResult.message, 100);
        throw new Error(scanResult.message);
    }

    // Persist to DB
    let scanId = null;
    try {
        const cleanVulns = sanitizeVulnerabilities(scanResult.vulnerabilities, url);

        const newScan = new Scan({
            user: userEmail,
            targetUrl: url,
            vulnerabilities: cleanVulns,
            status: 'Completed',
            duration,
            scanMode: mode,
            aiAnalysis: scanResult.aiAnalysis || null,
            crawlData: scanResult.crawlData || { endpoints: [], parameters: [], technologies: [] },
            agentLogs: scanResult.agentLogs || null,
        });
        await newScan.save();
        scanId = newScan._id;
        console.log(`[Server] ${mode.toUpperCase()} scan saved for ${url} (${cleanVulns.length} vulnerabilities)`);
    } catch (dbErr) {
        console.error('[Server] Failed to save scan:', dbErr.message);
    }

    emitProgress('complete', `Scan complete! Found ${scanResult.vulnerabilities.length} vulnerabilities.`, 100);

    return { scanResult, scanId, mode, duration };
}

module.exports = { buildAuthOptions, sanitizeVulnerabilities, runAndPersistScan };
