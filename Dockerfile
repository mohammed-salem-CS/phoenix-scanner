# ============================================
# PHOENIX SCANNER — Production Dockerfile
# Node.js 18 + Python 3 + Security Tools
# ============================================

FROM node:18-slim

# ─── System Dependencies ────────────────────────────────────────────────────
# Install Python 3, pip, build essentials, and utilities needed by tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    build-essential \
    curl \
    wget \
    unzip \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Symlink python3 → python (some tools expect 'python')
RUN ln -sf /usr/bin/python3 /usr/bin/python

# ─── Install Go Security Tools (Linux AMD64 binaries) ────────────────────────
# These are the Linux equivalents of the Windows .exe tools used by the AI agents

# GAU — Get All URLs (Wayback Machine / OTX / Common Crawl)
RUN curl -sL https://github.com/lc/gau/releases/latest/download/gau_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin gau && chmod +x /usr/local/bin/gau

# Dalfox — XSS scanner
RUN curl -sL https://github.com/hahwul/dalfox/releases/latest/download/dalfox_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin dalfox && chmod +x /usr/local/bin/dalfox

# FFUF — Web fuzzer
RUN curl -sL https://github.com/ffuf/ffuf/releases/latest/download/ffuf_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin ffuf && chmod +x /usr/local/bin/ffuf

# kxss — XSS reflection checker
RUN curl -sL https://github.com/Emoe/kxss/releases/latest/download/kxss_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin kxss && chmod +x /usr/local/bin/kxss \
    || echo "kxss: will try go install fallback" \
    && (which kxss || true)

# Nuclei — Template-based scanner
RUN curl -sL https://github.com/projectdiscovery/nuclei/releases/latest/download/nuclei_linux_amd64.zip \
    -o /tmp/nuclei.zip \
    && unzip -o /tmp/nuclei.zip -d /usr/local/bin nuclei \
    && chmod +x /usr/local/bin/nuclei \
    && rm /tmp/nuclei.zip

# Interactsh-client — OOB interaction testing
RUN curl -sL https://github.com/projectdiscovery/interactsh/releases/latest/download/interactsh-client_linux_amd64.zip \
    -o /tmp/interactsh.zip \
    && unzip -o /tmp/interactsh.zip -d /usr/local/bin interactsh-client \
    && chmod +x /usr/local/bin/interactsh-client \
    && rm /tmp/interactsh.zip

# ─── Application Setup ──────────────────────────────────────────────────────
WORKDIR /app

# Copy backend package files and install Node.js dependencies
COPY backend/package*.json ./backend/
RUN cd backend && npm install --omit=dev

# Install Python dependencies for AI agents
COPY backend/ai_agents/requirements.txt ./backend/ai_agents/
RUN pip3 install --no-cache-dir --break-system-packages -r backend/ai_agents/requirements.txt

# Install Playwright browsers (used by crewai/AI agents)
RUN python3 -m playwright install --with-deps chromium || true

# ─── Copy Source Code ────────────────────────────────────────────────────────
# Copy backend source
COPY backend/ ./backend/

# Copy frontend static files (served by Express)
COPY frontend/ ./frontend/

# ─── Create temp directories ────────────────────────────────────────────────
RUN mkdir -p /app/backend/ai_agents/tmp

# ─── Environment Variables ──────────────────────────────────────────────────
ENV NODE_ENV=production
ENV PYTHON_EXE=python3
ENV PORT=3000

EXPOSE 3000

WORKDIR /app/backend

CMD ["node", "server.js"]
