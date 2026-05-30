/**
 * PHOENIX SCAN ROUTES
 * 
 * POST /scan              - Execute a vulnerability scan
 * POST /cancel-scan       - Cancel an active scan
 * GET  /scan/:id/download-logs - Download agent logs (admin only)
 */
const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const { validateScanRequest } = require('../middleware/validate');
const { buildAuthOptions, runAndPersistScan } = require('../services/scanService');
const { cancelScan } = require('../services/scanRegistry');
const Scan = require('../models/Scan');

// Execute Scan (Protected)
router.post('/scan', auth, validateScanRequest, async (req, res) => {
    const { url, scanMode, socketId, proMode } = req.body;
    const authOptions = buildAuthOptions(req.body);
    const io = req.app.locals.io; // Socket.IO instance from server.js

    try {
        const result = await runAndPersistScan(
            url, scanMode, authOptions, req.user.email, io, socketId, proMode || null
        );

        // Check if the scan was canceled
        if (result.canceled) {
            return res.json({ status: 'canceled', message: 'Scan was canceled by user.', data: result.scanResult });
        }

        res.json({ status: 'success', data: result.scanResult, scanId: result.scanId, scanMode: result.mode });
    } catch (scanErr) {
        res.status(400).json({ status: 'error', message: scanErr.message });
    }
});

// Cancel Scan (Protected — works for ALL scan modes: script, AI, hybrid)
router.post('/cancel-scan', auth, async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ status: 'error', message: 'URL is required to cancel scan' });
    }
    const canceled = cancelScan(url);
    if (canceled) {
        res.json({ status: 'success', message: `Scan for ${url} was canceled successfully.` });
    } else {
        res.status(404).json({ status: 'error', message: `No active scan found for ${url}.` });
    }
});

// Download Agent Logs (Admin Only)
router.get('/scan/:id/download-logs', auth, adminAuth, async (req, res) => {
    try {
        const scan = await Scan.findById(req.params.id);
        if (!scan) {
            return res.status(404).json({ status: 'error', message: 'Scan not found' });
        }

        if (!scan.agentLogs) {
            return res.status(404).json({ status: 'error', message: 'No agent logs available for this scan.' });
        }

        const mdContent = `# Phoenix Scan Logs\n\n**Target:** ${scan.targetUrl}\n**Date:** ${new Date(scan.timestamp).toLocaleString()}\n**Mode:** ${scan.scanMode}\n\n## AI Agent Execution Logs\n\n\`\`\`text\n${scan.agentLogs}\n\`\`\`\n`;

        res.setHeader('Content-disposition', `attachment; filename=phoenix_logs_${scan._id}.md`);
        res.setHeader('Content-type', 'text/markdown');
        res.send(mdContent);
    } catch (error) {
        console.error("Download logs error:", error);
        res.status(500).json({ status: 'error', message: 'Server error' });
    }
});

module.exports = router;
