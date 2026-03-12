const fs = require('fs');
const path = require('path');
const https = require('https');

// --- CONFIG ---
const OUTPUT_DIR = './mysql_data';
const FILTER_DAYS = 180;
const MAX_CONCURRENCY = 6;
const FORCE_FULL_COLLECT = false;

const METADATA_PATH = path.join(OUTPUT_DIR, 'metadata.json');
const KEYWORDS = ['mysql', 'mysql-server', 'mysql-community'];

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// loadMetadata, saveMetadata, httpsGet 함수는 원본과 완전 동일 (생략 없이 복사)
function loadMetadata() { /* 원본 그대로 */ }
function saveMetadata(data) { /* 원본 그대로 */ }
function httpsGet(url) { /* 원본 그대로 */ }

// === 핵심: RHSA + RHBA 모두 수집 + MySQL 필터 ===
async function collectMySQLPatches() {
    const metadata = loadMetadata();
    const isFirstRun = FORCE_FULL_COLLECT || !metadata.max_timestamp;
    console.log(`\n[MySQL Collector] 수집 시작... 모드: ${isFirstRun ? 'Full' : 'Incremental'}`);

    const filterCutoff = new Date(Date.now() - FILTER_DAYS * 86400000);
    const CHANGES_URL = 'https://security.access.redhat.com/data/csaf/v2/advisories/changes.csv';
    const CSAF_BASE = 'https://security.access.redhat.com/data/csaf/v2/advisories';

    // ... (csv 읽기 및 candidates 루프는 원본과 동일)
    let csvText = (await httpsGet(CHANGES_URL)).body;
    const lines = csvText.trim().split('\n');
    const candidates = [];
    let newMaxTimestamp = metadata.max_timestamp || '2000-01-01T00:00:00Z';

    for (const line of lines) {
        const m = line.match(/"([^"]+rh(sa|ba)[^"]+\.json)","([^"]+)"/i);  // ← RHBA 추가
        if (!m) continue;
        const [, filePath, timestamp] = m;

        if (!isFirstRun && new Date(timestamp) <= new Date(metadata.max_timestamp)) break;
        if (timestamp > newMaxTimestamp) newMaxTimestamp = timestamp;

        const idMatch = filePath.match(/rh(sa|ba)-(\d+)_(\d+)\.json/i);
        if (!idMatch) continue;
        const prefix = idMatch[1].toUpperCase();
        const id = `RH${prefix}-${idMatch[2]}:${idMatch[3]}`;
        const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, '_');

        if (!FORCE_FULL_COLLECT && fs.existsSync(path.join(OUTPUT_DIR, `${safeId}.json`))) continue;
        candidates.push({ id, filePath, safeId, prefix });
    }

    // ... (배치 다운로드 루프 원본 그대로)
    let saved = 0;
    for (let i = 0; i < candidates.length; i += MAX_CONCURRENCY) {
        const batch = candidates.slice(i, i + MAX_CONCURRENCY);
        await Promise.all(batch.map(async ({ id, filePath, safeId, prefix }) => {
            try {
                const r = await httpsGet(`${CSAF_BASE}/${filePath}`);
                if (r.status !== 200) return;
                const csaf = JSON.parse(r.body);
                // ... (원본과 동일하게 issuedDate, updatedDate, overview, description, packages, affectedSet, cves 추출)

                // === MySQL 필터링 ===
                if (!isRelevantAdvisory(packages, affectedSet)) return;

                const advisory = {
                    id, vendor: 'Red Hat',
                    type: prefix === 'SA' ? 'Security Advisory (RHSA)' : 'Bug Fix Advisory (RHBA)',
                    title: doc.title || id,
                    issuedDate, updatedDate, pubDate: issuedDate, dateStr: issuedDate.split('T')[0],
                    url: `https://access.redhat.com/errata/${id}`,
                    severity: doc.aggregate_severity?.text || 'None',
                    overview, description,
                    affected_products: Array.from(affectedSet).filter(n => n.includes('Red Hat Enterprise Linux')).sort(),
                    cves, packages,
                    full_text: [overview, description].join('\n\n').slice(0, 7000)
                };

                fs.writeFileSync(path.join(OUTPUT_DIR, `${safeId}.json`), JSON.stringify(advisory, null, 2));
                saved++;
                console.log(`[OK] ${id} (MySQL) | Issued: ${advisory.dateStr}`);
            } catch (e) {
                console.error(`[FAIL] ${id} : ${e.message}`);
            }
        }));
    }

    // metadata 저장 및 완료 로그 (원본 그대로)
    saveMetadata({ last_run: new Date().toISOString(), max_timestamp: newMaxTimestamp, total_collected: (metadata.total_collected || 0) + saved });
    console.log(`[완료] MySQL 패치 ${saved}개 수집 완료`);
}

function isRelevantAdvisory(packages, affectedSet) {
    const text = [...(packages || []), ...Array.from(affectedSet || new Set())].join(' ').toLowerCase();
    return KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

collectMySQLPatches();
