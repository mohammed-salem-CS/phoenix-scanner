/**
 * PHOENIX ACTIVE SCAN REGISTRY
 * 
 * Centralized tracking of all active scans across ALL modes (script, AI, hybrid).
 * Provides a unified cancel mechanism:
 *   - Script/Hybrid scans: Uses AbortController to cancel in-flight HTTP requests
 *   - AI scans: Kills the Python child process (via SIGKILL)
 * 
 * Each scan is keyed by its normalized target URL.
 */

const activeScans = new Map();

/**
 * Normalize a URL for consistent lookup (remove trailing slashes, lowercase host).
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
    try {
        const parsed = new URL(url);
        // Normalize: lowercase protocol + host, keep path, remove trailing slash
        let normalized = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
        normalized = normalized.replace(/\/+$/, '');
        return normalized || url;
    } catch (e) {
        return url.replace(/\/+$/, '');
    }
}

/**
 * Register a script/hybrid scan with an AbortController.
 * 
 * @param {string} url - Target URL
 * @param {AbortController} abortController - Controller to abort in-flight requests
 * @param {string} mode - Scan mode ('script', 'hybrid')
 * @returns {AbortController} The same controller (for chaining)
 */
function registerScan(url, abortController, mode = 'script') {
    const key = normalizeUrl(url);
    activeScans.set(key, {
        type: mode,
        controller: abortController,
        process: null,
        startTime: Date.now(),
    });
    console.log(`[ScanRegistry] Registered ${mode} scan for ${key}`);
    return abortController;
}

/**
 * Register an AI scan with a Python child process reference.
 * 
 * @param {string} url - Target URL
 * @param {object} pythonProcess - Child process to kill on cancel
 * @returns {void}
 */
function registerAIScan(url, pythonProcess) {
    const key = normalizeUrl(url);
    activeScans.set(key, {
        type: 'ai',
        controller: null,
        process: pythonProcess,
        startTime: Date.now(),
    });
    console.log(`[ScanRegistry] Registered AI scan for ${key}`);
}

/**
 * Remove a scan from the registry (called when scan completes or errors out).
 * 
 * @param {string} url - Target URL
 */
function unregisterScan(url) {
    const key = normalizeUrl(url);
    if (activeScans.has(key)) {
        activeScans.delete(key);
        console.log(`[ScanRegistry] Unregistered scan for ${key}`);
    }
}

/**
 * Cancel an active scan. Works for all scan modes.
 * 
 * @param {string} url - Target URL to cancel
 * @returns {boolean} true if a scan was found and canceled, false otherwise
 */
function cancelScan(url) {
    const key = normalizeUrl(url);
    const entry = activeScans.get(key);

    if (!entry) {
        console.log(`[ScanRegistry] No active scan found for ${key}`);
        return false;
    }

    console.log(`[ScanRegistry] Canceling ${entry.type} scan for ${key}`);

    // Cancel based on scan type
    if (entry.controller) {
        // Script/Hybrid: abort all in-flight HTTP requests
        entry.controller.abort();
    }
    if (entry.process) {
        // AI: kill the Python child process
        try {
            entry.process.kill('SIGKILL');
        } catch (e) {
            console.log(`[ScanRegistry] Process kill error: ${e.message}`);
        }
    }

    activeScans.delete(key);
    return true;
}

/**
 * Check if a scan is currently active.
 * 
 * @param {string} url - Target URL
 * @returns {boolean}
 */
function isActive(url) {
    return activeScans.has(normalizeUrl(url));
}

/**
 * Check if a scan has been aborted (for script/hybrid scans).
 * Scanners should check this periodically to exit early.
 * 
 * @param {string} url - Target URL
 * @returns {boolean} true if the scan was aborted
 */
function isAborted(url) {
    const key = normalizeUrl(url);
    const entry = activeScans.get(key);
    if (!entry || !entry.controller) return false;
    return entry.controller.signal.aborted;
}

module.exports = {
    registerScan,
    registerAIScan,
    unregisterScan,
    cancelScan,
    isActive,
    isAborted,
    normalizeUrl,
};
