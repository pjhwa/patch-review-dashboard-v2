const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CONFIG ---
const OUTPUT_DIR = './redhat_data';
const FILTER_DAYS = 180;
const MAX_CONCURRENCY = 6;
const FORCE_FULL_COLLECT = false;

const METADATA_PATH = path.join(OUTPUT_DIR, 'metadata.json');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// --- Metadata 강화 ---
function loadMetadata() {
    if (fs.existsSync(METADATA_PATH)) {
        try {
            const data = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
            if (data.max_timestamp) return data;
        } catch (e) {
            console.log('[WARN] metadata.json 손상 → Full Collect 진행');
        }
    }
    return { last_run: null, max_timestamp: null, total_collected: 0 };
}

function saveMetadata(data) {
    try {
        fs.writeFileSync(METADATA_PATH, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[ERROR] metadata 저장 실패');
    }
}

// --- HTTPS HELPER ---
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

// --- RHSA v7: 완전 수정 버전 ---
async function collectRedHatRHSA() {
    const metadata = loadMetadata();
    const isFirstRun = FORCE_FULL_COLLECT || !metadata.max_timestamp;

    console.log(`\n[RHSA v7] Red Hat Security Advisory 수집 시작...`);
    console.log(`   모드: ${isFirstRun ? 'Full Collect' : 'Incremental'}`);
    if (!isFirstRun) console.log(`   마지막 timestamp: ${metadata.max_timestamp}`);

    const filterCutoff = new Date(Date.now() - FILTER_DAYS * 86400000);
    const CHANGES_URL = 'https://security.access.redhat.com/data/csaf/v2/advisories/changes.csv';
    const CSAF_BASE = 'https://security.access.redhat.com/data/csaf/v2/advisories';

    let csvText = '';
    try {
        const r = await httpsGet(CHANGES_URL);
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        csvText = r.body;
    } catch (e) {
        console.error(`[ERROR] changes.csv 실패: ${e.message}`);
        return;
    }

    const lines = csvText.trim().split('\n');
    const candidates = [];
    let newMaxTimestamp = metadata.max_timestamp || '2000-01-01T00:00:00Z';

    for (const line of lines) {
        const m = line.match(/"([^"]+rhsa[^"]+\.json)","([^"]+)"/i);
        if (!m) continue;
        const [, filePath, timestamp] = m;

        // === 핵심 수정: Date 객체로 안전 비교 ===
        if (!isFirstRun && new Date(timestamp) <= new Date(metadata.max_timestamp)) {
            break;
        }

        if (timestamp > newMaxTimestamp) newMaxTimestamp = timestamp;

        const idMatch = filePath.match(/rhsa-(\d+)_(\d+)\.json/i);
        if (!idMatch) continue;

        const id = `RHSA-${idMatch[1]}:${idMatch[2]}`;
        const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, '_');

        if (!FORCE_FULL_COLLECT && fs.existsSync(path.join(OUTPUT_DIR, `${safeId}.json`))) continue;

        candidates.push({ id, filePath, safeId });
    }

    console.log(`[RHSA] 신규 후보 ${candidates.length}개 발견`);

    let saved = 0;
    for (let i = 0; i < candidates.length; i += MAX_CONCURRENCY) {
        const batch = candidates.slice(i, i + MAX_CONCURRENCY);
        await Promise.all(batch.map(async ({ id, filePath, safeId }) => {
            try {
                const r = await httpsGet(`${CSAF_BASE}/${filePath}`);
                if (r.status !== 200) return;
                const csaf = JSON.parse(r.body);
                const doc = csaf.document || {};
                const tracking = doc.tracking || {};

                const issuedDate = tracking.initial_release_date || '';
                if (new Date(issuedDate) < filterCutoff) return;

                const revisions = tracking.revision_history || [];
                let updatedDate = issuedDate;
                for (let j = revisions.length - 1; j >= 0; j--) {
                    if (!revisions[j].summary.includes('Last generated version')) {
                        updatedDate = revisions[j].date;
                        break;
                    }
                }

                const summaryNote = (doc.notes || []).find(n => n.category === 'summary');
                const generalNote = (doc.notes || []).find(n => n.category === 'general' || n.title === 'Details');
                const overview = summaryNote ? summaryNote.text : (doc.title || id);
                const description = generalNote ? generalNote.text : '';

                const packages = [];
                function extractPackages(node) {
                    if (!node) return;
                    if (node.category === 'product_version' && node.name) packages.push(node.name);
                    if (node.branches) node.branches.forEach(extractPackages);
                }
                extractPackages(csaf.product_tree);

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

                const cves = [];
                if (csaf.vulnerabilities) {
                    csaf.vulnerabilities.forEach(v => { if (v.cve) cves.push(v.cve); });
                }

                const advisory = {
                    id, vendor: 'Red Hat', type: 'Security Advisory (RHSA)',
                    title: doc.title || id,
                    issuedDate, updatedDate, pubDate: issuedDate, dateStr: issuedDate.split('T')[0],
                    url: `https://access.redhat.com/errata/${id}`,
                    severity: doc.aggregate_severity?.text || 'None',
                    overview, description,
                    affected_products: Array.from(affectedSet)
                        .filter(n => n && n.includes('Red Hat Enterprise Linux'))
                        .sort(),
                    cves, packages,
                    full_text: [overview, description].join('\n\n').slice(0, 7000)
                };

                fs.writeFileSync(path.join(OUTPUT_DIR, `${safeId}.json`), JSON.stringify(advisory, null, 2));
                saved++;
                console.log(`[OK] ${id} | Issued: ${advisory.dateStr} | CVEs: ${cves.length}`);
            } catch (e) {
                console.error(`[FAIL] ${id} : ${e.message}`);
            }
        }));
    }

    saveMetadata({
        last_run: new Date().toISOString(),
        max_timestamp: newMaxTimestamp,
        total_collected: (metadata.total_collected || 0) + saved
    });

    console.log(`\n[완료] RHSA v7 수집 성공! 신규 저장: ${saved}개`);
}

collectRedHatRHSA();
