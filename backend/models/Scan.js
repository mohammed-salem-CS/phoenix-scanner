const mongoose = require('mongoose');

const ScanSchema = new mongoose.Schema({
    user: {
        type: String,
        required: true,
        index: true
    },
    targetUrl: {
        type: String,
        required: true
    },
    timestamp: {
        type: Date,
        default: Date.now
    },
    vulnerabilities: [{
        type: { type: String },
        name: { type: String },
        severity: {
            type: String,
            enum: ['Critical', 'High', 'Medium', 'Low', 'Info']
        },
        location: { type: String },
        description: { type: String },
        evidence: { type: String }
    }],
    status: {
        type: String,
        enum: ['Completed', 'Failed', 'In Progress'],
        default: 'Completed'
    },
    duration: {
        type: String, // e.g., "1m 30s"
        default: "0s"
    },
    aiReport: {
        type: String,  // Cached AI-generated report (Markdown)
        default: null
    },
    scanMode: {
        type: String,
        enum: ['script', 'ai', 'hybrid'],
        default: 'script'
    },
    aiAnalysis: {
        type: String,  // Raw AI analysis from AI-mode scans
        default: null
    },
    crawlData: {
        endpoints: [{ type: String }],
        parameters: [{ type: String }],
        technologies: [{ type: String }]
    },
    agentLogs: {
        type: String, // Raw execution logs
        default: null
    }
});

module.exports = mongoose.model('Scan', ScanSchema);
