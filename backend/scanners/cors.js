const axios = require('axios');

async function checkCORS(url) {
    const vulnerabilities = [];
    let scoreDeduction = 0;

    // Test multiple origin variations
    const TEST_ORIGINS = [
        { origin: 'http://evil.com', name: 'Evil Origin' },
        { origin: 'https://' + new URL(url).hostname + '.evil.com', name: 'Subdomain Trick' },
        { origin: 'null', name: 'Null Origin' },
        { origin: 'http://localhost', name: 'Localhost Origin' },
    ];

    for (const test of TEST_ORIGINS) {
        try {
            const response = await axios.get(url, {
                headers: { 'Origin': test.origin },
                timeout: 5000,
                validateStatus: () => true
            });

            const acao = response.headers['access-control-allow-origin'];
            const acac = response.headers['access-control-allow-credentials'];

            // Wildcard CORS (only report once)
            if (acao === '*' && test === TEST_ORIGINS[0]) {
                vulnerabilities.push({
                    type: 'CORS Misconfiguration',
                    name: 'Insecure CORS (Wildcard)',
                    severity: 'Low',
                    location: 'HTTP Headers',
                    description: 'The server allows access from ANY origin (*). This is risky for APIs.'
                });
                scoreDeduction += 5;
            }

            // Reflected origin
            else if (acao === test.origin) {
                let severity = 'Medium';
                let desc = `The server reflects the Origin header: ${test.origin} (${test.name}).`;

                if (acac === 'true') {
                    severity = 'High';
                    desc += ' AND Access-Control-Allow-Credentials is TRUE. Allows cookie theft!';
                    scoreDeduction += 20;
                } else {
                    scoreDeduction += 10;
                }

                vulnerabilities.push({
                    type: 'CORS Misconfiguration',
                    name: `Insecure CORS (${test.name})`,
                    severity: severity,
                    location: 'HTTP Headers',
                    description: desc
                });

                // If evil.com origin is reflected, no need to test further
                return { vulnerabilities, scoreDeduction };
            }

            // Null origin accepted
            else if (test.origin === 'null' && acao === 'null') {
                let severity = acac === 'true' ? 'High' : 'Medium';
                vulnerabilities.push({
                    type: 'CORS Misconfiguration',
                    name: 'Insecure CORS (Null Origin)',
                    severity: severity,
                    location: 'HTTP Headers',
                    description: `Server accepts 'null' Origin. Sandboxed iframes can exploit this.${acac === 'true' ? ' Credentials allowed!' : ''}`
                });
                scoreDeduction += acac === 'true' ? 20 : 10;
            }

        } catch (error) {
            // continue to next origin
        }
    }

    return { vulnerabilities, scoreDeduction };
}

module.exports = { checkCORS };