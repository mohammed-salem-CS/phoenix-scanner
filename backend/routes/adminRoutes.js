/**
 * PHOENIX ADMIN ROUTES
 * 
 * GET /admin/system-stats - Get system-wide statistics
 * GET /admin/users        - Get all registered users
 */
const express = require('express');
const router = express.Router();
const { auth, adminAuth } = require('../middleware/auth');
const { getAdminSystemStats, getAllUsers } = require('../services/statsService');

// Admin: Get System Stats (Protected)
router.get('/admin/system-stats', auth, adminAuth, async (req, res) => {
    try {
        const stats = await getAdminSystemStats();
        res.json({ status: 'success', data: stats });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Admin: Get All Users (Protected)
router.get('/admin/users', auth, adminAuth, async (req, res) => {
    try {
        const users = await getAllUsers();
        res.json({ status: 'success', data: users });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
