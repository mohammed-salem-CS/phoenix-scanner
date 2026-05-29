const SENSITIVE_REGEX = [
    // API Keys & Tokens
    { name: 'Generic API Key', regex: /api_key\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/i },
    { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
    { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
    { name: 'JWT Token', regex: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+/ },

    // Credentials & Secrets
    { name: 'Private Key', regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
    { name: 'Hardcoded Password', regex: /password\s*=\s*['"][a-zA-Z0-9@#$%^&*]{3,}['"]/i },
    { name: 'Database Connection String', regex: /mongodb:\/\/|mysql:\/\/|postgres:\/\/|redis:\/\//i },
    { name: 'Secret Key', regex: /secret[_-]?key\s*[:=]\s*['"][a-zA-Z0-9]{8,}['"]/i },

    // Server & Path Info
    { name: 'Server Path Disclosure', regex: /\/var\/www\/|C:\\\\inetpub|\/home\/\w+\//i },
    { name: 'Internal IP Address', regex: /(?:10|172\.(?:1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}/ },
    { name: 'Error Stack Trace', regex: /at\s+\w+\s+\(.*:\d+:\d+\)/m },

    // Developer Comments & Debug Info
    { name: 'Developer Comment (TODO)', regex: /TODO:/i },
    { name: 'Developer Comment (FIXME)', regex: /FIXME:/i },
    { name: 'Debug Mode Enabled', regex: /debug\s*[:=]\s*(true|1|on)/i },
    { name: 'Sensitive HTML Comment', regex: /<!--[\s\S]*?(password|secret|key|token|admin|debug|credentials)[\s\S]*?-->/i },

    // Email Addresses (potential data exposure)
    { name: 'Email Address Exposure', regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },

    // Version Disclosure (in headers or body)
    { name: 'PHP Version Disclosure', regex: /PHP\/[0-9.]+/i },
    { name: 'Apache Version Disclosure', regex: /Apache\/[0-9.]+/i },
    { name: 'Nginx Version Disclosure', regex: /nginx\/[0-9.]+/i },
];

function checkSensitiveInfo(htmlBody, url) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    if (!htmlBody) return { vulnerabilities, scoreDeduction };

    SENSITIVE_REGEX.forEach(item => {
        // Create a fresh copy of the regex to ensure lastIndex is reset (important for /g flags)
        const regex = new RegExp(item.regex.source, item.regex.flags.includes('g') ? item.regex.flags : item.regex.flags + 'g');
        const matches = [];
        let match;
        const MAX_MATCHES = 3; // Limit to avoid huge outputs

        while ((match = regex.exec(htmlBody)) !== null && matches.length < MAX_MATCHES) {
            let matchedText = match[0];

            // Truncate very long matches for readability
            if (matchedText.length > 120) {
                matchedText = matchedText.substring(0, 120) + '...';
            }

            matches.push(matchedText.trim());

            // Prevent infinite loop on zero-length matches
            if (match.index === regex.lastIndex) regex.lastIndex++;
        }

        if (matches.length > 0) {
            const isLow = item.name.includes('TODO') || item.name.includes('FIXME') || item.name.includes('Email');

            // Build the evidence string with all found instances
            const evidenceList = matches.map((m, i) => `[${i + 1}] ${m}`).join('\n');

            vulnerabilities.push({
                type: 'Information Disclosure',
                name: `Sensitive Data Exposure (${item.name})`,
                severity: isLow ? 'Low' : 'High',
                location: url,
                description: `Found sensitive information in source code matching pattern: ${item.name}`,
                evidence: evidenceList
            });
            scoreDeduction += isLow ? 2 : 15;
        }
    });

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkSensitiveInfo };