/**
 * PHOENIX SCAN STRATEGIES
 * 
 * Strategy pattern for scan mode dispatch.
 * Adding a new scan mode requires only registering a new strategy — no modification
 * to the route handler or service layer (OCP compliance).
 * 
 * Available modes:
 *   - script: Fast, deterministic vulnerability scanning with 13 scanner modules
 *   - ai:     Deep analysis using CrewAI specialized agents (8 Python-based agents)
 *   - hybrid: Runs BOTH script + AI engines in parallel, merges & deduplicates results
 */
const scanner = require('../scannerEngine');
const { aiScan } = require('../ai_agents/aiScanner');
const { executeHybridScan } = require('./hybridOrchestrator');
const { GEMINI_API_KEY, VALID_SCAN_MODES } = require('../config');

// ─── Strategy Definitions ───────────────────────────────────────────────────

const strategies = {
    script: {
        label: 'Script-based',
        requiresApiKey: false,
        async execute(url, authOptions, emitProgress, abortSignal, proMode) {
            console.log(`[Server] Starting script-based scan for: ${url}`);
            return scanner.scanTarget(url, authOptions, emitProgress, abortSignal, proMode);
        },
    },
    ai: {
        label: 'AI-powered',
        requiresApiKey: true,
        async execute(url, authOptions, emitProgress, abortSignal, proMode) {
            console.log(`[Server] Starting AI-powered scan for: ${url}`);
            if (emitProgress) emitProgress('ai_init', 'Connecting to AI Agent pipeline...', 10);
            return aiScan(url, GEMINI_API_KEY, authOptions);
        },
    },
    hybrid: {
        label: 'Hybrid (Script + AI)',
        requiresApiKey: true,
        async execute(url, authOptions, emitProgress, abortSignal, proMode) {
            console.log(`[Server] Starting hybrid scan (Script + AI parallel) for: ${url}`);
            if (emitProgress) emitProgress('hybrid_init', 'Launching Script Engine + AI Agents in parallel...', 10);
            return executeHybridScan(url, GEMINI_API_KEY, authOptions);
        },
    },
};

/**
 * Execute a scan using the appropriate strategy.
 * 
 * @param {string} mode           - Scan mode ('script', 'ai', 'hybrid')
 * @param {string} url            - Target URL
 * @param {object} authOptions    - Authentication options for the scanner
 * @param {Function} emitProgress - Optional callback for real-time progress
 * @param {AbortSignal} [abortSignal] - Optional AbortSignal for cancellation
 * @param {object} [proMode] - Professional Mode settings
 * @returns {Promise<object>}     - Scan result
 * @throws {Error} If API key is missing for AI modes
 */
async function executeScan(mode, url, authOptions, emitProgress, abortSignal, proMode = null) {
    const resolvedMode = VALID_SCAN_MODES.includes(mode) ? mode : 'script';
    const strategy = strategies[resolvedMode];

    if (strategy.requiresApiKey && !GEMINI_API_KEY) {
        throw new Error('Gemini API key is not configured on the server.');
    }

    return strategy.execute(url, authOptions, emitProgress, abortSignal, proMode);
}

/**
 * Get a human-readable label for a scan mode.
 * @param {string} mode
 * @returns {string}
 */
function getModeLabel(mode) {
    return (strategies[mode] && strategies[mode].label) || mode;
}

module.exports = { executeScan, getModeLabel, strategies };
