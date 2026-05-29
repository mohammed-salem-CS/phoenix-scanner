/**
 * PHOENIX AUTH SERVICE
 * 
 * Handles user registration, login, and password management.
 * Contains business logic extracted from server.js route handlers.
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { JWT_SECRET, JWT_EXPIRY, BCRYPT_SALT_ROUNDS } = require('../config');

/**
 * Register a new user account.
 * 
 * @param {string} email    - User email address
 * @param {string} password - Plain text password
 * @returns {Promise<{status: string, message: string}>}
 * @throws {Error} If email already exists
 */
async function registerUser(email, password) {
    const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
    const hashedPassword = await bcrypt.hash(password, salt);

    const newUser = new User({ email, password: hashedPassword });
    await newUser.save();

    return { status: 'success', message: 'Account created successfully!' };
}

/**
 * Authenticate a user and return a JWT token.
 * 
 * @param {string} email    - User email address
 * @param {string} password - Plain text password
 * @returns {Promise<{status: string, message: string, token: string, user: string, role: string}>}
 * @throws {Error} If credentials are invalid
 */
async function loginUser(email, password) {
    const user = await User.findOne({ email });

    if (!user) {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }

    const isMatch = await bcrypt.compare(password, user.password);

    if (!isMatch) {
        const err = new Error('Invalid credentials');
        err.statusCode = 401;
        throw err;
    }

    const token = jwt.sign(
        { id: user._id, email: user.email, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY }
    );

    return {
        status: 'success',
        message: 'Login successful',
        token,
        user: user.email,
        role: user.role,
    };
}

/**
 * Change a user's password.
 * 
 * @param {string} userId          - MongoDB user ID
 * @param {string} currentPassword - Current plain text password
 * @param {string} newPassword     - New plain text password
 * @returns {Promise<{status: string, message: string}>}
 * @throws {Error} If current password is incorrect
 */
async function changePassword(userId, currentPassword, newPassword) {
    const user = await User.findById(userId);
    const isMatch = await bcrypt.compare(currentPassword, user.password);

    if (!isMatch) {
        const err = new Error('Current password is incorrect');
        err.statusCode = 401;
        throw err;
    }

    const salt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
    user.password = await bcrypt.hash(newPassword, salt);
    await user.save();

    return { status: 'success', message: 'Password changed successfully' };
}

/**
 * Get user profile info.
 * 
 * @param {string} userId - MongoDB user ID
 * @returns {Promise<object>}
 */
async function getUserProfile(userId) {
    const Scan = require('../models/Scan');
    const user = await User.findById(userId).select('-password');
    const scanCount = await Scan.countDocuments({ user: user.email });

    return {
        email: user.email,
        role: user.role,
        createdAt: user.createdAt,
        scanCount,
    };
}

module.exports = { registerUser, loginUser, changePassword, getUserProfile };
