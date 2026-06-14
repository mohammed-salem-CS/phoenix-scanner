/**
 * PHOENIX CONFIGURATION
 * 
 * Centralizes all environment variables, paths, and magic constants.
 * Every module reads from here instead of hardcoding values.
 */
require('dotenv').config();
const path = require('path');

// ─── Paths ──────────────────────────────────────────────────────────────────
const ROOT_DIR = path.resolve(__dirname, '..');
const AI_AGENTS_DIR = path.join(ROOT_DIR, 'ai_agents');
const TOOLS_DIR = path.join(ROOT_DIR, 'tools');

// ─── Server ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/phoenixDB';

// ─── Authentication ─────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'phoenix_secret_key_123';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '1h';
const BCRYPT_SALT_ROUNDS = 10;
const MIN_PASSWORD_LENGTH = 6;

// ─── AI / LLM ───────────────────────────────────────────────────────────────
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// ─── Python Bridge ──────────────────────────────────────────────────────────
const PYTHON_EXE = process.env.PYTHON_EXE
    || (process.platform === 'win32'
        ? path.join(AI_AGENTS_DIR, 'venv', 'Scripts', 'python.exe')
        : 'python3');
const SPECIALIZED_AGENTS_SCRIPT = path.join(AI_AGENTS_DIR, 'specialized_agents.py');

// ─── Dirsearch ──────────────────────────────────────────────────────────────
const DIRSEARCH_PATH = process.env.DIRSEARCH_PATH || path.join(TOOLS_DIR, 'dirsearch', 'dirsearch.py');

// ─── Scanner Defaults ───────────────────────────────────────────────────────
const VALID_SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Info'];
const VALID_SCAN_MODES = ['script', 'ai', 'hybrid'];

const SCAN_TIMEOUTS = {
    default: 8000,
    timeBased: 10000,
    page: 5000,
    long: 15000,
};

const CRAWLER_DEFAULTS = {
    maxDepth: 3,
    maxPages: 50,
    concurrency: 5,
    delayMs: 100,
};

const USER_AGENT = 'Phoenix/1.0 (Graduation Project)';

module.exports = {
    // Paths
    ROOT_DIR,
    AI_AGENTS_DIR,
    TOOLS_DIR,
    // Server
    PORT,
    MONGO_URI,
    // Auth
    JWT_SECRET,
    JWT_EXPIRY,
    BCRYPT_SALT_ROUNDS,
    MIN_PASSWORD_LENGTH,
    // AI
    GEMINI_API_KEY,
    // Python Bridge
    PYTHON_EXE,
    SPECIALIZED_AGENTS_SCRIPT,
    // Dirsearch
    DIRSEARCH_PATH,
    // Scanner
    VALID_SEVERITIES,
    VALID_SCAN_MODES,
    SCAN_TIMEOUTS,
    CRAWLER_DEFAULTS,
    USER_AGENT,
};
