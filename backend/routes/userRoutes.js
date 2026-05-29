/**
 * PHOENIX USER ROUTES
 * 
 * GET /me              - Get current user profile
 * PUT /change-password - Change password
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const { validatePasswordChange } = require('../middleware/validate');
const { changePassword, getUserProfile } = require('../services/authService');

// Get Current User Info (Protected)
router.get('/me', auth, async (req, res) => {
    try {
        const profile = await getUserProfile(req.user.id);
        res.json({ status: 'success', data: profile });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// Change Password (Protected)
router.put('/change-password', auth, validatePasswordChange, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const result = await changePassword(req.user.id, currentPassword, newPassword);
        res.json(result);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
