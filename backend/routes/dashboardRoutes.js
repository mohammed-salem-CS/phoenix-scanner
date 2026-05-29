/**
 * PHOENIX DASHBOARD ROUTES
 * 
 * GET /dashboard-stats  - Get dashboard statistics for current user
 * GET /dashboard-trends - Get vulnerability trend data over time (Feature #8)
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { getUserDashboardStats, getVulnerabilityTrends } = require('../services/statsService');

// Get Dashboard Stats (Protected)
router.get('/dashboard-stats', auth, async (req, res) => {
    try {
        const stats = await getUserDashboardStats(req.user.email);
        res.json({ status: 'success', data: stats });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Get Vulnerability Trends (Protected) — Feature #8
// GET /dashboard-trends?days=30
router.get('/dashboard-trends', auth, async (req, res) => {
    try {
        const days = parseInt(req.query.days) || 30;
        const trends = await getVulnerabilityTrends(req.user.email, days);
        res.json({ status: 'success', data: trends });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
