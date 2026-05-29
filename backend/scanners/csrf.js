/**
 * CSRF Scanner — Checks forms for missing anti-CSRF tokens
 */

const CSRF_TOKEN_NAMES = [
    'csrf', 'csrf_token', '_csrf', 'csrftoken', 'csrfmiddlewaretoken',
    '_token', 'authenticity_token', 'token', 'anti-csrf',
    'xsrf', '_xsrf', 'xsrf_token', '__requestverificationtoken',
    'antiforgery', '__antixsrftoken',
];

function checkCSRF(forms, cookies) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    // Check SameSite cookie attribute
    let hasSameSiteCookie = false;
    if (cookies) {
        const cookieStr = Array.isArray(cookies) ? cookies.join('; ') : String(cookies);
        if (/samesite\s*=\s*(strict|lax)/i.test(cookieStr)) {
            hasSameSiteCookie = true;
        }
    }

    // Check each POST form for CSRF tokens
    for (const form of forms) {
        if (form.method && form.method.toUpperCase() !== 'POST') continue;

        // Look for CSRF token in form fields
        const hasToken = form.fields && form.fields.some(field => {
            const fieldName = (field.name || '').toLowerCase();
            return CSRF_TOKEN_NAMES.some(tokenName => fieldName.includes(tokenName));
        });

        // Look for CSRF token in hidden inputs
        const hasHiddenToken = form.fields && form.fields.some(field => {
            return field.type === 'hidden' && field.value && field.value.length > 16;
        });

        if (!hasToken && !hasHiddenToken && !hasSameSiteCookie) {
            vulnerabilities.push({
                type: 'Cross-Site Request Forgery (CSRF)',
                name: 'Missing Anti-CSRF Token',
                severity: 'Medium',
                location: `Form: ${form.action || 'unknown'}`,
                description: `POST form at "${form.action || 'unknown'}" has no CSRF token and no SameSite cookie protection. An attacker could forge requests.`
            });
            scoreDeduction += 10;
        }
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkCSRF };
