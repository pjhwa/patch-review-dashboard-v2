"""MySQL Community Oracle CPU 패치 수집기

- Oracle Critical Patch Update(CPU) 분기별 페이지 스크래핑 + NVD CVE 2.0 API 보완
- 최근 7개월 패치 정보를 AI 리뷰 최적화 JSON으로 저장
- Oracle CPU는 1/4/7/10월 분기별로 발행됨

데이터 소스:
  1. oracle.com/security-alerts/cpu{mon}{year}.html : MySQL Risk Matrix 테이블
     (섹션 id="AppendixMSQL")
     컬럼: CVE#, Sub-component, Protocol, Remote Exploit, CVSS score, Affected Versions
  2. NVD CVE 2.0 API : 설명 및 상세 CVSS 벡터 (선택적 보완)

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

# Oracle CPU 발행 월: {월 번호: URL용 약어}
CPU_MONTHS = {1: "jan", 4: "apr", 7: "jul", 10: "oct"}

MONTHS_TO_COLLECT = 7

NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"

NVD_API_KEY = os.environ.get("NVD_API_KEY", "")
_NVD_DELAY = 0.6 if NVD_API_KEY else 6.5  # 초 단위

OUT_DIR = Path("mysql_data")
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


def month_year_to_prefix(month_year):
    """'2026-Jan' → '2026-01' 형태의 ISO 연월 접두사 반환."""
    dt = datetime.strptime(month_year, "%Y-%b")
    return dt.strftime("%Y-%m")


def get_cpu_month_for(month_year):
    """주어진 'YYYY-Mon' 월이 속하는 CPU 분기 월을 반환한다.

    Oracle CPU는 1/4/7/10월에 발행되므로, 해당 월이 CPU 발행월이면 해당 월 번호,
    아니면 None을 반환한다.

    Args:
        month_year: "2026-Jan"

    Returns:
        int | None: CPU 발행 월 번호 (1, 4, 7, 10) 또는 None
    """
    dt = datetime.strptime(month_year, "%Y-%b")
    if dt.month in CPU_MONTHS:
        return dt.month
    return None


def cpu_url(year, mon_abbr):
    """Oracle CPU URL을 생성한다.

    Args:
        year: 정수 연도 (2026)
        mon_abbr: "jan", "apr", "jul", "oct"

    Returns:
        str: CPU 페이지 URL
    """
    return f"https://www.oracle.com/security-alerts/cpu{mon_abbr}{year}.html"


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
        cve_id: "CVE-2025-21548"

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


# ─── Oracle CPU 페이지 스크래핑 ───────────────────────────────────────────────

def _parse_mysql_risk_matrix(html):
    """Oracle CPU HTML에서 MySQL Risk Matrix 테이블을 파싱한다.

    섹션 id="AppendixMSQL" 이후의 첫 번째 <table>을 대상으로 한다.

    테이블 컬럼 (순서 기준):
      0: CVE#
      1: Sub-component
      2: Protocol
      3: Remote Exploit (Yes/No)
      4: CVSS v3.1 Base Score
      5+: Affected Versions (버전 목록)

    Args:
        html: CPU 페이지 전체 HTML

    Returns:
        list[dict]: [
            {
                "cve": str,               # "CVE-2025-21548"
                "sub_component": str,     # "Server: DDL"
                "protocol": str,          # "MySQL Protocol"
                "remote_exploit": bool,   # True/False
                "cvss_score": float,      # 6.5
                "affected_versions": str, # "8.0.41 and prior, 9.2.0 and prior"
            }, ...
        ]
    """
    # AppendixMSQL 섹션 찾기
    section_m = re.search(
        r'id=["\']AppendixMSQL["\'][^>]*>',
        html, re.IGNORECASE
    )
    if not section_m:
        # 섹션 앵커가 없으면 "MySQL" 헤딩으로 fallback
        section_m = re.search(
            r'<h[23][^>]*>.*?MySQL.*?</h[23]>',
            html, re.IGNORECASE | re.DOTALL
        )
    if not section_m:
        return []

    # 섹션 이후 첫 번째 <table> ~ </table>
    section_start = section_m.end()
    table_m = re.search(
        r'<table[^>]*>(.*?)</table>',
        html[section_start:], re.DOTALL | re.IGNORECASE
    )
    if not table_m:
        return []

    table_html = table_m.group(1)

    # 헤더 행에서 컬럼 인덱스 파악
    header_m = re.search(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE)
    header_cols = []
    if header_m:
        th_matches = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', header_m.group(1), re.DOTALL | re.IGNORECASE)
        header_cols = [clean_html(th).lower() for th in th_matches]

    # 컬럼 인덱스 매핑 (기본값)
    idx_cve = 0
    idx_sub = 1
    idx_proto = 2
    idx_remote = 3
    idx_cvss = 4
    idx_affected = 5

    for i, h in enumerate(header_cols):
        if "cve" in h:
            idx_cve = i
        elif "component" in h or "sub" in h:
            idx_sub = i
        elif "protocol" in h:
            idx_proto = i
        elif "remote" in h:
            idx_remote = i
        elif "score" in h or "cvss" in h:
            idx_cvss = i
        elif "affected" in h or "version" in h:
            idx_affected = i

    results = []
    # 데이터 행 파싱 (헤더 제외)
    rows = re.findall(r'<tr[^>]*>(.*?)</tr>', table_html, re.DOTALL | re.IGNORECASE)
    for row in rows[1:]:  # 첫 번째 행(헤더) 스킵
        cells = re.findall(r'<t[hd][^>]*>(.*?)</t[hd]>', row, re.DOTALL | re.IGNORECASE)
        cols = [clean_html(c) for c in cells]
        if len(cols) <= idx_cve:
            continue

        cve_raw = cols[idx_cve] if idx_cve < len(cols) else ""
        cve_m = re.search(r'CVE-\d{4}-\d+', cve_raw, re.IGNORECASE)
        if not cve_m:
            continue
        cve_id = cve_m.group(0).upper()

        sub_component = cols[idx_sub] if idx_sub < len(cols) else ""
        protocol = cols[idx_proto] if idx_proto < len(cols) else ""
        remote_raw = cols[idx_remote] if idx_remote < len(cols) else ""
        remote_exploit = remote_raw.strip().lower() in ("yes", "y")
        cvss_raw = cols[idx_cvss] if idx_cvss < len(cols) else "0"
        try:
            cvss_score = float(re.search(r'[\d.]+', cvss_raw).group())
        except (AttributeError, ValueError):
            cvss_score = 0.0

        # 영향 버전: idx_affected 이후 모든 셀 합치기
        affected_parts = cols[idx_affected:] if idx_affected < len(cols) else []
        affected_versions = ", ".join(p for p in affected_parts if p)

        results.append({
            "cve": cve_id,
            "sub_component": sub_component,
            "protocol": protocol,
            "remote_exploit": remote_exploit,
            "cvss_score": cvss_score,
            "affected_versions": affected_versions,
        })

    return results


def fetch_cpu_page(year, month_num):
    """Oracle CPU 페이지를 가져와 MySQL Risk Matrix를 파싱한다.

    Args:
        year: 정수 연도
        month_num: CPU 발행 월 번호 (1, 4, 7, 10)

    Returns:
        tuple[list[dict], str]: (mysql_cves, cpu_url)
                                 실패 시 ([], url)
    """
    mon_abbr = CPU_MONTHS[month_num]
    url = cpu_url(year, mon_abbr)

    try:
        r = requests.get(url, headers=_HTTP_HEADERS, timeout=30)
        if r.status_code == 404:
            return [], url
        if r.status_code != 200:
            print(f"  Oracle CPU 페이지 응답 오류: {r.status_code} ({url})")
            return [], url
    except requests.exceptions.RequestException as e:
        print(f"  Oracle CPU 페이지 접근 실패: {e}")
        return [], url

    cves = _parse_mysql_risk_matrix(r.text)
    return cves, url


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
    """매니페스트 키 생성. 예: '2026-Jan-MySQL_CPU'"""
    return f"{month_year}-MySQL_CPU"


def needs_update(month_year, manifest):
    """해당 월 데이터를 (재)수집해야 하는지 판단한다.

    Returns:
        tuple[bool, str]: (update_needed, reason)
    """
    key = _manifest_key(month_year)
    outfile = OUT_DIR / f"MYSQ-{month_year}-MySQL_CPU.json"

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
        # 키 형식: "YYYY-Mon-MySQL_CPU"
        m = re.match(r'^(\d{4}-[A-Za-z]{3})-MySQL_CPU$', key)
        if not m:
            continue
        month_year = m.group(1)
        if month_year not in valid_months:
            f = OUT_DIR / f"MYSQ-{month_year}-MySQL_CPU.json"
            if f.exists():
                f.unlink()
            del manifest[key]
            removed.append(month_year)
    return removed


# ─── 패치 수집 ────────────────────────────────────────────────────────────────

def fetch_mysql_update(month_year):
    """해당 CPU 월의 MySQL 보안 패치 JSON을 생성하여 저장한다.

    해당 월이 CPU 발행월(1/4/7/10)인 경우에만 수집한다.

    Args:
        month_year: "2026-Jan"

    Returns:
        dict | None: {stats, "last_published": str} 또는 None (CPU 발행월 아님)
    """
    dt = datetime.strptime(month_year, "%Y-%b")
    cpu_month = get_cpu_month_for(month_year)
    if cpu_month is None:
        return None  # CPU 발행월 아님

    print(f"    Oracle CPU {month_year} 페이지 조회 중...")
    mysql_cves, page_url = fetch_cpu_page(dt.year, cpu_month)

    if not mysql_cves:
        print(f"    MySQL Risk Matrix 데이터 없음 (URL: {page_url})")
        return {"last_published": "", "stats": {}}

    print(f"    MySQL CVE {len(mysql_cves)}건 발견, NVD 상세 조회 중...")

    # NVD에서 CVE별 상세 정보 조회
    nvd_cache = {}
    for cve_rec in mysql_cves:
        cve_id = cve_rec["cve"]
        if cve_id in nvd_cache:
            continue
        nvd_data = fetch_nvd_cve(cve_id)
        nvd_cache[cve_id] = nvd_data
        if nvd_data:
            print(f"      {cve_id}: CVSS {nvd_data['cvss_base_score']} ({nvd_data['severity']})")
        else:
            print(f"      {cve_id}: NVD 데이터 없음 (Oracle CPU 데이터 사용)")

    # CPU 날짜: 발행 월의 셋째 화요일 근사값 (편의상 15일 사용)
    cpu_date = dt.strftime("%Y-%m-15")

    adv = {
        "id": f"MYSQ-{month_year}-MySQL_CPU",
        "vendor": "Oracle",
        "product": "MySQL Community",
        "month": month_year,
        "type": "Critical Patch Update",
        "cpu_date": cpu_date,
        "cpu_url": page_url,
        "vulnerabilities": [],
        "stats": {
            "total_cves": 0,
            "critical_count": 0,
            "high_count": 0,
            "medium_count": 0,
            "low_count": 0,
            "remotely_exploitable_count": 0,
            "max_cvss_base": 0.0,
        },
    }

    for cve_rec in mysql_cves:
        cve_id = cve_rec["cve"]
        nvd = nvd_cache.get(cve_id)

        # CVSS: Oracle 테이블 점수 우선, NVD로 검증
        oracle_score = cve_rec["cvss_score"]
        if nvd and nvd["cvss_base_score"] > 0:
            cvss_base = nvd["cvss_base_score"]
            cvss_vector = nvd["cvss_vector"]
            description = nvd["description"]
            severity = nvd["severity"]
        else:
            cvss_base = oracle_score
            cvss_vector = ""
            description = ""
            severity = _score_to_severity(oracle_score)

        vuln_entry = {
            "cve": cve_id,
            "severity": severity,
            "description": description,
            "sub_component": cve_rec["sub_component"],
            "protocol": cve_rec["protocol"],
            "remote_exploit": cve_rec["remote_exploit"],
            "cvss_base_score": cvss_base,
            "cvss_oracle_score": oracle_score,
            "cvss_vector": cvss_vector,
            "affected_versions": cve_rec["affected_versions"],
            "patch_url": page_url,
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
        if cve_rec["remote_exploit"]:
            stats["remotely_exploitable_count"] += 1
        if cvss_base > stats["max_cvss_base"]:
            stats["max_cvss_base"] = cvss_base

    adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)

    OUT_DIR.mkdir(exist_ok=True)
    outfile = OUT_DIR / f"MYSQ-{month_year}-MySQL_CPU.json"
    outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

    stats = adv["stats"]
    print(
        f"    MySQL CPU {month_year}: {stats['total_cves']}건 CVE "
        f"(Critical: {stats['critical_count']}, High: {stats['high_count']}, "
        f"원격악용: {stats['remotely_exploitable_count']}건, "
        f"Max CVSS: {stats['max_cvss_base']})"
    )

    return {
        "last_published": cpu_date,
        "stats": stats,
    }


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    months = get_last_n_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"CPU 발행 월: {', '.join(str(m) for m in sorted(CPU_MONTHS.keys()))}월 분기별")
    if NVD_API_KEY:
        print("NVD API Key: 설정됨 (rate limit 완화)")
    else:
        print("NVD API Key: 미설정 (요청 간 6.5초 대기)")
    print()

    manifest = load_manifest()

    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    fetched = 0
    skipped = 0
    total_cves = 0

    for m in months:
        cpu_month = get_cpu_month_for(m)
        if cpu_month is None:
            # CPU 발행월 아님 → 건너뜀
            continue

        update_needed, reason = needs_update(m, manifest)
        if not update_needed:
            f = OUT_DIR / f"MYSQ-{m}-MySQL_CPU.json"
            if f.exists():
                existing = json.loads(f.read_text(encoding="utf-8"))
                total_cves += existing["stats"]["total_cves"]
            print(f"  {m}: 건너뜀 ({reason})")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({reason})")
        result = fetch_mysql_update(m)
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
    print(f"  MySQL CPU 총 {total_cves}건 CVE")


if __name__ == "__main__":
    main()
