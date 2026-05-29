/**
 * PHOENIX AUTH MIDDLEWARE
 * 
 * JWT token verification and role-based access control.
 * Extracted from server.js to satisfy SRP.
 */
const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config');

/**
 * Middleware: Verify JWT token from Authorization header.
 * Attaches decoded user to req.user on success.
 */
function auth(req, res, next) {
    const token = req.header('Authorization')?.replace('Bearer ', '');

    if (!token) {
        return res.status(401).json({ status: 'error', message: 'No token, authorization denied' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (e) {
        res.status(400).json({ status: 'error', message: 'Token is not valid' });
    }
}

/**
 * Middleware: Require admin role (must be used after auth middleware).
 */
function adminAuth(req, res, next) {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ status: 'error', message: 'Admin access required' });
    }
}

module.exports = { auth, adminAuth };
