const { chromium } = require('playwright');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto('https://ubuntu.com/security/notices?offset=0');
    const html = await page.content();
    console.log(html.substring(html.indexOf('USN-8'), html.indexOf('USN-8') + 1000));
    await browser.close();
})();
