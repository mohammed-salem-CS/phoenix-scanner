// =============================================
//  PHOENIX SCANNER — Enhanced Frontend Logic
// =============================================

// -----------------------------------------------
// 0a. Socket.IO Real-Time Connection (Feature #2)
// -----------------------------------------------
let phoenixSocket = null;
let _scanProgressHighWaterMark = 0; // Tracks the highest progress value to prevent regression

function initSocket() {
    if (phoenixSocket) return phoenixSocket;
    try {
        phoenixSocket = io('http://localhost:3000', { transports: ['websocket', 'polling'] });
        phoenixSocket.on('connect', () => {
            console.log('[Phoenix] Socket.IO connected:', phoenixSocket.id);
        });
        phoenixSocket.on('disconnect', () => {
            console.log('[Phoenix] Socket.IO disconnected');
        });
        // Real-time scan progress handler
        // Only updates the UI if the incoming percent is HIGHER than the current value
        // to prevent the progress bar from jumping backwards when the local animation
        // is ahead of the backend's reported progress.
        phoenixSocket.on('scan:progress', (data) => {
            const progressBar = document.getElementById('progressBar');
            const percentText = document.getElementById('percentText');
            const statusText = document.getElementById('statusText');

            if (progressBar && data.percent !== undefined) {
                // Enforce monotonically increasing progress
                if (data.percent > _scanProgressHighWaterMark) {
                    _scanProgressHighWaterMark = data.percent;
                    progressBar.style.width = data.percent + '%';
                    percentText.innerText = Math.round(data.percent) + '%';

                    // Sync the local animation tracker so it doesn't fall behind
                    if (typeof window._scanLocalProgress !== 'undefined') {
                        window._scanLocalProgress = Math.max(window._scanLocalProgress, data.percent);
                    }
                }
            }
            // Always update status text from backend (more accurate phase info)
            if (statusText && data.message) {
                statusText.innerText = data.message;
            }
        });
    } catch (e) {
        console.warn('[Phoenix] Socket.IO unavailable:', e.message);
    }
    return phoenixSocket;
}

// -----------------------------------------------
// 0. Toast Notification System (replaces alert())
// -----------------------------------------------
function showToast(message, type = 'info', duration = 4000) {
    const container = document.getElementById('toastContainer');
    if (!container) return;

    const icons = {
        success: 'fa-check',
        error: 'fa-xmark',
        warning: 'fa-triangle-exclamation',
        info: 'fa-circle-info'
    };

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `
        <div class="toast-icon"><i class="fas ${icons[type] || icons.info}"></i></div>
        <span>${message}</span>
        <button class="toast-close" onclick="dismissToast(this.parentElement)">
            <i class="fas fa-times"></i>
        </button>
    `;

    container.appendChild(toast);

    // Auto dismiss
    const timer = setTimeout(() => dismissToast(toast), duration);
    toast._timer = timer;
}

function dismissToast(toast) {
    if (!toast || toast._dismissed) return;
    toast._dismissed = true;
    clearTimeout(toast._timer);
    toast.classList.add('toast-exit');
    setTimeout(() => toast.remove(), 300);
}


// -----------------------------------------------
// 1. Navigation Logic
// -----------------------------------------------
function switchView(viewName) {
    const sections = document.querySelectorAll('.view-section');
    sections.forEach(section => section.classList.remove('active'));

    const target = document.getElementById('view-' + viewName);
    if (target) target.classList.add('active');

    const navLinks = document.querySelectorAll('.navbar .nav-links a');
    navLinks.forEach(link => link.classList.remove('active'));

    let activeLink = document.getElementById('nav-' + viewName);
    if (!activeLink && viewName === 'login') {
        activeLink = document.getElementById('nav-account');
    }
    if (activeLink) activeLink.classList.add('active');

    // Close mobile menu on navigation
    const navLinksContainer = document.querySelector('.nav-links');
    if (navLinksContainer) navLinksContainer.classList.remove('open');

    // Trigger Data Load
    if (viewName === 'dashboard') loadDashboardData();
    if (viewName === 'history') loadHistoryData();
    if (viewName === 'account') {
        const token = localStorage.getItem('phoenix_token');
        if (!token) {
            switchView('login');
            return;
        }
        loadAccountData();
    }
    if (viewName === 'admin') loadAdminData();
}

// Mobile Hamburger Menu Toggle
function toggleMobileMenu() {
    const navLinks = document.querySelector('.nav-links');
    navLinks.classList.toggle('open');
}


// -----------------------------------------------
// 2. Scan Mode Selection
// -----------------------------------------------
let selectedScanMode = 'script'; // Default

function setScanMode(mode) {
    selectedScanMode = mode;
    document.querySelectorAll('.scan-mode-btn').forEach(btn => btn.classList.remove('active'));
    if (mode === 'ai') {
        document.getElementById('modeAI').classList.add('active');
    } else if (mode === 'hybrid') {
        document.getElementById('modeHybrid').classList.add('active');
    } else {
        document.getElementById('modeScript').classList.add('active');
    }
}

function toggleAdvancedOptions() {
    const el = document.getElementById('advancedOptions');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// -----------------------------------------------
// 3. Scan Logic with Smooth Progress Bar
// -----------------------------------------------
async function startScan() {
    const url = document.getElementById('scanUrl').value.trim();
    const targetUsername = document.getElementById('targetUsername')?.value.trim();
    const targetPassword = document.getElementById('targetPassword')?.value.trim();

    if (!url) {
        showToast("Please enter a URL to scan.", "warning");
        return;
    }

    // URL Validation
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
            showToast("Invalid URL: Only http:// and https:// URLs are supported.", "error");
            return;
        }
    } catch (e) {
        showToast("Invalid URL format. Please enter a valid URL (e.g., http://example.com)", "error");
        return;
    }

    const progressArea = document.getElementById('progressArea');
    const progressBar = document.getElementById('progressBar');
    const percentText = document.getElementById('percentText');
    const statusText = document.getElementById('statusText');
    const resultsArea = document.getElementById('resultsArea');
    const tbody = document.querySelector('#resultsArea table tbody');

    progressArea.style.display = 'block';
    resultsArea.style.display = 'none';
    tbody.innerHTML = "";

    // Toggle buttons
    document.getElementById('startScanBtn').style.display = 'none';
    document.getElementById('cancelScanBtn').style.display = 'inline-block';

    // Reset progress bar to 0%
    progressBar.style.width = '0%';
    percentText.innerText = '0%';
    statusText.innerText = selectedScanMode === 'ai'
        ? 'Initializing Phoenix AI Agent...'
        : selectedScanMode === 'hybrid'
            ? 'Initializing Phoenix Hybrid Scanner...'
            : 'Initializing Phoenix Engine...';

    // Reset progress tracking for this scan
    _scanProgressHighWaterMark = 0;
    window._scanLocalProgress = 0;

    const modeLabel = selectedScanMode === 'ai' ? '🤖 AI Agent' : selectedScanMode === 'hybrid' ? '⚛️ Hybrid' : '⚡ Script Engine';
    showToast(`${modeLabel} scan initiated for ${url}`, 'info', 3000);

    // Smooth progress animation — different messages per mode
    let currentProgress = 0;
    const statusMessages = selectedScanMode === 'ai'
        ? [
            { at: 5, text: 'Connecting to target server...' },
            { at: 12, text: 'Fetching page content & headers...' },
            { at: 22, text: 'Extracting forms, links & scripts...' },
            { at: 35, text: 'Sending data to Gemini AI for analysis...' },
            { at: 50, text: 'AI is analyzing security headers...' },
            { at: 60, text: 'AI is checking for injection points...' },
            { at: 70, text: 'AI is evaluating information disclosure...' },
            { at: 78, text: 'AI is assessing overall security posture...' },
            { at: 83, text: 'Compiling AI findings...' },
        ]
        : selectedScanMode === 'hybrid'
            ? [
                { at: 3, text: 'Starting deep crawler...' },
                { at: 8, text: 'Crawling website pages...' },
                { at: 15, text: 'Discovering forms & parameters...' },
                { at: 25, text: 'Collecting data from crawled pages...' },
                { at: 35, text: 'Crawl complete. Preparing data for AI...' },
                { at: 42, text: 'Sending crawled data to Gemini AI...' },
                { at: 52, text: 'AI is analyzing all pages for vulnerabilities...' },
                { at: 62, text: 'AI is evaluating forms for stored XSS...' },
                { at: 70, text: 'AI is checking for stored SQL injection...' },
                { at: 78, text: 'AI is analyzing second-order injection risks...' },
                { at: 83, text: 'Compiling hybrid findings...' },
            ]
            : [
                { at: 5, text: 'Connecting to target server...' },
                { at: 10, text: 'Fetching initial page...' },
                { at: 15, text: 'Analyzing security headers...' },
                { at: 20, text: 'Checking CORS & clickjacking...' },
                { at: 28, text: 'Enumerating directories...' },
                { at: 35, text: 'Deep crawling discovered pages...' },
                { at: 45, text: 'Discovering forms & parameters...' },
                { at: 55, text: 'Running reflected attack suite...' },
                { at: 65, text: 'Testing SQL injection vectors...' },
                { at: 72, text: 'Testing XSS payloads...' },
                { at: 78, text: 'Scanning for stored vulnerabilities...' },
                { at: 83, text: 'Verifying stored payloads on display pages...' },
            ];

    const progressInterval = setInterval(() => {
        if (currentProgress < 85) {
            const increment = currentProgress < 30 ? 0.8 : currentProgress < 60 ? 0.5 : 0.3;
            currentProgress = Math.min(85, currentProgress + increment);

            // Sync with any Socket.IO updates that may have jumped ahead
            currentProgress = Math.max(currentProgress, window._scanLocalProgress || 0);
            window._scanLocalProgress = currentProgress;

            const rounded = Math.round(currentProgress);

            // Only update DOM if this is actually higher than what's displayed
            if (rounded > _scanProgressHighWaterMark) {
                _scanProgressHighWaterMark = rounded;
                progressBar.style.width = rounded + '%';
                percentText.innerText = rounded + '%';
            }

            for (const msg of statusMessages) {
                if (rounded >= msg.at && rounded < msg.at + 3) {
                    statusText.innerText = msg.text;
                }
            }
        }
    }, 500);

    try {
        const token = localStorage.getItem('phoenix_token');
        if (!token) {
            clearInterval(progressInterval);
            showToast('Please login first to perform a scan.', 'warning');
            switchView('login');
            return;
        }

        // Initialize Socket.IO for real-time progress (Feature #2)
        const socket = initSocket();
        const socketId = socket && socket.connected ? socket.id : null;

        const response = await fetch('http://localhost:3000/scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ 
                url: url, 
                scanMode: selectedScanMode, 
                targetUsername: targetUsername,
                targetPassword: targetPassword,
                socketId: socketId
            })
        });

        const result = await response.json();

        // Stop the animation and snap to 100%
        clearInterval(progressInterval);
        progressBar.style.width = '100%';
        percentText.innerText = '100%';
        statusText.innerText = "Analysis Complete!";

        // Revert buttons
        document.getElementById('startScanBtn').style.display = 'inline-block';
        document.getElementById('cancelScanBtn').style.display = 'none';

        if (result.status === 'canceled') {
            // Scan was canceled by user
            progressBar.style.width = '0%';
            percentText.innerText = '0%';
            statusText.innerText = 'Scan canceled.';
            progressContainer.style.display = 'none';
            showToast('Scan was successfully canceled.', 'info', 4000);

        } else if (result.status === 'success') {
            const report = result.data;

            // Store scan ID for AI report generation
            window._lastScanId = result.scanId || null;

            // Update scan result summary cards
            let critCount = 0, highCount = 0, medCount = 0;
            report.vulnerabilities.forEach(vuln => {
                if (vuln.severity === 'Critical') critCount++;
                if (vuln.severity === 'High') highCount++;
                if (vuln.severity === 'Medium') medCount++;

                // Determine color based on severity
                let bgColor, textColor;
                switch (vuln.severity) {
                    case 'Critical': bgColor = '#FDE2E2'; textColor = '#991B1B'; break;
                    case 'High': bgColor = '#FEE2E2'; textColor = '#EF4444'; break;
                    case 'Medium': bgColor = '#FEF3C7'; textColor = '#D97706'; break;
                    case 'Low': bgColor = '#E0E7FF'; textColor = '#4338CA'; break;
                    default: bgColor = '#F3F4F6'; textColor = '#6B7280'; break;
                }

                const locationHtml = formatLocationAsUrl(vuln.location);
                const evidenceHtml = vuln.evidence
                    ? `<div class="evidence-block"><i class="fas fa-fingerprint evidence-icon"></i>${escapeHtml(vuln.evidence).replace(/\n/g, '<br>')}</div>`
                    : '<span style="color:#9CA3AF;">—</span>';
                const vulnNameHtml = buildVulnNameLink(vuln.type, vuln.name, vuln.severity);
                const row = `
                    <tr>
                        <td>${vulnNameHtml}</td>
                        <td><span class="status-badge" style="background:${bgColor}; color:${textColor}">${vuln.severity}</span></td>
                        <td>${locationHtml}</td>
                        <td>${evidenceHtml}</td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });

            // Update result summary counts (Critical, High, Medium)
            const countElements = resultsArea.querySelectorAll('.stat-card .count');
            if (countElements.length >= 3) {
                animateCount(countElements[0], critCount);
                animateCount(countElements[1], highCount);
                animateCount(countElements[2], medCount);
            }

            setTimeout(() => {
                resultsArea.style.display = 'block';
                resultsArea.scrollIntoView({ behavior: 'smooth' });
            }, 500);

            const totalVulns = report.vulnerabilities.length;
            if (totalVulns > 0) {
                showToast(`Scan complete! ${totalVulns} vulnerabilities discovered.`, critCount > 0 ? 'error' : 'warning', 5000);
            } else {
                showToast("Scan complete! No vulnerabilities found.", "success", 5000);
            }

            // Refresh dashboard data in background so it's ready
            loadDashboardData();

        } else {
            showToast("Scan Failed: " + result.message, "error");
        }

    } catch (error) {
        clearInterval(progressInterval);
        console.error(error);
        progressBar.style.width = '100%';
        percentText.innerText = 'Error';
        statusText.innerText = "Scan failed!";
        showToast("Server Error: Make sure Backend is running!", "error", 6000);

        // Revert buttons
        document.getElementById('startScanBtn').style.display = 'inline-block';
        document.getElementById('cancelScanBtn').style.display = 'none';
    }
}

async function cancelScan() {
    const url = document.getElementById('scanUrl').value.trim();
    if (!url) return;

    try {
        const token = localStorage.getItem('phoenix_token');
        const response = await fetch('http://localhost:3000/cancel-scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ url: url })
        });
        const result = await response.json();
        
        if (result.status === 'success') {
            showToast('Scan cancelation requested...', 'info');
        } else {
            showToast('Could not cancel scan: ' + result.message, 'warning');
        }
    } catch (error) {
        console.error("Cancel scan error", error);
        showToast('Error trying to cancel scan.', 'error');
    }
}

// Animate counting up numbers
function animateCount(element, target) {
    let current = 0;
    const step = Math.max(1, Math.ceil(target / 20));
    const interval = setInterval(() => {
        current += step;
        if (current >= target) {
            current = target;
            clearInterval(interval);
        }
        element.innerText = current;
    }, 40);
}


// -----------------------------------------------
// 3. Login Logic
// -----------------------------------------------
document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;

    try {
        const response = await fetch('http://localhost:3000/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });

        const data = await response.json();

        if (data.status === 'success') {
            // Store Token
            localStorage.setItem('phoenix_token', data.token);
            localStorage.setItem('phoenix_user', data.user);
            localStorage.setItem('phoenix_role', data.role);

            // Update UI to logged-in state
            updateNavForLoggedIn(data.user, data.role);

            showToast('Login Successful! Welcome ' + data.user, 'success');
            switchView('home');
        } else {
            showToast('Login Failed: ' + data.message, 'error');
        }
    } catch (error) {
        console.error('Error:', error);
        showToast('Could not connect to server. Make sure "node server.js" is running.', 'error', 6000);
    }
});


// -----------------------------------------------
// 4. Logout Function
// -----------------------------------------------
function logout() {
    localStorage.removeItem('phoenix_token');
    localStorage.removeItem('phoenix_user');
    localStorage.removeItem('phoenix_role');

    // Reset nav to logged-out state
    updateNavForLoggedOut();

    // Clear form fields
    document.getElementById('profileEmail').value = "";
    document.getElementById('loginEmail').value = "";
    document.getElementById('loginPassword').value = "";

    showToast("You have been logged out.", "info");
    switchView('login');
}


// -----------------------------------------------
// Nav State Helpers
// -----------------------------------------------
function updateNavForLoggedIn(email, role) {
    const navAccount = document.getElementById('nav-account');
    const navLogout = document.getElementById('nav-logout');
    const navAdmin = document.getElementById('nav-admin');

    navAccount.innerHTML = `<i class="fas fa-user-circle"></i> ${email}`;
    navAccount.setAttribute('onclick', "switchView('account')");
    if (navLogout) navLogout.style.display = 'inline';
    if (role === 'admin' && navAdmin) navAdmin.style.display = 'inline';
}

function updateNavForLoggedOut() {
    const navAccount = document.getElementById('nav-account');
    const navLogout = document.getElementById('nav-logout');
    const navAdmin = document.getElementById('nav-admin');

    navAccount.innerHTML = `<i class="fas fa-user-circle"></i> Account / Login`;
    navAccount.setAttribute('onclick', "switchView('login')");
    if (navLogout) navLogout.style.display = 'none';
    if (navAdmin) navAdmin.style.display = 'none';
}


// -----------------------------------------------
// 5. Dashboard Data & Chart
// -----------------------------------------------
let vulnerabilityChart = null;

async function loadDashboardData() {
    try {
        const token = localStorage.getItem('phoenix_token');
        if (!token) return;

        const response = await fetch('http://localhost:3000/dashboard-stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status === 'success') {
            const stats = result.data;

            // Update Stats Cards (Sites, Critical, High, Medium)
            const dashCards = document.querySelectorAll('#view-dashboard .stat-card .number');
            if (dashCards.length >= 4) {
                dashCards[0].innerText = stats.uniqueSites;
                dashCards[1].innerText = stats.criticalVulns || 0;
                dashCards[2].innerText = stats.highVulns;
                dashCards[3].innerText = stats.mediumVulns;
            }

            // Render Chart — now uses trend data instead of doughnut
            renderChart(stats);
            loadTrendChart(30); // Load 30-day trend chart (Feature #8)
        }
    } catch (error) {
        console.error("Failed to load dashboard data", error);
    }
}

function renderChart(stats) {
    // Legacy doughnut — now replaced by trend chart (Feature #8)
    // Keep this as a no-op so the initial loadDashboardData call doesn't break
}

// -----------------------------------------------
// 5b. Trend Chart (Feature #8)
// -----------------------------------------------
let trendChart = null;

async function loadTrendChart(days = 30) {
    try {
        const token = localStorage.getItem('phoenix_token');
        if (!token) return;

        // Update period selector buttons
        document.querySelectorAll('.trend-period-btn').forEach(btn => {
            btn.classList.toggle('active', parseInt(btn.dataset.days) === days);
        });

        const response = await fetch(`http://localhost:3000/dashboard-trends?days=${days}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status !== 'success') return;

        const { labels, datasets } = result.data;

        const ctx = document.getElementById('vulnChart');
        if (!ctx) return;

        if (trendChart) trendChart.destroy();

        // Format labels as shorter dates
        const formattedLabels = labels.map(d => {
            const date = new Date(d);
            return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });

        const isDark = document.body.classList.contains('dark-mode');
        const gridColor = isDark ? 'rgba(249,115,22,0.08)' : 'rgba(0,0,0,0.06)';
        const textColor = isDark ? '#A8A29E' : '#6B7280';

        trendChart = new Chart(ctx, {
            type: 'line',
            data: {
                labels: formattedLabels,
                datasets: [
                    {
                        label: 'Critical',
                        data: datasets.critical,
                        borderColor: '#991B1B',
                        backgroundColor: 'rgba(153, 27, 27, 0.1)',
                        borderWidth: 2.5,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#991B1B',
                    },
                    {
                        label: 'High',
                        data: datasets.high,
                        borderColor: '#EF4444',
                        backgroundColor: 'rgba(239, 68, 68, 0.08)',
                        borderWidth: 2.5,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#EF4444',
                    },
                    {
                        label: 'Medium',
                        data: datasets.medium,
                        borderColor: '#F59E0B',
                        backgroundColor: 'rgba(245, 158, 11, 0.08)',
                        borderWidth: 2.5,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 3,
                        pointHoverRadius: 6,
                        pointBackgroundColor: '#F59E0B',
                    },
                    {
                        label: 'Low / Info',
                        data: datasets.low,
                        borderColor: '#3B82F6',
                        backgroundColor: 'rgba(59, 130, 246, 0.06)',
                        borderWidth: 2,
                        tension: 0.4,
                        fill: true,
                        pointRadius: 2,
                        pointHoverRadius: 5,
                        pointBackgroundColor: '#3B82F6',
                        borderDash: [5, 3],
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    mode: 'index',
                    intersect: false,
                },
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            padding: 20,
                            usePointStyle: true,
                            pointStyleWidth: 12,
                            font: {
                                family: "'Poppins', sans-serif",
                                size: 12
                            },
                            color: textColor
                        }
                    },
                    tooltip: {
                        backgroundColor: isDark ? '#1C1917' : '#1F2937',
                        titleFont: { family: "'Poppins', sans-serif", weight: '600' },
                        bodyFont: { family: "'Poppins', sans-serif" },
                        padding: 12,
                        cornerRadius: 10,
                        displayColors: true,
                    }
                },
                scales: {
                    x: {
                        grid: { color: gridColor, drawBorder: false },
                        ticks: {
                            color: textColor,
                            font: { family: "'Poppins', sans-serif", size: 11 },
                            maxTicksLimit: 10,
                        }
                    },
                    y: {
                        beginAtZero: true,
                        grid: { color: gridColor, drawBorder: false },
                        ticks: {
                            color: textColor,
                            font: { family: "'Poppins', sans-serif", size: 11 },
                            stepSize: 1,
                        }
                    }
                },
                animation: {
                    duration: 800,
                    easing: 'easeOutQuart'
                }
            }
        });
    } catch (error) {
        console.error("Failed to load trend chart", error);
    }
}


// -----------------------------------------------
// 6. Scan History Logic (with Filter & Compare support)
// -----------------------------------------------
let compareSelection = []; // Track selected scan IDs for comparison

async function loadHistoryData(filters = {}) {
    const tbody = document.querySelector('#view-history table tbody');
    tbody.innerHTML = `
        <tr>
            <td colspan="7" style="text-align:center; padding:2rem;">
                <i class="fas fa-spinner fa-spin" style="color:var(--primary-orange); font-size:1.2rem;"></i>
                <span style="margin-left:8px;">Loading scan history...</span>
            </td>
        </tr>`;

    try {
        const token = localStorage.getItem('phoenix_token');
        if (!token) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="7" class="empty-state">
                        <i class="fas fa-lock"></i>
                        <p>Please login to view scan history.</p>
                    </td>
                </tr>`;
            return;
        }

        // Build query string from filters (Feature #4)
        const params = new URLSearchParams();
        if (filters.search) params.set('search', filters.search);
        if (filters.severity) params.set('severity', filters.severity);
        if (filters.scanMode) params.set('scanMode', filters.scanMode);
        if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
        if (filters.dateTo) params.set('dateTo', filters.dateTo);

        const queryStr = params.toString() ? `?${params.toString()}` : '';

        const response = await fetch(`http://localhost:3000/history${queryStr}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status === 'success') {
            tbody.innerHTML = '';

            result.data.forEach(scan => {
                const date = new Date(scan.timestamp).toLocaleDateString();
                const issuesCount = scan.vulnerabilities.length;
                const statusClass = scan.status === 'Completed' ? 'status-completed' : 'status-failed';
                const modeBadge = scan.scanMode === 'ai'
                    ? '<span class="status-badge" style="background:#F5F3FF; color:#7C3AED; margin-left:6px;"><i class="fas fa-robot" style="margin-right:3px;"></i>AI</span>'
                    : scan.scanMode === 'hybrid'
                        ? '<span class="status-badge" style="background:#ECFDF5; color:#059669; margin-left:6px;"><i class="fas fa-atom" style="margin-right:3px;"></i>Hybrid</span>'
                        : '<span class="status-badge" style="background:var(--light-orange-bg); color:var(--primary-orange); margin-left:6px;"><i class="fas fa-terminal" style="margin-right:3px;"></i>Script</span>';

                const isChecked = compareSelection.includes(scan._id) ? 'checked' : '';

                const row = `
                    <tr>
                        <td><input type="checkbox" class="compare-checkbox" data-scan-id="${scan._id}" ${isChecked} onchange="onCompareCheckboxChange(this)" /></td>
                        <td>${date}</td>
                        <td style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${scan.targetUrl}</td>
                        <td>${scan.duration}</td>
                        <td><strong>${issuesCount}</strong> Issues</td>
                        <td><span class="status-badge ${statusClass}">${scan.status}</span>${modeBadge}</td>
                        <td>
                            <a href="#" onclick="viewScan('${scan._id}'); return false;" style="color:var(--primary-orange);"><i class="fas fa-eye" style="margin-right:4px;"></i>View</a>
                            <a href="#" onclick="deleteScan('${scan._id}')" style="color:var(--danger-red); margin-left:0.5rem;"><i class="fas fa-trash" style="margin-right:4px;"></i>Delete</a>
                        </td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });

            if (result.data.length === 0) {
                tbody.innerHTML = `
                    <tr>
                        <td colspan="7" class="empty-state">
                            <i class="fas fa-folder-open"></i>
                            <p>No scans found. ${Object.keys(filters).length > 0 ? 'Try adjusting your filters.' : 'Start your first scan!'}</p>
                        </td>
                    </tr>`;
            }
        }
    } catch (error) {
        console.error("Failed to load history", error);
        tbody.innerHTML = `
            <tr>
                <td colspan="7" class="empty-state">
                    <i class="fas fa-circle-exclamation" style="color:var(--danger-red);"></i>
                    <p>Failed to load history. Check your connection.</p>
                </td>
            </tr>`;
    }
}

// -----------------------------------------------
// 6a. Filter Functions (Feature #4)
// -----------------------------------------------
function applyHistoryFilters() {
    const filters = {
        search: document.getElementById('filterSearch').value.trim(),
        severity: document.getElementById('filterSeverity').value,
        scanMode: document.getElementById('filterMode').value,
        dateFrom: document.getElementById('filterDateFrom').value,
        dateTo: document.getElementById('filterDateTo').value,
    };
    loadHistoryData(filters);
}

function clearHistoryFilters() {
    document.getElementById('filterSearch').value = '';
    document.getElementById('filterSeverity').value = '';
    document.getElementById('filterMode').value = '';
    document.getElementById('filterDateFrom').value = '';
    document.getElementById('filterDateTo').value = '';
    loadHistoryData();
}

// -----------------------------------------------
// 6a2. Compare Functions (Feature #1)
// -----------------------------------------------
function onCompareCheckboxChange(checkbox) {
    const scanId = checkbox.dataset.scanId;

    if (checkbox.checked) {
        if (compareSelection.length >= 2) {
            checkbox.checked = false;
            showToast('You can only select 2 scans to compare.', 'warning');
            return;
        }
        compareSelection.push(scanId);
    } else {
        compareSelection = compareSelection.filter(id => id !== scanId);
    }

    // Update compare bar
    const compareBar = document.getElementById('compareBar');
    const compareCount = document.getElementById('compareCount');
    const compareBtn = document.getElementById('compareBtn');

    compareCount.innerText = compareSelection.length;
    compareBar.classList.toggle('visible', compareSelection.length > 0);
    compareBtn.disabled = compareSelection.length !== 2;
}

function clearCompareSelection() {
    compareSelection = [];
    document.querySelectorAll('.compare-checkbox').forEach(cb => cb.checked = false);
    document.getElementById('compareBar').classList.remove('visible');
    document.getElementById('compareCount').innerText = '0';
}

async function compareSelectedScans() {
    if (compareSelection.length !== 2) return;

    const token = localStorage.getItem('phoenix_token');
    if (!token) return;

    showToast('Comparing scans...', 'info', 2000);

    try {
        const response = await fetch(`http://localhost:3000/history/compare?scan1=${compareSelection[0]}&scan2=${compareSelection[1]}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status !== 'success') {
            showToast('Error: ' + result.message, 'error');
            return;
        }

        const { scan1, scan2, comparison } = result.data;

        // Populate scan meta
        document.getElementById('compareScan1Info').innerHTML = `
            ${escapeHtml(scan1.targetUrl)}<br>
            <small style="color:var(--light-text);">${new Date(scan1.timestamp).toLocaleDateString()} · ${scan1.totalVulns} vulns · ${scan1.scanMode}</small>
        `;
        document.getElementById('compareScan2Info').innerHTML = `
            ${escapeHtml(scan2.targetUrl)}<br>
            <small style="color:var(--light-text);">${new Date(scan2.timestamp).toLocaleDateString()} · ${scan2.totalVulns} vulns · ${scan2.scanMode}</small>
        `;

        // Populate summary counts with animation
        animateCount(document.getElementById('compareNewCount'), comparison.summary.new);
        animateCount(document.getElementById('compareFixedCount'), comparison.summary.fixed);
        animateCount(document.getElementById('comparePersistentCount'), comparison.summary.persistent);

        // Populate comparison tables
        fillCompareTable('compareNewTable', comparison.newVulns);
        fillCompareTable('compareFixedTable', comparison.fixedVulns);
        fillCompareTable('comparePersistentTable', comparison.persistentVulns);

        // Switch to compare view
        switchView('compare');

    } catch (error) {
        console.error('Compare error:', error);
        showToast('Failed to compare scans.', 'error');
    }
}

function fillCompareTable(tableId, vulns) {
    const tbody = document.querySelector(`#${tableId} tbody`);
    tbody.innerHTML = '';

    if (vulns.length === 0) {
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:1rem; color:var(--light-text);"><i class="fas fa-check-circle" style="margin-right:6px;"></i>None</td></tr>`;
        return;
    }

    vulns.forEach(v => {
        let bgColor, textColor;
        switch (v.severity) {
            case 'Critical': bgColor = '#FDE2E2'; textColor = '#991B1B'; break;
            case 'High': bgColor = '#FEE2E2'; textColor = '#EF4444'; break;
            case 'Medium': bgColor = '#FEF3C7'; textColor = '#D97706'; break;
            case 'Low': bgColor = '#E0E7FF'; textColor = '#4338CA'; break;
            default: bgColor = '#F3F4F6'; textColor = '#6B7280'; break;
        }

        tbody.innerHTML += `
            <tr>
                <td><strong>${escapeHtml(v.type || 'Unknown')}</strong>${v.name ? ` <span style="color:var(--light-text);">(${escapeHtml(v.name)})</span>` : ''}</td>
                <td><span class="status-badge" style="background:${bgColor}; color:${textColor}">${v.severity}</span></td>
                <td style="max-width:250px; word-break:break-all;">${formatLocationAsUrl(v.location)}</td>
                <td style="font-size:0.85rem; color:var(--light-text); max-width:200px;">${v.description ? escapeHtml(v.description) : '—'}</td>
            </tr>
        `;
    });
}

async function deleteScan(scanId) {
    if (!confirm('Are you sure you want to delete this scan?')) return;

    try {
        const token = localStorage.getItem('phoenix_token');
        const response = await fetch(`http://localhost:3000/history/${scanId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status === 'success') {
            showToast("Scan deleted successfully.", "success");
            loadHistoryData(); // Refresh the table
        } else {
            showToast('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error("Failed to delete scan", error);
        showToast('Failed to delete scan.', 'error');
    }
}


// -----------------------------------------------
// 6b. View Scan Detail Logic
// -----------------------------------------------
let currentDetailScan = null; // Store the currently viewed scan for PDF export

async function viewScan(scanId) {
    try {
        const token = localStorage.getItem('phoenix_token');
        if (!token) {
            showToast('Please login first.', 'warning');
            switchView('login');
            return;
        }

        showToast('Loading scan details...', 'info', 2000);

        const response = await fetch(`http://localhost:3000/history/${scanId}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status !== 'success') {
            showToast('Error: ' + result.message, 'error');
            return;
        }

        const scan = result.data;
        currentDetailScan = scan;

        // Populate meta info
        document.getElementById('detailTargetUrl').innerText = scan.targetUrl;
        document.getElementById('detailScanDate').innerText = new Date(scan.timestamp).toLocaleString();
        document.getElementById('detailDuration').innerText = scan.duration || 'N/A';

        const statusEl = document.getElementById('detailStatus');
        const statusClass = scan.status === 'Completed' ? 'status-completed' : 'status-failed';
        const detailModeBadge = scan.scanMode === 'ai'
            ? '<span class="status-badge" style="background:#F5F3FF; color:#7C3AED; margin-left:8px;"><i class="fas fa-robot" style="margin-right:3px;"></i>AI Agent</span>'
            : scan.scanMode === 'hybrid'
                ? '<span class="status-badge" style="background:#ECFDF5; color:#059669; margin-left:8px;"><i class="fas fa-atom" style="margin-right:3px;"></i>Hybrid</span>'
                : '<span class="status-badge" style="background:var(--light-orange-bg); color:var(--primary-orange); margin-left:8px;"><i class="fas fa-terminal" style="margin-right:3px;"></i>Script Engine</span>';
        statusEl.innerHTML = `<span class="status-badge ${statusClass}">${scan.status}</span>${detailModeBadge}`;

        // Populate Discovery Data
        const endpointsList = document.getElementById('detailEndpointsList');
        const techList = document.getElementById('detailTechnologiesList');
        endpointsList.innerHTML = '';
        techList.innerHTML = '';

        if (scan.crawlData) {
            const { endpoints, parameters, technologies } = scan.crawlData;
            
            if (endpoints && endpoints.length > 0) {
                endpoints.forEach(ep => {
                    endpointsList.innerHTML += `<li style="padding: 0.3rem 0; border-bottom: 1px solid var(--border-color);"><i class="fas fa-link" style="margin-right:6px; font-size:0.8rem;"></i>${escapeHtml(ep)}</li>`;
                });
            }
            if (parameters && parameters.length > 0) {
                parameters.forEach(p => {
                    endpointsList.innerHTML += `<li style="padding: 0.3rem 0; border-bottom: 1px solid var(--border-color);"><i class="fas fa-code" style="margin-right:6px; font-size:0.8rem; color:#8B5CF6;"></i>Param: ${escapeHtml(p)}</li>`;
                });
            }
            if (!endpoints?.length && !parameters?.length) {
                endpointsList.innerHTML = `<li>No endpoints or parameters discovered.</li>`;
            }

            if (technologies && technologies.length > 0) {
                technologies.forEach(tech => {
                    techList.innerHTML += `<li style="padding: 0.3rem 0; border-bottom: 1px solid var(--border-color);"><i class="fas fa-microchip" style="margin-right:6px; font-size:0.8rem;"></i>${escapeHtml(tech)}</li>`;
                });
            } else {
                techList.innerHTML = `<li>No technology information collected.</li>`;
            }
        } else {
            endpointsList.innerHTML = `<li>No discovery data available for this scan.</li>`;
            techList.innerHTML = `<li>No discovery data available for this scan.</li>`;
        }

        // Count severities
        let critCount = 0, highCount = 0, medCount = 0, lowCount = 0;
        scan.vulnerabilities.forEach(v => {
            switch (v.severity) {
                case 'Critical': critCount++; break;
                case 'High': highCount++; break;
                case 'Medium': medCount++; break;
                case 'Low': case 'Info': lowCount++; break;
            }
        });

        // Update stat cards with animation
        animateCount(document.getElementById('detailCritical'), critCount);
        animateCount(document.getElementById('detailHigh'), highCount);
        animateCount(document.getElementById('detailMedium'), medCount);
        animateCount(document.getElementById('detailLow'), lowCount);

        // Update total count label
        document.getElementById('detailVulnCount').innerText = `(${scan.vulnerabilities.length})`;

        // Populate vulnerability table
        const tbody = document.querySelector('#detailVulnTable tbody');
        tbody.innerHTML = '';

        if (scan.vulnerabilities.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="6" class="empty-state">
                        <i class="fas fa-shield-check" style="color:var(--success-green);"></i>
                        <p>No vulnerabilities found in this scan.</p>
                    </td>
                </tr>`;
        } else {
            scan.vulnerabilities.forEach((vuln, index) => {
                let bgColor, textColor;
                switch (vuln.severity) {
                    case 'Critical': bgColor = '#FDE2E2'; textColor = '#991B1B'; break;
                    case 'High': bgColor = '#FEE2E2'; textColor = '#EF4444'; break;
                    case 'Medium': bgColor = '#FEF3C7'; textColor = '#D97706'; break;
                    case 'Low': bgColor = '#E0E7FF'; textColor = '#4338CA'; break;
                    default: bgColor = '#F3F4F6'; textColor = '#6B7280'; break;
                }

                const locationHtml = formatLocationAsUrl(vuln.location);
                const description = vuln.description ? escapeHtml(vuln.description) : '<span style="color:#9CA3AF;">—</span>';
                const evidenceHtml = vuln.evidence
                    ? `<div class="evidence-block"><i class="fas fa-fingerprint evidence-icon"></i>${escapeHtml(vuln.evidence).replace(/\n/g, '<br>')}</div>`
                    : '<span style="color:#9CA3AF;">—</span>';

                const vulnNameHtml = buildVulnNameLink(vuln.type, vuln.name, vuln.severity);
                const row = `
                    <tr>
                        <td style="color:var(--light-text); font-weight:600;">${index + 1}</td>
                        <td>${vulnNameHtml}</td>
                        <td><span class="status-badge" style="background:${bgColor}; color:${textColor}">${vuln.severity}</span></td>
                        <td style="max-width:250px; word-break:break-all;">${locationHtml}</td>
                        <td style="font-size:0.85rem; color:var(--light-text); max-width:200px;">${description}</td>
                        <td>${evidenceHtml}</td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });
        }

        // Show Admin Logs Download button only if admin and scan has logs
        const userRole = localStorage.getItem('phoenix_role');
        const downloadLogsBtn = document.getElementById('downloadLogsBtn');
        if (userRole === 'admin' && scan.agentLogs) {
            downloadLogsBtn.style.display = 'inline-flex';
        } else {
            downloadLogsBtn.style.display = 'none';
        }

        // Switch to detail view
        switchView('scan-detail');

    } catch (error) {
        console.error('Failed to load scan details', error);
        showToast('Failed to load scan details.', 'error');
    }
}

async function downloadAgentLogs() {
    if (!currentDetailScan || !currentDetailScan._id) return;
    try {
        const token = localStorage.getItem('phoenix_token');
        const response = await fetch(`http://localhost:3000/scan/${currentDetailScan._id}/download-logs`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            const data = await response.json();
            showToast('Error: ' + (data.message || 'Failed to download logs'), 'error');
            return;
        }

        // Handle file download via blob
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = `phoenix_logs_${currentDetailScan._id}.md`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
        showToast('Logs downloaded successfully!', 'success');
    } catch (error) {
        console.error("Failed to download logs", error);
        showToast('Failed to download logs.', 'error');
    }
}

// Generate PDF from the detail view
function downloadDetailPDF() {
    if (!currentDetailScan) {
        showToast('No scan data to export.', 'warning');
        return;
    }
    if (!window.jspdf) {
        showToast('PDF Generator is initializing... please try again.', 'warning');
        return;
    }

    const scan = currentDetailScan;
    const doc = new window.jspdf.jsPDF();
    const date = new Date(scan.timestamp).toLocaleString();

    // Header
    doc.setFontSize(22);
    doc.setTextColor(249, 115, 22);
    doc.text('Phoenix Scan Report', 14, 22);

    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(`Target: ${scan.targetUrl}`, 14, 32);
    doc.text(`Scan Date: ${date}`, 14, 38);
    doc.text(`Duration: ${scan.duration || 'N/A'}`, 14, 44);
    doc.text(`Status: ${scan.status}`, 14, 50);

    doc.setLineWidth(0.5);
    doc.line(14, 56, 196, 56);

    // Summary
    let critCount = 0, highCount = 0, medCount = 0, lowCount = 0;
    scan.vulnerabilities.forEach(v => {
        switch (v.severity) {
            case 'Critical': critCount++; break;
            case 'High': highCount++; break;
            case 'Medium': medCount++; break;
            default: lowCount++; break;
        }
    });

    doc.setFontSize(11);
    doc.setTextColor(60);
    doc.text(`Summary: ${scan.vulnerabilities.length} vulnerabilities — ${critCount} Critical, ${highCount} High, ${medCount} Medium, ${lowCount} Low/Info`, 14, 64);

    // Table
    const rows = scan.vulnerabilities.map((v, i) => [
        i + 1,
        `${v.type || 'Unknown'}${v.name ? ' (' + v.name + ')' : ''}`,
        v.severity,
        v.location || 'N/A',
        v.description || '—',
        v.evidence || '—'
    ]);

    if (rows.length === 0) {
        doc.text('No vulnerabilities found.', 14, 74);
    } else {
        doc.autoTable({
            head: [['#', 'Vulnerability', 'Severity', 'Location', 'Description', 'Evidence']],
            body: rows,
            startY: 70,
            theme: 'grid',
            headStyles: { fillColor: [249, 115, 22] },
            styles: { fontSize: 8, cellPadding: 3 },
            columnStyles: {
                0: { cellWidth: 8 },
                4: { cellWidth: 40 },
                5: { cellWidth: 45, fontStyle: 'italic', fontSize: 7 }
            }
        });
    }

    // Footer
    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(10);
        doc.setTextColor(150);
        doc.text(`Page ${i} of ${pageCount} — Generated by Phoenix Scanner`, 105, 287, null, null, 'center');
    }

    doc.save(`Phoenix_Report_${scan.targetUrl.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.pdf`);
    showToast('PDF report downloaded!', 'success');
}


// -----------------------------------------------
// 7. Auth Helpers
// -----------------------------------------------
function toggleAuth(mode) {
    if (mode === 'signup') {
        document.getElementById('loginContainer').style.display = 'none';
        document.getElementById('signupContainer').style.display = 'block';
    } else {
        document.getElementById('loginContainer').style.display = 'block';
        document.getElementById('signupContainer').style.display = 'none';
    }
}

// Sign Up
document.getElementById('signupForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('signupEmail').value;
    const password = document.getElementById('signupPassword').value;

    try {
        const response = await fetch('http://localhost:3000/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
        });
        const data = await response.json();

        if (data.status === 'success') {
            showToast('Account Created! Please Login.', 'success');
            toggleAuth('login');
        } else {
            showToast('Error: ' + data.message, 'error');
        }
    } catch (error) {
        console.error(error);
        showToast('Server Error. Make sure the backend is running.', 'error');
    }
});


// -----------------------------------------------
// 8. PDF Generation Logic
// -----------------------------------------------
function downloadPDF() {
    if (!window.jspdf) {
        showToast("PDF Generator is initializing... please try again in a second.", "warning");
        return;
    }

    const doc = new window.jspdf.jsPDF();
    const url = document.getElementById('scanUrl').value;
    const date = new Date().toLocaleString();

    doc.setFontSize(22);
    doc.setTextColor(249, 115, 22);
    doc.text("Phoenix Scan Report", 14, 22);

    doc.setFontSize(12);
    doc.setTextColor(100);
    doc.text(`Target: ${url}`, 14, 32);
    doc.text(`Scan Date: ${date}`, 14, 38);

    doc.setLineWidth(0.5);
    doc.line(14, 45, 196, 45);

    const rows = [];
    const tbodyRows = document.querySelectorAll('#resultsArea table tbody tr');

    tbodyRows.forEach(tr => {
        const cols = tr.querySelectorAll('td');
        if (cols.length >= 4) {
            rows.push([
                cols[0].innerText,
                cols[1].innerText,
                cols[2].innerText,
                cols[3].innerText
            ]);
        }
    });

    if (rows.length === 0) {
        doc.text("No vulnerabilities found.", 14, 55);
    } else {
        doc.autoTable({
            head: [['Vulnerability', 'Severity', 'Location', 'Evidence']],
            body: rows,
            startY: 50,
            theme: 'grid',
            headStyles: { fillColor: [249, 115, 22] },
            styles: { fontSize: 9 },
            columnStyles: {
                3: { cellWidth: 50, fontStyle: 'italic', fontSize: 7 }
            }
        });
    }

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(10);
        doc.setTextColor(150);
        doc.text(`Page ${i} of ${pageCount} - Generated by Phoenix Scanner`, 105, 287, null, null, "center");
    }

    doc.save(`Phoenix_Report_${Date.now()}.pdf`);
    showToast("PDF report downloaded successfully!", "success");
}


// -----------------------------------------------
// 9. Account Data Logic
// -----------------------------------------------
async function loadAccountData() {
    const token = localStorage.getItem('phoenix_token');
    if (!token) {
        switchView('login');
        return;
    }

    try {
        const response = await fetch('http://localhost:3000/me', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const result = await response.json();

        if (result.status === 'success') {
            const user = result.data;
            document.getElementById('profileEmail').value = user.email;
            document.getElementById('profileRole').value = user.role.toUpperCase();
            document.getElementById('profileJoined').value = new Date(user.createdAt).toLocaleDateString();
            document.getElementById('profileScanCount').value = user.scanCount;
        }
    } catch (error) {
        console.error("Failed to load profile", error);
    }
}

// Change Password
async function changePassword() {
    const currentPassword = document.getElementById('currentPassword').value;
    const newPassword = document.getElementById('newPassword').value;

    if (!currentPassword || !newPassword) {
        showToast('Please fill in both password fields.', 'warning');
        return;
    }
    if (newPassword.length < 6) {
        showToast('New password must be at least 6 characters.', 'warning');
        return;
    }

    try {
        const token = localStorage.getItem('phoenix_token');
        const response = await fetch('http://localhost:3000/change-password', {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ currentPassword, newPassword })
        });
        const result = await response.json();

        if (result.status === 'success') {
            showToast('Password changed successfully!', 'success');
            document.getElementById('currentPassword').value = '';
            document.getElementById('newPassword').value = '';
        } else {
            showToast('Error: ' + result.message, 'error');
        }
    } catch (error) {
        console.error("Failed to change password", error);
        showToast('Failed to change password.', 'error');
    }
}


// -----------------------------------------------
// 10. Admin Data Logic
// -----------------------------------------------
async function loadAdminData() {
    const token = localStorage.getItem('phoenix_token');
    if (!token) return;

    try {
        const statsResponse = await fetch('http://localhost:3000/admin/system-stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const statsResult = await statsResponse.json();

        if (statsResult.status === 'success') {
            document.getElementById('adminTotalUsers').innerText = statsResult.data.totalUsers;
            document.getElementById('adminTotalScans').innerText = statsResult.data.totalScans;
        }

        const usersResponse = await fetch('http://localhost:3000/admin/users', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const usersResult = await usersResponse.json();

        if (usersResult.status === 'success') {
            const tbody = document.querySelector('#adminUsersTable tbody');
            tbody.innerHTML = '';

            usersResult.data.forEach(user => {
                const row = `
                    <tr>
                        <td>${user.email}</td>
                        <td><span class="status-badge" style="background:var(--light-orange-bg); color:var(--primary-orange);">${user.role}</span></td>
                        <td>${new Date(user.createdAt).toLocaleDateString()}</td>
                        <td>
                            <button class="tool-btn tool-btn-sm" onclick="alert('Manage User Coming Soon')">Edit</button>
                        </td>
                    </tr>
                `;
                tbody.innerHTML += row;
            });
        }

    } catch (error) {
        console.error("Failed to load admin data", error);
        showToast("Access Denied: Admin privileges required.", "error");
        switchView('home');
    }
}


// -----------------------------------------------
// 11. Session Restoration on Page Load
// -----------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('phoenix_token');
    const email = localStorage.getItem('phoenix_user');
    const role = localStorage.getItem('phoenix_role');

    if (token && email) {
        updateNavForLoggedIn(email, role);
    }
});


// -----------------------------------------------
// 12. Location URL Formatter
// -----------------------------------------------
function formatLocationAsUrl(location) {
    if (!location) return 'N/A';

    // Regex to find URLs in the string
    const urlRegex = /(https?:\/\/[^\s,→]+)/g;
    const urls = location.match(urlRegex);

    if (!urls || urls.length === 0) {
        // No URL found — return as plain text
        return escapeHtml(location);
    }

    // Replace each URL in the string with a clickable link
    let result = escapeHtml(location);
    for (const url of urls) {
        const cleanUrl = url.replace(/[)}\]>]+$/, ''); // strip trailing punctuation
        const escapedUrl = escapeHtml(url);
        result = result.replace(
            escapedUrl,
            `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-orange); text-decoration:underline; word-break:break-all;">${cleanUrl}</a>`
        );
    }

    return result;
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}


// -----------------------------------------------
// 13. AI Report Generation
// -----------------------------------------------

// Called from the home/scan results page
function generateAIReportFromScan() {
    const scanId = window._lastScanId;
    if (!scanId) {
        showToast('No scan data available. Please run a scan first.', 'warning');
        return;
    }
    requestAIReport(scanId, document.getElementById('aiReportBtnHome'));
}

// Called from the scan detail view
function generateAIReportFromDetail() {
    if (!currentDetailScan || !currentDetailScan._id) {
        showToast('No scan data available.', 'warning');
        return;
    }
    requestAIReport(currentDetailScan._id, document.getElementById('aiReportBtnDetail'));
}

// Core function: calls backend and generates PDF
async function requestAIReport(scanId, buttonEl) {
    const token = localStorage.getItem('phoenix_token');
    if (!token) {
        showToast('Please login first.', 'warning');
        switchView('login');
        return;
    }

    // Disable button and show loading state
    if (buttonEl) {
        buttonEl.disabled = true;
        buttonEl.classList.add('generating');
        buttonEl._originalHTML = buttonEl.innerHTML;
        buttonEl.innerHTML = '<i class="fas fa-spinner fa-spin" style="margin-right:6px;"></i>Generating...';
    }

    showToast('🤖 AI is analyzing your scan results... This may take a moment.', 'info', 8000);

    try {
        const response = await fetch('http://localhost:3000/generate-ai-report', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ scanId })
        });

        const result = await response.json();

        if (result.status === 'success' && result.data && result.data.report) {
            showToast('AI Report generated! Downloading PDF...', 'success', 4000);
            buildAIReportPDF(result.data.report, scanId);
        } else {
            showToast('AI Report Error: ' + (result.message || 'Unknown error'), 'error', 6000);
        }

    } catch (error) {
        console.error('AI Report Error:', error);
        showToast('Failed to generate AI report. Check your connection.', 'error', 6000);
    } finally {
        // Restore button
        if (buttonEl) {
            buttonEl.disabled = false;
            buttonEl.classList.remove('generating');
            buttonEl.innerHTML = buttonEl._originalHTML || '<i class="fas fa-robot" style="margin-right:4px;"></i>AI Report';
        }
    }
}

// Convert Markdown report to a professional PDF
function buildAIReportPDF(markdownText, scanId) {
    if (!window.jspdf) {
        showToast('PDF Generator is initializing... please try again.', 'warning');
        return;
    }

    const doc = new window.jspdf.jsPDF();
    const pageWidth = doc.internal.pageSize.getWidth();
    const pageHeight = doc.internal.pageSize.getHeight();
    const margin = 16;
    const contentWidth = pageWidth - margin * 2;
    let y = 20;

    // ---- Cover / Header ----
    doc.setFillColor(124, 58, 237); // Purple
    doc.rect(0, 0, pageWidth, 48, 'F');

    doc.setFontSize(26);
    doc.setTextColor(255, 255, 255);
    doc.text('Phoenix AI Security Report', margin, 28);

    doc.setFontSize(10);
    doc.setTextColor(220, 220, 255);
    doc.text('Generated by Phoenix AI \u2022 Powered by Google Gemini', margin, 38);
    doc.text(`Date: ${new Date().toLocaleString()}`, pageWidth - margin - 60, 38);

    y = 58;

    // ---- Parse and render markdown ----
    const lines = markdownText.split('\n');
    let inCodeBlock = false;
    let inTable = false;
    let tableRows = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // Check page overflow
        if (y > pageHeight - 30) {
            addPageFooter(doc, pageWidth, pageHeight, margin);
            doc.addPage();
            y = 20;
        }

        // Code blocks
        if (line.trim().startsWith('```')) {
            if (inCodeBlock) {
                inCodeBlock = false;
                y += 4;
            } else {
                inCodeBlock = true;
                y += 2;
            }
            continue;
        }

        if (inCodeBlock) {
            doc.setFillColor(240, 240, 245);
            const codeLines = doc.splitTextToSize(line, contentWidth - 8);
            const blockH = codeLines.length * 5 + 4;
            doc.rect(margin, y - 3, contentWidth, blockH, 'F');
            doc.setFontSize(8);
            doc.setTextColor(60, 60, 80);
            doc.text(codeLines, margin + 4, y + 2);
            y += blockH + 2;
            continue;
        }

        // Table handling
        if (line.trim().startsWith('|') && line.trim().endsWith('|')) {
            // Skip separator rows like |---|---|---|
            if (/^\|[\s:-]+\|/.test(line.trim()) && !line.includes('a')) {
                continue;
            }
            const cells = line.split('|').filter(c => c.trim() !== '').map(c => c.trim());
            if (cells.length > 0) {
                if (!inTable) {
                    inTable = true;
                    tableRows = [];
                }
                tableRows.push(cells);
            }
            // Check if next line is not a table line
            const nextLine = i + 1 < lines.length ? lines[i + 1].trim() : '';
            if (!nextLine.startsWith('|') || i + 1 >= lines.length) {
                // Render table
                if (tableRows.length > 1) {
                    try {
                        doc.autoTable({
                            head: [tableRows[0]],
                            body: tableRows.slice(1),
                            startY: y,
                            margin: { left: margin, right: margin },
                            theme: 'grid',
                            headStyles: { fillColor: [124, 58, 237], fontSize: 8, cellPadding: 3 },
                            styles: { fontSize: 7.5, cellPadding: 2.5 },
                        });
                        y = doc.lastAutoTable.finalY + 8;
                    } catch (e) {
                        // Fallback: render as text
                        tableRows.forEach(row => {
                            doc.setFontSize(8);
                            doc.setTextColor(60, 60, 60);
                            doc.text(row.join('  |  '), margin, y);
                            y += 5;
                        });
                    }
                }
                inTable = false;
                tableRows = [];
            }
            continue;
        }

        // Headers
        if (line.startsWith('#### ')) {
            doc.setFontSize(10);
            doc.setTextColor(100, 60, 180);
            doc.setFont(undefined, 'bold');
            const headerText = cleanMarkdown(line.substring(5));
            const headerLines = doc.splitTextToSize(headerText, contentWidth);
            doc.text(headerLines, margin, y);
            y += headerLines.length * 5 + 3;
            doc.setFont(undefined, 'normal');
            continue;
        }
        if (line.startsWith('### ')) {
            y += 4;
            doc.setFontSize(12);
            doc.setTextColor(124, 58, 237);
            doc.setFont(undefined, 'bold');
            const headerText = cleanMarkdown(line.substring(4));
            const headerLines = doc.splitTextToSize(headerText, contentWidth);
            doc.text(headerLines, margin, y);
            y += headerLines.length * 6 + 3;
            doc.setFont(undefined, 'normal');
            continue;
        }
        if (line.startsWith('## ')) {
            y += 6;
            // Draw a subtle divider line
            doc.setDrawColor(200, 200, 220);
            doc.line(margin, y - 3, pageWidth - margin, y - 3);
            doc.setFontSize(14);
            doc.setTextColor(79, 70, 229);
            doc.setFont(undefined, 'bold');
            const headerText = cleanMarkdown(line.substring(3));
            const headerLines = doc.splitTextToSize(headerText, contentWidth);
            doc.text(headerLines, margin, y + 2);
            y += headerLines.length * 7 + 6;
            doc.setFont(undefined, 'normal');
            continue;
        }
        if (line.startsWith('# ')) {
            y += 6;
            doc.setFontSize(16);
            doc.setTextColor(60, 30, 150);
            doc.setFont(undefined, 'bold');
            const headerText = cleanMarkdown(line.substring(2));
            const headerLines = doc.splitTextToSize(headerText, contentWidth);
            doc.text(headerLines, margin, y);
            y += headerLines.length * 8 + 5;
            doc.setFont(undefined, 'normal');
            continue;
        }

        // Horizontal rule
        if (line.trim() === '---' || line.trim() === '***') {
            doc.setDrawColor(200, 200, 220);
            doc.line(margin, y, pageWidth - margin, y);
            y += 6;
            continue;
        }

        // Empty line
        if (line.trim() === '') {
            y += 4;
            continue;
        }

        // Bullet points
        if (line.trim().startsWith('- ') || line.trim().startsWith('* ')) {
            doc.setFontSize(9);
            doc.setTextColor(50, 50, 50);
            const bulletText = cleanMarkdown(line.trim().substring(2));
            const bulletLines = doc.splitTextToSize(bulletText, contentWidth - 10);
            doc.text('\u2022', margin + 2, y);
            doc.text(bulletLines, margin + 8, y);
            y += bulletLines.length * 4.5 + 2;
            continue;
        }

        // Numbered list
        const numberedMatch = line.trim().match(/^(\d+)\.\s+(.+)/);
        if (numberedMatch) {
            doc.setFontSize(9);
            doc.setTextColor(50, 50, 50);
            const num = numberedMatch[1];
            const listText = cleanMarkdown(numberedMatch[2]);
            const listLines = doc.splitTextToSize(listText, contentWidth - 12);
            doc.setFont(undefined, 'bold');
            doc.text(`${num}.`, margin + 2, y);
            doc.setFont(undefined, 'normal');
            doc.text(listLines, margin + 10, y);
            y += listLines.length * 4.5 + 2;
            continue;
        }

        // Regular paragraph text
        doc.setFontSize(9);
        doc.setTextColor(50, 50, 50);
        const cleanLine = cleanMarkdown(line);
        const wrappedLines = doc.splitTextToSize(cleanLine, contentWidth);
        doc.text(wrappedLines, margin, y);
        y += wrappedLines.length * 4.5 + 1;
    }

    // Add footer to last page
    addPageFooter(doc, pageWidth, pageHeight, margin);

    // Add page numbers
    const totalPages = doc.internal.getNumberOfPages();
    for (let p = 1; p <= totalPages; p++) {
        doc.setPage(p);
        doc.setFontSize(8);
        doc.setTextColor(150);
        doc.text(
            `Page ${p} of ${totalPages} — Phoenix AI Report`,
            pageWidth / 2, pageHeight - 8, { align: 'center' }
        );
    }

    doc.save(`Phoenix_AI_Report_${Date.now()}.pdf`);
    showToast('AI Report PDF downloaded!', 'success');
}

// Helper: clean markdown formatting for PDF text
function cleanMarkdown(text) {
    return text
        .replace(/\*\*(.+?)\*\*/g, '$1')  // bold
        .replace(/\*(.+?)\*/g, '$1')      // italic
        .replace(/`(.+?)`/g, '$1')        // inline code
        .replace(/\[(.+?)\]\(.+?\)/g, '$1') // links
        .trim();
}

// Helper: add footer to PDF page
function addPageFooter(doc, pageWidth, pageHeight, margin) {
    doc.setDrawColor(200, 200, 220);
    doc.line(margin, pageHeight - 15, pageWidth - margin, pageHeight - 15);
}

// -----------------------------------------------
// 10. Dark Mode Logic
// -----------------------------------------------
function initDarkMode() {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle) return;

    // Check for saved theme preference
    const savedTheme = localStorage.getItem('phoenix_theme');
    const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

    if (savedTheme === 'dark' || (!savedTheme && systemPrefersDark)) {
        document.body.classList.add('dark-mode');
        updateThemeIcon(true);
    }

    themeToggle.addEventListener('click', () => {
        const isDark = document.body.classList.toggle('dark-mode');
        localStorage.setItem('phoenix_theme', isDark ? 'dark' : 'light');
        updateThemeIcon(isDark);
    });
}

function updateThemeIcon(isDark) {
    const themeToggle = document.getElementById('themeToggle');
    if (!themeToggle || !themeToggle.querySelector('i')) return;

    const icon = themeToggle.querySelector('i');
    if (isDark) {
        icon.className = 'fas fa-sun';
        themeToggle.title = 'Switch to Light Mode';
        themeToggle.style.color = 'var(--accent-yellow)';
    } else {
        icon.className = 'fas fa-moon';
        themeToggle.title = 'Switch to Dark Mode';
        themeToggle.style.color = '#4B5563';
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', () => {
    initDarkMode();
    initSocket(); // Initialize Socket.IO connection (Feature #2)

    // Check if already logged in - existing logic helper
    const user = localStorage.getItem('phoenix_user');
    const role = localStorage.getItem('phoenix_role');
    if (user && typeof updateNavForLoggedIn === 'function') {
        updateNavForLoggedIn(user, role);
    }
});

// -----------------------------------------------
// 14. Export Functions (Feature #11)
// -----------------------------------------------
function toggleExportDropdown() {
    const dropdown = document.getElementById('exportDropdown');
    dropdown.classList.toggle('open');
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('exportDropdown');
    if (dropdown && !dropdown.contains(e.target)) {
        dropdown.classList.remove('open');
    }
});

async function exportScanData(format) {
    if (!currentDetailScan || !currentDetailScan._id) {
        showToast('No scan data available to export.', 'warning');
        return;
    }

    const token = localStorage.getItem('phoenix_token');
    if (!token) {
        showToast('Please login first.', 'warning');
        return;
    }

    try {
        showToast(`Preparing ${format.toUpperCase()} export...`, 'info', 2000);
        
        const response = await fetch(`http://localhost:3000/history/${currentDetailScan._id}/export/${format}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!response.ok) {
            const data = await response.json();
            showToast('Export error: ' + (data.message || 'Unknown error'), 'error');
            return;
        }

        // Download file via blob
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        
        // Extract filename from Content-Disposition header
        const disposition = response.headers.get('Content-Disposition');
        let filename = `phoenix_scan.${format}`;
        if (disposition) {
            const match = disposition.match(/filename=([^;]+)/);
            if (match) filename = match[1].trim();
        }
        
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);

        showToast(`${format.toUpperCase()} exported successfully!`, 'success');
        
        // Close the dropdown
        document.getElementById('exportDropdown').classList.remove('open');
    } catch (error) {
        console.error(`Export ${format} error:`, error);
        showToast(`Failed to export as ${format.toUpperCase()}.`, 'error');
    }
}


// -----------------------------------------------
// 15. Vulnerability Knowledge Base & Detail Modal
// -----------------------------------------------

/**
 * Comprehensive vulnerability definitions for all types
 * detected by Phoenix Scanner. Keys match the `type` field
 * from scanner results. A fallback key '_default' is provided
 * for any unknown types (e.g., from AI agent analysis).
 */
const VULN_KNOWLEDGE_BASE = {
    'Cross-Site Scripting (XSS)': {
        icon: 'fa-code',
        category: 'Injection',
        definition: 'Cross-Site Scripting (XSS) is a client-side code injection attack where an attacker injects malicious scripts (usually JavaScript) into web pages viewed by other users.',
        description: 'XSS vulnerabilities occur when an application includes untrusted data in a web page without proper validation or escaping. Attackers can use XSS to execute scripts in a victim\'s browser, which can hijack user sessions, deface websites, redirect users to malicious sites, or steal sensitive information like cookies and tokens.',
        impact: { confidentiality: 'High', integrity: 'High', availability: 'Low' },
        remediation: [
            'Encode all user-supplied output using context-aware encoding (HTML, JavaScript, URL, CSS)',
            'Implement Content Security Policy (CSP) headers to restrict script sources',
            'Use HTTPOnly and Secure flags on session cookies',
            'Sanitize user input using established libraries (e.g., DOMPurify)',
            'Use modern frameworks with built-in XSS protection (React, Angular, Vue)'
        ],
        references: [
            { label: 'OWASP XSS', url: 'https://owasp.org/www-community/attacks/xss/' },
            { label: 'CWE-79', url: 'https://cwe.mitre.org/data/definitions/79.html' },
            { label: 'OWASP Top 10: A03', url: 'https://owasp.org/Top10/A03_2021-Injection/' }
        ]
    },
    'SQL Injection': {
        icon: 'fa-database',
        category: 'Injection',
        definition: 'SQL Injection (SQLi) is a code injection technique that exploits a security vulnerability in an application\'s database layer by inserting malicious SQL statements into input fields.',
        description: 'When user input is improperly sanitized and directly concatenated into SQL queries, attackers can manipulate database queries to access, modify, or delete data they are not authorized to see. In severe cases, attackers can execute administrative operations on the database, read system files, or gain operating system access.',
        impact: { confidentiality: 'Critical', integrity: 'Critical', availability: 'High' },
        remediation: [
            'Use parameterized queries (prepared statements) for all database interactions',
            'Employ an Object-Relational Mapping (ORM) framework',
            'Implement input validation with a whitelist approach',
            'Apply the principle of least privilege for database accounts',
            'Use Web Application Firewalls (WAF) as an additional defense layer',
            'Regularly audit and test database queries for injection flaws'
        ],
        references: [
            { label: 'OWASP SQLi', url: 'https://owasp.org/www-community/attacks/SQL_Injection' },
            { label: 'CWE-89', url: 'https://cwe.mitre.org/data/definitions/89.html' },
            { label: 'OWASP Top 10: A03', url: 'https://owasp.org/Top10/A03_2021-Injection/' }
        ]
    },
    'OS Command Injection': {
        icon: 'fa-terminal',
        category: 'Injection',
        definition: 'OS Command Injection is an attack in which the goal is execution of arbitrary operating system commands on the host via a vulnerable application.',
        description: 'Command injection vulnerabilities occur when an application passes unsafe user-supplied data to a system shell. An attacker can use this to execute arbitrary commands on the server, potentially gaining full control of the host system, stealing data, installing malware, or pivoting to other internal systems.',
        impact: { confidentiality: 'Critical', integrity: 'Critical', availability: 'Critical' },
        remediation: [
            'Avoid calling OS commands directly from application code whenever possible',
            'Use language-specific APIs and libraries instead of shell commands',
            'If OS commands are necessary, use parameterized interfaces that separate commands from arguments',
            'Implement strict input validation with allowlists for permitted characters',
            'Run applications with the minimum required OS privileges',
            'Use sandboxing or containerization to limit command execution scope'
        ],
        references: [
            { label: 'OWASP Command Injection', url: 'https://owasp.org/www-community/attacks/Command_Injection' },
            { label: 'CWE-78', url: 'https://cwe.mitre.org/data/definitions/78.html' }
        ]
    },
    'Local File Inclusion (LFI)': {
        icon: 'fa-folder-open',
        category: 'Injection',
        definition: 'Local File Inclusion (LFI) is a vulnerability that allows an attacker to include and read files on the server through the web application.',
        description: 'LFI occurs when a web application dynamically includes files based on user input without proper sanitization. Attackers can exploit this to read sensitive system files (e.g., /etc/passwd, configuration files), view application source code, or in combination with other vulnerabilities, achieve remote code execution through log poisoning or PHP wrappers.',
        impact: { confidentiality: 'High', integrity: 'Medium', availability: 'Medium' },
        remediation: [
            'Avoid dynamic file inclusion based on user input',
            'Use a whitelist of allowed files/paths if dynamic inclusion is required',
            'Implement proper input validation — strip path traversal sequences (../, ..\\)',
            'Configure the web server to restrict file access to the web root directory',
            'Use chroot jails or containerization to limit filesystem access',
            'Disable unnecessary PHP wrappers (php://, data://, expect://)'
        ],
        references: [
            { label: 'OWASP LFI', url: 'https://owasp.org/www-project-web-security-testing-guide/v42/4-Web_Application_Security_Testing/07-Input_Validation_Testing/11.1-Testing_for_Local_File_Inclusion' },
            { label: 'CWE-98', url: 'https://cwe.mitre.org/data/definitions/98.html' }
        ]
    },
    'CORS Misconfiguration': {
        icon: 'fa-globe',
        category: 'Misconfiguration',
        definition: 'A CORS (Cross-Origin Resource Sharing) misconfiguration occurs when a server improperly configures CORS headers, allowing unauthorized cross-origin requests.',
        description: 'CORS is a browser security mechanism that restricts cross-origin HTTP requests. When CORS is misconfigured — for example, by reflecting the Origin header, using wildcard (*) with credentials, or trusting null origins — attackers can make authenticated requests from malicious websites, potentially stealing sensitive user data or performing unauthorized actions.',
        impact: { confidentiality: 'High', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Explicitly whitelist trusted origins — never reflect the Origin header directly',
            'Avoid using Access-Control-Allow-Origin: * with credentials',
            'Do not trust the "null" origin',
            'Validate the Origin header against a strict allowlist on the server side',
            'Limit allowed methods and headers to what is strictly necessary',
            'Implement proper CSRF protection alongside CORS policies'
        ],
        references: [
            { label: 'OWASP CORS', url: 'https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/11-Client-side_Testing/07-Testing_Cross_Origin_Resource_Sharing' },
            { label: 'CWE-942', url: 'https://cwe.mitre.org/data/definitions/942.html' }
        ]
    },
    'Cross-Site Request Forgery (CSRF)': {
        icon: 'fa-user-secret',
        category: 'Session Management',
        definition: 'CSRF is an attack that forces an authenticated user to submit a request to a web application against which they are currently authenticated.',
        description: 'In a CSRF attack, a malicious website, email, or program causes a user\'s browser to perform an unwanted action on a trusted site where the user is authenticated. This can lead to unauthorized state changes such as transferring funds, changing email addresses or passwords, or making purchases — all without the user\'s knowledge or consent.',
        impact: { confidentiality: 'Low', integrity: 'High', availability: 'Low' },
        remediation: [
            'Implement anti-CSRF tokens (synchronizer token pattern) in all state-changing forms',
            'Use the SameSite cookie attribute (Strict or Lax) on session cookies',
            'Verify the Origin and Referer headers for state-changing requests',
            'Require re-authentication for sensitive actions (e.g., password changes, financial transactions)',
            'Use custom request headers for AJAX requests (since cross-origin requests cannot set custom headers without CORS)'
        ],
        references: [
            { label: 'OWASP CSRF', url: 'https://owasp.org/www-community/attacks/csrf' },
            { label: 'CWE-352', url: 'https://cwe.mitre.org/data/definitions/352.html' }
        ]
    },
    'Missing Security Header': {
        icon: 'fa-shield-halved',
        category: 'Misconfiguration',
        definition: 'Missing security headers indicate that the web server does not include critical HTTP response headers that help protect against common web attacks.',
        description: 'HTTP security headers instruct browsers to enable built-in security features. Missing headers like Content-Security-Policy, X-Frame-Options, Strict-Transport-Security (HSTS), X-Content-Type-Options, and Referrer-Policy leave the application vulnerable to XSS, clickjacking, MIME sniffing, downgrade attacks, and information leakage.',
        impact: { confidentiality: 'Medium', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Add Content-Security-Policy (CSP) header to prevent XSS and data injection attacks',
            'Set X-Frame-Options to DENY or SAMEORIGIN to prevent clickjacking',
            'Enable Strict-Transport-Security (HSTS) with a long max-age to enforce HTTPS',
            'Add X-Content-Type-Options: nosniff to prevent MIME type sniffing',
            'Configure a strict Referrer-Policy header (e.g., strict-origin-when-cross-origin)',
            'Set Permissions-Policy to disable unnecessary browser features (camera, microphone, geolocation)'
        ],
        references: [
            { label: 'OWASP Headers', url: 'https://owasp.org/www-project-secure-headers/' },
            { label: 'CWE-693', url: 'https://cwe.mitre.org/data/definitions/693.html' }
        ]
    },
    'Weak Security Header': {
        icon: 'fa-shield-virus',
        category: 'Misconfiguration',
        definition: 'A weak security header means the server includes a security-related header but with a configuration that does not provide adequate protection.',
        description: 'Even when security headers are present, they may be misconfigured or use weak values. For example, a permissive CSP with unsafe-inline, a short HSTS max-age, X-XSS-Protection set to 0, or a Referrer-Policy of unsafe-url. These weak configurations provide a false sense of security while leaving the application partially exposed to attacks.',
        impact: { confidentiality: 'Medium', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Review and strengthen CSP directives — remove unsafe-inline, unsafe-eval where possible',
            'Set HSTS max-age to at least 31536000 (1 year) and include includeSubDomains',
            'Use a strict Referrer-Policy (strict-origin-when-cross-origin or no-referrer)',
            'Ensure X-Content-Type-Options is set to nosniff',
            'Use security header analysis tools (e.g., securityheaders.com) to audit your configuration',
            'Regularly review and update security headers as new best practices emerge'
        ],
        references: [
            { label: 'OWASP Headers', url: 'https://owasp.org/www-project-secure-headers/' },
            { label: 'SecurityHeaders.com', url: 'https://securityheaders.com/' }
        ]
    },
    'Information Disclosure': {
        icon: 'fa-eye',
        category: 'Information Exposure',
        definition: 'Information disclosure (also known as information leakage) is when a web application unintentionally reveals sensitive data to users.',
        description: 'Information disclosure vulnerabilities expose data that should not be accessible to end users. This includes server version strings, technology stack details, internal IP addresses, file paths, stack traces, database error messages, or backup files. Attackers use this information for reconnaissance — identifying specific software versions to look up known vulnerabilities, or understanding the architecture to plan targeted attacks.',
        impact: { confidentiality: 'Medium', integrity: 'Low', availability: 'Low' },
        remediation: [
            'Remove or suppress server version headers (Server, X-Powered-By, X-AspNet-Version)',
            'Configure custom error pages that do not expose stack traces or debug information',
            'Disable directory listing on the web server',
            'Remove backup files, development artifacts, and commented-out code from production',
            'Implement proper access controls to restrict access to sensitive endpoints',
            'Use generic error messages that do not reveal internal implementation details'
        ],
        references: [
            { label: 'OWASP Info Leakage', url: 'https://owasp.org/www-project-web-security-testing-guide/latest/4-Web_Application_Security_Testing/01-Information_Gathering/' },
            { label: 'CWE-200', url: 'https://cwe.mitre.org/data/definitions/200.html' }
        ]
    },
    'UI Redress': {
        icon: 'fa-layer-group',
        category: 'Client-Side',
        definition: 'UI Redress (Clickjacking) is an attack that tricks a user into clicking on something different from what they perceive by overlaying transparent or opaque layers over a legitimate page.',
        description: 'In a clickjacking attack, the attacker embeds a target website in an invisible iframe and overlays it with a decoy page. When the user interacts with the decoy, they unknowingly perform actions on the hidden target site — such as enabling their webcam, making purchases, or changing account settings. This exploits the absence of X-Frame-Options or Content-Security-Policy frame-ancestors directives.',
        impact: { confidentiality: 'Low', integrity: 'High', availability: 'Low' },
        remediation: [
            'Set X-Frame-Options header to DENY or SAMEORIGIN',
            'Use Content-Security-Policy: frame-ancestors \'self\' for more granular control',
            'Implement frame-busting JavaScript as a secondary defense',
            'Use the SameSite cookie attribute to prevent cookies from being sent in framed contexts',
            'Ensure critical actions require additional user confirmation (e.g., CAPTCHA, re-authentication)'
        ],
        references: [
            { label: 'OWASP Clickjacking', url: 'https://owasp.org/www-community/attacks/Clickjacking' },
            { label: 'CWE-1021', url: 'https://cwe.mitre.org/data/definitions/1021.html' }
        ]
    },
    'Insecure Cookie': {
        icon: 'fa-cookie-bite',
        category: 'Session Management',
        definition: 'Insecure cookies are HTTP cookies that lack critical security attributes, making them vulnerable to interception, theft, or unauthorized access.',
        description: 'When cookies — especially session cookies — are missing security flags like Secure, HttpOnly, and SameSite, they become vulnerable. Cookies without the Secure flag can be intercepted over unencrypted HTTP connections. Cookies without HttpOnly can be accessed by JavaScript (enabling XSS-based theft). Missing SameSite enables CSRF attacks. These weaknesses can lead to session hijacking and account takeover.',
        impact: { confidentiality: 'High', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Set the Secure flag on all cookies to ensure they are only sent over HTTPS',
            'Set the HttpOnly flag on session cookies to prevent JavaScript access',
            'Use SameSite=Strict or SameSite=Lax to prevent cross-site request attacks',
            'Set appropriate cookie expiration/max-age — avoid long-lived session cookies',
            'Use the __Host- or __Secure- cookie prefix for additional protections',
            'Encrypt sensitive cookie values and validate them server-side'
        ],
        references: [
            { label: 'OWASP Cookie Security', url: 'https://owasp.org/www-community/controls/SecureCookieAttribute' },
            { label: 'CWE-614', url: 'https://cwe.mitre.org/data/definitions/614.html' }
        ]
    },
    'Sensitive Path': {
        icon: 'fa-folder-tree',
        category: 'Information Exposure',
        definition: 'Sensitive path exposure occurs when directories or files containing sensitive information (configuration files, backups, admin panels) are publicly accessible on a web server.',
        description: 'Web servers often contain files and directories that should not be publicly accessible — such as .git/, .env, wp-admin/, phpinfo.php, backup archives, and configuration files. Attackers use automated directory brute-forcing tools to discover these paths. Finding sensitive paths can reveal source code, credentials, database connection strings, API keys, or administrative interfaces.',
        impact: { confidentiality: 'High', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Remove unnecessary files (backups, test scripts, default pages) from the web root',
            'Block access to sensitive directories (.git, .svn, .env) via server configuration',
            'Implement proper access controls and authentication for admin interfaces',
            'Use a web application firewall (WAF) to block directory enumeration attempts',
            'Return consistent 404 responses for non-existent and restricted paths',
            'Regularly audit publicly accessible paths with scanning tools'
        ],
        references: [
            { label: 'OWASP Directory Traversal', url: 'https://owasp.org/www-community/attacks/Path_Traversal' },
            { label: 'CWE-538', url: 'https://cwe.mitre.org/data/definitions/538.html' }
        ]
    },
    'Open Redirection': {
        icon: 'fa-arrow-right-arrow-left',
        category: 'Input Validation',
        definition: 'Open Redirection is a vulnerability where a web application accepts user-controlled input to redirect users to an external URL without proper validation.',
        description: 'Open redirect vulnerabilities occur when a web application uses a user-supplied URL parameter to redirect the browser to a different site. Attackers exploit this to create phishing links that appear to come from a trusted domain, redirecting victims to malicious sites that steal credentials, install malware, or carry out further social engineering attacks.',
        impact: { confidentiality: 'Medium', integrity: 'Low', availability: 'Low' },
        remediation: [
            'Avoid using user-controlled input for redirect destinations',
            'If redirects are necessary, use a whitelist of allowed URLs/domains',
            'Use indirect references (e.g., numeric IDs mapping to predefined URLs)',
            'Validate that redirect URLs are relative paths (same domain)',
            'Warn users before redirecting to external URLs',
            'Use the Referer header to verify redirect requests come from your application'
        ],
        references: [
            { label: 'OWASP Open Redirect', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Unvalidated_Redirects_and_Forwards_Cheat_Sheet.html' },
            { label: 'CWE-601', url: 'https://cwe.mitre.org/data/definitions/601.html' }
        ]
    },
    'SSL/TLS Issue': {
        icon: 'fa-lock-open',
        category: 'Cryptography',
        definition: 'SSL/TLS issues encompass vulnerabilities in the implementation or configuration of SSL/TLS encryption, which secures data transmitted between clients and servers.',
        description: 'These vulnerabilities include expired or self-signed certificates, support for deprecated protocols (SSL 3.0, TLS 1.0/1.1), weak cipher suites, missing HSTS headers, certificate chain issues, and mixed content. These weaknesses can allow attackers to intercept encrypted traffic through man-in-the-middle attacks, downgrade attacks, or exploit known protocol vulnerabilities like POODLE, BEAST, or CRIME.',
        impact: { confidentiality: 'High', integrity: 'High', availability: 'Low' },
        remediation: [
            'Use valid, trusted certificates from a reputable Certificate Authority (CA)',
            'Disable SSL 3.0, TLS 1.0, and TLS 1.1 — only allow TLS 1.2 and TLS 1.3',
            'Configure strong cipher suites and prefer forward secrecy (ECDHE)',
            'Enable HTTP Strict Transport Security (HSTS) with a long max-age',
            'Redirect all HTTP traffic to HTTPS',
            'Regularly renew certificates before expiration and monitor for revocation',
            'Use tools like SSL Labs (ssllabs.com) to test and grade your SSL/TLS configuration'
        ],
        references: [
            { label: 'OWASP TLS', url: 'https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Security_Cheat_Sheet.html' },
            { label: 'CWE-295', url: 'https://cwe.mitre.org/data/definitions/295.html' },
            { label: 'SSL Labs', url: 'https://www.ssllabs.com/ssltest/' }
        ]
    },
    '_default': {
        icon: 'fa-shield-halved',
        category: 'Security',
        definition: 'This vulnerability represents a security weakness detected during the scan that could potentially be exploited by an attacker.',
        description: 'A security vulnerability was identified that may pose a risk to the confidentiality, integrity, or availability of the application and its data. The specific impact depends on the nature of the vulnerability, its location, and the sensitivity of the affected system.',
        impact: { confidentiality: 'Medium', integrity: 'Medium', availability: 'Low' },
        remediation: [
            'Investigate the vulnerability details and evidence provided in the scan report',
            'Assess the risk based on the severity rating and the sensitivity of the affected system',
            'Implement appropriate fixes following security best practices',
            'Test the fix to ensure the vulnerability is properly remediated',
            'Consider conducting a penetration test for further validation'
        ],
        references: [
            { label: 'OWASP Top 10', url: 'https://owasp.org/www-project-top-ten/' },
            { label: 'OWASP Testing Guide', url: 'https://owasp.org/www-project-web-security-testing-guide/' }
        ]
    }
};

/**
 * Look up vulnerability knowledge by type string.
 * Falls back to '_default' for unknown types.
 */
function getVulnKnowledge(vulnType) {
    // Direct match
    if (VULN_KNOWLEDGE_BASE[vulnType]) return VULN_KNOWLEDGE_BASE[vulnType];

    // Partial match — check if any key is a substring of the type or vice-versa
    const lowerType = vulnType.toLowerCase();
    for (const key of Object.keys(VULN_KNOWLEDGE_BASE)) {
        if (key === '_default') continue;
        if (lowerType.includes(key.toLowerCase()) || key.toLowerCase().includes(lowerType)) {
            return VULN_KNOWLEDGE_BASE[key];
        }
    }

    return VULN_KNOWLEDGE_BASE['_default'];
}

/**
 * Open the vulnerability detail modal for a given vulnerability type and severity.
 * Called when a user clicks on a vulnerability name.
 */
function openVulnModal(vulnType, severity) {
    const knowledge = getVulnKnowledge(vulnType);
    const overlay = document.getElementById('vulnDetailModal');
    const accent = document.getElementById('vulnModalAccent');
    const title = document.getElementById('vulnModalTitle');
    const meta = document.getElementById('vulnModalMeta');
    const body = document.getElementById('vulnModalBody');

    // Set severity accent
    const sevClass = (severity || 'info').toLowerCase();
    accent.className = `vuln-modal-accent severity-${sevClass}`;

    // Severity badge colors
    let badgeBg, badgeColor;
    switch (severity) {
        case 'Critical': badgeBg = '#FDE2E2'; badgeColor = '#991B1B'; break;
        case 'High': badgeBg = '#FEE2E2'; badgeColor = '#EF4444'; break;
        case 'Medium': badgeBg = '#FEF3C7'; badgeColor = '#D97706'; break;
        case 'Low': badgeBg = '#E0E7FF'; badgeColor = '#4338CA'; break;
        default: badgeBg = '#F3F4F6'; badgeColor = '#6B7280'; break;
    }

    // Title
    title.innerHTML = `<i class="fas ${knowledge.icon}"></i>${escapeHtml(vulnType)}`;

    // Meta (severity badge + category)
    meta.innerHTML = `
        <span class="vuln-modal-severity-badge" style="background:${badgeBg}; color:${badgeColor}">${severity || 'Info'}</span>
        <span class="vuln-modal-category"><i class="fas fa-tag"></i>${escapeHtml(knowledge.category)}</span>
    `;

    // Body content
    const impactLevel = severity === 'Critical' ? 'critical' : severity === 'High' ? 'high' : severity === 'Medium' ? 'medium' : 'low';

    let bodyHtml = `
        <!-- Definition -->
        <div class="vuln-modal-section">
            <div class="vuln-modal-section-title"><i class="fas fa-book"></i> Definition</div>
            <div class="vuln-modal-section-content">${escapeHtml(knowledge.definition)}</div>
        </div>

        <!-- How it works -->
        <div class="vuln-modal-section">
            <div class="vuln-modal-section-title"><i class="fas fa-gears"></i> How It Works</div>
            <div class="vuln-modal-section-content">${escapeHtml(knowledge.description)}</div>
        </div>

        <!-- Impact -->
        <div class="vuln-modal-section">
            <div class="vuln-modal-section-title"><i class="fas fa-bolt"></i> Impact Assessment</div>
            <div class="vuln-modal-impact">
                <div class="vuln-modal-impact-item">
                    <div class="vuln-modal-impact-label">Confidentiality</div>
                    <div class="vuln-modal-impact-value impact-${knowledge.impact.confidentiality.toLowerCase()}">${knowledge.impact.confidentiality}</div>
                </div>
                <div class="vuln-modal-impact-item">
                    <div class="vuln-modal-impact-label">Integrity</div>
                    <div class="vuln-modal-impact-value impact-${knowledge.impact.integrity.toLowerCase()}">${knowledge.impact.integrity}</div>
                </div>
                <div class="vuln-modal-impact-item">
                    <div class="vuln-modal-impact-label">Availability</div>
                    <div class="vuln-modal-impact-value impact-${knowledge.impact.availability.toLowerCase()}">${knowledge.impact.availability}</div>
                </div>
            </div>
        </div>

        <div class="vuln-modal-divider"></div>

        <!-- Remediation -->
        <div class="vuln-modal-section">
            <div class="vuln-modal-section-title"><i class="fas fa-wrench"></i> Remediation Steps</div>
            <ol class="vuln-modal-remediation">
                ${knowledge.remediation.map(step => `<li>${escapeHtml(step)}</li>`).join('')}
            </ol>
        </div>

        <!-- References -->
        <div class="vuln-modal-section">
            <div class="vuln-modal-section-title"><i class="fas fa-external-link-alt"></i> References</div>
            <div class="vuln-modal-references">
                ${knowledge.references.map(ref => `<a href="${ref.url}" target="_blank" rel="noopener noreferrer" class="vuln-modal-ref-link"><i class="fas fa-arrow-up-right-from-square"></i>${escapeHtml(ref.label)}</a>`).join('')}
            </div>
        </div>
    `;

    body.innerHTML = bodyHtml;

    // Show modal
    overlay.classList.add('active');
    document.body.style.overflow = 'hidden';
}

/**
 * Close the vulnerability detail modal.
 */
function closeVulnModal() {
    const overlay = document.getElementById('vulnDetailModal');
    overlay.classList.remove('active');
    document.body.style.overflow = '';
}

// Close modal on backdrop click
document.addEventListener('click', (e) => {
    const overlay = document.getElementById('vulnDetailModal');
    if (e.target === overlay) {
        closeVulnModal();
    }
});

// Close modal on Escape key
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const overlay = document.getElementById('vulnDetailModal');
        if (overlay && overlay.classList.contains('active')) {
            closeVulnModal();
        }
    }
});

/**
 * Create a clickable vulnerability name HTML string.
 * Used in results tables to make vulnerability names interactive.
 */
function buildVulnNameLink(vulnType, vulnName, severity) {
    const displayType = escapeHtml(vulnType || 'Unknown');
    const displayName = vulnName ? ` <span style="color:var(--light-text);">(${escapeHtml(vulnName)})</span>` : '';
    const escapedType = escapeHtml(vulnType || 'Unknown').replace(/'/g, "\\'");
    const escapedSeverity = escapeHtml(severity || 'Info').replace(/'/g, "\\'");

    return `<span class="vuln-name-link" onclick="openVulnModal('${escapedType}', '${escapedSeverity}')" title="Click for details about ${displayType}"><strong>${displayType}</strong>${displayName}<span class="vuln-click-hint"><i class="fas fa-circle-info"></i></span></span>`;
}

