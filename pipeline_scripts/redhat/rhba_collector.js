const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

// === 설정 ===
const COOKIE_FILE = './cookie.txt';
const OUTPUT_DIR = './redhat_data';
const FILTER_DAYS = 90;
const ROWS_PER_PAGE = 100;
const MAX_PAGES = 500;
const RETRY = 3;
const DELAY_MS = 600;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

let COOKIE = '';
try {
    COOKIE = fs.readFileSync(COOKIE_FILE, 'utf8').trim();
    console.log(`[INFO] cookie.txt 로드 성공`);
} catch (e) {
    console.error(`[ERROR] cookie.txt 파일이 없습니다!`);
    process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const BASE_URL = 'https://access.redhat.com/hydra/rest/search/kcs?q=*%3A*&hl=true&hl.fl=abstract&hl.simple.pre=%253Cmark%253E&hl.simple.post=%253C%252Fmark%253E&fq=documentKind%3A%28%22Errata%22%29+AND+portal_advisory_type%3A%28%22Bug+Fix+Advisory%22%29&facet=true&facet.mincount=1&fl=id%2Cportal_severity%2Cportal_advisory_type%2Cportal_product_names%2Cportal_publication_date%2Cportal_update_date%2Cportal_synopsis%2Cview_uri%2CallTitle&sort=portal_update_date+desc&facet.field=portal_advisory_type&facet.field=portal_severity&fq=portal_product_filter%3ARed%5C+Hat%5C+Enterprise%5C+Linux%7CRed%5C+Hat%5C+Enterprise%5C+Linux%5C+for%5C+x86_64%7C*%7Cx86_64';

function cleanText(text) {
    return text.replace(/Skip to navigation|Skip to main content|Subscriptions|Downloads|Red Hat Console|Utilities|Top Products|Product Life Cycles|Knowledge|Training and Certification|About|Course Index|Certification Index|Skill Assessment|Red Hat Knowledge Center|Product Compliance/g, '').replace(/\n\s+/g, ' ').trim();
}

async function httpsGet(url) {
    return new Promise((resolve) => {
        https.get(url, { headers: { 'Cookie': COOKIE, 'User-Agent': USER_AGENT, 'Accept': 'text/html,application/json' } }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
        }).on('error', () => resolve({ status: 0, body: '' }));
    });
}

async function scrapeErrataPage(id, summary) {
    const url = `https://access.redhat.com/errata/${id}`;
    for (let attempt = 1; attempt <= RETRY; attempt++) {
        const r = await httpsGet(url);
        if (r.status !== 200) {
            await new Promise(res => setTimeout(res, DELAY_MS));
            continue;
        }

        const $ = cheerio.load(r.body);

        let description = '';
        $('h2, h3').each((i, el) => {
            const heading = $(el).text().trim();
            if (heading.includes('Description') || heading.includes('Bug Fix') || heading.includes('Enhancement')) {
                description += $(el).nextUntil('h2, h3').text().trim() + '\n';
            }
        });
        if (!description) description = $('.errata-description, article').text().trim();

        const packages = [];
        $('td, li, .list-group-item, table tr td').each((i, el) => {
            let text = $(el).text().trim();
            if ((text.includes('.el') || text.includes('.rpm')) && text.length > 5) {
                if (text.includes('JIRA') || text.includes('Rebuild') || text.includes('updates dse.ldif')) return;
                text = text.replace(/\.rpm/g, '').trim();
                packages.push(text);
            }
        });

        return {
            id,
            vendor: 'Red Hat',
            type: 'Bug Fix Advisory (RHBA)',
            title: `Red Hat Bug Fix Advisory: ${summary.portal_synopsis || summary.allTitle.replace(/^\(RHBA-\d+:\d+\)\s*/, '')}`,
            issuedDate: summary.portal_update_date ? (Array.isArray(summary.portal_update_date) ? summary.portal_update_date[0] : summary.portal_update_date) : new Date().toISOString(),
            updatedDate: summary.portal_update_date ? (Array.isArray(summary.portal_update_date) ? summary.portal_update_date[0] : summary.portal_update_date) : new Date().toISOString(),
            pubDate: summary.portal_update_date ? (Array.isArray(summary.portal_update_date) ? summary.portal_update_date[0] : summary.portal_update_date) : new Date().toISOString(),
            dateStr: (summary.portal_update_date ? (Array.isArray(summary.portal_update_date) ? summary.portal_update_date[0] : summary.portal_update_date) : new Date().toISOString()).split('T')[0],
            url: `https://access.redhat.com/errata/${id}`,
            severity: 'None',
            overview: `An update for ${summary.portal_synopsis.split(' ')[0] || 'package'} is now available for Red Hat Enterprise Linux 10.`,
            description: cleanText(description) || '',
            affected_products: summary.portal_product_names ? summary.portal_product_names.map(p => p.includes('x86_64') ? `${p} 10 x86_64` : p) : ['Red Hat Enterprise Linux for x86_64 10 x86_64'],
            cves: [],
            packages: [...new Set(packages)],
            full_text: [`An update for ${summary.portal_synopsis.split(' ')[0] || 'package'} is now available for Red Hat Enterprise Linux 10.`, cleanText(description) || ''].join('\n\n').slice(0, 7000)
        };
    }
    return null;
}

async function collectAllRHBA() {
    console.log(`\n[RHBA Full Final] 자동 반복 + incremental 완전 강화 버전 시작...`);
    const cutoff = new Date(Date.now() - FILTER_DAYS * 86400000);
    let totalAdded = 0;

    // 자동 반복 루프 (새로운 패치가 0개가 될 때까지)
    let run = 1;
    while (true) {
        console.log(`\n[RUN ${run}] 수집 시작...`);
        let addedThisRun = 0;
        let page = 1;

        while (page <= MAX_PAGES) {
            const start = (page - 1) * ROWS_PER_PAGE;
            const url = `${BASE_URL}&rows=${ROWS_PER_PAGE}&start=${start}`;
            const r = await httpsGet(url);
            if (r.status !== 200) break;

            const json = JSON.parse(r.body);
            const docs = json.response?.docs || [];
            if (docs.length === 0) break;

            let foundOld = false;
            for (const summary of docs) {
                const updateDateStr = Array.isArray(summary.portal_update_date) ? summary.portal_update_date[0] : summary.portal_update_date;
                if (new Date(updateDateStr) < cutoff) {
                    foundOld = true;
                    break;
                }

                const id = summary.id;
                const safeId = id.replace(/[^a-zA-Z0-9:_-]/g, '_');
                if (fs.existsSync(path.join(OUTPUT_DIR, `${safeId}.json`))) continue;

                const advisory = await scrapeErrataPage(id, summary);
                if (!advisory) continue;

                fs.writeFileSync(path.join(OUTPUT_DIR, `${safeId}.json`), JSON.stringify(advisory, null, 2));
                addedThisRun++;
                console.log(`[OK] ${id} → packages: ${advisory.packages.length}개`);
            }

            console.log(`[PAGE ${page}] 완료 (이번 실행 추가: ${addedThisRun}개)`);
            if (foundOld || docs.length < ROWS_PER_PAGE) break;
            page++;
        }

        totalAdded += addedThisRun;
        console.log(`[RUN ${run}] 이번 실행에서 ${addedThisRun}개 추가 (누적 ${totalAdded}개)`);

        if (addedThisRun === 0) {
            console.log(`[자동 종료] 새로운 패치가 더 이상 없음 → 수집 완료`);
            break;
        }
        run++;
    }

    console.log(`\n[완료] 90일 내 총 ${totalAdded}개 RHBA 수집 완료 (한 번 실행으로 모든 패치 확보)`);
}

collectAllRHBA();
