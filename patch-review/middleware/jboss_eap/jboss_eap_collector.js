const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

// === 설정 ===
const COOKIE_FILE = './cookie.txt';
const OUTPUT_DIR = './jboss_eap_data';
const FILTER_DAYS = 180;          // 6개월
const ROWS_PER_PAGE = 100;
const MAX_PAGES = 200;
const RETRY = 3;
const DELAY_MS = 600;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const METADATA_PATH = path.join(OUTPUT_DIR, 'metadata.json');

// === Cookie 로드 (선택사항, 없으면 경고만 출력) ===
let COOKIE = '';
try {
    COOKIE = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    console.log(`[INFO] cookie.txt 로드 성공`);
} catch (e) {
    console.warn(`[WARN] cookie.txt 파일이 없습니다. 인증이 필요한 경우 일부 데이터가 누락될 수 있습니다.`);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// === JBoss EAP 전용 검색 URL ===
// - documentKind: Errata (RHSA, RHBA, RHEA 모두 포함)
// - portal_product_filter: JBoss Enterprise Application Platform (Red Hat 접두어 없음)
// - sort: 최신 업데이트 순
const BASE_URL =
    'https://access.redhat.com/hydra/rest/search/kcs' +
    '?q=*%3A*' +
    '&hl=true&hl.fl=abstract' +
    '&fq=documentKind%3A%28%22Errata%22%29' +
    '&facet=true&facet.mincount=1' +
    '&fl=id%2Cportal_severity%2Cportal_advisory_type%2Cportal_product_names%2Cportal_publication_date%2Cportal_update_date%2Cportal_synopsis%2Cview_uri%2CallTitle' +
    '&sort=portal_update_date+desc' +
    '&fq=portal_product_filter%3AJBoss%5C+Enterprise%5C+Application%5C+Platform%7C*%7C*%7C*';

// === Metadata ===
function loadMetadata() {
    if (fs.existsSync(METADATA_PATH)) {
        try { return JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8')); } catch (e) {}
    }
    return { last_run: null, total_collected: 0 };
}

function saveMetadata(data) {
    fs.writeFileSync(METADATA_PATH, JSON.stringify(data, null, 2));
}

// === HTTP 헬퍼 ===
async function httpsGet(url) {
    return new Promise((resolve) => {
        const headers = { 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/json,*/*' };
        if (COOKIE) headers['Cookie'] = COOKIE;
        https.get(url, { headers, timeout: 30000 }, res => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return httpsGet(res.headers.location).then(resolve);
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', () => resolve({ status: 0, body: '' }));
    });
}

function delay(ms) {
    return new Promise(res => setTimeout(res, ms));
}

function cleanText(text) {
    return text.replace(/\n\s+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

// === 날짜 추출 헬퍼 ===
function extractDate(field) {
    return Array.isArray(field) ? field[0] : (field || new Date().toISOString());
}

// === Errata 상세 페이지 스크래핑 ===
async function scrapeErrataPage(id, summary) {
    const url = `https://access.redhat.com/errata/${id}`;

    for (let attempt = 1; attempt <= RETRY; attempt++) {
        const r = await httpsGet(url);
        if (r.status !== 200) {
            await delay(DELAY_MS * attempt);
            continue;
        }

        const $ = cheerio.load(r.body);

        // Description / Bug Fix / Enhancement 섹션 수집
        let description = '';
        $('h2, h3').each((i, el) => {
            const heading = $(el).text().trim();
            if (/description|bug fix|enhancement|security/i.test(heading)) {
                description += $(el).nextUntil('h2, h3').text().trim() + '\n';
            }
        });
        if (!description) {
            description = $('.errata-description, #description, article').first().text().trim();
        }

        // Package 목록 수집 (.el 또는 .rpm 포함 항목)
        const packageSet = new Set();
        $('td, li').each((i, el) => {
            const text = $(el).text().trim();
            if ((text.includes('.el') || text.includes('.rpm')) &&
                text.length > 5 && text.length < 300) {
                packageSet.add(text.replace(/\.rpm$/, '').trim());
            }
        });

        // CVE 목록 수집 (RHSA 어드바이저리 해당)
        const cveSet = new Set();
        const cvePattern = /CVE-\d{4}-\d+/g;
        let m;
        while ((m = cvePattern.exec(r.body)) !== null) cveSet.add(m[0]);

        // Fixes 섹션 수집 (RHBA 어드바이저리 해당)
        const fixes = [];
        let fixesHeading = null;
        $('h2, h3').each((i, el) => {
            if ($(el).text().trim() === 'Fixes') fixesHeading = $(el);
        });
        if (fixesHeading) {
            fixesHeading.nextAll('ul').first().find('li').each((i, li) => {
                const link = $(li).find('a').first();
                const issueId = link.text().trim();
                const issueUrl = link.attr('href') || '';
                const issueDesc = $(li).text().trim().replace(issueId, '').replace(/^[\s\-–]+/, '').trim();
                if (issueId) fixes.push({ id: issueId, url: issueUrl, description: issueDesc });
            });
        }

        // 필드 정리
        const advisoryType = Array.isArray(summary.portal_advisory_type)
            ? summary.portal_advisory_type[0]
            : (summary.portal_advisory_type || 'Unknown');
        const severity = Array.isArray(summary.portal_severity)
            ? summary.portal_severity[0]
            : (summary.portal_severity || 'None');
        const updateDate = extractDate(summary.portal_update_date);
        const pubDate = extractDate(summary.portal_publication_date) || updateDate;
        const synopsis = summary.portal_synopsis || '';
        const products = summary.portal_product_names || ['Red Hat JBoss Enterprise Application Platform'];
        const overview = synopsis || id;

        return {
            id,
            vendor: 'Red Hat',
            type: advisoryType,
            title: summary.allTitle || `${id}: ${synopsis}`,
            issuedDate: pubDate,
            updatedDate: updateDate,
            pubDate,
            dateStr: updateDate.split('T')[0],
            url: `https://access.redhat.com/errata/${id}`,
            severity,
            overview,
            description: cleanText(description),
            affected_products: products,
            cves: [...cveSet],
            packages: [...packageSet],
            fixes,
            full_text: [overview, cleanText(description)].join('\n\n').slice(0, 7000)
        };
    }

    return null;
}

// === 메인 수집 함수 ===
async function collectJBossEAP() {
    console.log(`\n[JBoss EAP Collector] Red Hat JBoss EAP 패치 정보 수집 시작`);
    console.log(`   기간: 최근 ${FILTER_DAYS}일 (약 6개월)`);
    console.log(`   출력: ${OUTPUT_DIR}/`);

    const metadata = loadMetadata();
    if (metadata.last_run) {
        console.log(`   이전 실행: ${metadata.last_run} (누적 ${metadata.total_collected}개)`);
    }

    const cutoff = new Date(Date.now() - FILTER_DAYS * 86400000);
    let totalAdded = 0;
    let page = 1;

    while (page <= MAX_PAGES) {
        const start = (page - 1) * ROWS_PER_PAGE;
        const url = `${BASE_URL}&rows=${ROWS_PER_PAGE}&start=${start}`;

        console.log(`\n[PAGE ${page}] 조회 중... (start=${start})`);
        const r = await httpsGet(url);

        if (r.status !== 200) {
            console.error(`[ERROR] HTTP ${r.status}`);
            if (r.status === 403) {
                console.error(`[ERROR] 인증 실패. Red Hat 포털에서 cookie.txt를 갱신하세요.`);
            }
            break;
        }

        let json;
        try {
            json = JSON.parse(r.body);
        } catch (e) {
            console.error(`[ERROR] JSON 파싱 실패: ${e.message}`);
            break;
        }

        const docs = json.response?.docs || [];
        const total = json.response?.numFound || 0;
        console.log(`[PAGE ${page}] 결과: ${docs.length}건 / 전체 ${total}건`);

        if (docs.length === 0) {
            console.log(`[INFO] 더 이상 결과 없음 → 수집 완료`);
            break;
        }

        let foundOld = false;
        for (const summary of docs) {
            const updateDateStr = extractDate(summary.portal_update_date);
            if (new Date(updateDateStr) < cutoff) {
                console.log(`[STOP] ${updateDateStr} → 6개월 이전 데이터 도달`);
                foundOld = true;
                break;
            }

            const id = summary.id;
            if (!id) continue;

            const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, '_');
            const outputPath = path.join(OUTPUT_DIR, `${safeId}.json`);

            if (fs.existsSync(outputPath)) {
                console.log(`[SKIP] ${id} (기수집)`);
                continue;
            }

            await delay(DELAY_MS);
            const advisory = await scrapeErrataPage(id, summary);
            if (!advisory) {
                console.warn(`[WARN] ${id} 스크래핑 실패`);
                continue;
            }

            fs.writeFileSync(outputPath, JSON.stringify(advisory, null, 2));
            totalAdded++;

            const typLabel = advisory.type.replace('Advisory', '').trim();
            const cveStr = advisory.cves.length > 0 ? ` | CVEs: ${advisory.cves.join(', ')}` : '';
            console.log(`[OK] ${id} | ${typLabel} | ${advisory.dateStr} | Severity: ${advisory.severity}${cveStr}`);
        }

        if (foundOld || docs.length < ROWS_PER_PAGE) break;
        page++;
    }

    saveMetadata({
        last_run: new Date().toISOString(),
        filter_days: FILTER_DAYS,
        total_collected: (metadata.total_collected || 0) + totalAdded
    });

    console.log(`\n[완료] JBoss EAP 패치 수집 종료`);
    console.log(`   신규 저장: ${totalAdded}개`);
    console.log(`   저장 위치: ${OUTPUT_DIR}/`);
}

collectJBossEAP();
