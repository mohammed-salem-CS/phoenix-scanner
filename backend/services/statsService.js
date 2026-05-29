/**
 * PHOENIX STATS SERVICE
 * 
 * Dashboard and admin statistics computation.
 * Extracted from server.js route handlers.
 * Includes trend analysis for time-series charts (Feature #8).
 */
const Scan = require('../models/Scan');
const User = require('../models/User');

/**
 * Get dashboard stats for a specific user.
 * 
 * @param {string} userEmail - User's email address
 * @returns {Promise<object>}
 */
async function getUserDashboardStats(userEmail) {
    const scans = await Scan.find({ user: userEmail });

    const totalScans = scans.length;
    let highVulns = 0;
    let mediumVulns = 0;
    let criticalVulns = 0;

    scans.forEach(scan => {
        scan.vulnerabilities.forEach(v => {
            if (v.severity === 'Critical') criticalVulns++;
            if (v.severity === 'High') highVulns++;
            if (v.severity === 'Medium') mediumVulns++;
        });
    });

    // Unique sites monitored (safe URL parsing)
    const uniqueSites = new Set(scans.map(s => {
        try { return new URL(s.targetUrl).hostname; }
        catch { return s.targetUrl; }
    })).size;

    return { totalScans, uniqueSites, criticalVulns, highVulns, mediumVulns };
}

/**
 * Get vulnerability trends over time for a specific user.
 * Aggregates scan data by date, returning counts per severity level.
 * 
 * @param {string} userEmail - User's email address
 * @param {number} days      - Number of days to look back (default 30)
 * @returns {Promise<object>} - { labels: string[], datasets: { critical, high, medium, low } }
 */
async function getVulnerabilityTrends(userEmail, days = 30) {
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);
    startDate.setHours(0, 0, 0, 0);

    const scans = await Scan.find({
        user: userEmail,
        timestamp: { $gte: startDate }
    }).sort({ timestamp: 1 });

    // Build a date → severity counts map
    const dateMap = new Map();

    // Pre-fill all dates in the range
    for (let d = new Date(startDate); d <= new Date(); d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        dateMap.set(dateStr, { critical: 0, high: 0, medium: 0, low: 0, total: 0 });
    }

    // Aggregate vulnerability counts per scan date
    scans.forEach(scan => {
        const dateStr = new Date(scan.timestamp).toISOString().split('T')[0];
        const entry = dateMap.get(dateStr);
        if (!entry) return;

        scan.vulnerabilities.forEach(v => {
            entry.total++;
            switch (v.severity) {
                case 'Critical': entry.critical++; break;
                case 'High': entry.high++; break;
                case 'Medium': entry.medium++; break;
                case 'Low': case 'Info': entry.low++; break;
            }
        });
    });

    // Convert to arrays for Chart.js
    const labels = [];
    const critical = [];
    const high = [];
    const medium = [];
    const low = [];
    const total = [];

    for (const [date, counts] of dateMap) {
        labels.push(date);
        critical.push(counts.critical);
        high.push(counts.high);
        medium.push(counts.medium);
        low.push(counts.low);
        total.push(counts.total);
    }

    return { labels, datasets: { critical, high, medium, low, total } };
}

/**
 * Get system-wide admin stats.
 * 
 * @returns {Promise<{totalUsers: number, totalScans: number}>}
 */
async function getAdminSystemStats() {
    const totalUsers = await User.countDocuments();
    const totalScans = await Scan.countDocuments();
    return { totalUsers, totalScans };
}

/**
 * Get all users (admin view).
 * 
 * @returns {Promise<Array>}
 */
async function getAllUsers() {
    return User.find().select('-password').sort({ createdAt: -1 });
}

module.exports = { getUserDashboardStats, getVulnerabilityTrends, getAdminSystemStats, getAllUsers };
