"""PostgreSQL Security 패치 수집기

- postgresql.org/support/security/ + NVD CVE 2.0 API 데이터를 조합
- 최근 6개월 패치 정보를 버전별 AI 리뷰 최적화 JSON으로 저장
- PostgreSQL 13 / 14 / 15 / 16 / 17 대상 (현재 지원 버전)

데이터 소스:
  1. postgresql.org/support/security/ : CVE ID, 영향받는 버전, 수정 버전, CVSS, 설명 (권위있는 출처)
  2. postgresql.org/about/news/* : 릴리스 발행일 (각 보안 공지 페이지)
  3. NVD CVE 2.0 API : 상세 CVSS 벡터, 전문 설명 (선택적 보완)
  4. postgresql.org/docs/{major}/release-{major}-{minor}.html : 버전별 릴리스 노트 (non-CVE 버그픽스)

실제 pg.org 보안 페이지 컬럼 구조:
  0: Reference (CVE ID + Announcement 링크)
  1: Affected (영향받는 major 버전 목록)
  2: Fixed (수정 버전 목록, 예: "17.8, 16.12, 15.16, 14.21")
  3: Component & CVSS v3 Base Score (컴포넌트명, CVSS 점수, CVSS 벡터)
  4: Description (단문 설명)

NVD API Key (선택):
  환경변수 NVD_API_KEY를 설정하면 rate limit이 완화됩니다 (50 req/30s → 5 req/30s).
  미설정 시 요청 간 6.5초 대기합니다.
"""

import requests
import json
import re
import time
import os
from pathlib import Path
from datetime import datetime
from dateutil.relativedelta import relativedelta
from dotenv import load_dotenv


# ─── 설정 ─────────────────────────────────────────────────────────────────────

# .env 파일 로드 (스크립트 위치 기준, 없으면 무시)
load_dotenv(Path(__file__).parent / ".env")

TARGET_PG_VERSIONS = [13, 14, 15, 16, 17]  # 현재 지원 버전

PG_SECURITY_URL = "https://www.postgresql.org/support/security/"
NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"

NVD_API_KEY = os.environ.get("NVD_API_KEY", "")
_NVD_DELAY = 0.6 if NVD_API_KEY else 6.5  # 초 단위

OUT_DIR = Path("pgsql_data")
MANIFEST_FILE = OUT_DIR / "manifest.json"

_nvd_last_call_ts = 0.0  # 마지막 NVD API 호출 시각

_HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 patch-collector/1.0"}


# ─── 공통 유틸 ────────────────────────────────────────────────────────────────

def clean_html(text, max_len=0):
    """HTML 태그 제거 및 공백 정리."""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', ' ', str(text))
    text = re.sub(r'\s+', ' ', text).strip()
    if max_len > 0:
        text = text[:max_len]
    return text


def parse_date(date_str):
    """날짜 문자열을 'YYYY-MM-DD' 형태로 정규화. 실패 시 '' 반환."""
    if not date_str:
        return ""
    date_str = date_str.strip()
    for fmt in ("%Y-%m-%d", "%B %d, %Y", "%d %b %Y", "%b %d, %Y", "%d %B %Y"):
        try:
            return datetime.strptime(date_str, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    iso_match = re.search(r'(\d{4}-\d{2}-\d{2})', date_str)
    if iso_match:
        return iso_match.group(1)
    return ""


def pg_version_tuple(ver_str):
    """버전 문자열을 정수 튜플로 변환 (크기 비교용). 예: '17.4' → (17, 4)"""
    try:
        return tuple(int(p) for p in ver_str.split("."))
    except (ValueError, AttributeError):
        return (0, 0)


def pg_safe_name(major):
    """PostgreSQL 버전 번호를 파일명에 안전한 문자열로 변환."""
    return f"PostgreSQL_{major}"


def month_year_to_prefix(month_year):
    """'2026-Mar' → '2026-03' 형태의 ISO 연월 접두사 반환."""
    dt = datetime.strptime(month_year, "%Y-%b")
    return dt.strftime("%Y-%m")


# ─── NVD API ──────────────────────────────────────────────────────────────────

def _nvd_throttle():
    """NVD API rate limit 준수를 위한 대기."""
    global _nvd_last_call_ts
    elapsed = time.time() - _nvd_last_call_ts
    if elapsed < _NVD_DELAY:
        time.sleep(_NVD_DELAY - elapsed)
    _nvd_last_call_ts = time.time()


def fetch_nvd_cve(cve_id):
    """NVD API에서 특정 CVE의 상세 정보를 조회한다.

    Args:
        cve_id: "CVE-2024-10978"

    Returns:
        dict | None: {description, cvss_base_score, cvss_vector, severity, published}
                     NVD에 없거나 실패 시 None
    """
    global _nvd_last_call_ts
    _nvd_throttle()

    params = {"cveId": cve_id}
    req_headers = {**_HTTP_HEADERS}
    if NVD_API_KEY:
        req_headers["apiKey"] = NVD_API_KEY

    r = None
    for attempt in range(2):
        try:
            r = requests.get(NVD_BASE_URL, params=params, headers=req_headers, timeout=20)
            if r.status_code in (429, 403) and attempt == 0:
                print(f"      NVD rate limit ({r.status_code}), 35초 대기 후 재시도...")
                time.sleep(35)
                _nvd_last_call_ts = time.time()
                continue
            r.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            if attempt == 0:
                continue
            print(f"      NVD 조회 실패 ({cve_id}): {e}")
            return None

    if r is None:
        return None

    data = r.json()
    vulns = data.get("vulnerabilities", [])
    if not vulns:
        return None

    cve_item = vulns[0].get("cve", {})

    # 영어 설명 추출
    description = ""
    for desc in cve_item.get("descriptions", []):
        if desc.get("lang") == "en":
            description = desc.get("value", "")
            break

    # CVSS 추출 (V31 → V30 → V2 순)
    cvss_base = 0.0
    cvss_vector = ""
    metrics = cve_item.get("metrics", {})
    for metric_key in ("cvssMetricV31", "cvssMetricV30", "cvssMetricV2"):
        metric_list = metrics.get(metric_key, [])
        if metric_list:
            cvss_data = metric_list[0].get("cvssData", {})
            cvss_base = float(cvss_data.get("baseScore", 0.0))
            cvss_vector = cvss_data.get("vectorString", "")
            break

    return {
        "description": description,
        "cvss_base_score": cvss_base,
        "cvss_vector": cvss_vector,
        "severity": _score_to_severity(cvss_base),
        "published": (cve_item.get("published", "") or "")[:10],
    }


def _score_to_severity(score):
    """CVSS 점수를 severity 레이블로 변환."""
    if score >= 9.0:
        return "Critical"
    elif score >= 7.0:
        return "High"
    elif score >= 4.0:
        return "Medium"
    else:
        return "Low"


# ─── PostgreSQL 페이지 스크래핑 ───────────────────────────────────────────────

def fetch_announcement_date(announcement_url):
    """pg.org 뉴스 공지 페이지에서 'Posted on YYYY-MM-DD' 날짜를 추출한다.

    Args:
        announcement_url: "https://www.postgresql.org/about/news/..."

    Returns:
        str: "YYYY-MM-DD" 또는 실패 시 ""
    """
    try:
        r = requests.get(announcement_url, headers=_HTTP_HEADERS, timeout=15)
        if r.status_code != 200:
            return ""
    except requests.exceptions.RequestException:
        return ""

    # <div class="newsdate">Posted on <strong>YYYY-MM-DD</strong>
    m = re.search(r'class="newsdate"[^>]*>.*?<strong>(\d{4}-\d{2}-\d{2})</strong>', r.text, re.DOTALL)
    if m:
        return m.group(1)
    return ""


def parse_component_cvss(cell_html):
    """pg.org 보안 페이지의 'Component & CVSS' 컬럼 셀을 파싱한다.

    셀 형식 (예시):
      contrib module<br/>
      <a href="...?vector=AV:N/AC:L/...">8.2</a><br/>
      <span class="cvssvector">AV:N/AC:L/...</span>

    Returns:
        tuple[str, float, str]: (component, cvss_score, cvss_vector)
    """
    # 컴포넌트: 첫 번째 <br> 이전 텍스트
    pre_br = re.split(r'<br\s*/?>', cell_html, maxsplit=1)[0]
    component = clean_html(pre_br)

    # CVSS 점수: 링크 텍스트
    score_m = re.search(r'>(\d+\.\d+)</a>', cell_html)
    cvss_score = float(score_m.group(1)) if score_m else 0.0

    # CVSS 벡터: href의 vector= 파라미터 또는 cvssvector span
    vector_m = re.search(r'vector=([A-Za-z0-9:/.,]+)', cell_html)
    if vector_m:
        cvss_vector = vector_m.group(1)
    else:
        span_m = re.search(r'class="cvssvector">(.*?)</span>', cell_html, re.DOTALL)
        cvss_vector = clean_html(span_m.group(1)) if span_m else ""

    return component, cvss_score, cvss_vector


def parse_fixed_versions(fixed_str):
    """고정 버전 문자열을 파싱하여 {major: fixed_version} dict 반환.

    Args:
        fixed_str: "17.8, 16.12, 15.16, 14.21" 또는 "18.2" 등

    Returns:
        dict: {17: "17.8", 16: "16.12", ...} (TARGET_PG_VERSIONS에 속하는 것만)
    """
    result = {}
    for m in re.finditer(r'(\d+)\.(\d+)', fixed_str):
        major = int(m.group(1))
        if major in TARGET_PG_VERSIONS:
            result[major] = f"{major}.{m.group(2)}"
    return result


def fetch_pg_security_page():
    """postgresql.org/support/security/ 를 스크래핑하여 전체 CVE 목록을 반환한다.

    각 CVE의 발행일은 Announcement 뉴스 페이지에서 조회한다 (릴리스 배치별 캐시).

    Returns:
        list[dict]: [
            {
                "cve": str,                  # "CVE-2026-2006"
                "affected_raw": str,         # "18, 17, 16, 15, 14"
                "fixed_raw": str,            # "18.2, 17.8, 16.12, 15.16, 14.21"
                "component": str,            # "core server"
                "cvss_pg": float,            # 8.8
                "cvss_vector_pg": str,       # "AV:N/AC:L/PR:L/..."
                "title": str,                # 단문 설명
                "announcement_url": str,     # pg.org 뉴스 URL
                "published": str,            # "YYYY-MM-DD" (뉴스 페이지 발행일)
                "fixed_versions": dict,      # {17: "17.8", 16: "16.12", ...}
            }, ...
        ]
        스크래핑 실패 시 빈 리스트.
    """
    try:
        r = requests.get(PG_SECURITY_URL, headers=_HTTP_HEADERS, timeout=20)
        if r.status_code != 200:
            print(f"  pg.org 보안 페이지 응답 오류: {r.status_code}")
            return []
    except requests.exceptions.RequestException as e:
        print(f"  pg.org 보안 페이지 접근 실패: {e}")
        return []

    html = r.text

    # 보안 테이블 추출 (class="table" 포함 우선, fallback: 첫 번째 <table>)
    table_m = re.search(
        r'<table[^>]*class="[^"]*table[^"]*"[^>]*>(.*?)</table>',
        html, re.DOTALL | re.IGNORECASE
    )
    if not table_m:
        table_m = re.search(r'<table[^>]*>(.*?)</table>', html, re.DOTALL)
    if not table_m:
        print("  pg.org 보안 테이블을 찾을 수 없음")
        return []

    table_html = table_m.group(1)

    # tbody 데이터 행 파싱
    tbody_m = re.search(r'<tbody[^>]*>(.*?)</tbody>', table_html, re.DOTALL | re.IGNORECASE)
    if tbody_m:
        rows_html = re.findall(
            r'<tr[^>]*>(.*?)</tr>', tbody_m.group(1), re.DOTALL | re.IGNORECASE
        )
    else:
        # fallback: 모든 tr에서 헤더 행(th 포함) 제외
        all_rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE)
        rows_html = [r for r in all_rows if '<th' not in r.lower()]

    # 발행일 캐시: {announcement_url: "YYYY-MM-DD"}
    date_cache = {}

    results = []
    for row_html in rows_html:
        cells = re.findall(r'<td[^>]*>(.*?)</td>', row_html, re.DOTALL | re.IGNORECASE)
        if len(cells) < 4:
            continue

        # Cell[0]: CVE ID + Announcement 링크
        cve_m = re.search(r'CVE-\d{4}-\d+', cells[0], re.IGNORECASE)
        if not cve_m:
            continue
        cve_id = cve_m.group(0).upper()

        # Announcement URL 추출 (두 번째 <a> 태그)
        all_links = re.findall(r'href="([^"]+)"', cells[0])
        announcement_url = ""
        for link in all_links:
            if "/about/news/" in link:
                announcement_url = link if link.startswith("http") else f"https://www.postgresql.org{link}"
                break

        # Cell[1]: Affected (예: "18, 17, 16, 15, 14")
        affected_raw = clean_html(cells[1])

        # Cell[2]: Fixed (예: "18.2, 17.8, 16.12, 15.16, 14.21")
        fixed_raw = clean_html(cells[2])
        fixed_versions = parse_fixed_versions(fixed_raw)
        if not fixed_versions:
            continue  # TARGET_PG_VERSIONS 대상 패치가 아님

        # Cell[3]: Component & CVSS
        component, cvss_pg, cvss_vector_pg = parse_component_cvss(cells[3])

        # Cell[4]: Description (단문)
        title = clean_html(cells[4], 300) if len(cells) > 4 else ""
        # "more details" 링크 텍스트 제거
        title = re.sub(r'\s*more details\s*$', '', title, flags=re.IGNORECASE).strip()

        # 발행일: Announcement 뉴스 페이지에서 조회 (캐시)
        published = ""
        if announcement_url:
            if announcement_url not in date_cache:
                date_cache[announcement_url] = fetch_announcement_date(announcement_url)
            published = date_cache[announcement_url]

        if not published:
            continue  # 날짜를 알 수 없으면 스킵

        results.append({
            "cve": cve_id,
            "affected_raw": affected_raw,
            "fixed_raw": fixed_raw,
            "component": component,
            "cvss_pg": cvss_pg,
            "cvss_vector_pg": cvss_vector_pg,
            "title": title,
            "announcement_url": announcement_url,
            "published": published,
            "fixed_versions": fixed_versions,
        })

    return results


# ─── 릴리스 노트 (Non-CVE 버그픽스) ─────────────────────────────────────────

# 심각도 키워드 (비공식 휴리스틱, 설명 텍스트에서 판단)
_SEVERITY_HIGH_KW = [
    "crash", "data loss", "data corrupt", "corruption", "corrupt",
    "buffer overrun", "memory overrun", "overflow",
    "deadlock", "silent data", "arbitrary code", "remote code",
]
_SEVERITY_LOW_KW = [
    "cosmetic", "minor", "typo", "spelling", "documentation",
    "performance", "improve", "avoid scribbling", "update time zone",
]


def _heuristic_severity(text):
    """키워드 기반으로 버그픽스 심각도를 추정한다 (비공식).

    Returns:
        str: "High" | "Medium" | "Low"
    """
    t = text.lower()
    if any(k in t for k in _SEVERITY_HIGH_KW):
        return "High"
    if any(k in t for k in _SEVERITY_LOW_KW):
        return "Low"
    return "Medium"


def fetch_release_notes(major, release_version, cve_keywords=None):
    """pg.org 릴리스 노트 페이지에서 버그픽스 목록을 수집한다.

    릴리스 노트 URL 형식: https://www.postgresql.org/docs/{major}/release-{major}-{minor}.html
    예: https://www.postgresql.org/docs/17/release-17-8.html

    릴리스 노트의 itemizedlist에는 보안 CVE 픽스 + 일반 버그픽스가 함께 포함되어 있다.
    CVE 항목은 (1) "CVE-" 패턴, (2) cve_keywords 교차 검증으로 필터링하고 나머지만 반환한다.

    각 항목에는 키워드 기반 휴리스틱 severity가 포함된다 (severity_source: "heuristic").

    Args:
        major: 정수 major 버전 (예: 17)
        release_version: "17.8" 형태의 버전 문자열
        cve_keywords: CVE 설명에서 추출한 핵심 키워드 집합 (is_security 판별 보조)
                      예: {"oidvector", "pgcrypto", "multibyte"}

    Returns:
        list[dict]: [
            {
                "description": str,          # 버그픽스 요약 (기여자 제외)
                "detail": str,               # § 이후 보충 설명
                "author": str,               # "(Tom Lane)" 등 기여자
                "severity": str,             # "High" | "Medium" | "Low" (휴리스틱)
                "severity_source": str,      # 항상 "heuristic"
                "is_security": bool,         # CVE 관련 보안 픽스 여부
            }, ...
        ]
        is_security=True 항목은 non_cve_fixes에서 제외된다.
        실패 시 빈 리스트.
    """
    cve_keywords = {k.lower() for k in (cve_keywords or set())}

    ver_slug = release_version.replace(".", "-")
    url = f"https://www.postgresql.org/docs/{major}/release-{ver_slug}.html"

    try:
        r = requests.get(url, headers=_HTTP_HEADERS, timeout=20)
        if r.status_code != 200:
            return []
    except requests.exceptions.RequestException:
        return []

    html = r.text

    # itemizedlist 추출 (가장 긴 것 = Changes 섹션)
    lists = re.findall(
        r'<ul class="itemizedlist[^"]*"[^>]*>(.*?)</ul>',
        html, re.DOTALL | re.IGNORECASE
    )
    if not lists:
        lists = re.findall(r'<ul[^>]*>(.*?)</ul>', html, re.DOTALL | re.IGNORECASE)
    if not lists:
        return []

    target_list = max(lists, key=len)
    items_html = re.findall(r'<li[^>]*>(.*?)</li>', target_list, re.DOTALL | re.IGNORECASE)

    fixes = []
    for item_html in items_html:
        raw_text = re.sub(r'<[^>]+>', ' ', item_html)
        raw_text = re.sub(r'\s+', ' ', raw_text).strip()
        if not raw_text:
            continue

        # § 기호로 요약과 보충 설명 분리
        parts = [p.strip() for p in raw_text.split('§')]
        summary = parts[0]
        detail = ' '.join(parts[1:]).strip() if len(parts) > 1 else ""

        # 기여자 추출: 요약 끝 "(Name)" 패턴
        author_m = re.search(r'\(([^)]+)\)\s*$', summary)
        author = author_m.group(1) if author_m else ""
        description = summary[:author_m.start()].strip() if author_m else summary

        # CVE 관련 여부 판별
        # 1) "CVE-XXXX-XXXXX" 명시
        has_cve_ref = bool(re.search(r'CVE-\d{4}-\d+', raw_text, re.IGNORECASE))
        # 2) cve_keywords 교차 검증 (pg.org 보안 페이지 제목의 핵심어)
        desc_lower = description.lower()
        has_cve_kw = bool(cve_keywords and any(kw in desc_lower for kw in cve_keywords))

        is_security = has_cve_ref or has_cve_kw

        # 심각도 (비보안 항목에 의미 있음; 보안 항목은 CVSS 사용)
        severity = _heuristic_severity(description + " " + detail)

        fixes.append({
            "description": description,
            "detail": detail,
            "author": author,
            "severity": severity,
            "severity_source": "heuristic",
            "is_security": is_security,
        })

    return fixes


# ─── 수집 상태 관리 ───────────────────────────────────────────────────────────

def get_last_6_months():
    """현재 월 포함 최근 7개월의 'YYYY-Mon' 문자열 목록 반환."""
    now = datetime.now()
    months = []
    for i in range(7):
        d = now - relativedelta(months=i)
        months.append(d.strftime("%Y-%b"))
    return sorted(months)


def load_manifest():
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest):
    OUT_DIR.mkdir(exist_ok=True)
    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def fetch_remote_release_dates(pg_cves):
    """pg.org CVE 목록에서 월별 가장 최근 발행일을 추출한다 (staleness 감지용).

    Args:
        pg_cves: fetch_pg_security_page() 반환값

    Returns:
        dict: {"2026-Feb": "2026-02-12", ...}
    """
    result = {}
    for cve in pg_cves:
        published = cve.get("published", "")
        if not published:
            continue
        try:
            dt = datetime.strptime(published, "%Y-%m-%d")
        except ValueError:
            continue
        month_key = dt.strftime("%Y-%b")
        if month_key not in result or published > result[month_key]:
            result[month_key] = published
    return result


def _has_zero_cvss(month_year):
    """해당 월 파일 중 cvss_base_score=0.0인 취약점이 있는지 확인 (NVD 지연 재시도 판단용)."""
    for v in TARGET_PG_VERSIONS:
        f = OUT_DIR / f"PGSL-{month_year}-{pg_safe_name(v)}.json"
        if f.exists():
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                for vuln in data.get("vulnerabilities", []):
                    if vuln.get("cvss_base_score", 0.0) == 0.0:
                        return True
            except (json.JSONDecodeError, KeyError):
                pass
    return False


def needs_update(month_year, manifest, remote_dates):
    """해당 월의 데이터를 (재)수집해야 하는지 판단한다.

    Returns:
        tuple[bool, str]: (update_needed, reason)
    """
    # 매니페스트 미등록 → 신규 수집
    if month_year not in manifest:
        return True, "신규 수집"

    local_date = manifest[month_year].get("last_published", "")
    remote_date = remote_dates.get(month_year, "")

    has_any = any(
        (OUT_DIR / f"PGSL-{month_year}-{pg_safe_name(v)}.json").exists()
        for v in TARGET_PG_VERSIONS
    )

    if not has_any:
        # 파일 없음 = 이전 수집 시 패치가 없었던 달
        # pg.org에 해당 월 신규 CVE가 생겼으면 재수집
        if remote_date and local_date != remote_date:
            return True, f"신규 CVE 감지 ({remote_date[:10]})"
        return False, "해당 월 패치 없음"

    if not remote_date:
        if _has_zero_cvss(month_year):
            return True, "CVSS 미수집 재시도"
        return False, "해당 월 패치 없음"

    if local_date != remote_date:
        return True, f"업데이트 감지 ({local_date[:10] or '없음'} → {remote_date[:10]})"

    if _has_zero_cvss(month_year):
        return True, "CVSS 미수집 재시도"

    return False, "최신 상태"


def cleanup_old_months(manifest, valid_months):
    """수집 범위를 벗어난 오래된 데이터를 정리한다."""
    removed = []
    for month_year in list(manifest.keys()):
        if month_year not in valid_months:
            for v in TARGET_PG_VERSIONS:
                f = OUT_DIR / f"PGSL-{month_year}-{pg_safe_name(v)}.json"
                if f.exists():
                    f.unlink()
            del manifest[month_year]
            removed.append(month_year)
    return removed


# ─── 패치 수집 ────────────────────────────────────────────────────────────────

def fetch_pg_update(month_year, pg_cves):
    """해당 월의 PostgreSQL 보안 패치 JSON을 생성하여 저장한다.

    Args:
        month_year: "2026-Mar"
        pg_cves:    fetch_pg_security_page() 반환값 (전체 CVE 목록)

    Returns:
        dict: {major_version: stats_dict, "last_published": str}
              해당 월 CVE가 없으면 {"last_published": ""}
    """
    month_prefix = month_year_to_prefix(month_year)  # "2026-03"

    # 해당 월 CVE 필터링 (pg.org 발행일 기준)
    month_cves = [c for c in pg_cves if c["published"].startswith(month_prefix)]

    if not month_cves:
        print(f"    해당 월 CVE 없음 (패치 릴리스 없음)")
        return {"last_published": ""}

    print(f"    pg.org CVE {len(month_cves)}건 수집, NVD 상세 조회 중...")

    # NVD에서 CVE별 상세 정보 조회 (CVSS 벡터 + 전문 설명)
    nvd_cache = {}
    for cve_rec in month_cves:
        cve_id = cve_rec["cve"]
        nvd_data = fetch_nvd_cve(cve_id)
        nvd_cache[cve_id] = nvd_data
        if nvd_data:
            print(f"      {cve_id}: CVSS {nvd_data['cvss_base_score']} ({nvd_data['severity']})")
        else:
            print(f"      {cve_id}: NVD 데이터 없음 (pg.org 데이터 사용)")

    # 버전별 advisory 초기화
    advisories = {}
    for major in TARGET_PG_VERSIONS:
        advisories[major] = {
            "id": f"PGSL-{month_year}-{pg_safe_name(major)}",
            "vendor": "PostgreSQL Global Development Group",
            "product": f"PostgreSQL {major}",
            "month": month_year,
            "type": "Security Update",
            "vulnerabilities": [],
            "non_cve_fixes": [],  # 구조화된 공개 피드 없음
            "release_version": "",
            "release_date": "",
            "release_url": PG_SECURITY_URL,
            "stats": {
                "total_cves": 0,
                "critical_count": 0,
                "high_count": 0,
                "medium_count": 0,
                "low_count": 0,
                "max_cvss_base": 0.0,
                "non_cve_fix_count": 0,
            },
        }

    last_published = ""

    for cve_rec in month_cves:
        cve_id = cve_rec["cve"]
        fixed_versions = cve_rec["fixed_versions"]
        nvd = nvd_cache.get(cve_id)

        # CVSS 및 설명: NVD 우선, 없으면 pg.org fallback
        if nvd and nvd["cvss_base_score"] > 0:
            cvss_base = nvd["cvss_base_score"]
            cvss_vector = nvd["cvss_vector"]
            description = nvd["description"]
            severity = nvd["severity"]
        else:
            cvss_base = cve_rec["cvss_pg"]
            cvss_vector = cve_rec["cvss_vector_pg"]
            description = cve_rec["title"]
            severity = _score_to_severity(cvss_base) if cvss_base > 0 else "Low"

        published = cve_rec["published"]
        if published > last_published:
            last_published = published

        # 대상 major 버전에만 취약점 추가
        for major, fixed_ver in fixed_versions.items():
            adv = advisories[major]

            vuln_entry = {
                "cve": cve_id,
                "title": cve_rec["title"],
                "description": description,
                "severity": severity,
                "cvss_base_score": cvss_base,
                "cvss_vector": cvss_vector,
                "component": cve_rec["component"],
                "affected_versions": [cve_rec["affected_raw"]],
                "fixed_in_version": fixed_ver,
                "patch_url": f"https://www.postgresql.org/support/security/{cve_id}/",
                "published": published,
            }
            adv["vulnerabilities"].append(vuln_entry)

            # 릴리스 버전: 가장 높은 fixed_ver 사용
            if not adv["release_version"] or (
                pg_version_tuple(fixed_ver) > pg_version_tuple(adv["release_version"])
            ):
                adv["release_version"] = fixed_ver
                adv["release_date"] = published

            # stats 업데이트
            stats = adv["stats"]
            stats["total_cves"] += 1
            if severity == "Critical":
                stats["critical_count"] += 1
            elif severity == "High":
                stats["high_count"] += 1
            elif severity == "Medium":
                stats["medium_count"] += 1
            else:
                stats["low_count"] += 1
            if cvss_base > stats["max_cvss_base"]:
                stats["max_cvss_base"] = cvss_base

    # CVE 제목에서 핵심 키워드 추출 (릴리스 노트 CVE 항목 필터링 보조)
    cve_keywords = set()
    for cve_rec in month_cves:
        # pg.org 단문 제목(title)에서 의미있는 단어 추출 (3자 이상, 일반 동사 제외)
        words = re.findall(r'\b([a-z_][a-z_]{2,})\b', cve_rec["title"].lower())
        skip = {"the", "for", "and", "with", "from", "that", "this", "are",
                "has", "via", "its", "can", "may", "not", "into", "over",
                "fix", "fixes", "fixed", "postgresql", "could", "would", "allow",
                "when", "upon", "more", "than", "onto", "server", "memory", "using"}
        cve_keywords.update(w for w in words if w not in skip and len(w) > 3)

    # 릴리스 노트에서 버전별 non-CVE 버그픽스 수집
    print(f"    릴리스 노트 버그픽스 수집 중...")
    release_notes_cache = {}  # {release_version: [fixes]}
    for major in TARGET_PG_VERSIONS:
        adv = advisories[major]
        release_ver = adv["release_version"]
        if not release_ver:
            continue
        if release_ver not in release_notes_cache:
            all_fixes = fetch_release_notes(major, release_ver, cve_keywords)
            release_notes_cache[release_ver] = all_fixes
        all_fixes = release_notes_cache.get(release_ver, [])
        # is_security=False 항목만 non_cve_fixes에 포함
        adv["non_cve_fixes"] = [f for f in all_fixes if not f["is_security"]]

    # 저장
    OUT_DIR.mkdir(exist_ok=True)
    result = {"last_published": last_published}

    for major in TARGET_PG_VERSIONS:
        adv = advisories[major]
        if not adv["vulnerabilities"]:
            continue

        adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)
        adv["stats"]["non_cve_fix_count"] = len(adv["non_cve_fixes"])

        outfile = OUT_DIR / f"PGSL-{month_year}-{pg_safe_name(major)}.json"
        outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

        stats = adv["stats"]
        result[major] = stats
        fix_count = len(adv["non_cve_fixes"])
        print(
            f"    PostgreSQL {major}: {stats['total_cves']}건 CVE "
            f"(Critical: {stats['critical_count']}, High: {stats['high_count']}, "
            f"Max CVSS: {stats['max_cvss_base']}, 릴리스: {adv['release_version']}, "
            f"버그픽스: {fix_count}건)"
        )

    return result


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    months = get_last_6_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"대상 버전: {', '.join(f'PostgreSQL {v}' for v in TARGET_PG_VERSIONS)}")
    if NVD_API_KEY:
        print("NVD API Key: 설정됨 (rate limit 완화)")
    else:
        print("NVD API Key: 미설정 (요청 간 6.5초 대기)")
    print()

    manifest = load_manifest()

    print("pg.org 보안 페이지 조회 중...")
    pg_cves = fetch_pg_security_page()
    if not pg_cves:
        print("  ※ pg.org 데이터 수집 실패 - 수집을 중단합니다.")
        return
    print(f"  CVE 총 {len(pg_cves)}건 조회됨 (TARGET 버전 포함)")

    remote_dates = fetch_remote_release_dates(pg_cves)
    print()

    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    fetched = 0
    skipped = 0
    pg_totals = {v: {"cves": 0} for v in TARGET_PG_VERSIONS}

    for m in months:
        update_needed, reason = needs_update(m, manifest, remote_dates)

        if not update_needed:
            for v in TARGET_PG_VERSIONS:
                f = OUT_DIR / f"PGSL-{m}-{pg_safe_name(v)}.json"
                if f.exists():
                    existing = json.loads(f.read_text(encoding="utf-8"))
                    pg_totals[v]["cves"] += existing["stats"]["total_cves"]
            print(f"  {m}: 건너뜀 ({reason})")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({reason})")
        result = fetch_pg_update(m, pg_cves)
        if result is not None:
            manifest[m] = {
                "last_published": result["last_published"],
                "fetched_at": datetime.now().isoformat(),
            }
            for v in TARGET_PG_VERSIONS:
                if v in result:
                    pg_totals[v]["cves"] += result[v]["total_cves"]
            fetched += 1

    save_manifest(manifest)

    print()
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    for v in TARGET_PG_VERSIONS:
        t = pg_totals[v]
        print(f"  PostgreSQL {v}: {t['cves']}건 CVE")


if __name__ == "__main__":
    main()
