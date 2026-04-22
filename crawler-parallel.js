/**
 * DAPO Kemendikdasmen Parallel Crawler
 *
 * Uses Node.js worker_threads to run multiple browser instances simultaneously.
 *
 * Architecture:
 *   Main Thread:
 *     1. Launches a single browser to crawl Level 0 (National) and discover provinces.
 *     2. Splits province list into chunks and spawns N worker threads.
 *     3. Manages a shared progress file (workers report back via messages).
 *
 *   Worker Threads:
 *     Each worker launches its OWN headed Playwright browser and recursively
 *     crawls the assigned provinces (Level 1 → 2 → 3).
 *
 * Usage:
 *   node crawler-parallel.js              # default 10 workers
 *   node crawler-parallel.js --workers=5  # custom worker count
 */

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// ── Configuration ──────────────────────────────────────────────────────────
const BASE_URL = 'https://dapo.kemendikdasmen.go.id';
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const PROGRESS_FILE = path.join(__dirname, 'progress-parallel.json');
const MAX_DEPTH = 3;          // 0=national, 1=province, 2=regency, 3=district
const DELAY_MS = 3000;        // delay between requests (be respectful)
const NAV_TIMEOUT = 120000;   // 2 min for navigation
const WAIT_TIMEOUT = 90000;   // 1.5 min for element wait
const MAX_RETRIES = 3;        // retry per page
const MAX_WAF_RELOADS = 15;   // max reload attempts for WAF screen

// Parse --workers=N from CLI args (default: 10)
const DEFAULT_WORKERS = 10;

// ── Utilities ──────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').trim();
}

// ── Progress Management (Main thread only) ─────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
//  WORKER THREAD CODE
// ══════════════════════════════════════════════════════════════════════════════
if (!isMainThread) {
  const { workerId, provinces, completedSet, downloadsDir } = workerData;

  const TAG = `[Worker ${workerId}]`;

  // Worker keeps its own local set to avoid re-crawling within this session
  const localCompleted = new Set(completedSet);

  function wIsCompleted(key) {
    return localCompleted.has(key);
  }

  function wMarkCompleted(key) {
    if (!localCompleted.has(key)) {
      localCompleted.add(key);
      // Notify main thread to persist progress
      parentPort.postMessage({ type: 'completed', key });
    }
  }

  // ── Navigate & wait for WAF ──────────────────────────────────────────────
  async function navigateAndWait(page, url) {
    console.log(`${TAG}    → Navigating to ${url}`);

    let wafDetected = false;
    for (let attempt = 1; attempt <= MAX_WAF_RELOADS; attempt++) {
      if (attempt === 1) {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      } else {
        console.log(`${TAG}    ↻ WAF not detected, reloading... (attempt ${attempt}/${MAX_WAF_RELOADS})`);
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
          console.log(`${TAG}    🔒 WAF "Dynamic Decrypting" detected (attempt ${attempt})`);
          wafDetected = true;
          break;
        }

        const alreadyLoaded = await page.$('.buttons-excel');
        if (alreadyLoaded) {
          console.log(`${TAG}    ✓ Page already loaded (no WAF needed)`);
          await sleep(2000);
          return;
        }
      } catch (e) {
        // page might be navigating, ignore
      }
    }

    if (!wafDetected) {
      console.log(`${TAG}    ⚠ WAF screen not detected after ${MAX_WAF_RELOADS} attempts, waiting for content anyway...`);
    }

    await page.waitForSelector('.buttons-excel', { timeout: WAIT_TIMEOUT });
    await sleep(2000);
  }

  // ── Download Excel ────────────────────────────────────────────────────────
  async function downloadExcel(page, dirPath, fileName) {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }

    const filePath = path.join(dirPath, fileName);

    if (fs.existsSync(filePath)) {
      console.log(`${TAG}    ✓ Already exists: ${filePath}`);
      return true;
    }

    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.click('.buttons-excel')
      ]);
      await download.saveAs(filePath);
      console.log(`${TAG}    ✓ Downloaded: ${filePath}`);
      return true;
    } catch (err) {
      console.warn(`${TAG}    ✘ Download failed: ${err.message}`);
      return false;
    }
  }

  // ── Extract child links ──────────────────────────────────────────────────
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

  // ── Recursive crawl (within worker) ──────────────────────────────────────
  async function crawlLevel(browser, urlPath, levelName, depth, parentDir) {
    const progressKey = `${depth}:${urlPath}`;

    if (wIsCompleted(progressKey)) {
      console.log(`${TAG} [Depth ${depth}] SKIP (done): ${levelName}`);
      return;
    }

    const safeName = sanitize(levelName);
    const currentDir = path.join(parentDir, safeName);
    const fullUrl = `${BASE_URL}${urlPath}`;

    console.log(`\n${TAG} ${'═'.repeat(50)}`);
    console.log(`${TAG} [Depth ${depth}] ${levelName}`);
    console.log(`${TAG}   URL: ${fullUrl}`);
    console.log(`${TAG}   Dir: ${currentDir}`);
    console.log(`${TAG} ${'═'.repeat(50)}`);

    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    let success = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await navigateAndWait(page, fullUrl);
        success = true;
        break;
      } catch (err) {
        console.warn(`${TAG}    ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) {
          console.log(`${TAG}    Retrying in ${DELAY_MS * 2}ms...`);
          await sleep(DELAY_MS * 2);
        }
      }
    }

    if (!success) {
      console.error(`${TAG}    ✘ FAILED after ${MAX_RETRIES} attempts. Skipping.`);
      await page.close();
      await context.close();
      return;
    }

    // Download Excel
    const excelName = `${safeName}.xlsx`;
    await downloadExcel(page, currentDir, excelName);

    // Discover children if not at max depth
    let children = [];
    if (depth < MAX_DEPTH) {
      const nextLevel = depth + 1;
      children = await extractChildren(page, nextLevel);
      console.log(`${TAG}    Found ${children.length} children at level ${nextLevel}`);
    }

    await page.close();
    await context.close();

    // Recurse into children sequentially within this worker
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      console.log(`${TAG}    [${i + 1}/${children.length}] → ${child.name} (${child.code})`);
      await crawlLevel(browser, child.href, child.name, depth + 1, currentDir);
      await sleep(DELAY_MS);
    }

    wMarkCompleted(progressKey);
  }

  // ── Worker entry point ───────────────────────────────────────────────────
  (async () => {
    console.log(`${TAG} Starting with ${provinces.length} provinces to crawl`);

    const browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    try {
      for (let i = 0; i < provinces.length; i++) {
        const prov = provinces[i];
        console.log(`\n${TAG} ▶ Province ${i + 1}/${provinces.length}: ${prov.name}`);
        await crawlLevel(browser, prov.href, prov.name, 1, downloadsDir);
        await sleep(DELAY_MS);
      }
    } catch (err) {
      console.error(`${TAG} Fatal error:`, err);
    } finally {
      await browser.close();
      console.log(`${TAG} ✓ Finished.`);
      parentPort.postMessage({ type: 'done', workerId });
    }
  })();

  // ═══════════════════════════════════════════════════════════════════════════
  //  END OF WORKER CODE — everything below runs only in the MAIN thread
  // ═══════════════════════════════════════════════════════════════════════════

} else {
  // ══════════════════════════════════════════════════════════════════════════
  //  MAIN THREAD CODE
  // ══════════════════════════════════════════════════════════════════════════

  function parseWorkerCount() {
    const arg = process.argv.find(a => a.startsWith('--workers='));
    if (arg) {
      const n = parseInt(arg.split('=')[1]);
      if (n > 0) return n;
    }
    return DEFAULT_WORKERS;
  }

  // Distribute items as evenly as possible across N buckets
  function chunkArray(arr, n) {
    const chunks = Array.from({ length: n }, () => []);
    arr.forEach((item, i) => {
      chunks[i % n].push(item);
    });
    return chunks.filter(c => c.length > 0);
  }

  async function discoverProvinces(progress) {
    console.log('\n🔍 Discovering provinces from national page...\n');

    const browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox'
      ]
    });

    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();
    const fullUrl = `${BASE_URL}/pd`;

    // Navigate with WAF handling
    let navigated = false;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // WAF loop
        let wafDetected = false;
        for (let r = 1; r <= MAX_WAF_RELOADS; r++) {
          if (r === 1) {
            await page.goto(fullUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          } else {
            console.log(`   ↻ WAF reload attempt ${r}/${MAX_WAF_RELOADS}`);
            await sleep(1000);
            await page.reload({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          }
          try {
            const hasWaf = await page.evaluate(() => {
              const t = document.body ? document.body.innerText : '';
              return t.includes('Dynamic Decrypting') || t.includes('网页被保护') || t.includes('正在解密中');
            });
            if (hasWaf) { wafDetected = true; break; }
            const loaded = await page.$('.buttons-excel');
            if (loaded) { wafDetected = true; break; }
          } catch (_) { /* ignore */ }
        }

        await page.waitForSelector('.buttons-excel', { timeout: WAIT_TIMEOUT });
        await sleep(2000);
        navigated = true;
        break;
      } catch (err) {
        console.warn(`   ⚠ Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
        if (attempt < MAX_RETRIES) await sleep(DELAY_MS * 2);
      }
    }

    if (!navigated) {
      await browser.close();
      throw new Error('Failed to load national page after all retries');
    }

    // Download national Excel
    const nationalDir = path.join(DOWNLOADS_DIR, 'National');
    if (!fs.existsSync(nationalDir)) fs.mkdirSync(nationalDir, { recursive: true });
    const nationalExcel = path.join(nationalDir, 'National.xlsx');
    if (!fs.existsSync(nationalExcel)) {
      try {
        const [download] = await Promise.all([
          page.waitForEvent('download', { timeout: 30000 }),
          page.click('.buttons-excel')
        ]);
        await download.saveAs(nationalExcel);
        console.log(`   ✓ Downloaded: ${nationalExcel}`);
      } catch (err) {
        console.warn(`   ✘ National Excel download failed: ${err.message}`);
      }
    }

    // Extract provinces
    const provinces = await page.evaluate(() => {
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

        if (level !== 1) continue;
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
    });

    await page.close();
    await context.close();
    await browser.close();

    markCompleted(progress, '0:/pd');

    console.log(`\n✓ Found ${provinces.length} provinces.\n`);
    return provinces;
  }

  // ── Main ─────────────────────────────────────────────────────────────────
  (async () => {
    const NUM_WORKERS = parseWorkerCount();

    console.log('╔══════════════════════════════════════════════════════════════╗');
    console.log('║      DAPO Kemendikdasmen PARALLEL Crawler                  ║');
    console.log('║      https://dapo.kemendikdasmen.go.id/pd                  ║');
    console.log('╚══════════════════════════════════════════════════════════════╝');
    console.log(`\nDownloads dir : ${DOWNLOADS_DIR}`);
    console.log(`Max depth     : ${MAX_DEPTH} (0=national → 3=district/schools)`);
    console.log(`Workers       : ${NUM_WORKERS} parallel browsers`);
    console.log(`Delay         : ${DELAY_MS}ms between requests\n`);

    if (!fs.existsSync(DOWNLOADS_DIR)) {
      fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
    }

    const progress = loadProgress();
    console.log(`Loaded progress: ${progress.completed.length} items already done.\n`);

    // Step 1: Discover all provinces from the national page
    let provinces;
    try {
      provinces = await discoverProvinces(progress);
    } catch (err) {
      console.error('✘ Failed to discover provinces:', err.message);
      process.exit(1);
    }

    // Filter out provinces that are already fully completed
    const remainingProvinces = provinces.filter(p => {
      const key = `1:${p.href}`;
      return !isCompleted(progress, key);
    });

    console.log(`Provinces remaining: ${remainingProvinces.length} / ${provinces.length}\n`);

    if (remainingProvinces.length === 0) {
      console.log('✓ All provinces already completed!');
      return;
    }

    // Step 2: Split provinces across workers
    const actualWorkers = Math.min(NUM_WORKERS, remainingProvinces.length);
    const chunks = chunkArray(remainingProvinces, actualWorkers);

    console.log(`Splitting ${remainingProvinces.length} provinces across ${actualWorkers} workers:\n`);
    chunks.forEach((chunk, i) => {
      const names = chunk.map(p => p.name).join(', ');
      console.log(`  Worker ${i + 1}: ${chunk.length} provinces — ${names}`);
    });
    console.log('');

    // Step 3: Spawn workers
    const startTime = Date.now();
    const workerPromises = chunks.map((chunk, index) => {
      return new Promise((resolve, reject) => {
        const worker = new Worker(__filename, {
          workerData: {
            workerId: index + 1,
            provinces: chunk,
            completedSet: progress.completed,
            downloadsDir: path.join(DOWNLOADS_DIR, 'National')
          }
        });

        worker.on('message', (msg) => {
          if (msg.type === 'completed') {
            markCompleted(progress, msg.key);
          } else if (msg.type === 'done') {
            console.log(`\n✓ Worker ${msg.workerId} finished.`);
          }
        });

        worker.on('error', (err) => {
          console.error(`\n✘ Worker ${index + 1} error:`, err);
          reject(err);
        });

        worker.on('exit', (code) => {
          if (code !== 0) {
            console.error(`\n✘ Worker ${index + 1} exited with code ${code}`);
          }
          resolve();
        });
      });
    });

    // Step 4: Wait for all workers to finish
    try {
      await Promise.allSettled(workerPromises);
    } catch (err) {
      console.error('Error waiting for workers:', err);
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n${'═'.repeat(60)}`);
    console.log(`✓ All workers finished in ${elapsed} minutes.`);
    console.log(`  Total completed items: ${progress.completed.length}`);
    console.log(`  Downloads saved to: ${DOWNLOADS_DIR}`);
    console.log('═'.repeat(60));
  })();
}
