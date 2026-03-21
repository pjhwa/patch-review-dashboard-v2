"""WildFly Security 패치 수집기

- NVD CVE 2.0 API (keywordSearch=wildfly) 로 WildFly 관련 CVE 수집
- GitHub Security Advisories API (선택, GITHUB_TOKEN 필요) 추가 보완
- 최근 7개월 패치 정보를 AI 리뷰 최적화 JSON으로 저장

데이터 소스:
  1. NVD CVE 2.0 API (keywordSearch=wildfly) : WildFly 관련 CVE (주 소스)
     ※ NVD API는 pubStartDate/pubEndDate 사용 시 120일 범위 제한이 있으므로
        날짜 파라미터 없이 전체 조회 후 로컬 필터링 방식으로 처리
  2. GitHub Security Advisories API (선택, GITHUB_TOKEN 필요):
     https://api.github.com/repos/wildfly/wildfly/security-advisories
  ※ wildfly.org/security/ 는 보안 신고 안내 페이지로 CVE 목록을 제공하지 않음

NVD API Key (선택):
  환경변수 NVD_API_KEY를 설정하면 rate limit이 완화됩니다 (50 req/30s → 5 req/30s).
  미설정 시 요청 간 6.5초 대기합니다.

GitHub Token (선택):
  환경변수 GITHUB_TOKEN을 설정하면 GitHub Security Advisories를 조회합니다.
  미설정 시 이 소스는 건너뜁니다.
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

WILDFLY_SECURITY_URL = "https://www.wildfly.org/security/"
NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
GITHUB_ADVISORIES_URL = "https://api.github.com/repos/wildfly/wildfly/security-advisories"

MONTHS_TO_COLLECT = 7

NVD_API_KEY = os.environ.get("NVD_API_KEY", "")
_NVD_DELAY = 0.6 if NVD_API_KEY else 6.5  # 초 단위

GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")

OUT_DIR = Path("wildfly_data")
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


def normalize_severity(raw):
    """WildFly 심각도 레이블을 정규화 (Critical/High/Medium/Low).

    Args:
        raw: "Critical", "Important", "Moderate", "Low" 등

    Returns:
        str: "Critical" | "High" | "Medium" | "Low"
    """
    if not raw:
        return "Medium"
    s = raw.strip().lower()
    if s == "critical":
        return "Critical"
    elif s in ("important", "high"):
        return "High"
    elif s in ("moderate", "medium"):
        return "Medium"
    elif s == "low":
        return "Low"
    return "Medium"


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
        cve_id: "CVE-2024-1234"

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


def fetch_nvd_keyword_search(keyword, months_back=7):
    """NVD API에서 키워드로 최근 CVE를 검색한다.

    NVD API는 pubStartDate/pubEndDate 파라미터 사용 시 120일 범위 제한이 있으므로
    날짜 파라미터 없이 전체 조회 후 로컬에서 날짜 필터링한다.

    Args:
        keyword: 검색 키워드 (예: "wildfly")
        months_back: 조회할 최근 개월 수

    Returns:
        list[dict]: [{cve_id, description, cvss_base_score, cvss_vector, severity, published}, ...]
    """
    global _nvd_last_call_ts
    _nvd_throttle()

    cutoff_date = (datetime.now() - relativedelta(months=months_back)).strftime("%Y-%m-%d")

    params = {
        "keywordSearch": keyword,
        "resultsPerPage": 2000,
    }
    req_headers = {**_HTTP_HEADERS}
    if NVD_API_KEY:
        req_headers["apiKey"] = NVD_API_KEY

    results = []
    r = None
    for attempt in range(2):
        try:
            r = requests.get(NVD_BASE_URL, params=params, headers=req_headers, timeout=30)
            if r.status_code in (429, 403) and attempt == 0:
                print(f"    NVD rate limit ({r.status_code}), 35초 대기 후 재시도...")
                time.sleep(35)
                _nvd_last_call_ts = time.time()
                continue
            r.raise_for_status()
            break
        except requests.exceptions.RequestException as e:
            if attempt == 0:
                continue
            print(f"    NVD 키워드 검색 실패: {e}")
            return []

    if r is None:
        return []

    data = r.json()
    for item in data.get("vulnerabilities", []):
        cve_item = item.get("cve", {})
        cve_id = cve_item.get("id", "")
        if not cve_id:
            continue

        description = ""
        for desc in cve_item.get("descriptions", []):
            if desc.get("lang") == "en":
                description = desc.get("value", "")
                break

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

        published = (cve_item.get("published", "") or "")[:10]
        # 날짜 범위 로컬 필터링 (NVD API 120일 제한 우회)
        if published < cutoff_date:
            continue

        results.append({
            "cve": cve_id,
            "description": description,
            "cvss_base_score": cvss_base,
            "cvss_vector": cvss_vector,
            "severity": _score_to_severity(cvss_base),
            "published": published,
            "source": "nvd_keyword",
        })

    return results


# ─── wildfly.org 보안 페이지 스크래핑 ─────────────────────────────────────────

def fetch_wildfly_security_page():
    """wildfly.org/security/ 스크래핑 (현재 비활성).

    wildfly.org/security/ 페이지는 보안 이슈 신고 안내 페이지로 CVE 테이블을 포함하지 않음.
    이 함수는 하위 호환성을 위해 유지하며 항상 빈 리스트를 반환한다.

    Returns:
        list[dict]: 항상 빈 리스트
    """
    print("  wildfly.org/security/ 는 CVE 테이블 미포함 (신고 안내 페이지) - 건너뜀")
    return []


# ─── GitHub Security Advisories ───────────────────────────────────────────────

def fetch_github_advisories():
    """GitHub Security Advisories API에서 WildFly 보안 공지를 조회한다.

    GITHUB_TOKEN이 없으면 빈 리스트를 반환한다.

    Returns:
        list[dict]: [
            {
                "cve": str,            # "CVE-2024-1234" (없으면 ghsa_id 사용)
                "ghsa_id": str,        # "GHSA-xxxx-xxxx-xxxx"
                "severity": str,       # "Critical" | "High" | "Medium" | "Low"
                "description": str,
                "published": str,      # "YYYY-MM-DD"
                "fixed_in": str,       # 수정 버전
                "source": str,         # "github_advisories"
            }, ...
        ]
    """
    if not GITHUB_TOKEN:
        return []

    headers = {
        **_HTTP_HEADERS,
        "Authorization": f"Bearer {GITHUB_TOKEN}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }

    results = []
    page = 1
    per_page = 100

    while True:
        try:
            r = requests.get(
                GITHUB_ADVISORIES_URL,
                headers=headers,
                params={"per_page": per_page, "page": page},
                timeout=20,
            )
            if r.status_code == 404:
                break
            if r.status_code != 200:
                print(f"  GitHub Advisories API 응답 오류: {r.status_code}")
                break
        except requests.exceptions.RequestException as e:
            print(f"  GitHub Advisories API 접근 실패: {e}")
            break

        items = r.json()
        if not items:
            break

        for item in items:
            ghsa_id = item.get("ghsa_id", "")
            cve_id = item.get("cve_id", "") or ""
            if not cve_id and not ghsa_id:
                continue

            severity_raw = item.get("severity", "")
            severity = normalize_severity(severity_raw)
            description = (item.get("description") or item.get("summary") or "")[:500]
            published_raw = item.get("published_at", "")
            published = parse_date(published_raw[:10]) if published_raw else ""

            # 수정 버전: vulnerabilities[].patched_versions
            fixed_in = ""
            for vuln in (item.get("vulnerabilities") or []):
                pv = vuln.get("patched_versions", "")
                if pv:
                    fixed_in = pv
                    break

            # CVE ID가 없으면 GHSA ID를 대신 사용
            entry_id = cve_id.upper() if cve_id else ghsa_id

            results.append({
                "cve": entry_id,
                "ghsa_id": ghsa_id,
                "severity": severity,
                "description": description,
                "published": published,
                "fixed_in": fixed_in,
                "source": "github_advisories",
            })

        if len(items) < per_page:
            break
        page += 1

    return results


# ─── 수집 상태 관리 ───────────────────────────────────────────────────────────

def get_last_n_months():
    """현재 월 포함 최근 MONTHS_TO_COLLECT개월의 'YYYY-Mon' 문자열 목록 반환."""
    now = datetime.now()
    months = []
    for i in range(MONTHS_TO_COLLECT):
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


def _manifest_key(month_year):
    """매니페스트 키 생성. 예: '2026-Mar-WildFly'"""
    return f"{month_year}-WildFly"


def needs_update(month_year, manifest):
    """해당 월 데이터를 (재)수집해야 하는지 판단한다.

    Returns:
        tuple[bool, str]: (update_needed, reason)
    """
    key = _manifest_key(month_year)
    outfile = OUT_DIR / f"WFLY-{month_year}-WildFly.json"

    if not outfile.exists():
        return True, "신규 수집"
    if key not in manifest:
        return True, "매니페스트 누락"

    # CVSS 미수집 항목 재시도
    try:
        data = json.loads(outfile.read_text(encoding="utf-8"))
        for vuln in data.get("vulnerabilities", []):
            if vuln.get("cvss_base_score", 0.0) == 0.0 and not vuln.get("description"):
                return True, "NVD 미수집 재시도"
    except (json.JSONDecodeError, KeyError):
        return True, "파일 손상"

    return False, "최신 상태"


def cleanup_old_months(manifest, valid_months):
    """수집 범위를 벗어난 오래된 데이터를 정리한다."""
    removed = []
    for key in list(manifest.keys()):
        # 키 형식: "YYYY-Mon-WildFly"
        m = re.match(r'^(\d{4}-[A-Za-z]{3})-WildFly$', key)
        if not m:
            continue
        month_year = m.group(1)
        if month_year not in valid_months:
            f = OUT_DIR / f"WFLY-{month_year}-WildFly.json"
            if f.exists():
                f.unlink()
            del manifest[key]
            removed.append(month_year)
    return removed


# ─── 패치 수집 ────────────────────────────────────────────────────────────────

def _merge_cve_sources(wildfly_cves, nvd_cves, github_cves):
    """세 소스의 CVE 목록을 CVE ID 기준으로 병합한다.

    wildfly.org 데이터가 우선, NVD/GitHub는 보완.

    Args:
        wildfly_cves: wildfly.org 페이지 CVE 목록
        nvd_cves: NVD 키워드 검색 결과
        github_cves: GitHub Advisories 결과

    Returns:
        dict: {cve_id: merged_dict}
    """
    merged = {}

    for item in wildfly_cves:
        cve = item["cve"]
        merged[cve] = dict(item)

    # NVD 키워드 결과: wildfly.org에 없는 CVE만 추가
    for item in nvd_cves:
        cve = item["cve"]
        if cve not in merged:
            # WildFly 관련성 확인: 설명에 "wildfly" 또는 "jboss" 포함 여부
            desc_lower = item.get("description", "").lower()
            if "wildfly" in desc_lower or "jboss" in desc_lower:
                merged[cve] = {
                    "cve": cve,
                    "severity": item["severity"],
                    "affects": "",
                    "fixed_in": "",
                    "description": item["description"],
                    "published": item["published"],
                    "source": "nvd_keyword",
                }
        else:
            # 이미 있는 CVE: NVD 설명으로 보완
            if not merged[cve].get("description") and item.get("description"):
                merged[cve]["description"] = item["description"]

    # GitHub Advisories: wildfly.org에 없는 CVE만 추가
    for item in github_cves:
        cve = item["cve"]
        if cve not in merged:
            merged[cve] = {
                "cve": cve,
                "severity": item["severity"],
                "affects": "",
                "fixed_in": item.get("fixed_in", ""),
                "description": item["description"],
                "published": item["published"],
                "source": "github_advisories",
                "ghsa_id": item.get("ghsa_id", ""),
            }
        else:
            # ghsa_id 보완
            if item.get("ghsa_id") and not merged[cve].get("ghsa_id"):
                merged[cve]["ghsa_id"] = item["ghsa_id"]

    return merged


def fetch_wildfly_update(month_year, all_cves):
    """해당 월의 WildFly 보안 패치 JSON을 생성하여 저장한다.

    Args:
        month_year: "2026-Mar"
        all_cves: {cve_id: cve_dict} _merge_cve_sources() 결과

    Returns:
        dict: {stats, "last_published": str}
    """
    month_prefix = month_year_to_prefix(month_year)  # "2026-03"

    # 해당 월 CVE 필터링 (발행일 기준)
    month_cves = [
        c for c in all_cves.values()
        if c.get("published", "").startswith(month_prefix)
    ]

    if not month_cves:
        print(f"    해당 월 CVE 없음 (패치 릴리스 없음)")
        return {"last_published": "", "stats": {}}

    print(f"    WildFly: {len(month_cves)}건 CVE, NVD 상세 조회 중...")

    # NVD에서 개별 CVE 상세 조회 (wildfly.org에서 온 항목 보완)
    nvd_detail_cache = {}
    for cve_rec in month_cves:
        cve_id = cve_rec["cve"]
        if not cve_id.startswith("CVE-"):
            continue  # GHSA ID는 NVD 조회 불가
        if cve_id in nvd_detail_cache:
            continue
        if cve_rec.get("source") == "nvd_keyword" and cve_rec.get("cvss_base_score", 0) > 0:
            # 이미 NVD 데이터 있음
            nvd_detail_cache[cve_id] = {
                "description": cve_rec.get("description", ""),
                "cvss_base_score": cve_rec.get("cvss_base_score", 0.0),
                "cvss_vector": cve_rec.get("cvss_vector", ""),
                "severity": cve_rec.get("severity", "Medium"),
                "published": cve_rec.get("published", ""),
            }
            continue
        nvd_data = fetch_nvd_cve(cve_id)
        nvd_detail_cache[cve_id] = nvd_data
        if nvd_data:
            print(f"      {cve_id}: CVSS {nvd_data['cvss_base_score']} ({nvd_data['severity']})")
        else:
            print(f"      {cve_id}: NVD 데이터 없음 (WildFly 페이지 데이터 사용)")

    adv = {
        "id": f"WFLY-{month_year}-WildFly",
        "vendor": "Red Hat / WildFly Community",
        "product": "WildFly",
        "month": month_year,
        "type": "Security Update",
        "release_url": WILDFLY_SECURITY_URL,
        "vulnerabilities": [],
        "stats": {
            "total_cves": 0,
            "critical_count": 0,
            "high_count": 0,
            "medium_count": 0,
            "low_count": 0,
            "max_cvss_base": 0.0,
        },
    }

    last_published = ""

    for cve_rec in month_cves:
        cve_id = cve_rec["cve"]
        nvd = nvd_detail_cache.get(cve_id)

        # CVSS 및 설명: NVD 우선, 없으면 소스 데이터 fallback
        if nvd and nvd.get("cvss_base_score", 0) > 0:
            cvss_base = nvd["cvss_base_score"]
            cvss_vector = nvd["cvss_vector"]
            description = nvd["description"] or cve_rec.get("description", "")
            severity = nvd["severity"]
        else:
            cvss_base = 0.0
            cvss_vector = ""
            description = cve_rec.get("description", "")
            severity = cve_rec.get("severity", "Medium")

        pub = cve_rec.get("published", "")
        if pub > last_published:
            last_published = pub

        vuln_entry = {
            "cve": cve_id,
            "severity": severity,
            "description": description,
            "cvss_base_score": cvss_base,
            "cvss_vector": cvss_vector,
            "affects": cve_rec.get("affects", ""),
            "fixed_in": cve_rec.get("fixed_in", ""),
            "published": pub,
            "source": cve_rec.get("source", ""),
        }
        if cve_rec.get("ghsa_id"):
            vuln_entry["ghsa_id"] = cve_rec["ghsa_id"]

        adv["vulnerabilities"].append(vuln_entry)

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

    adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)

    OUT_DIR.mkdir(exist_ok=True)
    outfile = OUT_DIR / f"WFLY-{month_year}-WildFly.json"
    outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

    stats = adv["stats"]
    print(
        f"    WildFly: {stats['total_cves']}건 CVE "
        f"(Critical: {stats['critical_count']}, High: {stats['high_count']}, "
        f"Max CVSS: {stats['max_cvss_base']})"
    )

    return {
        "last_published": last_published,
        "stats": stats,
    }


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    months = get_last_n_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    if NVD_API_KEY:
        print("NVD API Key: 설정됨 (rate limit 완화)")
    else:
        print("NVD API Key: 미설정 (요청 간 6.5초 대기)")
    if GITHUB_TOKEN:
        print("GitHub Token: 설정됨 (Security Advisories 조회 활성)")
    else:
        print("GitHub Token: 미설정 (GitHub Advisories 건너뜀)")
    print()

    manifest = load_manifest()

    # ─ 소스 1: wildfly.org 보안 페이지
    print("wildfly.org 보안 페이지 조회 중...")
    wildfly_cves = fetch_wildfly_security_page()
    print(f"  CVE {len(wildfly_cves)}건 조회됨")

    # ─ 소스 2: NVD 키워드 검색
    print("NVD 키워드 검색 중 (wildfly)...")
    nvd_cves = fetch_nvd_keyword_search("wildfly", months_back=MONTHS_TO_COLLECT)
    print(f"  NVD CVE {len(nvd_cves)}건 조회됨")

    # ─ 소스 3: GitHub Security Advisories (선택)
    github_cves = []
    if GITHUB_TOKEN:
        print("GitHub Security Advisories 조회 중...")
        github_cves = fetch_github_advisories()
        print(f"  GitHub Advisories {len(github_cves)}건 조회됨")

    print()

    # 소스 병합
    all_cves = _merge_cve_sources(wildfly_cves, nvd_cves, github_cves)
    print(f"병합 후 총 CVE: {len(all_cves)}건")
    print()

    if not all_cves:
        print("  ※ WildFly 데이터 수집 실패 - 수집을 중단합니다.")
        return

    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    fetched = 0
    skipped = 0
    total_cves = 0

    for m in months:
        update_needed, reason = needs_update(m, manifest)

        if not update_needed:
            f = OUT_DIR / f"WFLY-{m}-WildFly.json"
            if f.exists():
                existing = json.loads(f.read_text(encoding="utf-8"))
                total_cves += existing["stats"]["total_cves"]
            print(f"  {m}: 건너뜀 ({reason})")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({reason})")
        result = fetch_wildfly_update(m, all_cves)
        if result is not None:
            key = _manifest_key(m)
            manifest[key] = {
                "last_published": result.get("last_published", ""),
                "fetched_at": datetime.now().isoformat(),
            }
            stats = result.get("stats", {})
            total_cves += stats.get("total_cves", 0)
            fetched += 1

    save_manifest(manifest)

    print()
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    print(f"  WildFly 총 {total_cves}건 CVE")


if __name__ == "__main__":
    main()
