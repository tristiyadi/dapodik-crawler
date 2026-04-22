const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log('Navigating to DAPO root...');
  try {
    await page.goto('https://dapo.kemendikdasmen.go.id/pd', { waitUntil: 'networkidle', timeout: 90000 });
    
    // Wait for any table to appear
    console.log('Waiting for any table...');
    await page.waitForSelector('table', { timeout: 60000 });

    const data = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      return links.map(link => {
        const href = link.getAttribute('href');
        if (href && href.includes('/pd/')) {
          const match = href.match(/\/pd\/(\d+)\/(\d+)/);
          return {
            name: link.innerText.trim(),
            level: match ? match[1] : null,
            code: match ? match[2] : null,
            href: href
          };
        }
        return null;
      }).filter(item => item !== null && item.code !== null);
    });

    if (data.length === 0) {
      console.log('No links found. Page content:');
      console.log(await page.content());
    } else {
      console.log('Discovered Items:');
      console.log(JSON.stringify(data, null, 2));
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await browser.close();
  }
})();
