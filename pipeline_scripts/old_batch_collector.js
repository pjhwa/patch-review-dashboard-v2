const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');

// --- ROBUST DEBUGGING (Anti-Hang) ---
process.on('uncaughtException', (err) => {
    console.error(`\n[FATAL] Uncaught Exception: ${err.message}\n${err.stack}`);
    fs.appendFileSync('debug_collector.log', `[FATAL] Uncaught Exception: ${err.message}\n`);
    saveFailureReport();
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error(`\n[FATAL] Unhandled Rejection at:`, promise, 'reason:', reason);
    fs.appendFileSync('debug_collector.log', `[FATAL] Unhandled Rejection: ${reason}\n`);
});

function logDebug(msg) {
    const ts = new Date().toISOString();
    fs.appendFileSync('debug_collector.log', `[${ts}] ${msg}\n`);
}
logDebug('--- NEW BATCH COLLECTION RUN ---');

// --- CONFIGURATION ---
const OUTPUT_DIR = path.join(__dirname, 'batch_data');
const UBUNTU_LTS_VERSIONS = ['22.04', '24.04'];
const MAX_CONCURRENCY = 3;
const MAX_REDHAT_PAGES = 50; // Increased to ensure 120+ days coverage
const MAX_UBUNTU_PAGES = 100; // Increased to ensure 120+ days coverage

// --- GLOBAL RETRY CONFIG ---
const MAX_GLOBAL_RETRIES = 2;
const GLOBAL_RETRY_DELAY_MS = 60000; // 60 seconds between retry passes
const RETRY_QUEUE = [];

// --- DATE RANGE: CLI PARSING ---
// Usage:
//   node batch_collector.js --quarter 2026-Q1   → covers quarter + 1-month buffer before
//   node batch_collector.js --days 90           → last 90 days from today
//   node batch_collector.js                     → default: last 90 days
function parseDateRange() {
    const args = process.argv.slice(2);
    let startDate, endDate;

    const quarterIdx = args.indexOf('--quarter');
    const daysIdx = args.indexOf('--days');
    const sinceIdx = args.indexOf('--since');
    const retryIdx = args.indexOf('--retry-failures');

    if (retryIdx !== -1) {
        console.log('[CONFIG] Retry mode activated: Parsing collection_failures.json');
        return { retryMode: true, startDate: new Date(0), endDate: new Date() };
    }

    if (quarterIdx !== -1 && args[quarterIdx + 1]) {
        const qMatch = args[quarterIdx + 1].match(/^(\d{4})-Q([1-4])$/);
        if (!qMatch) {
            console.error('Invalid quarter format. Use YYYY-QN (e.g., 2026-Q1)');
            process.exit(1);
        }
        const year = parseInt(qMatch[1]);
        const quarter = parseInt(qMatch[2]);
        // Quarter boundaries: Q1=Jan-Mar, Q2=Apr-Jun, Q3=Jul-Sep, Q4=Oct-Dec
        const qStartMonth = (quarter - 1) * 3; // 0-indexed
        endDate = new Date(year, qStartMonth + 3, 1); // First day of next quarter (exclusive)
        // Buffer: start 1 month before quarter for cumulative patch context
        startDate = new Date(year, qStartMonth - 1, 1);
        console.log(`[CONFIG] Quarter mode: ${args[quarterIdx + 1]}`);
    } else if (sinceIdx !== -1 && args[sinceIdx + 1]) {
        // Incremental mode: fetch only since last checkpoint
        startDate = new Date(args[sinceIdx + 1]);
        endDate = new Date();
        endDate.setDate(endDate.getDate() + 1); // Include today
        console.log(`[CONFIG] Incremental mode: fetching since ${args[sinceIdx + 1]}`);
    } else {
        let lookbackDays = 120;
        if (daysIdx !== -1 && args[daysIdx + 1]) {
            lookbackDays = parseInt(args[daysIdx + 1]) || 120;
        }
        endDate = new Date();
        endDate.setDate(endDate.getDate() + 1); // Include today
        startDate = new Date();
        startDate.setDate(startDate.getDate() - lookbackDays);
        startDate.setDate(1); // Snap to first of month
        console.log(`[CONFIG] Lookback mode: ${lookbackDays} days (full initial sync)`);
    }

    console.log(`[CONFIG] Date range: ${startDate.toISOString().split('T')[0]} ~ ${endDate.toISOString().split('T')[0]} (exclusive)`);
    return { startDate, endDate };
}

function generateOracleMonths(startDate, endDate) {
    const months = [];
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];
    const current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
    while (current < endDate) {
        months.push(`${current.getFullYear()}-${monthNames[current.getMonth()]}`);
        current.setMonth(current.getMonth() + 1);
    }
    return months;
}

const { startDate: TARGET_START_DATE, endDate: TARGET_END_DATE } = parseDateRange();
const ORACLE_TARGET_MONTHS = generateOracleMonths(TARGET_START_DATE, TARGET_END_DATE);
console.log(`[CONFIG] Oracle months: ${ORACLE_TARGET_MONTHS.join(', ')}`);

if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// --- FAILURE TRACKING ---
const failedAdvisories = [];

function recordFailure(vendor, id, url, error) {
    const entry = {
        vendor,
        id: id || 'UNKNOWN',
        url: url || '',
        error: error?.message || String(error),
        timestamp: new Date().toISOString()
    };
    failedAdvisories.push(entry);
    console.error(`[FAILURE] ${vendor} ${entry.id}: ${entry.error}`);
}

function saveFailureReport() {
    if (failedAdvisories.length === 0) {
        console.log('[REPORT] No collection failures.');
        return;
    }
    const filePath = path.join(OUTPUT_DIR, 'collection_failures.json');
    fs.writeFileSync(filePath, JSON.stringify(failedAdvisories, null, 2));
    console.log(`\n[REPORT] ⚠ ${failedAdvisories.length} advisory(ies) failed to collect.`);
    console.log(`[REPORT] Failure details saved to: ${filePath}`);
    console.log('[REPORT] Please review and manually re-collect if needed.');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- UTILS ---
function parseDate(dateStr) {
    if (!dateStr) return new Date(0);
    return new Date(dateStr);
}

function isWithinTargetPeriod(dateObj) {
    return dateObj >= TARGET_START_DATE && dateObj < TARGET_END_DATE;
}

function saveAdvisory(id, data) {
    if (!id) return;
    const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '_');
    const filePath = path.join(OUTPUT_DIR, `${safeId}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// --- RED HAT SCRAPER (CSAF API — no browser rendering needed) ---
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout: 30000 }, res => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('HTTPS timeout')); });
    });
}

async function scrapeRedHat(browser) {
    console.log('\n[REDHAT] Starting Collector (CSAF API)...');
    const CSAF_BASE = 'https://security.access.redhat.com/data/csaf/v2/advisories';
    const CHANGES_URL = `${CSAF_BASE}/changes.csv`;

    let csvText = '';
    try {
        const r = await httpsGet(CHANGES_URL);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        csvText = r.body;
    } catch (e) {
        console.error(`[REDHAT] Failed to fetch changes.csv: ${e.message}`);
        return;
    }

    // Parse CSV: "2026/rhsa-2026_XXXX.json","2026-03-03T..."
    const lines = csvText.trim().split('\n');
    const candidates = [];
    for (const line of lines) {
        const m = line.match(/"([^"]+rhsa[^"]+\.json)","([^"]+)"/);
        if (!m) continue;
        const [, filePath, timestamp] = m;
        const pubDate = new Date(timestamp);
        if (pubDate < TARGET_START_DATE || pubDate >= TARGET_END_DATE) continue;
        const idMatch = filePath.match(/rhsa-(\d+)_(\d+)\.json/);
        if (!idMatch) continue;

        // Skip regenerated old advisories using the year from the ID
        const advYear = parseInt(idMatch[1]);
        if (advYear < TARGET_START_DATE.getFullYear() - 1) continue; // Allow -1 year buffer for overlap

        const id = `RHSA-${idMatch[1]}:${idMatch[2]}`;
        const safeId = id.replace(/[^a-zA-Z0-9-_]/g, '_');
        if (fs.existsSync(path.join(OUTPUT_DIR, `${safeId}.json`))) continue;
        candidates.push({ id, filePath, pubDate, safeId });
    }

    console.log(`[REDHAT] Found ${candidates.length} new RHSA advisories in window (${TARGET_START_DATE.toISOString().split('T')[0]} ~ ${TARGET_END_DATE.toISOString().split('T')[0]}).`);

    let saved = 0, skipped = 0;
    for (let i = 0; i < candidates.length; i += MAX_CONCURRENCY) {
        const batch = candidates.slice(i, i + MAX_CONCURRENCY);
        await Promise.all(batch.map(async ({ id, filePath, pubDate, safeId }) => {
            const url = `${CSAF_BASE}/${filePath}`;
            try {
                const r = await httpsGet(url);
                if (r.status !== 200) { skipped++; return; }
                const csaf = JSON.parse(r.body);

                const doc = csaf.document || {};
                const tracking = doc.tracking || {};
                const releaseDateStr = tracking.initial_release_date || tracking.current_release_date || pubDate.toISOString();
                const actualReleaseDate = new Date(releaseDateStr);

                // Skip if actual release date is older than our target
                if (actualReleaseDate < TARGET_START_DATE) {
                    skipped++;
                    return;
                }

                const severity = doc.aggregate_severity?.text || '';
                const title = doc.title || id;
                const notes = doc.notes || [];
                const overview = notes.find(n => n.category === 'summary')?.text || '';
                const description = notes.find(n => n.category === 'description')?.text || overview;
                const cves = (csaf.vulnerabilities || []).map(v => v.cve).filter(Boolean);
                const cve_details = (csaf.vulnerabilities || []).map(v => {
                    const desc = v.notes?.find(n => n.category === 'description')?.text || '';
                    return v.cve ? `${v.cve}: ${desc}` : desc;
                }).filter(Boolean);
                const ref_url = `https://access.redhat.com/errata/${id}`;

                // Extract product names from product_tree branches
                const affected_products = [];
                function extractProducts(nodes) {
                    for (const node of (nodes || [])) {
                        if (node.category === 'product_name' && node.name) affected_products.push(node.name);
                        if (node.branches) extractProducts(node.branches);
                    }
                }
                extractProducts(csaf.product_tree?.branches);

                // Fetch the Errata HTML to get the Updated Packages list (RPMs)
                let rpmListText = '';
                try {
                    const errataRes = await httpsGet(ref_url);
                    if (errataRes.status === 200) {
                        const rpmMatches = errataRes.body.match(/[\w.-]+\.rpm/g);
                        if (rpmMatches) {
                            // Filter out duplicates and keep only actual RPM names
                            const uniqueRpms = [...new Set(rpmMatches)].filter(rpm => rpm.length > 5);
                            rpmListText = "Updated Packages:\n" + uniqueRpms.join('\n');
                        }
                    }
                } catch (e) {
                    logDebug(`[PROCESS FAIL] Failed to fetch RPMs for ${id}: ${e.message}`);
                }

                const full_text = [title, overview, description, rpmListText, ...cve_details].join('\n\n').slice(0, 7000);

                saveAdvisory(safeId, {
                    id, vendor: 'Red Hat',
                    url: ref_url,
                    pubDate: actualReleaseDate.toISOString(),
                    dateStr: actualReleaseDate.toISOString().split('T')[0],
                    severity, title, overview, description,
                    affected_products, cves, packages: [], fixes: '',
                    full_text
                });
                saved++;
                logDebug(`[PROCESS] Success ${id}`);
            } catch (e) {
                skipped++;
                logDebug(`[PROCESS FAIL] ${id}: ${e.message}`);
            }
        }));
        process.stdout.write(`\r[REDHAT PROGRESS] ${Math.min(i + MAX_CONCURRENCY, candidates.length)}/${candidates.length}`);
    }
    console.log(`\n[REDHAT] Saved ${saved}, Skipped/Failed ${skipped}.`);
    console.log(`[BATCH] Red Hat: Found ${candidates.length + saved} candidates. Skipped ${skipped} (already exist or failed). Processed ${saved} new items.`);
}

// --- ORACLE MAILING LIST SCRAPER ---
async function scrapeOracleMailingList(browser) {
    console.log('\n[ORACLE] Starting Collector (Mailing List Archive)...');
    const page = await browser.newPage();
    const allAdvisories = [];

    try {
        const baseUrl = 'https://oss.oracle.com/pipermail/el-errata';

        for (const month of ORACLE_TARGET_MONTHS) {
            const url = `${baseUrl}/${month}/date.html`;
            console.log(`[ORACLE] Fetching Archive: ${url}`);

            try {
                const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                if (response.status() === 404) {
                    console.log(`[ORACLE] Archive for ${month} not found (404). Skipping.`);
                    continue;
                }

                const pageAdvisories = await page.evaluate((monthStr) => {
                    const links = Array.from(document.querySelectorAll('ul li a'));

                    return links.map(link => {
                        const text = link.innerText.trim();
                        const href = link.href ? link.href.trim() : '';

                        // Only collect items with a valid ELSA/ELBA advisory ID
                        const idMatch = text.match(/EL[SB]A-\d{4}-\d+/);
                        if (!idMatch) return null;  // Skip non-advisory posts (bug reports etc.)
                        if (!href || !href.startsWith('http')) return null; // Skip empty URLs

                        return {
                            id: idMatch[0],
                            url: href,
                            synopsis: text,
                            dateStr: monthStr,
                            type: 'Mailing List Announcement'
                        };
                    }).filter(Boolean);
                }, month);

                console.log(`[ORACLE] Found ${pageAdvisories.length} UEK advisories in ${month}.`);
                allAdvisories.push(...pageAdvisories);

            } catch (err) {
                console.error(`[ORACLE] Error fetching ${month}: ${err.message}`);
            }
        }

        console.log(`[ORACLE] Total UEK Candidates: ${allAdvisories.length}`);

        await processInBatches(browser, allAdvisories, 'Oracle', oracleWorker);

    } catch (e) {
        console.error('[ORACLE] Error:', e);
    } finally {
        try { await page.close(); } catch (_) { }
    }
}

// --- UBUNTU WEB SCRAPER (New - Pagination-Based) ---
async function scrapeUbuntuWeb(browser) {
    console.log('\n[UBUNTU] Starting Collector (Web Pagination)...');
    const page = await browser.newPage();
    const allAdvisories = [];
    let shouldContinue = true;

    try {
        const baseUrl = 'https://ubuntu.com/security/notices';

        for (let i = 0; i < MAX_UBUNTU_PAGES && shouldContinue; i++) {
            const offset = i * 10;
            const url = `${baseUrl}?offset=${offset}`;
            console.log(`[UBUNTU] Fetching List Page ${i + 1}/${MAX_UBUNTU_PAGES} (offset=${offset}): ${url}`);

            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(2000);

                const pageAdvisories = await page.evaluate(() => {
                    const usnLinks = Array.from(document.querySelectorAll('a[href*="/security/notices/USN"]'));

                    return usnLinks.map(link => {
                        const text = link.innerText.trim();
                        const usnMatch = text.match(/USN-\d+-\d+/);
                        if (!usnMatch) return null;

                        // Try to find date from parent row/container
                        let dateStr = '';
                        // The anchor is likely under a h3 inside a div, sibling to the row div
                        const container = link.closest('.p-strip') || link.parentElement.parentElement.parentElement;
                        if (container) {
                            const dateMatch = container.innerText.match(/(\d{1,2}\s+\w+\s+\d{4})/);
                            if (dateMatch) dateStr = dateMatch[1];
                        }

                        return {
                            id: usnMatch[0],
                            url: link.href,
                            synopsis: text,
                            dateStr: dateStr || ''
                        };
                    }).filter(Boolean);
                });

                console.log(`[UBUNTU] Page ${i + 1}: Found ${pageAdvisories.length} USN entries.`);

                if (pageAdvisories.length === 0) {
                    console.log(`[UBUNTU] No more entries found. Stopping pagination.`);
                    shouldContinue = false;
                    break;
                }

                // Check if we've gone too far back (if dates are available)
                const datedAdvisories = pageAdvisories.filter(adv => adv.dateStr);
                if (datedAdvisories.length > 0) {
                    const oldestDate = parseDate(datedAdvisories[datedAdvisories.length - 1].dateStr);
                    if (oldestDate < TARGET_START_DATE && oldestDate > new Date('2000-01-01')) {
                        console.log(`[UBUNTU] Page ${i + 1}: Reached advisories before ${TARGET_START_DATE.toISOString().split('T')[0]}. Stopping pagination.`);
                        const filtered = pageAdvisories.filter(adv => !adv.dateStr || parseDate(adv.dateStr) >= TARGET_START_DATE);
                        allAdvisories.push(...filtered);
                        shouldContinue = false;
                        break;
                    }
                }

                allAdvisories.push(...pageAdvisories);

            } catch (err) {
                console.error(`[UBUNTU] Error page ${i + 1}: ${err.message}`);
            }
        }

        console.log(`[UBUNTU] Found ${allAdvisories.length} total USN candidates.`);

        // Fetch full details for each and filter by LTS version
        const ltsAdvisories = [];
        await processInBatches(browser, allAdvisories, 'Ubuntu', async (ctxPage, adv) => {
            const passed = await ubuntuWorker(ctxPage, adv);
            if (passed) ltsAdvisories.push(adv.id);
        });

        console.log(`[UBUNTU] Saved ${ltsAdvisories.length} LTS advisories matching target period.`);

    } catch (e) {
        console.error('[UBUNTU] Error:', e);
    } finally {
        await page.close();
    }
}

// --- HELPER ---
async function processInBatches(browser, allItems, vendorTitle, asyncWorker) {
    // Incremental Skipping Logic
    const items = allItems.filter(item => {
        const safeId = item.id ? item.id.replace(/[^a-zA-Z0-9-_]/g, '_') : '';
        if (!safeId) return true;
        const filePath = path.join(OUTPUT_DIR, `${safeId}.json`);
        // If file exists, skip scraping it again
        if (fs.existsSync(filePath)) {
            // logDebug(`[SKIP] ${item.id} already exists in ${OUTPUT_DIR}`);
            return false;
        }
        return true;
    });

    const skippedCount = allItems.length - items.length;
    console.log(`[BATCH] ${vendorTitle}: Found ${allItems.length} candidates. Skipped ${skippedCount} (already exist). Processing ${items.length} new items...`);

    if (items.length === 0) return false;

    const chunks = [];
    for (let i = 0; i < items.length; i += MAX_CONCURRENCY) {
        chunks.push(items.slice(i, i + MAX_CONCURRENCY));
    }
    let count = 0;
    let browserDead = false;
    for (const chunk of chunks) {
        if (browserDead) {
            for (const item of chunk) {
                RETRY_QUEUE.push({ vendor: vendorTitle, item, worker: asyncWorker, error: new Error('Browser closed — skipped remaining items') });
            }
            count += chunk.length;
            continue;
        }
        await Promise.all(chunk.map(async (item) => {
            let context, page;
            try {
                context = await browser.newContext();
                page = await context.newPage();
            } catch (e) {
                browserDead = true;
                RETRY_QUEUE.push({ vendor: vendorTitle, item, worker: asyncWorker, error: new Error(`Browser closed — cannot create page: ${e.message}`) });
                return;
            }
            try {
                await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', route => route.abort());

                logDebug(`[PROCESS] Starting ${item.id} (${item.url})`);

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('WATCHDOG_TIMEOUT: 60000ms exceeded')), 60000)
                );

                await Promise.race([
                    asyncWorker(page, item),
                    timeoutPromise
                ]);

                logDebug(`[PROCESS] Success ${item.id}`);
            } catch (e) {
                if (e.message && e.message.includes('has been closed')) {
                    browserDead = true;
                }
                RETRY_QUEUE.push({ vendor: vendorTitle, item, worker: asyncWorker, error: e });
                logDebug(`[PROCESS FAIL] ${item.id}: ${e.message}`);
            } finally {
                try { if (page) await page.close(); } catch (_) { }
                try { if (context) await context.close(); } catch (_) { }
            }
        }));
        count += chunk.length;
        process.stdout.write(`\r[PROGRESS] ${count}/${items.length}`);
    }
    console.log('\n[BATCH] Done.');
    return browserDead;
}

// --- WORKER DEFs ---
// redhatWorker removed — Red Hat data is now fetched directly via CSAF API in scrapeRedHat()
// keeping a no-op stub for any legacy references
const redhatWorker = async (ctxPage, adv) => {
    console.warn('[REDHAT] redhatWorker called unexpectedly — should use CSAF API path');
};

const oracleWorker = async (ctxPage, adv) => {
    if (!adv.url || !adv.url.startsWith('http')) {
        logDebug(`[SKIP] Oracle ${adv.id}: empty or invalid URL`);
        return;
    }
    await ctxPage.goto(adv.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const details = await ctxPage.evaluate(() => {
        let text = '';
        const pre = document.querySelector('pre');
        if (pre) {
            text = pre.innerText.trim();
        } else {
            function extractTextWithNewlines(node) {
                if (node.nodeType === 3) return node.nodeValue || '';
                if (node.nodeType !== 1) return '';
                let nodeText = '';
                const isBlock = /^(DIV|P|H[1-6]|LI|TR|UL|OL|TABLE|BLOCKQUOTE|PRE)$/i.test(node.tagName);
                for (let child of node.childNodes) nodeText += extractTextWithNewlines(child);
                if (isBlock) nodeText = '\n' + nodeText + '\n';
                return nodeText;
            }

            text = extractTextWithNewlines(document.body)
                .replace(/[\t]+/g, ' ')
                .replace(/ \n /g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim();
        }

        // Structured Extraction from Oracle's mailing text
        const detailsObj = {
            severity: '',
            overview: '',
            description: '',
            affected_products: [],
            packages: [],
            cves: [],
            fixes: '',
            notes: ''
        };

        // Severity: Oracle uses "Security Impact: Critical/Important/Moderate/Low"
        const sevMatch = text.match(/Security Impact:\s*(Critical|Important|Moderate|Low)/i)
            || text.match(/Type:\s*Security.*?(Critical|Important|Moderate|Low)/i);
        if (sevMatch) detailsObj.severity = sevMatch[1];

        // Overview/synopsis from the email subject line: first line like "EL[SB]A-XXXX:XXXX ..."
        const firstLine = text.split('\n').find(l => l.trim().match(/EL[SB]A-\d{4}/));
        if (firstLine) detailsObj.overview = firstLine.trim();

        // Match CVEs
        const cveMatches = text.match(/CVE-\d{4}-\d+/g);
        if (cveMatches) detailsObj.cves = [...new Set(cveMatches)];

        // Extract Description of changes
        const descMatch = text.match(/Description of changes:(.*?)($|Related CVEs:|Oracle Linux Security Advisory)/s);
        if (descMatch) detailsObj.description = descMatch[1].trim();

        // Affected Products: detect OL version strings
        const olMatches = text.match(/Oracle Linux \d+/g);
        if (olMatches) detailsObj.affected_products = [...new Set(olMatches)];

        // Extract RPMs
        const rpmsMatch = text.match(/x86_64:(.*?)SRPMS:/s) || text.match(/aarch64:(.*?)SRPMS:/s);
        if (rpmsMatch) {
            const lines = rpmsMatch[1].split('\n').map(l => l.trim()).filter(l => l && l.endsWith('.rpm'));
            detailsObj.packages = lines;
        }

        return { ...detailsObj, full_text: text.slice(0, 5000) };
    });
    saveAdvisory(adv.id, { ...adv, ...details, vendor: 'Oracle' });
};

const ubuntuWorker = async (ctxPage, adv) => {
    await ctxPage.goto(adv.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const details = await ctxPage.evaluate(() => {
        const main = document.querySelector('main') || document.body;
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

        const dateMatch = text.match(/(\d{1,2}\s+\w+\s+\d{4})/);
        const pubDate = dateMatch ? dateMatch[1] : '';

        const detailsObj = {
            overview: '',
            description: '',
            packages: [],
            cves: [],
            affected_products: [],
            fixes: '',
            notes: ''
        };

        const getSection = (header, nextHeaders) => {
            const regex = new RegExp(`(?:^|\\n)${header}\\s*\\n(.*?)(?:\\n(?:${nextHeaders.join('|')})\\s*\\n|$)`, 's');
            const match = text.match(regex);
            return match ? match[1].trim() : '';
        };

        const ubnHeaders = ['Overview', 'Releases', 'Packages', 'Details', 'Update instructions', 'Ubuntu Release & Package Version', 'References', 'Related notices', 'Reduce your security exposure'];

        detailsObj.overview = getSection('Overview', ubnHeaders);
        detailsObj.description = getSection('Details', ubnHeaders);

        const relText = getSection('Releases', ubnHeaders);
        if (relText) {
            detailsObj.affected_products = relText.split('\n').map(l => l.trim()).filter(Boolean);
        }

        const pkgText = getSection('Packages', ubnHeaders);
        if (pkgText) {
            detailsObj.packages = pkgText.split('\n').filter(l => l.includes('-')).map(l => l.split('-')[0].trim());
        }

        const refText = getSection('References', ubnHeaders);
        if (refText) {
            detailsObj.cves = [...new Set(refText.match(/CVE-\d{4}-\d+/g) || [])];
        } else {
            const allCves = text.match(/CVE-\d{4}-\d+/g);
            if (allCves) detailsObj.cves = [...new Set(allCves)];
        }

        return {
            ...detailsObj,
            full_text: text.slice(0, 6000),
            title: document.title,
            pubDate: pubDate
        };
    });

    // Check against `affected_products` safely + fallback to text
    let hasTargetLTS = false;
    if (details.affected_products && details.affected_products.length > 0) {
        hasTargetLTS = details.affected_products.some(prod => UBUNTU_LTS_VERSIONS.some(ver => prod.includes(ver)));
    } else {
        hasTargetLTS = UBUNTU_LTS_VERSIONS.some(ver =>
            details.full_text.includes(ver) || details.full_text.includes(`Ubuntu ${ver}`)
        );
    }

    const pubDate = parseDate(details.pubDate || adv.dateStr || new Date().toISOString());

    if (hasTargetLTS || process.env.RETRY_MODE === 'true') {
        saveAdvisory(adv.id, { ...adv, ...details, vendor: 'Ubuntu', pubDate: pubDate.toISOString() });
        return true;
    }
    return false;
};

// --- MAIN ---
(async () => {
    console.log(`=== BATCH COLLECTOR START ===`);
    const dateConfig = parseDateRange();
    const retryMode = dateConfig.retryMode === true;
    process.env.RETRY_MODE = retryMode ? 'true' : 'false';

    const workerMap = {
        'Red Hat': redhatWorker,
        'Oracle': oracleWorker,
        'Ubuntu': ubuntuWorker
    };

    async function launchBrowser() {
        return chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
    }

    if (retryMode) {
        let failures = [];
        try {
            const failData = fs.readFileSync(path.join(OUTPUT_DIR, 'collection_failures.json'), 'utf8');
            failures = JSON.parse(failData);
        } catch (e) {
            console.error('[CONFIG] No collection_failures.json found or invalid format.');
            process.exit(1);
        }

        console.log(`[RETRY ONLY] Loaded ${failures.length} failed items from collection_failures.json`);

        // Group by vendor
        const byVendor = {};
        for (const f of failures) {
            if (!byVendor[f.vendor]) byVendor[f.vendor] = [];
            byVendor[f.vendor].push({ id: f.id, url: f.url });
        }

        for (const [vendor, items] of Object.entries(byVendor)) {
            const worker = workerMap[vendor];
            if (!worker) continue;

            let browser;
            try {
                browser = await launchBrowser();
                console.log(`\n[RETRY ONLY] Processing ${items.length} items for ${vendor}`);
                await processInBatches(browser, items, vendor, worker);
            } catch (e) {
                console.error(`[RETRY ONLY] Browser failure for ${vendor}: ${e.message}`);
            } finally {
                try { if (browser) await browser.close(); } catch (_) { }
            }
        }
    } else {
        // Run each vendor with its own browser instance for isolation.
        // If one vendor crashes the browser, others still run.
        const vendors = [
            { name: 'Red Hat', fn: scrapeRedHat },
            { name: 'Oracle', fn: scrapeOracleMailingList },
            { name: 'Ubuntu', fn: scrapeUbuntuWeb }
        ];

        for (const { name, fn } of vendors) {
            let browser;
            try {
                browser = await launchBrowser();
                await fn(browser);
            } catch (e) {
                console.error(`[MAIN] ${name} scraper failed: ${e.message}`);
                recordFailure(name, 'SCRAPER_CRASH', '', e);
            } finally {
                try { if (browser) await browser.close(); } catch (_) { }
            }
        }
    }

    // --- GLOBAL RETRY LOGIC ---
    for (let pass = 1; pass <= MAX_GLOBAL_RETRIES; pass++) {
        if (RETRY_QUEUE.length === 0) break;

        console.log(`\n=== GLOBAL RETRY PASS ${pass}/${MAX_GLOBAL_RETRIES} ===`);
        console.log(`Waiting ${GLOBAL_RETRY_DELAY_MS / 1000} seconds before retrying ${RETRY_QUEUE.length} failed items...`);
        await sleep(GLOBAL_RETRY_DELAY_MS);

        const currentQueue = RETRY_QUEUE.splice(0, RETRY_QUEUE.length);
        const chunks = [];
        for (let i = 0; i < currentQueue.length; i += MAX_CONCURRENCY) {
            chunks.push(currentQueue.slice(i, i + MAX_CONCURRENCY));
        }

        let browser;
        try {
            browser = await launchBrowser();
            let browserDead = false;
            let count = 0;

            for (const chunk of chunks) {
                if (browserDead) {
                    for (const retryObj of chunk) {
                        retryObj.error = new Error('Browser closed earlier in retry pass');
                        RETRY_QUEUE.push(retryObj);
                    }
                    count += chunk.length;
                    continue;
                }

                await Promise.all(chunk.map(async (retryObj) => {
                    let context, page;
                    try {
                        context = await browser.newContext();
                        page = await context.newPage();
                    } catch (e) {
                        browserDead = true;
                        retryObj.error = new Error(`Browser context failed: ${e.message}`);
                        RETRY_QUEUE.push(retryObj);
                        return;
                    }

                    try {
                        await page.route('**/*.{png,jpg,jpeg,gif,svg,woff,woff2,css}', route => route.abort());
                        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('WATCHDOG_TIMEOUT')), 60000));

                        await Promise.race([
                            retryObj.worker(page, retryObj.item),
                            timeoutPromise
                        ]);

                        logDebug(`[RETRY SUCCESS] Pass ${pass} - ${retryObj.vendor} ${retryObj.item.id}`);
                    } catch (e) {
                        if (e.message && e.message.includes('has been closed')) {
                            browserDead = true;
                        }
                        retryObj.error = e;
                        RETRY_QUEUE.push(retryObj);
                        logDebug(`[RETRY FAIL] Pass ${pass} - ${retryObj.vendor} ${retryObj.item.id}: ${e.message}`);
                    } finally {
                        try { if (page) await page.close(); } catch (_) { }
                        try { if (context) await context.close(); } catch (_) { }
                    }
                }));
                count += chunk.length;
                process.stdout.write(`\r[RETRY PROGRESS] ${count}/${currentQueue.length}`);
            }
        } catch (e) {
            console.error(`\n[RETRY] Pass ${pass} Browser launch failed: ${e.message}`);
            // Push everything back and abort this pass
            RETRY_QUEUE.push(...currentQueue);
        } finally {
            try { if (browser) await browser.close(); } catch (_) { }
        }
        console.log('');
    }

    console.log('\n[BATCH SUMMARY] Global Retries finished.');

    // Register absolute failures
    const finalFails = Array.from(new Set(RETRY_QUEUE));
    for (const fail of finalFails) {
        recordFailure(fail.vendor, fail.item.id, fail.item.url, fail.error);
    }

    saveFailureReport();

    // --- CLEANUP: Remove any ELSA-UNKNOWN-* temp files left from previous runs ---
    try {
        const tempFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.startsWith('ELSA-UNKNOWN-') && f.endsWith('.json'));
        for (const f of tempFiles) {
            fs.unlinkSync(path.join(OUTPUT_DIR, f));
        }
        if (tempFiles.length > 0) {
            console.log(`[CLEANUP] Removed ${tempFiles.length} ELSA-UNKNOWN temp file(s).`);
        }
    } catch (e) {
        console.warn(`[CLEANUP] Could not clean ELSA-UNKNOWN files: ${e.message}`);
    }

    console.log('=== COLLECTION COMPLETE ===');
    // Write checkpoint so subsequent runs can be incremental
    const checkpointPath = path.join(__dirname, 'collection_checkpoint.json');
    const checkpoint = {
        lastCollectedAt: new Date().toISOString(),
        collectedUpTo: TARGET_END_DATE.toISOString(),
        fullSyncCompleted: true
    };
    fs.writeFileSync(checkpointPath, JSON.stringify(checkpoint, null, 2));
    console.log('[CHECKPOINT] Saved: ' + checkpoint.lastCollectedAt);
})();
