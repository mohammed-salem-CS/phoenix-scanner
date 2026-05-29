/**
 * PHOENIX AUTH ROUTES
 * 
 * POST /register - Create a new user account
 * POST /login    - Authenticate and receive JWT token
 */
const express = require('express');
const router = express.Router();
const { registerUser, loginUser } = require('../services/authService');

// Register
router.post('/register', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await registerUser(email, password);
        res.json(result);
    } catch (error) {
        res.status(400).json({ status: 'error', message: 'Email already exists' });
    }
});

// Login
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await loginUser(email, password);
        res.json(result);
    } catch (error) {
        const statusCode = error.statusCode || 500;
        res.status(statusCode).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
