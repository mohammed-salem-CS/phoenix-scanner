/**
 * PHOENIX REPORT ROUTES
 * 
 * POST /generate-ai-report - Generate AI-powered security report
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { getOrGenerateReport } = require('../services/reportService');

// AI Report Generation (Protected)
router.post('/generate-ai-report', auth, async (req, res) => {
    const { scanId } = req.body;

    if (!scanId) {
        return res.status(400).json({ status: 'error', message: 'scanId is required' });
    }

    try {
        const report = await getOrGenerateReport(scanId, req.user.email);
        res.json({ status: 'success', data: { report } });
    } catch (error) {
        const statusCode = error.statusCode || 500;
        console.error('[Server] AI Report Error:', error.message);
        res.status(statusCode).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
