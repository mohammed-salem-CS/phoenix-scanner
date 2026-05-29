function checkClickjacking(headers) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    const xFrame = headers['x-frame-options'];
    const csp = headers['content-security-policy'];

    let protected = false;


    if (xFrame && (xFrame.toLowerCase() === 'deny' || xFrame.toLowerCase() === 'sameorigin')) {
        protected = true;
    }

    if (csp && csp.includes('frame-ancestors')) {
        protected = true;
    }

    if (!protected) {
        vulnerabilities.push({
            type: 'UI Redress',
            name: 'Clickjacking',
            severity: 'Medium',
            location: 'HTTP Response Header',
            description: 'The website can be embedded in an iframe, making it vulnerable to Clickjacking attacks. Missing "X-Frame-Options" or CSP "frame-ancestors".'
        });
        scoreDeduction += 10;
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkClickjacking };