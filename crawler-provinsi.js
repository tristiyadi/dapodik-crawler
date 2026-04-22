/**
 * DAPO Kemendikdasmen Crawler — Province Only
 * 
 * Crawls https://dapo.kemendikdasmen.go.id/pd:
 *   Level 0: /pd              → National (downloads national Excel)
 *   Level 1: /pd/1/{code}     → Province (downloads Excel for each province)
 * 
 * Downloads the Excel file at each level via the ".buttons-excel" button.
 * Does NOT drill deeper into regencies/districts/schools.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────
const BASE_URL = 'https://dapo.kemendikdasmen.go.id';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads', 'provinsi');
const PROGRESS_FILE = path.join(__dirname, 'progress-provinsi.json');
const MAX_DEPTH = 1;          // 0=national, 1=province only
const DELAY_MS = 3000;        // delay between requests (be respectful)
const NAV_TIMEOUT = 120000;   // 2 min for navigation
const WAIT_TIMEOUT = 90000;   // 1.5 min for element wait
const MAX_RETRIES = 3;        // retry per page

// ── Utilities ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').trim();
}

function loadProgress() {
  if (fs.existsSync(PROGRESS_FILE)) {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf-8'));
  }
  return { completed: [] };
}

function saveProgress(progress) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

function isCompleted(progress, key) {
  return progress.completed.includes(key);
}

function markCompleted(progress, key) {
  if (!progress.completed.includes(key)) {
    progress.completed.push(key);
    saveProgress(progress);
  }
}

// ── Core: Navigate & wait for page to fully load past WAF ──────────────────
const MAX_WAF_RELOADS = 15;

async function navigateAndWait(page, url) {
  console.log(`   → Navigating to ${url}`);

  let wafDetected = false;
  for (let attempt = 1; attempt <= MAX_WAF_RELOADS; attempt++) {
    if (attempt === 1) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } else {
      console.log(`   ↻ WAF not detected, reloading... (attempt ${attempt}/${MAX_WAF_RELOADS})`);
      await sleep(1000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    }

    try {
      const hasWafText = await page.evaluate(() => {
        const bodyText = document.body ? document.body.innerText : '';
        return bodyText.includes('Dynamic Decrypting') || 
               bodyText.includes('网页被保护') ||
               bodyText.includes('正在解密中');
      });

      if (hasWafText) {
        console.log(`   🔒 WAF "Dynamic Decrypting" detected (attempt ${attempt})`);
        wafDetected = true;
        break;
      }

      const alreadyLoaded = await page.$('.buttons-excel');
      if (alreadyLoaded) {
        console.log(`   ✓ Page already loaded (no WAF needed)`);
        await sleep(2000);
        return;
      }
    } catch (e) {
      // page might be navigating, ignore
    }
  }

  if (!wafDetected) {
    console.log(`   ⚠ WAF screen not detected after ${MAX_WAF_RELOADS} attempts, waiting for content anyway...`);
  }

  await page.waitForSelector('.buttons-excel', { timeout: WAIT_TIMEOUT });
  await sleep(2000);
}

// ── Core: Download Excel file ──────────────────────────────────────────────
async function downloadExcel(page, dirPath, fileName) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  const filePath = path.join(dirPath, fileName);

  if (fs.existsSync(filePath)) {
    console.log(`   ✓ Already exists: ${filePath}`);
    return true;
  }

  try {
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.click('.buttons-excel')
    ]);
    await download.saveAs(filePath);
    console.log(`   ✓ Downloaded: ${filePath}`);
    return true;
  } catch (err) {
    console.warn(`   ✘ Download failed: ${err.message}`);
    return false;
  }
}

// ── Core: Extract child links from the current page ────────────────────────
async function extractChildren(page, expectedLevel) {
  return await page.evaluate((expLevel) => {
    const links = Array.from(document.querySelectorAll('a'));
    const results = [];
    const seen = new Set();

    for (const link of links) {
      const href = link.getAttribute('href');
      if (!href) continue;
      const match = href.match(/\/pd\/(\d+)\/(\d+)/);
      if (!match) continue;

      const level = parseInt(match[1]);
      const code = match[2].trim();

      if (level !== expLevel) continue;
      if (seen.has(code)) continue;
      seen.add(code);

      results.push({
        name: link.innerText.trim(),
        level,
        code,
        href: `/pd/${level}/${code}`
      });
    }
    return results;
  }, expectedLevel);
}

// ── Core: Recursive crawl ──────────────────────────────────────────────────
async function crawlLevel(browser, progress, urlPath, levelName, depth, parentDir) {
  const progressKey = `${depth}:${urlPath}`;

  if (isCompleted(progress, progressKey)) {
    console.log(`\n[Depth ${depth}] SKIP (done): ${levelName}`);
    return;
  }

  const safeName = sanitize(levelName);
  const currentDir = path.join(parentDir, safeName);
  const fullUrl = `${BASE_URL}${urlPath}`;

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Depth ${depth}] ${levelName}`);
  console.log(`  URL: ${fullUrl}`);
  console.log(`  Dir: ${currentDir}`);
  console.log('═'.repeat(60));

  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  let success = false;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await navigateAndWait(page, fullUrl);
      success = true;
      break;
    } catch (err) {
      console.warn(`   ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`   Retrying in ${DELAY_MS * 2}ms...`);
        await sleep(DELAY_MS * 2);
      }
    }
  }

  if (!success) {
    console.error(`   ✘ FAILED after ${MAX_RETRIES} attempts. Skipping.`);
    await page.close();
    await context.close();
    return;
  }

  const excelName = `${safeName}.xlsx`;
  await downloadExcel(page, currentDir, excelName);

  let children = [];
  if (depth < MAX_DEPTH) {
    const nextLevel = depth + 1;
    children = await extractChildren(page, nextLevel);
    console.log(`   Found ${children.length} children at level ${nextLevel}`);
  }

  await page.close();
  await context.close();

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    console.log(`\n   [${i + 1}/${children.length}] → ${child.name} (${child.code})`);
    await crawlLevel(browser, progress, child.href, child.name, depth + 1, currentDir);
    await sleep(DELAY_MS);
  }

  markCompleted(progress, progressKey);
}

// ── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  DAPO Crawler — Province Only (National + 39 Provinces)    ║');
  console.log('║  https://dapo.kemendikdasmen.go.id/pd                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\nDownloads dir: ${DOWNLOADS_DIR}`);
  console.log(`Max depth: ${MAX_DEPTH} (0=national, 1=province)`);
  console.log(`Delay between requests: ${DELAY_MS}ms\n`);

  if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  }

  const progress = loadProgress();
  console.log(`Loaded progress: ${progress.completed.length} items already done.\n`);

  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    await crawlLevel(browser, progress, '/pd', 'National', 0, DOWNLOADS_DIR);
  } catch (err) {
    console.error('\n\n✘ Fatal error:', err);
  } finally {
    await browser.close();
    console.log('\n\n✓ Crawler finished. Downloads are in:', DOWNLOADS_DIR);
  }
})();
