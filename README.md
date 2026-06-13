# 🦅 Phoenix AI Security Platform

<div align="center">
  <p><strong>Next-Generation Automated Web Vulnerability Scanner</strong></p>
  <p>Identify security threats with advanced scanning technology, combining high-speed traditional script engines with intelligent LLM reasoning agents.</p>
</div>

---

## 📖 Overview

**Phoenix** is a hybrid AI-powered web vulnerability scanner. It merges the speed and breadth of a traditional automated scanner with the contextual understanding of AI agents. Whether you want a quick check for common misconfigurations or a deep, AI-driven audit of your web application's security posture, Phoenix provides a comprehensive, unified platform.

## ✨ Key Features

- 🛡️ **Multi-Mode Scanning Engine:**
  - **Script Engine:** High-speed deep crawling, payload injection, and passive/active analysis.
  - **AI Agent Mode:** Deep reasoning audit utilizing CrewAI orchestration.
  - **Hybrid Mode:** Integrated automated discovery combined with AI confirmation for minimal false positives.
- 🎯 **Comprehensive Vulnerability Detection:**
  - **Injection Attacks:** SQLi, XSS (Reflected & Stored), Command Injection, LFI, Open Redirect.
  - **Misconfigurations:** Insecure CORS, Missing Security Headers, Insecure Cookies, SSL/TLS checks.
  - **Advanced Checks:** CSRF, Clickjacking, Directory Enumeration, Sensitive Information Disclosure.
- ⚙️ **Professional Mode Configuration:**
  - Fine-grained vulnerability targeting (select specific vulnerabilities to scan for).
  - WAF Evasion Levels (None, Basic, Advanced) with customized payload encoding.
  - Configurable request rates to prevent server overload or detection.
- 📊 **Rich Dashboard & Reporting:**
  - Real-time scan progress and socket-based live updates.
  - Downloadable PDF reports, JSON/CSV exports, and AI-generated summary reports.
  - Scan history and side-by-side comparative analysis of different scans.

## 🏗️ Architecture & Tech Stack

Phoenix is built using a modern decoupled architecture:

- **Frontend:** Vanilla HTML5, CSS3, and JavaScript with Socket.IO for real-time updates and Chart.js for data visualization.
- **Backend:** Node.js & Express.js. Handles user authentication, socket communication, database interactions, and orchestrates the scanning engines (`scannerEngine.js`).
- **Database:** MongoDB (via Mongoose) to store user profiles, scan histories, and detailed vulnerability findings.
- **AI Engine:** Python-based multi-agent orchestration framework (CrewAI), utilizing the Google Gemini API (`@google/generative-ai` & `crewai[google-genai]`).
- **Security Tools:** Integrates powerful CLI security tools (like `dirsearch`, `nuclei`, `sqlmap`, etc.).

---

## 🚀 Getting Started

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
MONGODB_URI=mongodb://localhost:27017/phoenixDB
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

## 🐳 Docker Deployment (Optional)

Phoenix includes a `docker-compose.yml` for simplified deployment:
```bash
docker-compose up --build
```
This will spin up both the Node.js backend (on port `3000`) and a MongoDB instance automatically.

## 🤝 Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.
1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

---
*Disclaimer: This tool is intended for educational purposes and authorized security testing only. The developers assume no liability and are not responsible for any misuse or damage caused by this program.*
