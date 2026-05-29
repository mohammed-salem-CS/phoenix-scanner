/**
 * Insecure Cookie Scanner — Checks Set-Cookie headers for missing security flags
 */

function checkInsecureCookies(headers) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    const setCookieHeaders = headers['set-cookie'];
    if (!setCookieHeaders) return { vulnerabilities, scoreDeduction };

    const cookies = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];

    for (const cookie of cookies) {
        const cookieName = cookie.split('=')[0].trim();
        const cookieLower = cookie.toLowerCase();
        const issues = [];

        // Check for session-like cookies (more critical)
        const isSession = /sess|token|auth|jwt|sid|login|user/i.test(cookieName);

        // A. Missing HttpOnly flag
        if (!cookieLower.includes('httponly')) {
            issues.push('HttpOnly');
        }

        // B. Missing Secure flag
        if (!cookieLower.includes('secure')) {
            issues.push('Secure');
        }

        // C. Missing SameSite attribute
        if (!cookieLower.includes('samesite')) {
            issues.push('SameSite');
        }

        if (issues.length > 0) {
            vulnerabilities.push({
                type: 'Insecure Cookie',
                name: `Cookie "${cookieName}" — Missing: ${issues.join(', ')}`,
                severity: isSession ? 'High' : 'Medium',
                location: 'Set-Cookie Header',
                description: `Cookie "${cookieName}" is missing security flags: ${issues.join(', ')}. ${isSession ? 'This appears to be a session cookie, making it high risk.' : ''}`
            });
            scoreDeduction += isSession ? 10 : 5;
        }
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkInsecureCookies };
