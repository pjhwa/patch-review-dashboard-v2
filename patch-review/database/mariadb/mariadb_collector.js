const fs = require('fs');
const path = require('path');
const https = require('https');

// ═══════════════════════════════════════════════════════════
//  MariaDB RHSA/RHBA Collector v3.0
//  Strategy:
//    PHASE 1 — Red Hat Hydra Errata API로 MariaDB 관련
//              Errata ID를 타겟 검색 (수십~수백 건 수준)
//    PHASE 2 — 각 Errata ID에 대해 CSAF JSON을 직접 fetch
//              하여 상세 패키지·CVE·영향 범위 등 수집
//    PHASE 3 — 기존 redhat_data/ 에서 MariaDB 패키지 포함
//              Advisory를 보충 스캔
// ═══════════════════════════════════════════════════════════

// --- CONFIG ---
const OUTPUT_DIR = './mariadb_data';
const FILTER_DAYS = 180;
const MAX_CONCURRENCY = 4;
const FORCE_FULL_COLLECT = false;
const HYDRA_ROWS_PER_PAGE = 200;  // Hydra API pagination size

// Search queries for Hydra API — multiple to capture all MariaDB patches
const HYDRA_SEARCH_QUERIES = [
    'mariadb security update',
    'mariadb bug fix update',
    'mariadb:10 security',
    'mariadb enhancement update',
    'galera security update',
];

// Package prefix filters for strict MariaDB matching
const MARIADB_PKG_PREFIXES = [
    'mariadb-', 'mariadb_', 'galera-',
    'mariadb-server', 'mariadb-backup', 'mariadb-common',
    'mariadb-devel', 'mariadb-errmsg', 'mariadb-gssapi',
    'mariadb-oqgraph', 'mariadb-pam', 'mariadb-test',
    'mariadb-connector', 'mariadb-java-client',
];

// Path to existing redhat_data (for PHASE 3 supplement scan)
const REDHAT_DATA_DIR = path.join(__dirname, '..', '..', 'os', 'linux', 'redhat', 'redhat_data');
const METADATA_PATH = path.join(OUTPUT_DIR, 'metadata.json');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Metadata ---
function loadMetadata() {
    if (fs.existsSync(METADATA_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
            return data;
        } catch (e) {
            console.log('[WARN] metadata.json corrupted → Full Collect');
        }
    }
    return { last_run: null, total_collected: 0, collected_ids: [] };
}

function saveMetadata(data) {
    try {
        fs.writeFileSync(METADATA_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[ERROR] Failed to save metadata');
    }
}

// --- HTTPS helper ---
function httpsGet(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { timeout: 45000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve).catch(reject);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', reject);
    });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Check if a package list contains MariaDB-specific RPMs
 * Excludes tangential packages like perl-DBD-MariaDB or mysql-selinux.
 */
function hasMariaDBPackages(packages) {
    if (!packages || packages.length === 0) return false;
    return packages.some(pkg => {
        const name = pkg.toLowerCase();
        
        // Exclude known false positives that mention mariadb but aren't mariadb server/client variants
        if (name.includes('perl-dbd-mariadb') || name.includes('mysql-selinux')) return false;

        // Strict matching: exactly 'mariadb' or 'mariadb-version'
        if (name === 'mariadb' || /^mariadb-\d/.test(name)) return true;
        
        // Prefix matching
        return MARIADB_PKG_PREFIXES.some(px => name.startsWith(px));
    });
}

// ═══════════════════════════════════════════════════════════
//  PHASE 1: Discover MariaDB advisory IDs via Hydra API
// ═══════════════════════════════════════════════════════════
async function discoverFromHydra() {
    console.log('\n=== PHASE 1: Discovering MariaDB advisories via Red Hat Hydra API ===');
    const metadata = loadMetadata();
    const filterCutoff = new Date(Date.now() - FILTER_DAYS * 86400000);
    const allIds = new Map();  // id -> { id, severity, type, pubDate, title }

    for (const query of HYDRA_SEARCH_QUERIES) {
        let start = 0;
        let totalFound = 0;

        do {
            const encodedQ = encodeURIComponent(query);
            const url = `https://access.redhat.com/hydra/rest/search/kcs?q=${encodedQ}&start=${start}&rows=${HYDRA_ROWS_PER_PAGE}&fq=documentKind:Errata`;

            try {
                const r = await httpsGet(url);
                if (r.status !== 200) {
                    console.error(`[WARN] Hydra API returned ${r.status} for query: ${query}`);
                    break;
                }
                const json = JSON.parse(r.body);
                totalFound = json.response?.numFound || 0;
                const docs = json.response?.docs || [];

                if (docs.length === 0) break;

                for (const doc of docs) {
                    const id = doc.id;
                    if (!id || !id.startsWith('RH')) continue;

                    // Only collect RHSA and RHBA
                    if (!id.startsWith('RHSA') && !id.startsWith('RHBA')) continue;

                    // Publication date filter
                    const pubDate = doc.portal_publication_date || '';
                    if (pubDate && new Date(pubDate) < filterCutoff) continue;

                    // Skip if already collected (incremental)
                    if (!FORCE_FULL_COLLECT && metadata.collected_ids?.includes(id)) continue;

                    const title = (doc.allTitle || doc.title || '').replace(/^\([^)]+\)\s*/, '');
                    allIds.set(id, {
                        id,
                        severity: doc.portal_severity || 'None',
                        type: doc.portal_advisory_type || 'Unknown',
                        pubDate,
                        title,
                    });
                }

                start += HYDRA_ROWS_PER_PAGE;
            } catch (e) {
                console.error(`[ERROR] Hydra query failed: ${e.message}`);
                break;
            }

            await sleep(200);  // rate limiting
        } while (start < totalFound);

        console.log(`   Query "${query}" → ${totalFound} total, ${allIds.size} unique MariaDB candidates so far`);
    }

    console.log(`[PHASE1] Total unique MariaDB advisory IDs discovered: ${allIds.size}`);
    return allIds;
}

// ═══════════════════════════════════════════════════════════
//  PHASE 2: Fetch detailed data from CSAF for each ID
// ═══════════════════════════════════════════════════════════
async function fetchCSAFDetails(advisoryMap) {
    console.log('\n=== PHASE 2: Fetching detailed CSAF data for discovered advisories ===');
    const CSAF_BASE = 'https://security.access.redhat.com/data/csaf/v2/advisories';
    const filterCutoff = new Date(Date.now() - FILTER_DAYS * 86400000);

    const entries = Array.from(advisoryMap.values());
    let saved = 0;
    let failed = 0;

    for (let i = 0; i < entries.length; i += MAX_CONCURRENCY) {
        const batch = entries.slice(i, i + MAX_CONCURRENCY);
        await Promise.all(batch.map(async (entry) => {
            const { id } = entry;
            const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, '_');

            // Skip if already exists
            if (!FORCE_FULL_COLLECT && fs.existsSync(path.join(OUTPUT_DIR, `${safeId}.json`))) return;

            try {
                // Convert ID like RHSA-2026:0137 → 2026/rhsa-2026_0137.json
                const m = id.match(/^(RHSA|RHBA|RHEA)-(\d+):(\d+)$/);
                if (!m) return;
                const [, prefix, year, num] = m;
                const filePath = `${year}/${prefix.toLowerCase()}-${year}_${num}.json`;

                const r = await httpsGet(`${CSAF_BASE}/${filePath}`);
                if (r.status !== 200) {
                    failed++;
                    return;
                }

                const csaf = JSON.parse(r.body);
                const doc = csaf.document || {};
                const tracking = doc.tracking || {};

                const issuedDate = tracking.initial_release_date || '';
                if (issuedDate && new Date(issuedDate) < filterCutoff) return;

                // Extract updated date
                const revisions = tracking.revision_history || [];
                let updatedDate = issuedDate;
                for (let j = revisions.length - 1; j >= 0; j--) {
                    if (!revisions[j].summary?.includes('Last generated version')) {
                        updatedDate = revisions[j].date;
                        break;
                    }
                }

                // Extract notes
                const summaryNote = (doc.notes || []).find(n => n.category === 'summary');
                const generalNote = (doc.notes || []).find(n => n.category === 'general' || n.title === 'Details');
                const overview = summaryNote ? summaryNote.text : (doc.title || id);
                const description = generalNote ? generalNote.text : '';

                // Extract packages
                const packages = [];
                function extractPackages(node) {
                    if (!node) return;
                    if (node.category === 'product_version' && node.name) packages.push(node.name);
                    if (node.branches) node.branches.forEach(extractPackages);
                }
                extractPackages(csaf.product_tree);

                // Extract affected products
                const affectedSet = new Set();
                function extractFromTree(node) {
                    if (!node) return;
                    if (node.full_product_name?.name) affectedSet.add(node.full_product_name.name);
                    if ((node.category === 'product_name' || node.category === 'product_family') && node.name) affectedSet.add(node.name);
                    if (node.product?.name) affectedSet.add(node.product.name);
                    if (node.branches) node.branches.forEach(extractFromTree);
                }
                extractFromTree(csaf.product_tree);
                if (csaf.relationships) {
                    csaf.relationships.forEach(rel => {
                        if (rel.full_product_name?.name) affectedSet.add(rel.full_product_name.name);
                    });
                }

                // Extract CVEs
                const cves = [];
                if (csaf.vulnerabilities) {
                    csaf.vulnerabilities.forEach(v => { if (v.cve) cves.push(v.cve); });
                }

                // Final strict filter: verify actual MariaDB packages exist
                const mariadbPackages = packages.filter(p => {
                    const lower = p.toLowerCase();
                    return lower.includes('mariadb') || lower.includes('galera');
                });

                if (mariadbPackages.length === 0 && !hasMariaDBPackages(packages)) {
                    // Advisory mentions MariaDB but doesn't include MariaDB packages
                    return;
                }

                // Extract MariaDB version
                let mariadbVersion = 'unknown';
                const title = doc.title || '';
                const versionMatch = title.match(/mariadb[:\s]*([\d.]+)/i);
                if (versionMatch) {
                    mariadbVersion = versionMatch[1];
                } else {
                    for (const pkg of mariadbPackages) {
                        const pkgVer = pkg.match(/mariadb-([\d.]+)/);
                        if (pkgVer) { mariadbVersion = pkgVer[1]; break; }
                    }
                }

                // Build advisory object
                const advisory = {
                    id,
                    vendor: 'Red Hat',
                    type: entry.type === 'Security Advisory' ? 'Security Advisory (RHSA)'
                        : entry.type === 'Bug Fix Advisory' ? 'Bug Fix Advisory (RHBA)'
                        : `Advisory (${prefix})`,
                    title: title || id,
                    mariadbVersion,
                    issuedDate,
                    updatedDate,
                    pubDate: issuedDate,
                    dateStr: issuedDate.split('T')[0],
                    url: `https://access.redhat.com/errata/${id}`,
                    severity: doc.aggregate_severity?.text || entry.severity || 'None',
                    overview,
                    description,
                    affected_products: Array.from(affectedSet)
                        .filter(n => n && n.includes('Red Hat Enterprise Linux'))
                        .sort(),
                    cves,
                    packages: mariadbPackages,
                    all_packages_count: packages.length,
                    full_text: [overview, description].join('\n\n').slice(0, 7000)
                };

                fs.writeFileSync(path.join(OUTPUT_DIR, `${safeId}.json`), JSON.stringify(advisory, null, 2));
                saved++;
                console.log(`[OK] ${id} (v${mariadbVersion}) | ${advisory.dateStr} | ${advisory.severity} | CVEs: ${cves.length} | Pkgs: ${mariadbPackages.length}`);
            } catch (e) {
                failed++;
                console.error(`[FAIL] ${id}: ${e.message}`);
            }
        }));
    }

    console.log(`[PHASE2 완료] CSAF에서 ${saved}건 저장, ${failed}건 실패\n`);
    return saved;
}

// ═══════════════════════════════════════════════════════════
//  PHASE 3: Supplement scan of existing redhat_data/
// ═══════════════════════════════════════════════════════════
function scanExistingRedhatData() {
    console.log('=== PHASE 3: Supplement scan of existing redhat_data/ ===');

    if (!fs.existsSync(REDHAT_DATA_DIR)) {
        console.log(`[SKIP] redhat_data not found at: ${REDHAT_DATA_DIR}`);
        return 0;
    }

    const files = fs.readdirSync(REDHAT_DATA_DIR).filter(f => f.endsWith('.json'));
    console.log(`[INFO] Scanning ${files.length} existing advisory files...`);

    let found = 0;
    for (const file of files) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join(REDHAT_DATA_DIR, file), 'utf8'));
            if (!hasMariaDBPackages(data.packages)) continue;

            const outPath = path.join(OUTPUT_DIR, file);
            if (fs.existsSync(outPath)) continue;

            fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
            found++;
            console.log(`[PHASE3] ${data.id} | ${data.title?.slice(0, 60)}`);
        } catch (e) {
            // skip
        }
    }

    console.log(`[PHASE3 완료] redhat_data에서 추가 ${found}건 보충\n`);
    return found;
}

// ═══════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════
async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║         MariaDB RHSA/RHBA Collector v3.0               ║');
    console.log('║   Hydra API discovery → CSAF detail → redhat_data scan ║');
    console.log('╚══════════════════════════════════════════════════════════╝');

    // Phase 1: Discover advisory IDs
    const advisoryMap = await discoverFromHydra();

    // Phase 2: Fetch CSAF details
    const phase2Count = await fetchCSAFDetails(advisoryMap);

    // Phase 3: Supplement from existing data
    const phase3Count = scanExistingRedhatData();

    // Update metadata
    const allFiles = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json') && f !== 'metadata.json');
    const collectedIds = allFiles.map(f => {
        try {
            return JSON.parse(fs.readFileSync(path.join(OUTPUT_DIR, f), 'utf8')).id;
        } catch (e) { return null; }
    }).filter(Boolean);

    saveMetadata({
        last_run: new Date().toISOString(),
        total_collected: allFiles.length,
        collected_ids: collectedIds,
    });

    // Summary
    console.log('════════════════════════════════════════════════════════════');
    console.log(`[최종 결과]`);
    console.log(`   PHASE 1 (Hydra Discovery): ${advisoryMap.size}건 발견`);
    console.log(`   PHASE 2 (CSAF Fetch):      ${phase2Count}건 저장`);
    console.log(`   PHASE 3 (redhat_data Scan): ${phase3Count}건 보충`);
    console.log(`   총 수집: ${allFiles.length}건 (mariadb_data/)`);
    console.log('════════════════════════════════════════════════════════════');
}

main();
