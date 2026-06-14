#  Phoenix AI Security Platform

<div align="center">
  <p><strong>Next-Generation Automated Web Vulnerability Scanner</strong></p>
  <p>Identify security threats with advanced scanning technology, combining high-speed traditional script engines with intelligent LLM reasoning agents.</p>
</div>

---

##  Overview

**Phoenix** is a hybrid AI-powered web vulnerability scanner. It merges the speed and breadth of a traditional automated scanner with the contextual understanding of AI agents. Whether you want a quick check for common misconfigurations or a deep, AI-driven audit of your web application's security posture, Phoenix provides a comprehensive, unified platform.

##  Key Features

-  **Multi-Mode Scanning Engine:**
  - **Script Engine:** High-speed deep crawling, payload injection, and passive/active analysis.
  - **AI Agent Mode:** Deep reasoning audit utilizing CrewAI orchestration.
  - **Hybrid Mode:** Integrated automated discovery combined with AI confirmation for minimal false positives.
-  **Comprehensive Vulnerability Detection:**
  - **Injection Attacks:** SQLi, XSS (Reflected & Stored), Command Injection, LFI, Open Redirect.
  - **Misconfigurations:** Insecure CORS, Missing Security Headers, Insecure Cookies, SSL/TLS checks.
  - **Advanced Checks:** CSRF, Clickjacking, Directory Enumeration, Sensitive Information Disclosure.
-  **Professional Mode Configuration:**
  - Fine-grained vulnerability targeting (select specific vulnerabilities to scan for).
  - WAF Evasion Levels (None, Basic, Advanced) with customized payload encoding.
  - Configurable request rates to prevent server overload or detection.
-  **Rich Dashboard & Reporting:**
  - Real-time scan progress and socket-based live updates.
  - Downloadable PDF reports, JSON/CSV exports, and AI-generated summary reports.
  - Scan history and side-by-side comparative analysis of different scans.

##  Architecture & Tech Stack

Phoenix is built using a modern decoupled architecture:

- **Frontend:** Vanilla HTML5, CSS3, and JavaScript with Socket.IO for real-time updates and Chart.js for data visualization.
- **Backend:** Node.js & Express.js. Handles user authentication, socket communication, database interactions, and orchestrates the scanning engines (`scannerEngine.js`).
- **Database:** MongoDB (via Mongoose) to store user profiles, scan histories, and detailed vulnerability findings.
- **AI Engine:** Python-based multi-agent orchestration framework (CrewAI), utilizing the Google Gemini API (`@google/generative-ai` & `crewai[google-genai]`).
- **Security Tools:** Integrates powerful CLI security tools (like `dirsearch`, `nuclei`, `sqlmap`, etc.).

---

##  Getting Started

Follow these instructions to set up the project locally.

### Prerequisites

- **Node.js** (v18 or higher)
- **Python** (v3.10 or higher)
- **MongoDB** (running locally or a cloud instance)
- **Google Gemini API Key** (for AI agent functionality)

### 1. Clone the Repository
```bash
git clone https://github.com/your-username/phoenix-scanner.git
cd phoenix-scanner
```

### 2. Backend Setup
Navigate to the backend directory and install the Node.js dependencies:
```bash
cd backend
npm install
```

Create a `.env` file in the `backend/` directory:
```env
PORT=3000
MONGO_URI=mongodb://localhost:27017/phoenixDB
JWT_SECRET=your_super_secret_jwt_key
GEMINI_API_KEY=your_google_ai_key_here
```

### 3. AI Agents Setup (Python)
Navigate to the AI agents directory, create a virtual environment, and install dependencies:
```bash
cd backend/ai_agents
python -m venv venv

# On Windows:
venv\Scripts\activate
# On macOS/Linux:
source venv/bin/activate

pip install -r requirements.txt
```

### 4. Running the Application

1. **Ensure MongoDB is running** on your system.
2. **Start the Backend Server:**
   ```bash
   cd backend
   npm start
   # Or using node directly: node server.js
   ```
3. **Open the Frontend:**
   Simply open `frontend/index.html` in your favorite modern web browser. The frontend will communicate directly with the backend running on `http://localhost:3000`.

---

## 🐳 Docker Deployment

### Quick Start (Local Docker)

```bash
docker compose up --build -d
```
This spins up the Node.js backend + MongoDB. Open `http://localhost:3000` in your browser.

---

## 🚀 Deploying to Hostinger VPS (Ubuntu)

Full step-by-step guide to deploy Phoenix on a Hostinger VPS running Ubuntu.

### Prerequisites

- A **Hostinger VPS** running Ubuntu 22.04 or newer
- A **domain name** pointed to your VPS IP address (configured via Hostinger DNS)
- Your **Gemini API Key** (for AI features)
- A terminal/SSH client (e.g., Windows Terminal, PuTTY, or VS Code Remote SSH)

---

### Step 1 — Connect to Your VPS via SSH

```bash
ssh root@your-server-ip
```

> If this is your first time, Hostinger provides the SSH credentials in your VPS dashboard under **"SSH Access"**.

---

### Step 2 — Install Docker & Docker Compose

Run these commands to install Docker on Ubuntu:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh

# Add your user to the docker group (avoids needing sudo)
sudo usermod -aG docker $USER

# Apply group changes (or log out and back in)
newgrp docker

# Verify installation
docker --version
docker compose version
```

---

### Step 3 — Install Git and Clone the Project

```bash
# Install Git
sudo apt install git -y

# Clone the repository
cd /home
git clone https://github.com/your-username/phoenix-scanner.git
cd phoenix-scanner
```

> **Alternative:** If your repo is private, use SSH keys or a personal access token:
> ```bash
> git clone https://<TOKEN>@github.com/your-username/phoenix-scanner.git
> ```

---

### Step 4 — Create the Environment File

Create a `.env` file in the **project root** directory (this is read by Docker Compose):

```bash
nano .env
```

Paste the following and replace the placeholder values:

```env
JWT_SECRET=replace_with_a_strong_random_secret
GEMINI_API_KEY=your_actual_gemini_api_key
```

> **Tip:** Generate a strong JWT secret with: `openssl rand -hex 32`

Save and exit (`Ctrl+O`, `Enter`, `Ctrl+X`).

---

### Step 5 — Build and Start the Application

```bash
# Build the Docker image (first time takes ~5–10 minutes)
docker compose build

# Start all services in the background
docker compose up -d
```

Verify everything is running:

```bash
docker compose ps
```

You should see two containers running: `phoenix-backend` and `mongo`.

Check the logs to confirm successful startup:

```bash
docker compose logs phoenix-backend
```

Look for:
```
Connected to MongoDB
Server running on port 3000
```

---

### Step 6 — Configure Firewall

Allow traffic on port 3000:

```bash
sudo ufw allow 3000
sudo ufw allow OpenSSH
sudo ufw enable
```

---

### Step 7 — Access Your Application

Open your browser and navigate to:

```
http://your-domain.com:3000
```

Or using the VPS IP address:

```
http://your-server-ip:3000
```

You should see the Phoenix Scanner interface. Register an account and start scanning!

---

### Maintenance & Useful Commands

```bash
# View real-time logs
docker compose logs -f phoenix-backend

# Restart services
docker compose restart

# Stop all services
docker compose down

# Rebuild after code changes
cd /home/phoenix-scanner
git pull
docker compose up -d --build

# Access MongoDB shell
docker compose exec mongo mongosh phoenixDB

# Check disk usage
docker system df

# Clean up unused Docker resources
docker system prune -f
```

---

### Updating the Application

When you push new changes to your GitHub repository:

```bash
cd /home/phoenix-scanner
git pull origin main
docker compose up -d --build
```

---

### Troubleshooting

| Problem | Solution |
|---------|----------|
| **"Cannot connect to MongoDB"** | Check if mongo container is running: `docker compose ps` |
| **Page shows "Cannot GET /"** | The frontend files might not have copied. Rebuild: `docker compose up -d --build` |
| **AI scan fails** | Verify `GEMINI_API_KEY` is set correctly in `.env` |
| **Port 3000 not accessible** | Check firewall: `sudo ufw status` and ensure port 3000 is allowed |
| **Container keeps restarting** | Check logs: `docker compose logs phoenix-backend` |
| **"Module not found" errors** | Rebuild from scratch: `docker compose build --no-cache` |

##  Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

##  License

This project is licensed under the MIT License - see the LICENSE file for details.

---
*Disclaimer: This tool is intended for educational purposes and authorized security testing only. The developers assume no liability and are not responsible for any misuse or damage caused by this program.*
