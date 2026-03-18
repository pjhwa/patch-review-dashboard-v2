const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.goto('https://access.redhat.com/errata/RHSA-2026:3488', { waitUntil: 'domcontentloaded', timeout: 30000 });

    const details = await page.evaluate(() => {
        const main = document.querySelector('#main-content') || document.body;
        const clones = main.cloneNode(true);
        clones.querySelectorAll('nav, footer, script, style, .hide').forEach(n => n.remove());

        function extractTextWithNewlines(node) {
            if (node.nodeType === 3) return node.nodeValue || '';
            if (node.nodeType !== 1) return '';
            let text = '';
            const isBlock = /^(DIV|P|H[1-6]|LI|TR|UL|OL|TABLE|BLOCKQUOTE|PRE)$/i.test(node.tagName);
            for (let child of node.childNodes) text += extractTextWithNewlines(child);
            if (isBlock) text = '\n' + text + '\n';
            return text;
        }

        let text = extractTextWithNewlines(clones)
            .replace(/[ \t]+/g, ' ')
            .replace(/ \n /g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();

        const detailsObj = { overview: '', description: '', packages: [], cves: [], fixes: '' };
        const getSection = (header, next) => {
            const regex = new RegExp(`(?:^|\\n)${header}\\s*\\n(.*?)(?:\\n(?:${next.join('|')})\\s*\\n|$)`, 's');
            const match = text.match(regex);
            return match ? match[1].trim() : '';
        };

        const rhHeaders = ['Synopsis', 'Topic', 'Description', 'Solution', 'Affected Products', 'Fixes', 'CVEs', 'References', 'Updated Packages'];
        detailsObj.overview = getSection('Topic', rhHeaders);
        detailsObj.description = getSection('Description', rhHeaders);
        detailsObj.fixes = getSection('Fixes', rhHeaders);
        const cvesText = getSection('CVEs', rhHeaders);
        detailsObj.cves = cvesText ? [...new Set(cvesText.match(/CVE-\d{4}-\d+/g) || [])] : [...new Set(text.match(/CVE-\d{4}-\d+/g) || [])];
        const pkgsText = getSection('Updated Packages', rhHeaders);
        if (pkgsText) detailsObj.packages = pkgsText.split('\n').filter(l => l.includes('.rpm')).map(l => l.trim().split(' ')[0]);

        return detailsObj;
    });
    console.log(JSON.stringify(details, null, 2));
    await browser.close();
})();
