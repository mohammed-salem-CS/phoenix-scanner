/**
 * PHOENIX REPORT SERVICE
 * 
 * AI report generation orchestration.
 * Extracted from server.js route handler for SRP compliance.
 */
const Scan = require('../models/Scan');
const { generateAIReport } = require('../ai_agents/reportAgent');
const { GEMINI_API_KEY } = require('../config');

/**
 * Generate or return cached AI report for a scan.
 * 
 * @param {string} scanId    - MongoDB scan document ID
 * @param {string} userEmail - Requesting user's email (for ownership check)
 * @returns {Promise<string>} - Markdown report content
 * @throws {Error} If scan not found, API key missing, or generation fails
 */
async function getOrGenerateReport(scanId, userEmail) {
    const scan = await Scan.findOne({ _id: scanId, user: userEmail });

    if (!scan) {
        const err = new Error('Scan not found');
        err.statusCode = 404;
        throw err;
    }

    // Return cached report if available
    if (scan.aiReport) {
        console.log('[Server] Returning cached AI report for scan:', scanId);
        return scan.aiReport;
    }

    // Validate API key
    if (!GEMINI_API_KEY) {
        const err = new Error('Gemini API key is not configured on the server.');
        err.statusCode = 500;
        throw err;
    }

    // Generate and cache
    console.log('[Server] Generating AI report for scan:', scanId);
    const reportMarkdown = await generateAIReport(scan.toObject(), GEMINI_API_KEY);

    scan.aiReport = reportMarkdown;
    await scan.save();
    console.log('[Server] AI report cached successfully for scan:', scanId);

    return reportMarkdown;
}

module.exports = { getOrGenerateReport };
