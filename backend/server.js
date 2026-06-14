/**
 * PHOENIX SERVER — Application Bootstrap
 * 
 * Responsibilities: Express initialization, middleware registration, route mounting,
 * database connection, Socket.IO setup, and server startup.
 * 
 * All business logic lives in:
 *   - services/    — Domain logic (auth, scans, stats, reports)
 *   - middleware/   — Request pipeline (auth, validation)
 *   - routes/       — HTTP route definitions
 *   - config/       — Environment & constants
 */
const express = require('express');
const http = require('http');
const path = require('path');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const { Server } = require('socket.io');

const { PORT, MONGO_URI } = require('./config');

// ─── Route Modules ──────────────────────────────────────────────────────────
const authRoutes = require('./routes/authRoutes');
const scanRoutes = require('./routes/scanRoutes');
const historyRoutes = require('./routes/historyRoutes');
const userRoutes = require('./routes/userRoutes');
const adminRoutes = require('./routes/adminRoutes');
const reportRoutes = require('./routes/reportRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');

// ─── App Initialization ─────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// ─── Socket.IO Setup ────────────────────────────────────────────────────────
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Make io accessible to routes via app.locals
app.locals.io = io;

io.on('connection', (socket) => {
    console.log(`[Socket.IO] Client connected: ${socket.id}`);
    socket.on('disconnect', () => {
        console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
    });
});

app.use(cors());
app.use(bodyParser.json());

// ─── Database Connection ────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
    .then(() => console.log("Connected to MongoDB"))
    .catch(err => console.error("Could not connect to MongoDB", err));

// ─── Mount Routes ───────────────────────────────────────────────────────────
app.use(authRoutes);       // POST /register, POST /login
app.use(scanRoutes);       // POST /scan, POST /cancel-scan, GET /scan/:id/download-logs
app.use(historyRoutes);    // GET /history, GET /history/:id, DELETE /history/:id, GET /history/compare, GET /history/:id/export/:format
app.use(userRoutes);       // GET /me, PUT /change-password
app.use(adminRoutes);      // GET /admin/system-stats, GET /admin/users
app.use(reportRoutes);     // POST /generate-ai-report
app.use(dashboardRoutes);  // GET /dashboard-stats, GET /dashboard-trends

// ─── Serve Frontend Static Files ────────────────────────────────────────────
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Catch-all: serve index.html for any non-API route (SPA support)
app.get(/.*/, (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

// ─── Start Server ───────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});