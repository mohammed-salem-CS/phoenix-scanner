/**
 * PHOENIX HISTORY ROUTES
 * 
 * GET    /history            - Get all scan history (with search/filter support)
 * GET    /history/compare    - Compare two scans side-by-side
 * GET    /history/:id        - Get single scan details
 * GET    /history/:id/export/:format - Export scan as JSON or CSV
 * DELETE /history/:id        - Delete a scan entry
 */
const express = require('express');
const router = express.Router();
const { auth } = require('../middleware/auth');
const Scan = require('../models/Scan');

// ─── Search & Filter History (Feature #4) ───────────────────────────────────
// GET /history?search=example&severity=High&scanMode=script&dateFrom=2026-01-01&dateTo=2026-12-31
router.get('/history', auth, async (req, res) => {
    try {
        const { search, severity, scanMode, dateFrom, dateTo } = req.query;

        // Base query: user's scans
        const query = { user: req.user.email };

        // Free-text search on targetUrl
        if (search) {
            query.targetUrl = { $regex: search, $options: 'i' };
        }

        // Filter by scan mode
        if (scanMode && ['script', 'ai', 'hybrid'].includes(scanMode)) {
            query.scanMode = scanMode;
        }

        // Filter by date range
        if (dateFrom || dateTo) {
            query.timestamp = {};
            if (dateFrom) query.timestamp.$gte = new Date(dateFrom);
            if (dateTo) {
                const endDate = new Date(dateTo);
                endDate.setHours(23, 59, 59, 999);
                query.timestamp.$lte = endDate;
            }
        }

        let scans = await Scan.find(query).sort({ timestamp: -1 });

        // Post-query filter by vulnerability severity (can't do nested array match simply)
        if (severity && ['Critical', 'High', 'Medium', 'Low', 'Info'].includes(severity)) {
            scans = scans.filter(scan =>
                scan.vulnerabilities.some(v => v.severity === severity)
            );
        }

        res.json({ status: 'success', data: scans });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Scan Comparison / Diff View (Feature #1) ──────────────────────────────
// GET /history/compare?scan1=<id1>&scan2=<id2>
router.get('/history/compare', auth, async (req, res) => {
    try {
        const { scan1, scan2 } = req.query;

        if (!scan1 || !scan2) {
            return res.status(400).json({
                status: 'error',
                message: 'Both scan1 and scan2 query parameters are required.'
            });
        }

        const [scanA, scanB] = await Promise.all([
            Scan.findOne({ _id: scan1, user: req.user.email }),
            Scan.findOne({ _id: scan2, user: req.user.email })
        ]);

        if (!scanA || !scanB) {
            return res.status(404).json({
                status: 'error',
                message: 'One or both scans not found.'
            });
        }

        // Build vulnerability maps for comparison
        const buildVulnKey = (v) => `${(v.type || '').toLowerCase()}|${(v.location || '').toLowerCase()}`;

        const vulnsA = new Map();
        scanA.vulnerabilities.forEach(v => {
            vulnsA.set(buildVulnKey(v), v);
        });

        const vulnsB = new Map();
        scanB.vulnerabilities.forEach(v => {
            vulnsB.set(buildVulnKey(v), v);
        });

        // Categorize vulnerabilities
        const newVulns = [];      // In scan2 but not in scan1 (newly discovered)
        const fixedVulns = [];    // In scan1 but not in scan2 (remediated)
        const persistentVulns = []; // In both scans (still present)

        // Find new and persistent
        for (const [key, vuln] of vulnsB) {
            if (vulnsA.has(key)) {
                persistentVulns.push({
                    ...vuln.toObject ? vuln.toObject() : vuln,
                    _oldSeverity: vulnsA.get(key).severity,
                    _newSeverity: vuln.severity
                });
            } else {
                newVulns.push(vuln);
            }
        }

        // Find fixed
        for (const [key, vuln] of vulnsA) {
            if (!vulnsB.has(key)) {
                fixedVulns.push(vuln);
            }
        }

        res.json({
            status: 'success',
            data: {
                scan1: {
                    _id: scanA._id,
                    targetUrl: scanA.targetUrl,
                    timestamp: scanA.timestamp,
                    scanMode: scanA.scanMode,
                    totalVulns: scanA.vulnerabilities.length
                },
                scan2: {
                    _id: scanB._id,
                    targetUrl: scanB.targetUrl,
                    timestamp: scanB.timestamp,
                    scanMode: scanB.scanMode,
                    totalVulns: scanB.vulnerabilities.length
                },
                comparison: {
                    newVulns,
                    fixedVulns,
                    persistentVulns,
                    summary: {
                        new: newVulns.length,
                        fixed: fixedVulns.length,
                        persistent: persistentVulns.length
                    }
                }
            }
        });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Get Single Scan Details (Protected) ────────────────────────────────────
router.get('/history/:id', auth, async (req, res) => {
    try {
        const scan = await Scan.findOne({ _id: req.params.id, user: req.user.email });
        if (!scan) {
            return res.status(404).json({ status: 'error', message: 'Scan not found' });
        }
        res.json({ status: 'success', data: scan });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Export Scan as JSON or CSV (Feature #11) ───────────────────────────────
// GET /history/:id/export/json  or  /history/:id/export/csv
router.get('/history/:id/export/:format', auth, async (req, res) => {
    try {
        const { format } = req.params;
        if (!['json', 'csv'].includes(format)) {
            return res.status(400).json({ status: 'error', message: 'Format must be json or csv' });
        }

        const scan = await Scan.findOne({ _id: req.params.id, user: req.user.email });
        if (!scan) {
            return res.status(404).json({ status: 'error', message: 'Scan not found' });
        }

        const safeName = scan.targetUrl.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
        const timestamp = new Date(scan.timestamp).toISOString().split('T')[0];

        if (format === 'json') {
            // JSON Export
            const exportData = {
                scanId: scan._id,
                targetUrl: scan.targetUrl,
                scanDate: scan.timestamp,
                scanMode: scan.scanMode,
                status: scan.status,
                duration: scan.duration,
                totalVulnerabilities: scan.vulnerabilities.length,
                vulnerabilities: scan.vulnerabilities.map(v => ({
                    type: v.type,
                    name: v.name,
                    severity: v.severity,
                    location: v.location,
                    description: v.description,
                    evidence: v.evidence
                })),
                crawlData: scan.crawlData || null
            };

            res.setHeader('Content-Disposition', `attachment; filename=phoenix_scan_${safeName}_${timestamp}.json`);
            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify(exportData, null, 2));

        } else {
            // CSV Export
            const headers = ['#', 'Type', 'Name', 'Severity', 'Location', 'Description', 'Evidence'];
            const escapeCSV = (field) => {
                const str = String(field || '').replace(/"/g, '""');
                return str.includes(',') || str.includes('"') || str.includes('\n')
                    ? `"${str}"` : str;
            };

            let csv = headers.join(',') + '\n';
            scan.vulnerabilities.forEach((v, i) => {
                csv += [
                    i + 1,
                    escapeCSV(v.type),
                    escapeCSV(v.name),
                    escapeCSV(v.severity),
                    escapeCSV(v.location),
                    escapeCSV(v.description),
                    escapeCSV(v.evidence)
                ].join(',') + '\n';
            });

            res.setHeader('Content-Disposition', `attachment; filename=phoenix_scan_${safeName}_${timestamp}.csv`);
            res.setHeader('Content-Type', 'text/csv');
            res.send(csv);
        }
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

// ─── Delete Scan History Entry (Protected) ──────────────────────────────────
router.delete('/history/:id', auth, async (req, res) => {
    try {
        const scan = await Scan.findOne({ _id: req.params.id, user: req.user.email });
        if (!scan) {
            return res.status(404).json({ status: 'error', message: 'Scan not found' });
        }
        await Scan.deleteOne({ _id: req.params.id });
        res.json({ status: 'success', message: 'Scan deleted successfully' });
    } catch (error) {
        res.status(500).json({ status: 'error', message: error.message });
    }
});

module.exports = router;
