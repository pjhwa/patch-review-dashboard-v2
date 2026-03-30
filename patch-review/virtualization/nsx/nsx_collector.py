"""VMware NSX 보안 및 버그 패치 수집기

트랙 A — VMSA 보안 어드바이저리 (이벤트 기반, 즉시 적용)
  - Broadcom Security Advisory API에서 VMSA 목록 조회
  - NSX 관련 VMSA 필터링 및 상세 페이지 파싱
  - NVD CVE 2.0 API로 CVSS v3.1 벡터 보완

트랙 B — NSX 릴리스 노트 (일반 유지보수, 누적 버그픽스)
  - techdocs.broadcom.com NSX 릴리스 노트에서 Resolved Issues 수집

대상: NSX 4.1/4.2 (현재 메이저), NSX-T Data Center 3.2 (이전 메이저)

데이터 소스:
  1. Broadcom Security Advisory API (VMSA 목록)
  2. support.broadcom.com VMSA 상세 페이지 (Response Matrix, CVE 설명)
  3. NVD CVE 2.0 API (CVSS v3.1 벡터, 전문 설명)
  4. techdocs.broadcom.com NSX 릴리스 노트 (Resolved Issues)

NSX 패치 적용 순서 (Best Practice):
  1. NSX Manager 업그레이드 (Primary → Standby, rolling)
  2. NSX Edge 노드 업그레이드 (Edge cluster 내 rolling, 서비스 무중단)
  3. Host Transport Node 업그레이드 (호스트 유지보수 모드 + vMotion)
  ※ NSX Upgrade Coordinator를 통한 전체 업그레이드 오케스트레이션 권장
  ※ NSX ↔ vCenter ↔ ESXi 호환성 매트릭스 사전 검증 필수

NVD API Key (선택):
  환경변수 NVD_API_KEY를 설정하면 rate limit이 완화됩니다 (50 req/30s → 5 req/30s).
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

load_dotenv(Path(__file__).parent / ".env")

TARGET_PRODUCTS = {
    "NSX": ["4.1", "4.2"],
    "NSX-T Data Center": ["3.2"],
}

VMSA_API_URL = (
    "https://support.broadcom.com/web/ecx/security-advisory"
    "/-/securityadvisory/getSecurityAdvisoryList"
)

# techdocs.broadcom.com NSX 릴리스 노트 인덱스 URL
# NSX-T 3.2는 techdocs에 인덱스 페이지 없음 — VMSA 필터링은 TARGET_PRODUCTS로 동작
RN_INDEX_URLS = {
    ("NSX", "4.2"): (
        "https://techdocs.broadcom.com/us/en/vmware-cis/nsx/vmware-nsx/4-2/release-notes.html"
    ),
    ("NSX", "4.1"): (
        "https://techdocs.broadcom.com/us/en/vmware-cis/nsx/vmware-nsx/4-1/release-notes.html"
    ),
}

NVD_BASE_URL = "https://services.nvd.nist.gov/rest/json/cves/2.0"
NVD_API_KEY = os.environ.get("NVD_API_KEY", "")
_NVD_DELAY = 0.6 if NVD_API_KEY else 6.5

OUT_DIR = Path("nsx_data")
MANIFEST_FILE = OUT_DIR / "manifest.json"

_nvd_last_call_ts = 0.0
_HTTP_HEADERS = {"User-Agent": "Mozilla/5.0 patch-collector/1.0"}

_SEVERITY_HIGH_KW = [
    "crash", "data loss", "data corrupt", "corruption", "corrupt",
    "buffer overrun", "memory overrun", "overflow",
    "deadlock", "silent data", "arbitrary code", "remote code",
    "unresponsive", "kernel panic",
]
_SEVERITY_LOW_KW = [
    "cosmetic", "minor", "typo", "spelling", "documentation",
    "performance", "improve", "display issue", "ui issue",
    "log message", "warning message",
]


# ─── 공통 유틸 ────────────────────────────────────────────────────────────────

def clean_html(text, max_len=0):
    """HTML 태그 제거 및 공백 정리."""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', ' ', str(text))
    text = re.sub(r'[\u00a0\u200b-\u200f\u2028-\u202f\ufeff]', ' ', text)
    text = re.sub(r'\s+', ' ', text).strip()
    if max_len > 0:
        text = text[:max_len]
    return text


def parse_date_str(date_str):
    """다양한 날짜 형식을 'YYYY-MM-DD'로 정규화."""
    if not date_str:
        return ""
    date_str = date_str.strip()
    for fmt in (
        "%d %B %Y", "%d %b %Y", "%B %d, %Y", "%b %d, %Y",
        "%Y-%m-%d", "%d %b %y", "%d %B %y",
        "%a %b %d %Y",
    ):
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


def _heuristic_severity(text):
    """키워드 기반으로 버그픽스 심각도를 추정한다."""
    t = text.lower()
    if any(k in t for k in _SEVERITY_HIGH_KW):
        return "High"
    if any(k in t for k in _SEVERITY_LOW_KW):
        return "Low"
    return "Medium"


def product_safe_name(product, version):
    """제품명+버전을 파일명에 안전한 형태로 변환."""
    return f"{product.replace(' ', '_')}_{version}"


def get_last_6_months():
    """현재 월 포함 최근 7개월의 'YYYY-Mon' 문자열 목록 반환."""
    now = datetime.now()
    months = []
    for i in range(7):
        d = now - relativedelta(months=i)
        months.append(d.strftime("%Y-%b"))
    return sorted(months)


def month_year_to_prefix(month_year):
    """'2026-Mar' → '2026-03' ISO 연월 접두사."""
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

    Returns:
        dict | None: {description, cvss_base_score, cvss_vector, severity, published}
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
            r = requests.get(NVD_BASE_URL, params=params,
                             headers=req_headers, timeout=20)
            if r.status_code in (429, 403) and attempt == 0:
                print(f"      NVD rate limit ({r.status_code}), 35초 대기...")
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

    return {
        "description": description,
        "cvss_base_score": cvss_base,
        "cvss_vector": cvss_vector,
        "severity": _score_to_severity(cvss_base),
        "published": (cve_item.get("published", "") or "")[:10],
    }


# ─── 트랙 A: VMSA 보안 어드바이저리 ──────────────────────────────────────────

def fetch_vmsa_list():
    """Broadcom Security Advisory API에서 전체 VMSA 목록을 조회한다.

    Returns:
        list[dict]: [{vmsa_id, notificationId, published, updated, severity,
                      title, notificationUrl, supportProducts, affectedCve,
                      workAround}, ...]
    """
    all_items = []
    page = 0
    page_size = 100

    while True:
        body = {
            "pageNumber": page,
            "pageSize": page_size,
            "searchVal": "",
            "segment": "VC",
            "sortInfo": {"column": "", "order": ""},
        }
        try:
            r = requests.post(
                VMSA_API_URL, json=body,
                headers={"Accept": "application/json", **_HTTP_HEADERS},
                timeout=30,
            )
            r.raise_for_status()
        except requests.exceptions.RequestException as e:
            print(f"  VMSA API 조회 실패 (page {page}): {e}")
            break

        data = r.json()
        if not data.get("success"):
            print(f"  VMSA API 응답 오류: {data}")
            break

        items = data.get("data", {}).get("list", [])
        if not items:
            break

        for item in items:
            vmsa_id = _extract_vmsa_id(item.get("title", ""))
            item["vmsa_id"] = vmsa_id
            item["published_date"] = parse_date_str(item.get("published", ""))
            all_items.append(item)

        page_info = data.get("data", {}).get("pageInfo", {})
        if page >= page_info.get("lastPage", 0):
            break
        page += 1

    return all_items


def _extract_vmsa_id(title):
    """제목에서 VMSA ID를 추출한다."""
    m = re.search(r'VMSA-\d{4}-\d{4,5}', title)
    return m.group(0) if m else ""


def _parse_cve_ids(cve_str):
    """CVE 문자열에서 CVE ID 목록을 추출한다."""
    if not cve_str:
        return []
    return [c.upper() for c in re.findall(r'CVE-\d{4}-\d+', cve_str, re.IGNORECASE)]


def is_nsx_related(vmsa):
    """해당 VMSA가 NSX 관련인지 판별한다."""
    title = vmsa.get("title") or ""
    products = vmsa.get("supportProducts") or ""
    combined = title + " " + products
    return bool(re.search(r'\bNSX\b', combined, re.IGNORECASE))


def fetch_vmsa_detail(url):
    """개별 VMSA 페이지에서 Response Matrix와 CVE 설명을 파싱한다.

    Returns:
        dict: {
            "response_matrix": [{product, version, cve_ids, cvss_scores,
                                  severity, fixed_version, workaround}, ...],
            "cve_details": {cve_id: {title, description, is_exploited}, ...},
            "advisory_severity": str,
        }
    """
    result = {
        "response_matrix": [],
        "cve_details": {},
        "advisory_severity": "",
    }

    try:
        r = requests.get(url, headers=_HTTP_HEADERS, timeout=30,
                         allow_redirects=True)
        if r.status_code != 200:
            print(f"      VMSA 페이지 응답 오류: {r.status_code}")
            return result
    except requests.exceptions.RequestException as e:
        print(f"      VMSA 페이지 접근 실패: {e}")
        return result

    html = r.text

    sev_m = re.search(r'Severity\s*[:\-]\s*(Critical|Important|High|Medium|Low)',
                      html, re.IGNORECASE)
    if sev_m:
        result["advisory_severity"] = sev_m.group(1).capitalize()

    result["response_matrix"] = _parse_response_matrix(html)
    result["cve_details"] = _parse_cve_sections(html)

    return result


def _parse_response_matrix(html):
    """VMSA 페이지에서 Response Matrix 테이블을 파싱한다."""
    rows = []

    tables = re.findall(r'<table[^>]*>(.*?)</table>', html, re.DOTALL | re.IGNORECASE)

    target_tables = []
    for table in tables:
        has_fixed = bool(re.search(r'Fixed\s*Version', table, re.IGNORECASE))
        is_meta = bool(re.search(r'Advisory\s*ID|Synopsis', table, re.IGNORECASE))
        if is_meta:
            continue
        if has_fixed:
            target_tables.append(table)

    if not target_tables:
        return _parse_response_matrix_text(html)

    for target_table in target_tables:
        header_match = re.search(r'<thead[^>]*>(.*?)</thead>', target_table,
                                 re.DOTALL | re.IGNORECASE)
        if not header_match:
            header_match = re.search(r'<tr[^>]*>(.*?)</tr>', target_table,
                                     re.DOTALL | re.IGNORECASE)

        col_map = {}
        if header_match:
            headers = re.findall(r'<th[^>]*>(.*?)</th>', header_match.group(1),
                                 re.DOTALL | re.IGNORECASE)
            for i, h in enumerate(headers):
                h_clean = clean_html(h).lower()
                if "product" in h_clean:
                    col_map["product"] = i
                elif "version" in h_clean and "fixed" not in h_clean:
                    col_map["version"] = i
                elif "component" in h_clean:
                    col_map["component"] = i
                elif "cve" in h_clean:
                    col_map["cve"] = i
                elif "cvss" in h_clean:
                    col_map["cvss"] = i
                elif "severity" in h_clean:
                    col_map["severity"] = i
                elif "fixed" in h_clean:
                    col_map["fixed_version"] = i
                elif "workaround" in h_clean:
                    col_map["workaround"] = i

        tbody_m = re.search(r'<tbody[^>]*>(.*?)</tbody>', target_table,
                            re.DOTALL | re.IGNORECASE)
        body_html = tbody_m.group(1) if tbody_m else target_table

        data_rows = re.findall(r'<tr[^>]*>(.*?)</tr>', body_html,
                               re.DOTALL | re.IGNORECASE)

        for row_html in data_rows:
            cells = re.findall(r'<td[^>]*>(.*?)</td>', row_html,
                               re.DOTALL | re.IGNORECASE)
            if not cells:
                continue

            def get_col(name, default="", _col_map=col_map, _cells=cells):
                idx = _col_map.get(name)
                if idx is not None and idx < len(_cells):
                    return clean_html(_cells[idx])
                return default

            product = get_col("product")
            version = get_col("version") or get_col("component")
            cve_str = get_col("cve")
            cvss_str = get_col("cvss")
            severity = get_col("severity")
            fixed_version = get_col("fixed_version")
            workaround = get_col("workaround")

            if not product and not fixed_version:
                continue

            cve_ids = _parse_cve_ids(cve_str)
            cvss_scores = [float(s) for s in re.findall(r'(\d+\.\d+)', cvss_str)]

            rows.append({
                "product": product,
                "version": version,
                "cve_ids": cve_ids,
                "cvss_scores": cvss_scores,
                "max_cvss": max(cvss_scores) if cvss_scores else 0.0,
                "severity": severity,
                "fixed_version": fixed_version,
                "workaround": workaround,
            })

    return rows


def _parse_response_matrix_text(html):
    """Response Matrix가 텍스트/인라인 형식일 때의 fallback 파서."""
    rows = []

    rm_match = re.search(
        r'Response\s+Matrix(.*?)(?:Workaround|Resolution|References|'
        r'Change\s+Log|Acknowledgement|<h[23])',
        html, re.DOTALL | re.IGNORECASE,
    )
    if not rm_match:
        return rows

    section = rm_match.group(1)
    text = clean_html(section)

    cve_ids = _parse_cve_ids(text)
    cvss_scores = [float(s) for s in re.findall(r'(\d+\.\d+)', text)
                   if 0.0 <= float(s) <= 10.0]

    # NSX 제품명/버전 패턴
    product_patterns = [
        (r'(?:VMware\s+)?NSX-T\s+Data\s+Center\s+(\d+\.\d+)', 'NSX-T Data Center'),
        (r'(?:VMware\s+)?NSX\s+Data\s+Center\s+(\d+\.\d+)', 'NSX-T Data Center'),
        (r'(?:VMware\s+)?NSX-T\s+(\d+\.\d+)', 'NSX-T Data Center'),
        (r'(?:VMware\s+)?NSX\s+(\d+\.\d+)', 'NSX'),
    ]

    found_products = []
    for pat, prod_name in product_patterns:
        for pm in re.finditer(pat, text, re.IGNORECASE):
            ver = pm.group(1)
            # major version만 추출 (예: "4.2.1" → "4.2")
            ver_major = ".".join(ver.split(".")[:2])
            found_products.append((prod_name, ver_major))

    fixed_versions = re.findall(
        r'(?:fixed\s+(?:version|in)\s*[:\-]?\s*)([\w\d.]+)',
        text, re.IGNORECASE,
    )
    if not fixed_versions:
        fixed_versions = re.findall(r'(\d+\.\d+\.\d+(?:\.\d+)?)', text)
    fixed_ver_str = fixed_versions[0] if fixed_versions else ""

    sev_m = re.search(r'(Critical|Important|High|Medium|Low)', text, re.IGNORECASE)
    severity = sev_m.group(1).capitalize() if sev_m else ""

    if found_products:
        for prod_name, ver in found_products:
            rows.append({
                "product": prod_name,
                "version": ver,
                "cve_ids": cve_ids,
                "cvss_scores": cvss_scores,
                "max_cvss": max(cvss_scores) if cvss_scores else 0.0,
                "severity": severity,
                "fixed_version": fixed_ver_str,
                "workaround": "",
            })
    elif cve_ids:
        rows.append({
            "product": "",
            "version": "",
            "cve_ids": cve_ids,
            "cvss_scores": cvss_scores,
            "max_cvss": max(cvss_scores) if cvss_scores else 0.0,
            "severity": severity,
            "fixed_version": fixed_ver_str,
            "workaround": "",
        })

    return rows


def _parse_cve_sections(html):
    """VMSA 페이지에서 CVE별 설명 섹션을 파싱한다.

    Returns:
        dict: {cve_id: {title, description, is_exploited}, ...}
    """
    details = {}

    cve_blocks = re.finditer(
        r'(?:^|\n)\s*\d+[a-z]?\.\s*(.*?)\((CVE-\d{4}-\d+)\)(.*?)(?=\n\s*\d+[a-z]?\.|$)',
        html, re.DOTALL | re.IGNORECASE
    )

    for m in cve_blocks:
        title = clean_html(m.group(1))
        cve_id = m.group(2).upper()
        body = m.group(3)

        is_exploited = bool(re.search(
            r'exploit(?:ation|ed)\s+(?:has\s+)?(?:occurred\s+)?in\s+the\s+wild|'
            r'zero[- ]day|actively\s+exploit',
            body, re.IGNORECASE
        ))

        description = ""
        desc_m = re.search(r'Description\s*[:\-]?\s*(.*?)(?:Known\s+Attack|'
                           r'Resolution|Workaround|Acknowledgement|\d+[a-z]?\.)',
                           body, re.DOTALL | re.IGNORECASE)
        if desc_m:
            description = clean_html(desc_m.group(1), 500)

        details[cve_id] = {
            "title": title,
            "description": description,
            "is_exploited": is_exploited,
        }

    if not details:
        for cve_m in re.finditer(r'(CVE-\d{4}-\d+)', html, re.IGNORECASE):
            cve_id = cve_m.group(1).upper()
            if cve_id not in details:
                start = max(0, cve_m.start() - 500)
                end = min(len(html), cve_m.end() + 1000)
                context = html[start:end]

                is_exploited = bool(re.search(
                    r'exploit(?:ation|ed)\s+(?:has\s+)?(?:occurred\s+)?'
                    r'in\s+the\s+wild|zero[- ]day|actively\s+exploit',
                    context, re.IGNORECASE
                ))

                details[cve_id] = {
                    "title": "",
                    "description": "",
                    "is_exploited": is_exploited,
                }

    return details


def classify_product_version(text):
    """텍스트에서 TARGET_PRODUCTS의 제품명과 메이저 버전을 분류한다.

    Returns:
        list[tuple]: [(product, version), ...]
    """
    matches = []
    for product, versions in TARGET_PRODUCTS.items():
        for version in versions:
            parts = product.split()
            alt_names = [product] + parts
            alt_names = list(dict.fromkeys(
                n for n in alt_names if len(n) > 3 or n == product
            ))
            matched = False
            for name in alt_names:
                pat = rf'{re.escape(name)}[^0-9]*{re.escape(version)}'
                if re.search(pat, text, re.IGNORECASE):
                    if (product, version) not in matches:
                        matches.append((product, version))
                    matched = True
                    break
            if matched:
                continue
    return matches


def classify_product_name_only(text):
    """버전 없이 제품명만으로 매칭 (모든 타겟 버전에 매핑).

    classify_product_version()이 실패할 때 fallback으로 사용한다.
    """
    matches = []
    for product, versions in TARGET_PRODUCTS.items():
        parts = product.split()
        alt_names = [product] + [p for p in parts if len(p) > 3]
        for name in alt_names:
            if re.search(rf'\b{re.escape(name)}\b', text, re.IGNORECASE):
                for version in versions:
                    if (product, version) not in matches:
                        matches.append((product, version))
                break
    return matches


def map_vmsa_severity(sev_str):
    """Broadcom API severity를 표준 형태로 변환."""
    mapping = {
        "CRITICAL": "Critical",
        "HIGH": "High",
        "MEDIUM": "Medium",
        "LOW": "Low",
        "IMPORTANT": "High",
    }
    return mapping.get(sev_str.upper(), sev_str.capitalize()) if sev_str else ""


# ─── 트랙 B: NSX 릴리스 노트 ─────────────────────────────────────────────────

def fetch_rn_index(product, version):
    """릴리스 노트 인덱스 페이지에서 업데이트 목록과 URL을 파싱한다.

    Returns:
        list[dict]: [{name, url}, ...] 최신순
    """
    key = (product, version)
    index_url = RN_INDEX_URLS.get(key)
    if not index_url:
        return []

    try:
        r = requests.get(index_url, headers=_HTTP_HEADERS, timeout=20,
                         allow_redirects=True)
        if r.status_code != 200:
            print(f"    릴리스 노트 인덱스 조회 실패 ({r.status_code}): {key}")
            return []
    except requests.exceptions.RequestException as e:
        print(f"    릴리스 노트 인덱스 접근 실패: {e}")
        return []

    html = r.text
    base_url = index_url.rsplit("/", 1)[0] + "/"

    # NSX 릴리스 노트 링크 패턴: 버전 번호(3자리 이상)가 포함된 파일명만 수집
    # 예: vmware-nsx-4233-release-notes.html, vmware-nsx-4127-release-notes.html
    update_slug_pat = re.compile(
        r'vmware-nsx-\d{3,}',
        re.IGNORECASE,
    )

    updates = []
    seen_urls = set()
    for m in re.finditer(
        r'<a[^>]+href="([^"]*release-notes[^"]*\.html)"[^>]*>(.*?)</a>',
        html, re.DOTALL | re.IGNORECASE
    ):
        href = m.group(1)
        name = clean_html(m.group(2))
        if not name:
            continue

        filename = href.rsplit("/", 1)[-1] if "/" in href else href
        if not update_slug_pat.search(filename):
            continue

        if href.startswith("http"):
            full_url = href
        elif href.startswith("/"):
            full_url = "https://techdocs.broadcom.com" + href
        else:
            full_url = base_url + href

        if full_url in seen_urls:
            continue
        seen_urls.add(full_url)

        updates.append({"name": name, "url": full_url})

    return updates


def fetch_rn_detail(url):
    """개별 릴리스 노트 페이지에서 빌드, 날짜, Resolved Issues, Known Issues를 파싱한다.

    Returns:
        dict: {
            "build": str,
            "release_date": str (YYYY-MM-DD),
            "resolved_security_issues": [{pr, description, vmsa_ids, cve_ids}, ...],
            "resolved_issues": [{pr, component, description}, ...],
            "known_issues": [{description}, ...],
        }
    """
    result = {
        "build": "",
        "release_date": "",
        "resolved_security_issues": [],
        "resolved_issues": [],
        "known_issues": [],
    }

    try:
        r = requests.get(url, headers=_HTTP_HEADERS, timeout=20,
                         allow_redirects=True)
        if r.status_code != 200:
            return result
    except requests.exceptions.RequestException:
        return result

    html = r.text
    text = clean_html(html)

    # 빌드 번호 추출
    build_m = re.search(r'Build\s*(?:Number|#)?\s*[:\-]?\s*(\d{7,10})', text, re.IGNORECASE)
    if build_m:
        result["build"] = build_m.group(1)

    # 릴리스 날짜 추출
    date_patterns_text = [
        r'Release\s*Date\s*[:\-]?\s*(\d{1,2}\s+\w+\s+\d{4})',
        r'Released?\s*[:\-]?\s*(\w+\s+\d{1,2},?\s+\d{4})',
        r'Released?\s*[:\-]?\s*(\d{1,2}\s+\w{3}\s+\d{4})',
        r'\|\s*(\d{1,2}\s+\w{3,9}\s+\d{4})\s*\|',
    ]
    for pat in date_patterns_text:
        date_m = re.search(pat, text, re.IGNORECASE)
        if date_m:
            result["release_date"] = parse_date_str(date_m.group(1))
            if result["release_date"]:
                break

    if not result["release_date"]:
        dm = re.search(r'"dateModified"\s*:\s*"([^"]+)"', html)
        if dm:
            result["release_date"] = parse_date_str(dm.group(1))

    # Resolved Issues 파싱 (PR 번호 기반)
    pr_items = re.findall(
        r'PR\s*(\d{5,8})\s*[:\-]\s*(.*?)(?=PR\s*\d{5,8}|Known\s*Issues?|$)',
        text, re.DOTALL | re.IGNORECASE
    )

    for pr_num, desc_raw in pr_items:
        desc = re.sub(r'\s+', ' ', desc_raw).strip()
        if not desc:
            continue

        vmsa_ids = re.findall(r'VMSA-\d{4}-\d{4,5}', desc, re.IGNORECASE)
        cve_ids = _parse_cve_ids(desc)
        is_security = bool(vmsa_ids or cve_ids)

        if is_security:
            result["resolved_security_issues"].append({
                "pr": pr_num,
                "description": desc[:500],
                "vmsa_ids": vmsa_ids,
                "cve_ids": cve_ids,
            })
        else:
            component = ""
            comp_m = re.match(r'^([A-Za-z][A-Za-z /]{2,30}?)(?:[:.\-]|\s{2,})', desc)
            if comp_m:
                component = comp_m.group(1).strip()
            result["resolved_issues"].append({
                "pr": pr_num,
                "component": component,
                "description": desc[:500],
            })

    # PR 패턴이 없는 경우: 불릿 리스트 파싱 (fallback)
    if not pr_items:
        result["resolved_issues"] = _parse_bullet_resolved_issues(html)

    result["known_issues"] = _parse_known_issues(html)

    return result


def _parse_bullet_resolved_issues(html):
    """PR 번호 없이 불릿 리스트로 된 Resolved Issues를 파싱한다 (fallback).

    techdocs.broadcom.com NSX 페이지는 헤더 내부에 중첩 div를 사용하므로
    "Resolved Issues" 텍스트 이후 섹션을 폭넓게 매칭한다.
    """
    fixes = []

    resolved_m = re.search(
        r'Resolved\s+Issues?(.*?)(?:Known\s+Issues|</body|$)',
        html, re.DOTALL | re.IGNORECASE
    )
    if not resolved_m:
        return fixes

    section = resolved_m.group(1)
    lis = re.findall(r'<li[^>]*>(.*?)</li>', section, re.DOTALL | re.IGNORECASE)
    for li in lis:
        desc = clean_html(li, 500)
        if not desc:
            continue
        if re.search(r'CVE-\d{4}-\d+|VMSA-\d{4}-\d+', desc, re.IGNORECASE):
            continue
        fixes.append({"pr": "", "component": "", "description": desc})

    return fixes


def _parse_known_issues(html):
    """릴리스 노트에서 Known Issues를 파싱한다."""
    issues = []

    ki_m = re.search(
        r'Known\s+Issues?(.*?)(?:</body|$)',
        html, re.DOTALL | re.IGNORECASE
    )
    if not ki_m:
        return issues

    section = ki_m.group(1)
    lis = re.findall(r'<li[^>]*>(.*?)</li>', section, re.DOTALL | re.IGNORECASE)
    for li in lis:
        desc = clean_html(li, 500)
        if not desc:
            continue
        issues.append({"description": desc})

    return issues


# ─── 수집 상태 관리 ───────────────────────────────────────────────────────────

def load_manifest():
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest):
    OUT_DIR.mkdir(exist_ok=True)
    MANIFEST_FILE.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def needs_update(month_year, manifest, vmsa_dates, rn_builds):
    """해당 월의 데이터를 (재)수집해야 하는지 판단한다.

    Args:
        vmsa_dates: {month_year: latest_vmsa_published_str}
        rn_builds: {(product, version): {month_year: build_number}}

    Returns:
        tuple[bool, str]
    """
    if month_year not in manifest:
        return True, "신규 수집"

    entry = manifest[month_year]

    # 트랙 A: VMSA 변경 확인
    local_vmsa_date = entry.get("vmsa_latest_date", "")
    remote_vmsa_date = vmsa_dates.get(month_year, "")
    if remote_vmsa_date and local_vmsa_date != remote_vmsa_date:
        return True, f"VMSA 업데이트 ({local_vmsa_date[:10] or '없음'} → {remote_vmsa_date[:10]})"

    # 트랙 B: 빌드 번호 변경 확인
    local_builds = entry.get("update_builds", {})
    for key, month_builds in rn_builds.items():
        pv_key = f"{key[0]} {key[1]}"
        remote_build = month_builds.get(month_year, "")
        local_build = local_builds.get(pv_key, "")
        if remote_build and local_build != remote_build:
            return True, f"신규 빌드 ({pv_key}: {local_build or '없음'} → {remote_build})"

    # CVSS=0 재시도
    has_any = bool(entry.get("files"))
    if has_any and _has_zero_cvss(month_year, manifest):
        return True, "CVSS 미수집 재시도"

    if not has_any and not remote_vmsa_date:
        return False, "해당 월 패치 없음"

    return False, "최신 상태"


def _has_zero_cvss(month_year, manifest):
    """해당 월 파일 중 cvss_base_score=0.0인 취약점이 있는지 확인."""
    files = manifest.get(month_year, {}).get("files", [])
    for fname in files:
        f = OUT_DIR / fname
        if f.exists():
            try:
                data = json.loads(f.read_text(encoding="utf-8"))
                for vuln in data.get("vulnerabilities", []):
                    if vuln.get("cvss_base_score", 0.0) == 0.0:
                        return True
            except (json.JSONDecodeError, KeyError):
                pass
    return False


def cleanup_old_months(manifest, valid_months):
    """수집 범위를 벗어난 오래된 데이터를 정리한다."""
    removed = []
    for month_year in list(manifest.keys()):
        if month_year not in valid_months:
            for fname in manifest[month_year].get("files", []):
                f = OUT_DIR / fname
                if f.exists():
                    f.unlink()
            del manifest[month_year]
            removed.append(month_year)
    return removed


# ─── 패치 수집 ────────────────────────────────────────────────────────────────

def _group_vmsas_by_month(vmsa_list, valid_months):
    """VMSA 목록을 발행 월 기준으로 그룹화한다."""
    by_month = {}
    for vmsa in vmsa_list:
        pub_date = vmsa.get("published_date", "")
        if not pub_date:
            continue
        try:
            dt = datetime.strptime(pub_date, "%Y-%m-%d")
        except ValueError:
            continue
        month_key = dt.strftime("%Y-%b")
        if month_key in valid_months:
            by_month.setdefault(month_key, []).append(vmsa)
    return by_month


def _group_releases_by_month(releases, valid_months):
    """릴리스 노트 목록을 릴리스 월 기준으로 그룹화한다.

    Returns:
        dict: {month_year: {(product, version): release_detail}}
        dict: {(product, version): {month_year: build_number}}
    """
    by_month = {}
    builds = {}

    for pv_key, release_list in releases.items():
        builds[pv_key] = {}
        for rel in release_list:
            detail = rel.get("detail", {})
            rd = detail.get("release_date", "")
            if not rd:
                continue
            try:
                dt = datetime.strptime(rd, "%Y-%m-%d")
            except ValueError:
                continue
            month_key = dt.strftime("%Y-%b")
            if month_key in valid_months:
                by_month.setdefault(month_key, {})
                by_month[month_key][pv_key] = rel
                builds[pv_key][month_key] = detail.get("build", "")

    return by_month, builds


def fetch_nsx_update(month_year, month_vmsas, month_releases):
    """해당 월의 NSX 패치를 개별 JSON 파일로 저장한다.

    VMSA별, Update 릴리스별로 각각 별도 JSON 파일을 생성한다.

    Args:
        month_year: "2026-Mar"
        month_vmsas: [vmsa_items] (해당 월 NSX 관련 VMSA 목록)
        month_releases: {(product, version): release_info}

    Returns:
        dict: {vmsa_latest_date, update_builds, written_files}
    """
    OUT_DIR.mkdir(exist_ok=True)
    written_files = []
    nvd_cache = {}
    target_pv_keys = set()
    for product, versions in TARGET_PRODUCTS.items():
        for version in versions:
            target_pv_keys.add((product, version))

    # === 트랙 A: VMSA 보안 어드바이저리 → 개별 파일 ===
    for vmsa in month_vmsas:
        vmsa_id = vmsa.get("vmsa_id", "")
        api_severity = map_vmsa_severity(vmsa.get("severity", ""))
        api_cve_ids = _parse_cve_ids(vmsa.get("affectedCve", ""))
        published = vmsa.get("published_date", "")
        url = vmsa.get("notificationUrl", "")

        print(f"    {vmsa_id}: VMSA 상세 페이지 파싱...")
        detail = fetch_vmsa_detail(url) if url else {
            "response_matrix": [], "cve_details": {}, "advisory_severity": ""
        }

        advisory_severity = detail["advisory_severity"] or api_severity

        # Response Matrix에서 제품별 매핑
        product_fixed = {}  # {(product, version): {fixed_version, workaround}}
        product_cves = {}   # {(product, version): [{cve_id, cvss, severity}]}

        for row in detail["response_matrix"]:
            pv_matches = classify_product_version(
                row["product"] + " " + row["version"]
            )
            for pv in pv_matches:
                if pv in target_pv_keys:
                    product_fixed[pv] = {
                        "fixed_version": row["fixed_version"],
                        "workaround": row["workaround"],
                    }
                    for i, cve_id in enumerate(row["cve_ids"]):
                        cvss = row["cvss_scores"][i] if i < len(row["cvss_scores"]) else 0.0
                        product_cves.setdefault(pv, []).append({
                            "cve_id": cve_id,
                            "cvss": cvss,
                            "severity": row["severity"],
                        })

        # Response Matrix가 비어있으면 VMSA 제목에서 제품 추론
        if not product_fixed:
            search_text = (vmsa.get("title") or "") + " " + (vmsa.get("supportProducts") or "")
            pv_matches = classify_product_version(search_text)
            if not pv_matches:
                pv_matches = classify_product_name_only(search_text)
            for pv in pv_matches:
                if pv in target_pv_keys:
                    product_fixed[pv] = {"fixed_version": "", "workaround": ""}
                    for cve_id in api_cve_ids:
                        product_cves.setdefault(pv, []).append({
                            "cve_id": cve_id, "cvss": 0.0, "severity": "",
                        })

        # NVD에서 CVE 상세 조회
        unique_cves = set()
        for pv_cve_list in product_cves.values():
            for item in pv_cve_list:
                unique_cves.add(item["cve_id"])
        if not unique_cves:
            unique_cves = set(api_cve_ids)

        for cve_id in unique_cves:
            if cve_id not in nvd_cache:
                nvd_data = fetch_nvd_cve(cve_id)
                nvd_cache[cve_id] = nvd_data
                if nvd_data:
                    print(f"      {cve_id}: CVSS {nvd_data['cvss_base_score']} "
                          f"({nvd_data['severity']})")
                else:
                    print(f"      {cve_id}: NVD 데이터 없음")

        # 제품별 개별 VMSA 파일 저장
        vmsa_title = (vmsa.get("title", "").split(":", 1)[-1].strip()
                      if ":" in vmsa.get("title", "") else vmsa.get("title", ""))

        for pv, fix_info in product_fixed.items():
            product, version = pv
            safe = product_safe_name(product, version)
            cve_entries = product_cves.get(pv, [])

            vulns = []
            seen_cves = set()
            target_cves = cve_entries if cve_entries else [
                {"cve_id": c, "cvss": 0.0, "severity": ""}
                for c in api_cve_ids
            ]

            for cve_info in target_cves:
                cve_id = cve_info["cve_id"]
                if cve_id in seen_cves:
                    continue
                seen_cves.add(cve_id)

                nvd = nvd_cache.get(cve_id)
                vmsa_cve_detail = detail["cve_details"].get(cve_id, {})

                if nvd and nvd["cvss_base_score"] > 0:
                    cvss_base = nvd["cvss_base_score"]
                    cvss_vector = nvd["cvss_vector"]
                    description = nvd["description"]
                    severity = nvd["severity"]
                elif cve_info["cvss"] > 0:
                    cvss_base = cve_info["cvss"]
                    cvss_vector = ""
                    description = vmsa_cve_detail.get("description", "")
                    severity = cve_info["severity"] or _score_to_severity(cvss_base)
                else:
                    cvss_base = 0.0
                    cvss_vector = ""
                    description = vmsa_cve_detail.get("description", "")
                    severity = advisory_severity

                is_exploited = vmsa_cve_detail.get("is_exploited", False)

                vulns.append({
                    "cve": cve_id,
                    "title": vmsa_cve_detail.get("title", ""),
                    "description": description,
                    "severity": severity,
                    "cvss_base_score": cvss_base,
                    "cvss_vector": cvss_vector,
                    "is_actively_exploited": is_exploited,
                    "fixed_in_version": fix_info["fixed_version"],
                    "patch_url": url,
                    "published": published,
                })

            vulns.sort(key=lambda x: x["cvss_base_score"], reverse=True)

            stats = {
                "total_cves": len(vulns),
                "critical_count": sum(1 for v in vulns if v["severity"] == "Critical"),
                "high_count": sum(1 for v in vulns if v["severity"] == "High"),
                "medium_count": sum(1 for v in vulns if v["severity"] == "Medium"),
                "low_count": sum(1 for v in vulns
                                 if v["severity"] not in ("Critical", "High", "Medium")),
                "actively_exploited_count": sum(1 for v in vulns if v["is_actively_exploited"]),
                "max_cvss_base": max((v["cvss_base_score"] for v in vulns), default=0.0),
            }

            file_id = f"NSX-{vmsa_id}_{safe}"
            vmsa_json = {
                "type": "security_advisory",
                "id": file_id,
                "vmsa_id": vmsa_id,
                "vendor": "VMware (Broadcom)",
                "product": product,
                "major_version": version,
                "month": month_year,
                "title": vmsa_title,
                "published": published,
                "vmsa_url": url,
                "advisory_severity": advisory_severity,
                "required_version": fix_info["fixed_version"],
                "workaround_available": bool(
                    fix_info["workaround"]
                    and fix_info["workaround"].lower() != "none"
                ),
                "upgrade_order": [
                    "1. NSX Manager (Primary → Standby)",
                    "2. NSX Edge 노드 (Edge cluster rolling upgrade)",
                    "3. Host Transport Node (유지보수 모드 + vMotion)",
                ],
                "vulnerabilities": vulns,
                "stats": stats,
            }

            fname = f"{file_id}.json"
            (OUT_DIR / fname).write_text(
                json.dumps(vmsa_json, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            written_files.append(fname)

            parts = [f"{stats['total_cves']}개 CVE"]
            if stats["critical_count"]:
                parts.append(f"Critical: {stats['critical_count']}")
            if stats["actively_exploited_count"]:
                parts.append(f"Exploited: {stats['actively_exploited_count']}")
            print(f"    → {product} {version}: {', '.join(parts)}")

    # === 트랙 B: Update 릴리스 → 개별 파일 ===
    result_builds = {}

    for pv_key, rel_info in month_releases.items():
        if pv_key not in target_pv_keys:
            continue

        product, version = pv_key
        safe = product_safe_name(product, version)
        detail = rel_info.get("detail", {})
        build = detail.get("build", "")

        if not build:
            continue

        non_cve_fixes = []
        for fix in detail.get("resolved_issues", []):
            severity = _heuristic_severity(fix.get("description", ""))
            non_cve_fixes.append({
                "pr": fix.get("pr", ""),
                "component": fix.get("component", ""),
                "description": fix.get("description", ""),
                "severity": severity,
                "severity_source": "heuristic",
            })

        included_vmsa = []
        for sec_fix in detail.get("resolved_security_issues", []):
            included_vmsa.extend(sec_fix.get("vmsa_ids", []))
        included_vmsa = sorted(set(included_vmsa))

        file_id = f"NSX-Build-{build}_{safe}"
        update_json = {
            "type": "update_release",
            "id": file_id,
            "vendor": "VMware (Broadcom)",
            "product": product,
            "major_version": version,
            "month": month_year,
            "version": rel_info.get("name", ""),
            "build": build,
            "release_date": detail.get("release_date", ""),
            "release_notes_url": rel_info.get("url", ""),
            "included_vmsa_fixes": included_vmsa,
            "non_cve_fixes": non_cve_fixes,
            "known_issues": detail.get("known_issues", []),
            "stats": {
                "non_cve_fix_count": len(non_cve_fixes),
                "included_vmsa_count": len(included_vmsa),
            },
        }

        fname = f"{file_id}.json"
        (OUT_DIR / fname).write_text(
            json.dumps(update_json, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        written_files.append(fname)

        pv_name = f"{product} {version}"
        result_builds[pv_name] = build

        print(f"    → {product} {version}: Update build {build}, "
              f"버그픽스: {len(non_cve_fixes)}건")

    # VMSA 최신 날짜
    vmsa_latest = ""
    if month_vmsas:
        dates = [v.get("published_date", "") for v in month_vmsas if v.get("published_date")]
        if dates:
            vmsa_latest = max(dates)

    return {
        "vmsa_latest_date": vmsa_latest,
        "update_builds": result_builds,
        "written_files": written_files,
    }


# ─── 메인 ─────────────────────────────────────────────────────────────────────

def main():
    months = get_last_6_months()
    valid_months = set(months)
    products_str = ", ".join(
        f"{p} {'/'.join(vs)}" for p, vs in TARGET_PRODUCTS.items()
    )
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"대상 제품: {products_str}")
    if NVD_API_KEY:
        print("NVD API Key: 설정됨 (rate limit 완화)")
    else:
        print("NVD API Key: 미설정 (요청 간 6.5초 대기)")
    print()

    manifest = load_manifest()

    removed = cleanup_old_months(manifest, valid_months)
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    # === 트랙 A: VMSA 목록 조회 ===
    print("Broadcom VMSA API 조회 중...")
    all_vmsas = fetch_vmsa_list()
    nsx_vmsas = [v for v in all_vmsas if is_nsx_related(v)]
    print(f"  전체 VMSA: {len(all_vmsas)}건, NSX 관련: {len(nsx_vmsas)}건")

    vmsa_by_month = _group_vmsas_by_month(nsx_vmsas, valid_months)
    vmsa_dates = {}
    for m_key, m_vmsas in vmsa_by_month.items():
        dates = [v.get("published_date", "") for v in m_vmsas if v.get("published_date")]
        if dates:
            vmsa_dates[m_key] = max(dates)
    print()

    # === 트랙 B: 릴리스 노트 인덱스 조회 ===
    print("NSX 릴리스 노트 인덱스 조회 중...")
    all_releases = {}  # {(product, version): [{name, url, detail}]}

    for pv_key in RN_INDEX_URLS:
        product, version = pv_key
        rn_list = fetch_rn_index(product, version)
        if not rn_list:
            print(f"  {product} {version}: 릴리스 노트 없음 또는 조회 실패")
            continue

        fetched_releases = []
        for rel in rn_list[:5]:
            print(f"  {product} {version}: {rel['name']} 파싱 중...")
            detail = fetch_rn_detail(rel["url"])
            rel["detail"] = detail
            fetched_releases.append(rel)

            rd = detail.get("release_date", "")
            build = detail.get("build", "")
            fixes = len(detail.get("resolved_issues", []))
            ki = len(detail.get("known_issues", []))
            if rd:
                print(f"    빌드: {build}, 날짜: {rd}, "
                      f"버그픽스: {fixes}건, Known Issues: {ki}건")

        all_releases[pv_key] = fetched_releases

    releases_by_month, rn_builds = _group_releases_by_month(all_releases, valid_months)
    print()

    # 구버전 파일 정리 (재수집 시 파일명 변경 대응)
    for m in months:
        if m in manifest and "files" not in manifest[m]:
            del manifest[m]

    # === 월별 수집 ===
    fetched = 0
    skipped = 0

    for m in months:
        update_needed, reason = needs_update(m, manifest, vmsa_dates, rn_builds)

        if not update_needed:
            file_count = len(manifest.get(m, {}).get("files", []))
            print(f"  {m}: 건너뜀 ({reason}, {file_count}개 파일)")
            skipped += 1
            continue

        month_vmsas = vmsa_by_month.get(m, [])
        month_releases = releases_by_month.get(m, {})

        if not month_vmsas and not month_releases:
            print(f"  {m}: 해당 월 데이터 없음")
            manifest[m] = {
                "vmsa_latest_date": "",
                "update_builds": {},
                "files": [],
                "fetched_at": datetime.now().isoformat(),
            }
            skipped += 1
            continue

        # 기존 파일 삭제 (재수집 전 정리)
        for fname in manifest.get(m, {}).get("files", []):
            f = OUT_DIR / fname
            if f.exists():
                f.unlink()

        vmsa_count = len(month_vmsas)
        rel_count = len(month_releases)
        print(f"  {m}: 수집 중... ({reason}) "
              f"[VMSA: {vmsa_count}건, Update: {rel_count}건]")

        result = fetch_nsx_update(m, month_vmsas, month_releases)
        written = result.get("written_files", [])

        manifest[m] = {
            "vmsa_latest_date": result.get("vmsa_latest_date", ""),
            "update_builds": result.get("update_builds", {}),
            "files": written,
            "fetched_at": datetime.now().isoformat(),
        }

        fetched += 1

    save_manifest(manifest)

    # 요약 출력
    all_files = []
    for m in months:
        all_files.extend(manifest.get(m, {}).get("files", []))

    print()
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    print(f"  총 파일 수: {len(all_files)}개 "
          f"(VMSA: {sum(1 for f in all_files if 'VMSA-' in f)}, "
          f"Update: {sum(1 for f in all_files if 'Build-' in f)})")

    for p, versions in TARGET_PRODUCTS.items():
        for v in versions:
            safe = product_safe_name(p, v)
            pv_files = [f for f in all_files if f.endswith(f"_{safe}.json")]
            cves = 0
            fixes = 0
            for fname in pv_files:
                fp = OUT_DIR / fname
                if fp.exists():
                    try:
                        data = json.loads(fp.read_text(encoding="utf-8"))
                        cves += data["stats"].get("total_cves", 0)
                        fixes += data["stats"].get("non_cve_fix_count", 0)
                    except (json.JSONDecodeError, KeyError):
                        pass
            print(f"  {p} {v}: {cves}건 CVE, {fixes}건 버그픽스 ({len(pv_files)}개 파일)")


if __name__ == "__main__":
    main()
