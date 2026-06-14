# ============================================
# PHOENIX SCANNER — Production Dockerfile
# Node.js 18 + Python 3 + Security Tools
# ============================================

FROM node:20-slim

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

# ─── Install Go Security Tools (Fixed URLs with Explicit Versions) ────────

# GAU — Get All URLs (v2.2.4)
RUN curl -sL https://github.com/lc/gau/releases/download/v2.2.4/gau_2.2.4_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin gau && chmod +x /usr/local/bin/gau

# Dalfox — XSS scanner (v2.9.2)
RUN curl -sL https://github.com/hahwul/dalfox/releases/download/v2.9.2/dalfox_2.9.2_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin dalfox && chmod +x /usr/local/bin/dalfox

# FFUF — Web fuzzer (v2.1.0)
RUN curl -sL https://github.com/ffuf/ffuf/releases/download/v2.1.0/ffuf_2.1.0_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin ffuf && chmod +x /usr/local/bin/ffuf

# kxss — XSS reflection checker (Maintained original fallback)
RUN curl -sL https://github.com/Emoe/kxss/releases/latest/download/kxss_linux_amd64.tar.gz \
    | tar xzf - -C /usr/local/bin kxss && chmod +x /usr/local/bin/kxss \
    || echo "kxss: will try go install fallback" \
    && (which kxss || true)

# Nuclei — Template-based scanner (v3.3.0)
RUN curl -sL https://github.com/projectdiscovery/nuclei/releases/download/v3.3.0/nuclei_3.3.0_linux_amd64.zip \
    -o /tmp/nuclei.zip \
    && unzip -o /tmp/nuclei.zip -d /usr/local/bin nuclei \
    && chmod +x /usr/local/bin/nuclei \
    && rm /tmp/nuclei.zip

# Interactsh-client — OOB interaction testing (v1.3.1)
RUN curl -sL https://github.com/projectdiscovery/interactsh/releases/download/v1.3.1/interactsh-client_1.3.1_linux_amd64.zip \
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
