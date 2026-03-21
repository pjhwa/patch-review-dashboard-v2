"""Apache Tomcat Security 패치 수집기

- tomcat.apache.org/security-{major}.html 페이지 스크래핑 + NVD CVE 2.0 API 보완
- 최근 7개월 패치 정보를 버전별 AI 리뷰 최적화 JSON으로 저장
- Apache Tomcat 9 / 10 / 11 대상 (현재 지원 버전)

데이터 소스:
  1. tomcat.apache.org/security-{major}.html : CVE ID, 심각도, 설명, 영향 버전, 수정 버전
  2. NVD CVE 2.0 API : 상세 CVSS 벡터, 전문 설명 (선택적 보완)

페이지 구조:
  - "Fixed in Apache Tomcat X.Y.Z" 섹션별로 CVE 항목 포함
  - dt/dd 또는 h4/p 엘리먼트로 CVE ID, 심각도, 설명, 영향 범위 기술

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

TARGET_VERSIONS = [9, 10, 11]  # 현재 지원 버전

MONTHS_TO_COLLECT = 7

NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"

NVD_API_KEY = os.environ.get("NVD_API_KEY", "")
_NVD_DELAY = 0.6 if NVD_API_KEY else 6.5  # 초 단위

OUT_DIR = Path("tomcat_data")
MANIFEST_FILE = OUT_DIR / "manifest.json"

_nvd_last_call_ts = 0.0  # 마지막 NVD API 호출 시각

_HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 patch-collector/1.0"}

# Tomcat 심각도 → 정규화 매핑
_SEVERITY_MAP = {
    "critical": "Critical",
    "important": "High",
    "moderate": "Medium",
    "low": "Low",
}


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


def normalize_severity(raw):
    """Tomcat 심각도 레이블을 정규화 (Critical/High/Medium/Low).

    Args:
        raw: "Critical", "Important", "Moderate", "Low" 등

    Returns:
        str: "Critical" | "High" | "Medium" | "Low"
    """
    if not raw:
        return "Medium"
    return _SEVERITY_MAP.get(raw.strip().lower(), "Medium")


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
        cve_id: "CVE-2024-56337"

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


# ─── Tomcat 보안 페이지 스크래핑 ─────────────────────────────────────────────

def _extract_date_from_section(section_title):
    """섹션 제목에서 날짜를 추출한다.

    "Fixed in Apache Tomcat 10.1.35 (released 19 Mar 2025)" 형태에서 날짜 추출.

    Returns:
        str: "YYYY-MM-DD" 또는 ""
    """
    m = re.search(r'released\s+([\w\s,]+\d{4})', section_title, re.IGNORECASE)
    if m:
        return parse_date(m.group(1).strip())
    # 날짜 없는 경우 ISO 날짜 패턴 시도
    m = re.search(r'(\d{4}-\d{2}-\d{2})', section_title)
    if m:
        return m.group(1)
    return ""


def _parse_severity_from_text(text):
    """텍스트에서 심각도 레이블을 추출한다.

    "Severity: Important" 또는 "Important:" 패턴을 탐색.

    Returns:
        str: 정규화된 심각도 ("Critical" | "High" | "Medium" | "Low")
    """
    m = re.search(
        r'Severity\s*[:\-]\s*(Critical|Important|Moderate|Low)',
        text, re.IGNORECASE
    )
    if m:
        return normalize_severity(m.group(1))
    # 레이블만 단독으로 나타나는 경우
    for label in ("Critical", "Important", "Moderate", "Low"):
        if re.search(rf'\b{label}\b', text, re.IGNORECASE):
            return normalize_severity(label)
    return "Medium"


def _parse_affected_from_text(text):
    """텍스트에서 영향받는 버전 범위를 추출한다.

    "Affects: Apache Tomcat 10.1.0-M1 to 10.1.34" 형태를 탐색.

    Returns:
        str: 영향 버전 문자열
    """
    m = re.search(r'Affects?\s*[:\-]\s*([^\n<]{5,120})', text, re.IGNORECASE)
    if m:
        return clean_html(m.group(1))
    return ""


def fetch_tomcat_security_page(major):
    """tomcat.apache.org/security-{major}.html 을 스크래핑하여 CVE 목록을 반환한다.

    Args:
        major: 정수 major 버전 (9, 10, 11)

    Returns:
        list[dict]: [
            {
                "cve": str,            # "CVE-2025-24813"
                "severity": str,       # "Critical" | "High" | "Medium" | "Low"
                "description": str,    # CVE 설명
                "affected": str,       # "Apache Tomcat 10.1.0-M1 to 10.1.34"
                "fixed_version": str,  # "10.1.35"
                "release_date": str,   # "YYYY-MM-DD"
                "major": int,          # 10
            }, ...
        ]
        스크래핑 실패 시 빈 리스트.
    """
    url = f"https://tomcat.apache.org/security-{major}.html"
    try:
        r = requests.get(url, headers=_HTTP_HEADERS, timeout=20)
        if r.status_code != 200:
            print(f"  Tomcat {major} 보안 페이지 응답 오류: {r.status_code}")
            return []
    except requests.exceptions.RequestException as e:
        print(f"  Tomcat {major} 보안 페이지 접근 실패: {e}")
        return []

    html = r.text
    results = []

    # "Fixed in Apache Tomcat X.Y.Z" 섹션으로 분리
    # h3 또는 h2 태그에 "Fixed in Apache Tomcat" 텍스트 포함
    section_pattern = re.compile(
        r'<(?:h2|h3)[^>]*>(.*?Fixed in Apache Tomcat\s*([\d.]+).*?)</(?:h2|h3)>',
        re.DOTALL | re.IGNORECASE
    )

    section_matches = list(section_pattern.finditer(html))
    if not section_matches:
        print(f"  Tomcat {major}: 'Fixed in' 섹션을 찾을 수 없음")
        return []

    for idx, sec_match in enumerate(section_matches):
        section_header = sec_match.group(1)
        fixed_version = sec_match.group(2).strip()

        # 섹션 본문: 현재 섹션 헤더 끝 ~ 다음 섹션 헤더 시작
        body_start = sec_match.end()
        body_end = section_matches[idx + 1].start() if idx + 1 < len(section_matches) else len(html)
        section_body = html[body_start:body_end]

        release_date = _extract_date_from_section(clean_html(section_header))

        # CVE 항목 파싱: dt/dd 형식 또는 h4+단락 형식
        cve_entries = _parse_cve_entries_from_section(section_body, fixed_version, major, release_date)
        results.extend(cve_entries)

    return results


def _parse_cve_entries_from_section(section_body, fixed_version, major, release_date):
    """섹션 본문에서 CVE 항목 목록을 파싱한다.

    dt/dd 쌍 또는 h4+p 구조를 모두 지원한다.

    Args:
        section_body: 섹션 HTML 본문
        fixed_version: "10.1.35" 형태의 수정 버전
        major: 정수 major 버전
        release_date: "YYYY-MM-DD" 릴리스 날짜

    Returns:
        list[dict]
    """
    entries = []

    # CVE ID가 포함된 블록 탐색
    # dt/dd 쌍 파싱
    dt_blocks = re.findall(
        r'<dt[^>]*>(.*?)</dt>\s*<dd[^>]*>(.*?)</dd>',
        section_body, re.DOTALL | re.IGNORECASE
    )
    for dt_html, dd_html in dt_blocks:
        cve_m = re.search(r'CVE-\d{4}-\d+', dt_html + dd_html, re.IGNORECASE)
        if not cve_m:
            continue
        cve_id = cve_m.group(0).upper()

        full_text = clean_html(dt_html + " " + dd_html)
        severity = _parse_severity_from_text(full_text)
        affected = _parse_affected_from_text(full_text)

        # 설명: dt 또는 dd에서 CVE/Severity/Affects 이외 텍스트
        description = _extract_description(full_text, cve_id)

        entries.append({
            "cve": cve_id,
            "severity": severity,
            "description": description,
            "affected": affected,
            "fixed_version": fixed_version,
            "release_date": release_date,
            "major": major,
        })

    # h4 + p 구조 파싱 (dt/dd로 찾지 못한 경우)
    found_cves = {e["cve"] for e in entries}
    h4_blocks = re.findall(
        r'<h4[^>]*>(.*?)</h4>(.*?)(?=<h4|$)',
        section_body, re.DOTALL | re.IGNORECASE
    )
    for h4_html, body_html in h4_blocks:
        combined = h4_html + " " + body_html
        cve_m = re.search(r'CVE-\d{4}-\d+', combined, re.IGNORECASE)
        if not cve_m:
            continue
        cve_id = cve_m.group(0).upper()
        if cve_id in found_cves:
            continue

        full_text = clean_html(combined)
        severity = _parse_severity_from_text(full_text)
        affected = _parse_affected_from_text(full_text)
        description = _extract_description(full_text, cve_id)

        entries.append({
            "cve": cve_id,
            "severity": severity,
            "description": description,
            "affected": affected,
            "fixed_version": fixed_version,
            "release_date": release_date,
            "major": major,
        })

    # 섹션 내 CVE ID 전수 탐색 (위 두 방식 모두 실패 시 fallback)
    found_cves = {e["cve"] for e in entries}
    for cve_m in re.finditer(r'CVE-\d{4}-\d+', section_body, re.IGNORECASE):
        cve_id = cve_m.group(0).upper()
        if cve_id in found_cves:
            continue
        # CVE 주변 300자 컨텍스트에서 정보 추출
        start = max(0, cve_m.start() - 100)
        end = min(len(section_body), cve_m.end() + 500)
        context = clean_html(section_body[start:end])
        severity = _parse_severity_from_text(context)
        affected = _parse_affected_from_text(context)
        description = _extract_description(context, cve_id)
        entries.append({
            "cve": cve_id,
            "severity": severity,
            "description": description,
            "affected": affected,
            "fixed_version": fixed_version,
            "release_date": release_date,
            "major": major,
        })
        found_cves.add(cve_id)

    return entries


def _extract_description(full_text, cve_id):
    """전체 텍스트에서 CVE ID, 심각도, 영향 범위 문구를 제거하고 설명을 추출한다.

    Args:
        full_text: 클린된 텍스트
        cve_id: 제거할 CVE ID

    Returns:
        str: 설명 텍스트 (최대 500자)
    """
    text = full_text
    # CVE ID 제거
    text = re.sub(re.escape(cve_id), '', text, flags=re.IGNORECASE)
    # Severity 레이블 제거
    text = re.sub(
        r'Severity\s*[:\-]\s*(Critical|Important|Moderate|Low)',
        '', text, flags=re.IGNORECASE
    )
    # Affects 문구 제거
    text = re.sub(r'Affects?\s*[:\-][^\n.]{0,150}', '', text, flags=re.IGNORECASE)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:500]


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


def _manifest_key(month_year, major):
    """매니페스트 키 생성. 예: '2026-Mar-Tomcat_10'"""
    return f"{month_year}-Tomcat_{major}"


def needs_update(month_year, major, manifest):
    """해당 월/버전 데이터를 (재)수집해야 하는지 판단한다.

    Returns:
        tuple[bool, str]: (update_needed, reason)
    """
    key = _manifest_key(month_year, major)
    outfile = OUT_DIR / f"TOMC-{month_year}-Apache_Tomcat_{major}.json"

    if not outfile.exists():
        return True, "신규 수집"
    if key not in manifest:
        return True, "매니페스트 누락"

    # CVSS 미수집 항목 재시도
    try:
        data = json.loads(outfile.read_text(encoding="utf-8"))
        for vuln in data.get("vulnerabilities", []):
            if vuln.get("cvss_base_score", 0.0) == 0.0:
                return True, "CVSS 미수집 재시도"
    except (json.JSONDecodeError, KeyError):
        return True, "파일 손상"

    return False, "최신 상태"


def cleanup_old_months(manifest, valid_months):
    """수집 범위를 벗어난 오래된 데이터를 정리한다."""
    removed = []
    keys_to_remove = []
    for key in list(manifest.keys()):
        # 키 형식: "YYYY-Mon-Tomcat_{major}"
        m = re.match(r'^(\d{4}-[A-Za-z]{3})-Tomcat_(\d+)$', key)
        if not m:
            continue
        month_year = m.group(1)
        major = int(m.group(2))
        if month_year not in valid_months:
            f = OUT_DIR / f"TOMC-{month_year}-Apache_Tomcat_{major}.json"
            if f.exists():
                f.unlink()
            keys_to_remove.append(key)
            if month_year not in removed:
                removed.append(month_year)
    for key in keys_to_remove:
        del manifest[key]
    return removed


# ─── 패치 수집 ────────────────────────────────────────────────────────────────

def fetch_tomcat_update(month_year, all_cves_by_major):
    """해당 월의 Tomcat 보안 패치 JSON을 생성하여 저장한다.

    Args:
        month_year: "2026-Mar"
        all_cves_by_major: {major: [cve_dict, ...]} fetch_tomcat_security_page() 결과

    Returns:
        dict: {major: stats_dict, "last_published": str}
    """
    month_prefix = month_year_to_prefix(month_year)  # "2026-03"
    result = {"last_published": ""}

    for major in TARGET_VERSIONS:
        all_cves = all_cves_by_major.get(major, [])
        # 릴리스 날짜 기준으로 해당 월 CVE 필터링
        month_cves = [c for c in all_cves if c["release_date"].startswith(month_prefix)]

        if not month_cves:
            continue

        print(f"    Tomcat {major}: {len(month_cves)}건 CVE, NVD 상세 조회 중...")

        # NVD에서 CVE별 상세 정보 조회
        nvd_cache = {}
        for cve_rec in month_cves:
            cve_id = cve_rec["cve"]
            if cve_id in nvd_cache:
                continue
            nvd_data = fetch_nvd_cve(cve_id)
            nvd_cache[cve_id] = nvd_data
            if nvd_data:
                print(f"      {cve_id}: CVSS {nvd_data['cvss_base_score']} ({nvd_data['severity']})")
            else:
                print(f"      {cve_id}: NVD 데이터 없음 (Tomcat 페이지 데이터 사용)")

        # advisory 초기화
        # 가장 최신 수정 버전 결정
        fixed_version = ""
        release_date = ""
        for c in month_cves:
            if not fixed_version or c["fixed_version"] > fixed_version:
                fixed_version = c["fixed_version"]
                release_date = c["release_date"]

        adv = {
            "id": f"TOMC-{month_year}-Apache_Tomcat_{major}",
            "vendor": "Apache Software Foundation",
            "product": f"Apache Tomcat {major}",
            "month": month_year,
            "type": "Security Update",
            "fixed_version": fixed_version,
            "release_date": release_date,
            "release_url": f"https://tomcat.apache.org/security-{major}.html",
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
            nvd = nvd_cache.get(cve_id)

            # CVSS 및 설명: NVD 우선, 없으면 Tomcat 페이지 fallback
            if nvd and nvd["cvss_base_score"] > 0:
                cvss_base = nvd["cvss_base_score"]
                cvss_vector = nvd["cvss_vector"]
                description = nvd["description"] or cve_rec["description"]
                severity = nvd["severity"]
            else:
                cvss_base = 0.0
                cvss_vector = ""
                description = cve_rec["description"]
                severity = cve_rec["severity"]

            pub = cve_rec["release_date"]
            if pub > last_published:
                last_published = pub

            vuln_entry = {
                "cve": cve_id,
                "severity": severity,
                "description": description,
                "cvss_base_score": cvss_base,
                "cvss_vector": cvss_vector,
                "affected_versions": cve_rec["affected"],
                "fixed_in_version": cve_rec["fixed_version"],
                "patch_url": f"https://tomcat.apache.org/security-{major}.html",
                "published": pub,
            }
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

        if last_published > result["last_published"]:
            result["last_published"] = last_published

        adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)

        OUT_DIR.mkdir(exist_ok=True)
        outfile = OUT_DIR / f"TOMC-{month_year}-Apache_Tomcat_{major}.json"
        outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

        stats = adv["stats"]
        result[major] = stats
        print(
            f"    Apache Tomcat {major}: {stats['total_cves']}건 CVE "
            f"(Critical: {stats['critical_count']}, High: {stats['high_count']}, "
            f"Max CVSS: {stats['max_cvss_base']}, 수정 버전: {fixed_version})"
        )

    return result


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    months = get_last_n_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"대상 버전: {', '.join(f'Apache Tomcat {v}' for v in TARGET_VERSIONS)}")
    if NVD_API_KEY:
        print("NVD API Key: 설정됨 (rate limit 완화)")
    else:
        print("NVD API Key: 미설정 (요청 간 6.5초 대기)")
    print()

    manifest = load_manifest()

    # 버전별 보안 페이지 수집
    print("Tomcat 보안 페이지 조회 중...")
    all_cves_by_major = {}
    for major in TARGET_VERSIONS:
        cves = fetch_tomcat_security_page(major)
        all_cves_by_major[major] = cves
        print(f"  Tomcat {major}: CVE {len(cves)}건 조회됨")

    total_cves = sum(len(v) for v in all_cves_by_major.values())
    if total_cves == 0:
        print("  ※ Tomcat 데이터 수집 실패 - 수집을 중단합니다.")
        return
    print()

    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    fetched = 0
    skipped = 0
    totals = {v: {"cves": 0} for v in TARGET_VERSIONS}

    for m in months:
        # 해당 월에 CVE가 있는 버전 확인
        has_data = any(
            any(c["release_date"].startswith(month_year_to_prefix(m)) for c in all_cves_by_major.get(v, []))
            for v in TARGET_VERSIONS
        )

        # 업데이트 필요 여부 판단 (버전 중 하나라도 필요하면 수집)
        update_needed = False
        reasons = []
        for v in TARGET_VERSIONS:
            needed, reason = needs_update(m, v, manifest)
            if needed and has_data:
                update_needed = True
                reasons.append(f"Tomcat {v}: {reason}")

        if not update_needed:
            for v in TARGET_VERSIONS:
                f = OUT_DIR / f"TOMC-{m}-Apache_Tomcat_{v}.json"
                if f.exists():
                    existing = json.loads(f.read_text(encoding="utf-8"))
                    totals[v]["cves"] += existing["stats"]["total_cves"]
            print(f"  {m}: 건너뜀 (최신 상태 또는 해당 월 패치 없음)")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({'; '.join(reasons)})")
        result = fetch_tomcat_update(m, all_cves_by_major)
        if result is not None:
            for v in TARGET_VERSIONS:
                key = _manifest_key(m, v)
                f = OUT_DIR / f"TOMC-{m}-Apache_Tomcat_{v}.json"
                if f.exists():
                    manifest[key] = {
                        "last_published": result.get("last_published", ""),
                        "fetched_at": datetime.now().isoformat(),
                    }
                if v in result:
                    totals[v]["cves"] += result[v]["total_cves"]
            fetched += 1

    save_manifest(manifest)

    print()
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    for v in TARGET_VERSIONS:
        t = totals[v]
        print(f"  Apache Tomcat {v}: {t['cves']}건 CVE")


if __name__ == "__main__":
    main()
