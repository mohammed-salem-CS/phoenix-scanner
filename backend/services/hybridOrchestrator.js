/**
 * PHOENIX HYBRID ORCHESTRATOR
 * 
 * Runs the Script Engine and AI Agents CONCURRENTLY, then merges their results.
 * 
 * Architecture:
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │                      Hybrid Orchestrator                            │
 * │                                                                    │
 * │  ┌────────────────────────┐     ┌────────────────────────────────┐ │
 * │  │    Script Engine        │     │       AI Agents                │ │
 * │  │                        │     │                                │ │
 * │  │  • Auth Session        │     │  • Auth Session                │ │
 * │  │  • Deep Crawl          │     │  • Deep Crawl                  │ │
 * │  │  • Passive Analysis    │     │  • Export crawl data → Python  │ │
 * │  │  • Active Attacks      │     │  • CrewAI Specialized Agents   │ │
 * │  │    (SQLi,XSS,LFI,CMD,  │     │    (Recon, XSS Confirm,       │ │
 * │  │     CORS,CSRF,SSL...)  │     │     SQLi Confirm, LFI,        │ │
 * │  │  • Stored Vuln Scans   │     │     SSRF, DOM-XSS, API,       │ │
 * │  │  • Dirsearch           │     │     Validator)                 │ │
 * │  └──────────┬─────────────┘     └──────────────┬─────────────────┘ │
 * │             │                                  │                   │
 * │             ▼                                  ▼                   │
 * │  ┌─────────────────────────────────────────────────────────────┐   │
 * │  │                   Result Merger                              │   │
 * │  │  • Deduplicate by (location + type) normalized key           │   │
 * │  │  • Escalate severity when both engines agree                 │   │
 * │  │  • Merge crawl metadata (union of endpoints/params/techs)   │   │
 * │  │  • Concatenate agent logs from both tracks                  │   │
 * │  │  • Tag each finding with its source (script / ai / both)     │   │
 * │  └─────────────────────────────────────────────────────────────┘   │
 * └──────────────────────────────────────────────────────────────────────┘
 * 
 * Design Decisions:
 *   1. Promise.allSettled — if one engine fails, we still return the other's results.
 *   2. Independent crawls — each engine manages its own auth session and crawl.
 *      This avoids coupling and ensures each engine works exactly as it does standalone.
 *   3. Smart deduplication — same vuln found by both engines is kept once with
 *      "Confirmed by both Script Engine and AI Agents" evidence.
 *   4. Severity escalation — if both engines find the same issue, trust the higher severity.
 */

const { VALID_SEVERITIES } = require('../config');

// ─── Severity Ordering ──────────────────────────────────────────────────────

const SEVERITY_RANK = { 'Critical': 0, 'High': 1, 'Medium': 2, 'Low': 3, 'Info': 4 };

function higherSeverity(a, b) {
    const rankA = SEVERITY_RANK[a] ?? 5;
    const rankB = SEVERITY_RANK[b] ?? 5;
    return rankA <= rankB ? a : b;
}

// ─── Normalization ──────────────────────────────────────────────────────────

/**
 * Build a deduplication key from a vulnerability.
 * Normalizes location and type to catch near-duplicates across engines.
 */
function buildDedupeKey(vuln) {
    const location = (vuln.location || '').toLowerCase().replace(/\s+/g, ' ').trim();
    const type = (vuln.type || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return `${location}|${type}`;
}

// ─── Result Merger ──────────────────────────────────────────────────────────

/**
 * Merge vulnerability arrays from the script engine and AI agents.
 * 
 * When the same vulnerability is found by both engines:
 *   - Keep the richer description (longer one)
 *   - Escalate to the higher severity
 *   - Mark evidence as "Confirmed by both engines"
 *   - Tag source as 'both'
 * 
 * @param {Array} scriptVulns - Vulnerabilities from the script engine
 * @param {Array} aiVulns     - Vulnerabilities from the AI agents
 * @returns {Array}           - Merged, deduplicated, sorted vulnerabilities
 */
function mergeVulnerabilities(scriptVulns, aiVulns) {
    const merged = new Map(); // key → merged vuln object

    // Pass 1: Index all script engine findings
    for (const vuln of scriptVulns) {
        const key = buildDedupeKey(vuln);
        merged.set(key, {
            ...vuln,
            _source: 'script',
            _key: key,
        });
    }

    // Pass 2: Merge AI findings
    for (const vuln of aiVulns) {
        // Skip internal agent error entries — they're not real findings
        if (vuln.type === 'Agent Error') continue;

        const key = buildDedupeKey(vuln);

        if (merged.has(key)) {
            // Duplicate found — escalate and enrich
            const existing = merged.get(key);
            existing.severity = higherSeverity(existing.severity, vuln.severity);
            existing._source = 'both';

            // Keep the longer/richer description
            if ((vuln.description || '').length > (existing.description || '').length) {
                existing.description = vuln.description;
            }

            // Append cross-validation evidence
            const aiEvidence = vuln.evidence || '';
            const crossNote = '✅ Confirmed by both Script Engine and AI Agents.';
            existing.evidence = existing.evidence
                ? `${existing.evidence}\n${crossNote}${aiEvidence ? '\nAI Evidence: ' + aiEvidence : ''}`
                : `${crossNote}${aiEvidence ? '\nAI Evidence: ' + aiEvidence : ''}`;
        } else {
            // New finding only from AI
            merged.set(key, {
                ...vuln,
                _source: 'ai',
                _key: key,
            });
        }
    }

    // Convert to array, clean internal fields, and sort by severity
    const results = Array.from(merged.values()).map(v => {
        const { _source, _key, ...clean } = v;
        return clean;
    });

    results.sort((a, b) => (SEVERITY_RANK[a.severity] ?? 5) - (SEVERITY_RANK[b.severity] ?? 5));

    return results;
}

// ─── Crawl Data Merger ──────────────────────────────────────────────────────

/**
 * Merge crawl metadata from both engines (union of endpoints, params, techs).
 */
function mergeCrawlData(scriptCrawl, aiCrawl) {
    const s = scriptCrawl || { endpoints: [], parameters: [], technologies: [] };
    const a = aiCrawl || { endpoints: [], parameters: [], technologies: [] };

    return {
        endpoints: [...new Set([...s.endpoints, ...a.endpoints])].slice(0, 100),
        parameters: [...new Set([...s.parameters, ...a.parameters])].slice(0, 100),
        technologies: [...new Set([...s.technologies, ...a.technologies])],
    };
}

// ─── Main Orchestrator ──────────────────────────────────────────────────────

/**
 * Execute a hybrid scan: run Script Engine + AI Agents concurrently,
 * then merge their results into a unified report.
 * 
 * Uses Promise.allSettled for graceful degradation — if one engine fails,
 * we still return the other's complete results.
 * 
 * @param {string} targetUrl     - Target URL to scan
 * @param {string} apiKey        - Gemini API key for AI agents
 * @param {object} authOptions   - Authentication configuration
 * @returns {Promise<object>}    - Unified scan result
 */
async function executeHybridScan(targetUrl, apiKey, authOptions = {}) {
    console.log(`[Phoenix Hybrid] ═══════════════════════════════════════════════════`);
    console.log(`[Phoenix Hybrid] Starting Hybrid Scan: Script Engine + AI Agents`);
    console.log(`[Phoenix Hybrid] Target: ${targetUrl}`);
    console.log(`[Phoenix Hybrid] ═══════════════════════════════════════════════════`);

    const startTime = Date.now();

    // Import engines lazily to avoid circular dependencies at module load
    const scanner = require('../scannerEngine');
    const { aiScan } = require('../ai_agents/aiScanner');

    // ── Run both engines concurrently ────────────────────────────────────
    console.log(`[Phoenix Hybrid] Launching both engines in parallel...`);

    const [scriptOutcome, aiOutcome] = await Promise.allSettled([
        scanner.scanTarget(targetUrl, authOptions),
        aiScan(targetUrl, apiKey, authOptions),
    ]);

    // ── Extract results (handle failures gracefully) ─────────────────────
    let scriptResult = null;
    let aiResult = null;
    const logs = [];

    if (scriptOutcome.status === 'fulfilled' && !scriptOutcome.value.error) {
        scriptResult = scriptOutcome.value;
        logs.push('=== SCRIPT ENGINE LOGS ===');
        if (scriptResult.agentLogs) logs.push(scriptResult.agentLogs);
        console.log(`[Phoenix Hybrid] ✅ Script Engine: ${scriptResult.vulnerabilities.length} vulnerabilities found`);
    } else {
        const reason = scriptOutcome.status === 'rejected'
            ? scriptOutcome.reason?.message
            : scriptOutcome.value?.message || 'Unknown error';
        logs.push(`=== SCRIPT ENGINE FAILED: ${reason} ===`);
        console.warn(`[Phoenix Hybrid] ⚠️ Script Engine failed: ${reason}`);
    }

    if (aiOutcome.status === 'fulfilled' && !aiOutcome.value.error) {
        aiResult = aiOutcome.value;
        logs.push('\n=== AI AGENT LOGS ===');
        if (aiResult.agentLogs) logs.push(aiResult.agentLogs);
        console.log(`[Phoenix Hybrid] ✅ AI Agents: ${aiResult.vulnerabilities.length} vulnerabilities found`);
    } else {
        const reason = aiOutcome.status === 'rejected'
            ? aiOutcome.reason?.message
            : aiOutcome.value?.message || 'Unknown error';
        logs.push(`\n=== AI AGENTS FAILED: ${reason} ===`);
        console.warn(`[Phoenix Hybrid] ⚠️ AI Agents failed: ${reason}`);
    }

    // ── Merge results ────────────────────────────────────────────────────
    const scriptVulns = scriptResult ? scriptResult.vulnerabilities : [];
    const aiVulns = aiResult ? aiResult.vulnerabilities : [];

    const mergedVulnerabilities = mergeVulnerabilities(scriptVulns, aiVulns);
    const mergedCrawlData = mergeCrawlData(
        scriptResult?.crawlData,
        aiResult?.crawlData
    );

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    // ── Build analysis summary ───────────────────────────────────────────
    const analysisParts = [];
    if (scriptResult) {
        analysisParts.push(`Script Engine: ${scriptVulns.length} findings (headers, CORS, CSRF, SSL, SQLi, XSS, LFI, CMD injection, cookies, clickjacking, dirsearch)`);
    }
    if (aiResult) {
        analysisParts.push(`AI Agents: ${aiVulns.length} findings (8 specialized CrewAI agents: Recon, XSS, SQLi, LFI, SSRF, DOM-XSS, API, Validator)`);
    }
    analysisParts.push(`Merged: ${mergedVulnerabilities.length} unique vulnerabilities after deduplication`);
    analysisParts.push(`Duration: ${elapsed}s`);

    const duplicatesFound = (scriptVulns.length + aiVulns.length) - mergedVulnerabilities.length;
    if (duplicatesFound > 0) {
        analysisParts.push(`Cross-validated: ${duplicatesFound} findings confirmed by both engines`);
    }

    console.log(`[Phoenix Hybrid] ═══════════════════════════════════════════════════`);
    console.log(`[Phoenix Hybrid] Hybrid Scan Complete in ${elapsed}s`);
    console.log(`[Phoenix Hybrid]   Script: ${scriptVulns.length} | AI: ${aiVulns.length} | Merged: ${mergedVulnerabilities.length}`);
    if (duplicatesFound > 0) {
        console.log(`[Phoenix Hybrid]   ${duplicatesFound} vulnerabilities confirmed by both engines`);
    }
    console.log(`[Phoenix Hybrid] ═══════════════════════════════════════════════════`);

    return {
        target: targetUrl,
        timestamp: new Date(),
        vulnerabilities: mergedVulnerabilities,
        crawlData: mergedCrawlData,
        aiAnalysis: `Hybrid Scan (Script + AI Parallel)\n${analysisParts.join('\n')}`,
        agentLogs: logs.join('\n'),
    };
}

module.exports = { executeHybridScan, mergeVulnerabilities, mergeCrawlData };
