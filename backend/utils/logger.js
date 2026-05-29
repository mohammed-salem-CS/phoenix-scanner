/**
 * PHOENIX SCAN LOGGER
 * 
 * Captures scan execution logs without overriding the global console.log.
 * Replaces the dangerous pattern of monkey-patching console.log in scannerEngine.js.
 * 
 * Usage:
 *   const logger = new ScanLogger();
 *   logger.log('[Engine] Starting scan...');
 *   // ... later ...
 *   const allLogs = logger.getLogs();
 */

class ScanLogger {
    constructor() {
        /** @type {string[]} */
        this._entries = [];
    }

    /**
     * Log a message — outputs to console AND captures internally.
     * @param {...any} args - Arguments to log (joined with space)
     */
    log(...args) {
        const message = args.join(' ');
        this._entries.push(message);
        console.log(message);
    }

    /**
     * Get all captured log entries as a single newline-separated string.
     * @returns {string}
     */
    getLogs() {
        return this._entries.join('\n');
    }

    /**
     * Append a raw message without printing to console (e.g. for error context).
     * @param {string} message
     */
    capture(message) {
        this._entries.push(message);
    }

    /**
     * Get the number of captured entries.
     * @returns {number}
     */
    get size() {
        return this._entries.length;
    }
}

module.exports = { ScanLogger };
