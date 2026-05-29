const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { Crawler } = require('../crawler');
const { createAuthenticatedSession } = require('../authSession');
const { PYTHON_EXE, SPECIALIZED_AGENTS_SCRIPT, CRAWLER_DEFAULTS } = require('../config');
const { extractCrawlMetadata } = require('../services/techFingerprint');

/**
 * PHOENIX AI SCANNER — CrewAI Specialized Agents Bridge
 * 
 * Architecture:
 *   Phase 0: Deep Crawling (Node.js Crawler from script engine)
 *   Phase 1: Pass discovered endpoints/params/forms → Python AI agents for testing
 * 
 * This eliminates the dependency on Katana/HTTPX CLI tools inside Python.
 * The script engine's Crawler handles authenticated deep crawling with JS-less BFS,
 * and the AI agents focus purely on vulnerability testing and confirmation.
 */

const activeScans = new Map();

/**
 * Run the script engine's deep Crawler to discover all endpoints, parameters, and forms.
 * Returns { pages, forms, errors } just like scannerEngine Phase 2.
 */
async function deepCrawl(targetUrl, authOptions = {}) {
    console.log(`[Phoenix AI] === Phase 0: Deep Crawling with Script Engine ===`);
    console.log(`[Phoenix AI] Target: ${targetUrl}`);

    // Build authenticated HTTP client if credentials/cookies provided
    let httpClient;
    try {
        const sessionInfo = await createAuthenticatedSession(targetUrl, {
            loginPath: authOptions.loginPath || '/login.php',
            username: authOptions.username,
            password: authOptions.password,
            securityLevel: authOptions.securityLevel || 'low',
            cookies: authOptions.cookies,
            sessionCheckUrl: authOptions.sessionCheckUrl,
            loggedInIndicator: authOptions.loggedInIndicator
        });
        httpClient = sessionInfo.axios;
        console.log(`[Phoenix AI] ✅ Authenticated session established for crawling`);
    } catch (e) {
        console.log(`[Phoenix AI] ⚠️ Auth session failed (${e.message}), crawling without auth`);
        httpClient = undefined; // Crawler defaults to plain axios
    }

    const crawler = new Crawler(targetUrl, {
        maxDepth: 3,
        maxPages: 50,
        concurrency: 5,
        delayMs: 100,
        authSession: httpClient,
        onPageCrawled: (pageUrl, depth, total) => {
            console.log(`[Phoenix AI]   Crawled [depth=${depth}] (${total} total): ${pageUrl}`);
        }
    });

    const crawlResult = await crawler.crawl();
    console.log(`[Phoenix AI] ✅ Deep Crawling complete: ${crawlResult.pages.length} pages, ${crawlResult.forms.length} forms, ${crawlResult.errors.length} errors`);
    return crawlResult;
}

/**
 * Save crawl results to a temporary JSON file for the Python agents to consume.
 * Returns the absolute path to the temp file.
 */
function saveCrawlData(crawlResult) {
    const tmpDir = path.join(__dirname, 'tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpFile = path.join(tmpDir, `crawl_data_${Date.now()}.json`);
    fs.writeFileSync(tmpFile, JSON.stringify(crawlResult, null, 0), 'utf-8');
    console.log(`[Phoenix AI] Crawl data saved to: ${tmpFile}`);
    return tmpFile;
}

/**
 * Clean up temporary crawl data file.
 */
function cleanupCrawlData(filePath) {
    try {
        if (filePath && fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
            console.log(`[Phoenix AI] Cleaned up temp file: ${filePath}`);
        }
    } catch (e) {
        console.log(`[Phoenix AI] Failed to clean up temp file: ${e.message}`);
    }
}

/**
 * AI-powered vulnerability scanner using specialized Python-based CrewAI agents.
 * 
 * NEW ARCHITECTURE:
 *   1. Deep crawl the target using the script engine's Crawler (Node.js)
 *   2. Save discovered endpoints/params/forms to a temp JSON file
 *   3. Pass the file to Python agents via --crawl-data
 *   4. AI agents load the pre-crawled data and focus on TESTING vulnerabilities
 */
async function aiScan(targetUrl, apiKey, authOptions = {}) {
    console.log(`[Phoenix AI] === Starting AI Agent Scan ===`);
    console.log(`[Phoenix AI] Phase 0: Deep Crawling (Script Engine)`);
    console.log(`[Phoenix AI] Phase 1: AI Agents test discovered endpoints`);

    let crawlDataFile = null;

    try {
        // Phase 0: Deep crawl using script engine
        const crawlResult = await deepCrawl(targetUrl, authOptions);
        crawlDataFile = saveCrawlData(crawlResult);

        // Phase 1: Launch Python AI agents with pre-crawled data
        return await new Promise((resolve, reject) => {
            console.log(`[Phoenix AI] === Phase 1: Launching AI Agents ===`);

            const pythonPath = PYTHON_EXE;
            const scriptPath = SPECIALIZED_AGENTS_SCRIPT;
            const env = { ...process.env, GEMINI_API_KEY: apiKey };

            // Build CLI args — pass crawl data file + auth options
            const args = [scriptPath, targetUrl, '--crawl-data', crawlDataFile];
            if (authOptions && Object.keys(authOptions).length > 0) {
                args.push('--auth', JSON.stringify(authOptions));
                console.log(`[Phoenix AI] Passing authentication options to Python agents`);
            }

            const pythonProcess = spawn(pythonPath, args, { env, cwd: __dirname });
            activeScans.set(targetUrl, pythonProcess);

            let stdoutData = '';
            let stderrData = '';

            pythonProcess.stdout.on('data', (data) => {
                stdoutData += data.toString();
            });

            pythonProcess.stderr.on('data', (data) => {
                const text = data.toString();
                stderrData += text;
                // Stream agent logs to terminal in real-time
                text.split('\n').forEach(line => {
                    line = line.trim();
                    if (line) {
                        console.log(`[AI Agent] ${line}`);
                    }
                });
            });

            pythonProcess.on('close', (code) => {
                activeScans.delete(targetUrl);
                cleanupCrawlData(crawlDataFile);

                // Log stderr as agent verbose output (not an error)
                if (stderrData) {
                    console.log(`[Phoenix AI] Agent logs (${stderrData.length} chars) written to stderr`);
                }

                if (code !== 0 && !stdoutData.trim()) {
                    if (code === null) {
                        console.log(`[Phoenix AI] Python process for ${targetUrl} was terminated.`);
                        return resolve({
                            target: targetUrl,
                            timestamp: new Date(),
                            vulnerabilities: [],
                            aiAnalysis: "Scan was manually canceled by the user."
                        });
                    }
                    console.error(`[Phoenix AI] Python process failed with code ${code}`);
                    console.error(`[Phoenix AI] Error: ${stderrData.substring(stderrData.length - 1000)}`);
                    return resolve({
                        target: targetUrl,
                        timestamp: new Date(),
                        vulnerabilities: [{
                            type: 'Agent Error',
                            name: 'AI Engine Failure',
                            severity: 'Info',
                            location: targetUrl,
                            description: `Python process exited with code ${code}. ${stderrData.substring(stderrData.length - 500)}`,
                            evidence: 'Check server logs for details'
                        }],
                        aiAnalysis: stderrData.substring(stderrData.length - 1000)
                    });
                }

                try {
                    let rawOutput = stdoutData.trim();
                    let vulnerabilities = [];
                    const startMarker = "---JSON_START---";
                    const endMarker = "---JSON_END---";
                    const startIdx = rawOutput.indexOf(startMarker);
                    const endIdx = rawOutput.lastIndexOf(endMarker);

                    if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx + startMarker.length) {
                        const jsonStr = rawOutput.substring(startIdx + startMarker.length, endIdx).trim();
                        vulnerabilities = JSON.parse(jsonStr);
                    } else {
                        vulnerabilities = JSON.parse(rawOutput);
                    }

                    console.log(`[Phoenix AI] Specialized agents complete. Found ${vulnerabilities.length} vulnerabilities.`);

                    // Extract discovery data — use shared service
                    const crawlData = extractCrawlMetadata(crawlResult);

                    resolve({
                        target: targetUrl,
                        timestamp: new Date(),
                        vulnerabilities: vulnerabilities,
                        crawlData,
                        aiAnalysis: `Deep Crawl (${crawlResult.pages.length} pages, ${crawlResult.forms.length} forms) → AI Agent Analysis (8 agents: Recon, XSS, SQLi, LFI, SSRF, DOM-XSS, API, Validator)`,
                        agentLogs: stderrData || stdoutData
                    });
                } catch (e) {
                    console.error(`[Phoenix AI] Failed to parse agent output: ${e.message}`);
                    console.log(`[Phoenix AI] Raw stdout (first 500 chars): ${stdoutData.substring(0, 500)}`);

                    resolve({
                        target: targetUrl,
                        timestamp: new Date(),
                        vulnerabilities: [{
                            type: 'Agent Error',
                            name: 'Analysis Parsing Failure',
                            severity: 'Info',
                            location: targetUrl,
                            description: 'The specialized agents completed but their output could not be parsed. Raw: ' + stdoutData.substring(0, 300),
                            evidence: stderrData.substring(stderrData.length - 500)
                        }],
                        aiAnalysis: stdoutData
                    });
                }
            });
        });
    } catch (crawlError) {
        // If the crawl itself fails, clean up and return error
        cleanupCrawlData(crawlDataFile);
        console.error(`[Phoenix AI] Deep crawl failed: ${crawlError.message}`);
        return {
            target: targetUrl,
            timestamp: new Date(),
            vulnerabilities: [{
                type: 'Agent Error',
                name: 'Deep Crawl Failure',
                severity: 'Info',
                location: targetUrl,
                description: `Deep crawling failed: ${crawlError.message}`,
                evidence: 'Check server logs for details'
            }],
            aiAnalysis: `Deep crawl error: ${crawlError.message}`
        };
    }
}

function cancelScan(targetUrl) {
    if (activeScans.has(targetUrl)) {
        console.log(`[Phoenix AI] Canceling active scan for ${targetUrl}`);
        const proc = activeScans.get(targetUrl);
        proc.kill('SIGKILL');
        activeScans.delete(targetUrl);
        return true;
    }
    return false;
}

module.exports = { aiScan, cancelScan };
