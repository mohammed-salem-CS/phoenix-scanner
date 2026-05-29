const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { DIRSEARCH_PATH } = require('../config');


async function runDirsearch(targetUrl) {
    return new Promise((resolve) => {
        // Create a unique name for the temporary JSON report
        const reportFile = `report_${Date.now()}.json`;
        const reportPath = path.join(__dirname, reportFile);

        // Command structure: python dirsearch.py -u [url] -e [extensions] --json-report [path]
        const command = `python "${DIRSEARCH_PATH}" -u ${targetUrl} -e php,html,js,txt --json-report "${reportPath}"`;

        console.log(`[Phoenix]  Starting Directory Discovery...`);

        exec(command, (error, stdout, stderr) => {
            let results = { vulnerabilities: [], scoreDeduction: 0 };

            try {
                // Check if the report file was created
                if (fs.existsSync(reportPath)) {
                    const data = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

                    // Map findings to your UI format
                    data.results.forEach(item => {
                        // Only report successful (200) or interesting (403) hits
                        if (item.status === 200 || item.status === 403) {
                            results.vulnerabilities.push({
                                type: "Sensitive Path",
                                name: `Discovered: ${item.path}`,
                                severity: item.status === 200 ? "Medium" : "Low",
                                location: item.url
                            });
                            results.scoreDeduction += 5;
                        }
                    });

                    // Delete the temp JSON file after reading it
                    fs.unlinkSync(reportPath);
                }
            } catch (parseError) {
                console.error("[Phoenix] Error parsing Dirsearch output:", parseError.message);
            }

            resolve(results);
        });
    });
}

module.exports = { runDirsearch };