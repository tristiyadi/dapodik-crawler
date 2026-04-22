const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true
  });
  const page = await context.newPage();

  console.log('Navigating to DAPO root...');
  try {
    await page.goto('https://dapo.kemendikdasmen.go.id/pd', { waitUntil: 'networkidle', timeout: 60000 });
    
    // Wait for the WAF/loading to finish and the table to appear
    console.log('Waiting for table to load...');
    await page.waitForSelector('.buttons-excel', { timeout: 60000 });

    console.log('Clicking download button...');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('.buttons-excel')
    ]);

    const downloadPath = path.join(__dirname, 'downloads', 'provinces.xlsx');
    if (!fs.existsSync(path.join(__dirname, 'downloads'))) {
      fs.mkdirSync(path.join(__dirname, 'downloads'));
    }
    
    await download.saveAs(downloadPath);
    console.log(`Download completed: ${downloadPath}`);

  } catch (error) {
    console.error('Error during download:', error);
  } finally {
    await browser.close();
  }
})();
