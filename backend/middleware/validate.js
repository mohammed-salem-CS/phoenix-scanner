/**
 * PHOENIX VALIDATION MIDDLEWARE
 * 
 * Request validation helpers for scan and auth endpoints.
 * Extracted from inline validation in server.js route handlers.
 */

/**
 * Middleware: Validate that a scan request has a properly formatted URL.
 */
function validateScanRequest(req, res, next) {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ status: 'error', message: 'URL is required' });
    }

    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            return res.status(400).json({ status: 'error', message: 'Only http:// and https:// URLs are supported' });
        }
    } catch (e) {
        return res.status(400).json({ status: 'error', message: 'Invalid URL format' });
    }

    next();
}

/**
 * Middleware: Validate password change request body.
 */
function validatePasswordChange(req, res, next) {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
        return res.status(400).json({ status: 'error', message: 'Both current and new password are required' });
    }

    if (newPassword.length < 6) {
        return res.status(400).json({ status: 'error', message: 'New password must be at least 6 characters' });
    }

    next();
}

module.exports = { validateScanRequest, validatePasswordChange };
