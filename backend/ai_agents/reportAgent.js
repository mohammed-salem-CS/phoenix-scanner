// =============================================
//  PHOENIX AI REPORT AGENT — Gemini-Powered
// =============================================
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Generates a comprehensive AI-powered security report from scan results.
 * Uses Google Gemini to analyze vulnerabilities and provide deep insights.
 *
 * @param {Object} scanData - The scan document from MongoDB
 * @param {string} apiKey - Gemini API key
 * @returns {string} AI-generated Markdown report
 */
async function generateAIReport(scanData, apiKey) {
    if (!apiKey) {
        throw new Error('Gemini API key is not configured. Set GEMINI_API_KEY in your .env file.');
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build a structured summary of vulnerabilities for the AI
    const vulnSummary = buildVulnSummary(scanData);

    const prompt = `
You are **Phoenix AI**, an elite cybersecurity analyst integrated into the Phoenix Vulnerability Scanner.
You have just received the results of an automated security scan. Your job is to produce a **comprehensive, professional security assessment report** written in Markdown.

---

## SCAN METADATA
- **Target URL:** ${scanData.targetUrl}
- **Scan Date:** ${new Date(scanData.timestamp).toLocaleString()}
- **Scan Duration:** ${scanData.duration || 'N/A'}
- **Scan Status:** ${scanData.status}
- **Total Vulnerabilities Found:** ${scanData.vulnerabilities.length}

## VULNERABILITY DATA
${vulnSummary}

---

## YOUR REPORT MUST INCLUDE THE FOLLOWING SECTIONS:

### 1. Executive Summary
Write a 3-5 sentence high-level overview of the security posture of the target. Mention the total count of vulnerabilities by severity. Give a risk rating (Critical / High / Medium / Low) for the overall target.

### 2. Severity Distribution
Provide a summary table showing counts by severity (Critical, High, Medium, Low/Info).

### 3. Detailed Vulnerability Analysis
For **each unique vulnerability type found**, create a subsection that includes:
- **Vulnerability Name & Type**
- **Severity Level** with a brief justification
- **Affected Location(s)** — list the specific URLs or locations
- **Evidence Found** — show the actual sensitive data or evidence that was detected (if available)
- **How It Was Discovered** — explain the detection methodology used (pattern matching, header analysis, form testing, payload injection, etc.)
- **Potential Impact** — describe what an attacker could achieve by exploiting this vulnerability. Be specific: data theft, session hijacking, remote code execution, etc.
- **Remediation Steps** — provide clear, actionable steps to fix the vulnerability. Include code examples or configuration snippets where appropriate.

### 4. Risk Assessment Matrix
Create a table mapping each vulnerability to its CVSS-like risk score, likelihood of exploitation, and business impact.

### 5. Prioritized Action Plan
List the top 5-10 most critical actions the development team should take, ordered by priority (most urgent first).

### 6. Conclusion
Summarize the key findings and provide an overall security recommendation.

---

## IMPORTANT FORMATTING RULES:
- Use proper Markdown headers (##, ###, ####)
- Use tables where appropriate
- Use **bold** for emphasis on critical terms
- Use code blocks (\`\`\`) for configuration examples and code fixes
- Use bullet points for lists
- Be thorough but avoid unnecessary repetition
- Group similar vulnerabilities together to keep the report organized
- The report should be professional quality, suitable for a graduation project presentation
- Write the report in English
`;

    console.log('[Phoenix AI] Sending scan data to Gemini for analysis...');

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const reportText = response.text();

        console.log(`[Phoenix AI] Report generated successfully (${reportText.length} characters)`);
        return reportText;
    } catch (error) {
        console.error('[Phoenix AI] Gemini API Error:', error.message);
        throw new Error(`AI Report generation failed: ${error.message}`);
    }
}

/**
 * Builds a structured text summary of all vulnerabilities for the AI prompt.
 */
function buildVulnSummary(scanData) {
    if (!scanData.vulnerabilities || scanData.vulnerabilities.length === 0) {
        return 'No vulnerabilities were found during this scan.';
    }

    // Group vulnerabilities by type for a cleaner summary
    const grouped = {};
    scanData.vulnerabilities.forEach(vuln => {
        const key = vuln.type || 'Unknown';
        if (!grouped[key]) {
            grouped[key] = [];
        }
        grouped[key].push(vuln);
    });

    let summary = '';
    let index = 1;

    for (const [type, vulns] of Object.entries(grouped)) {
        summary += `\n### Category: ${type} (${vulns.length} findings)\n`;

        vulns.forEach(vuln => {
            summary += `\n**[${index}] ${vuln.name || vuln.type}**\n`;
            summary += `- Severity: ${vuln.severity}\n`;
            summary += `- Location: ${vuln.location || 'N/A'}\n`;

            if (vuln.description) {
                summary += `- Description: ${vuln.description}\n`;
            }

            if (vuln.evidence) {
                // Truncate very long evidence to stay within token limits
                const evidence = vuln.evidence.length > 300
                    ? vuln.evidence.substring(0, 300) + '... (truncated)'
                    : vuln.evidence;
                summary += `- Evidence: ${evidence}\n`;
            }

            index++;
        });
    }

    return summary;
}

module.exports = { generateAIReport };
