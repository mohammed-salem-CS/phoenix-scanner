# Phoenix AI Security Platform — Project Documentation

## 1. Project Overview
Phoenix is a hybrid AI-powered vulnerability scanner that combines traditional high-performance security tools with advanced LLM reasoning agents (CrewAI).

---

## 2. Global Requirements & Dependencies

### Backend (Node.js)
The core server handles user authentication, scan management, and coordinates the AI agents.
- **Node.js**: v18+
- **Database**: MongoDB
- **Key Packages**:
  - `express`: Web framework
  - `mongoose`: MongoDB object modeling
  - `@google/generative-ai`: Direct Gemini API integration
  - `axios`, `cors`, `dotenv`, `bcryptjs`, `jsonwebtoken`

**Install Backend Dependencies:**
```bash
cd backend
npm install
```

### AI Agents (Python)
The scanning engine uses Python 3.10+ and a multi-agent orchestration framework.
- **Python**: v3.10+
- **Framework**: CrewAI
- **Key Packages**:
  - `crewai[google-genai]`: Agent orchestration and LLM support
  - `requests`: HTTP library
  - `beautifulsoup4`: HTML parsing
  - `playwright`: Headless browser support
  - `python-dotenv`: Environment management

**Install AI Dependencies:**
```bash
cd backend/ai_agents
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
```

### Security Tools (CLI Binaries)
The system relies on the following tools located in `backend/ai_agents/tools/`:
- **Discovery**: `katana`, `httpx`, `gau`
- **Scanners**: `nuclei`, `sqlmap`, `dalfox`, `ffuf`
- **Analysis**: `interactsh-client`, `arjun`, `kxss`

---

## 3. Configuration
1.  Create a `.env` file in the `backend/` directory.
2.  Add your API Keys:
    ```env
    PORT=3000
    MONGODB_URI=mongodb://localhost:27017/phoenix
    GEMINI_API_KEY=your_google_ai_key_here
    JWT_SECRET=your_random_secret_here
    ```

---

## 4. Running the Project
1.  **Start MongoDB** (if local).
2.  **Start the Backend**:
    ```bash
    cd backend
    node server.js
    ```
3.  **Access the Frontend**: Open `frontend/index.html` in any modern web browser.

---

## 5. Scanning Modes
- **Fast Scan**: Automated tool-only scan (Nuclei + HTTPX).
- **AI Scan**: Deep 8-agent reasoning audit.
- **Hybrid Mode**: Integrated tool discovery + AI confirmation pipeline.
