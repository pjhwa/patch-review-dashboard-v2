"""
Microsoft Security Update CVRF SQL Server 패치 수집기
- MSRC API v3.0에서 CVRF 데이터를 가져와 AI 리뷰에 최적화된 JSON으로 변환
- SQL Server 2016 / 2017 / 2019 / 2022 / 2025 대상
- CU(Cumulative Update) 경로 우선, GDR 경로 포함
"""

import requests
import xmltodict
import json
import re
from pathlib import Path
from datetime import datetime
from dateutil.relativedelta import relativedelta

TARGET_SQL = [
    "SQL Server 2016",
    "SQL Server 2017",
    "SQL Server 2019",
    "SQL Server 2022",
    "SQL Server 2025",
]

# CVRF XML 네임스페이스 접두사 후보
PREFIXES = ["", "cvrf:", "vuln:", "prod:"]


def find_key(node, key):
    """네임스페이스 접두사를 자동 탐색하여 dict에서 값을 찾는다."""
    if not isinstance(node, dict):
        return None
    for prefix in PREFIXES:
        k = prefix + key
        if k in node:
            return node[k]
    return None


def ensure_list(val):
    """단일 dict이면 리스트로 감싼다. None이면 빈 리스트 반환."""
    if val is None:
        return []
    if isinstance(val, list):
        return val
    return [val]


def text_of(node):
    """노드에서 텍스트 값을 추출. dict면 #text, 아니면 str 변환."""
    if node is None:
        return ""
    if isinstance(node, dict):
        return str(node.get("#text", ""))
    return str(node)


def clean_html(text, max_len=0):
    """HTML 태그 제거 및 공백 정리."""
    if not text:
        return ""
    text = re.sub(r'<[^>]+>', ' ', str(text))
    text = re.sub(r'\s+', ' ', text).strip()
    if max_len > 0:
        text = text[:max_len]
    return text


def fetch_kb_known_issues(kb_number):
    """Microsoft Support 페이지에서 KB별 Known Issues를 수집한다.

    Args:
        kb_number: "KB5040948" 형태의 KB 번호

    Returns:
        list: [{title, symptoms, workaround, resolution, status}, ...]
    """
    kb_num = kb_number.replace("KB", "")
    url = f"https://support.microsoft.com/en-us/help/{kb_num}"
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15, allow_redirects=True)
        if r.status_code != 200:
            return []
    except requests.exceptions.RequestException:
        return []

    html = r.text
    idx = html.lower().find("known issues in this update")
    if idx < 0:
        return []

    chunk = html[idx:idx + 40000]

    # 섹션 끝 찾기: <h2> 태그, 또는 "Known issues in this update" h3 재등장
    end_idx = len(chunk)
    h2_match = re.search(r'<h2[^>]*>', chunk[100:])
    if h2_match:
        end_idx = min(end_idx, 100 + h2_match.start())
    second_ki = chunk.lower().find("known issues in this update", 100)
    if second_ki > 0:
        end_idx = min(end_idx, second_ki)
    chunk = chunk[:end_idx]

    # h3 태그(이슈 제목) 기준으로 분리
    issue_blocks = re.split(r'<h3[^>]*>', chunk)[1:]

    issues = []
    for block in issue_blocks:
        # 제목 추출
        title_match = re.match(r'(.*?)</h3>', block, re.DOTALL)
        if not title_match:
            continue
        title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()
        if not title or "known issues in this update" in title.lower():
            continue
        if re.match(r'(?i)servicing stack update', title):
            continue

        body = block[title_match.end():]

        # Symptoms 섹션이 없으면 새 expando 형식(ocpExpandoBody)으로 처리 시도
        if not re.search(r'(?i)<b[^>]*>\s*Symptoms?\s*</b>', body):
            body_text = clean_html(body)
            if body_text:
                issues.append({
                    "title": title,
                    "symptoms": body_text,
                    "workaround": "",
                    "resolution": "",
                    "status": "",
                })
            continue

        # 섹션 분리: <b>Symptoms</b>, <b>Workaround</b>, <b>Resolution</b>, <b>Status</b>
        sections = {"symptoms": "", "workaround": "", "resolution": "", "status": ""}
        section_pattern = re.compile(
            r'<b[^>]*>\s*(Symptoms?|Workarounds?|Resolution|Resolved|Status|Next\s+steps?)\s*</b>',
            re.IGNORECASE
        )
        parts = section_pattern.split(body)

        current_key = None
        for part in parts:
            part_lower = part.strip().lower()
            if part_lower in ("symptom", "symptoms"):
                current_key = "symptoms"
            elif part_lower in ("workaround", "workarounds"):
                current_key = "workaround"
            elif part_lower in ("resolution", "resolved"):
                current_key = "resolution"
            elif part_lower in ("status", "next steps", "next step"):
                current_key = "status"
            elif current_key:
                cleaned = re.sub(r'<[^>]+>', ' ', part)
                cleaned = re.sub(r'[\u200b-\u200f\u2028-\u202f\ufeff]', '', cleaned)
                cleaned = re.sub(r'\s+', ' ', cleaned).strip()
                if cleaned:
                    sections[current_key] = (sections[current_key] + " " + cleaned).strip()

        issues.append({
            "title": title,
            "symptoms": sections["symptoms"],
            "workaround": sections["workaround"],
            "resolution": sections["resolution"],
            "status": sections["status"],
        })

    return issues


def fetch_kb_non_cve_fixes(kb_number):
    """KB 페이지에서 non-CVE 버그 패치 목록을 수집한다.

    SQL Server CU: "Improvements and fixes included in this update" 테이블에서 추출
    Windows Server: "Improvements" 섹션의 불릿 항목에서 추출

    Args:
        kb_number: "KB5077464" 형태의 KB 번호

    Returns:
        list: [{reference, fix_area, component, description, platform}, ...]
    """
    kb_num = kb_number.replace("KB", "")
    url = f"https://support.microsoft.com/en-us/help/{kb_num}"
    try:
        r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=15, allow_redirects=True)
        if r.status_code != 200:
            return []
    except requests.exceptions.RequestException:
        return []

    html = r.text

    # Improvements 섹션 찾기 (section > h2 기준)
    section_body = None
    for m in re.finditer(r'<section[^>]*>(.*?)</section>', html, re.DOTALL):
        body = m.group(1)
        h2 = re.search(r'<h2[^>]*>(.*?)</h2>', body, re.DOTALL)
        if h2:
            h2_text = re.sub(r'<[^>]+>', '', h2.group(1)).strip()
            if re.match(r'(?i)improvements?(\s+and\s+fixes?)?(\s+included)?', h2_text):
                section_body = body
                break
    if not section_body:
        return []

    fixes = []

    # SQL Server CU: 테이블 파싱 (Bug reference / Description / Fix area / Component / Platform)
    if '<table' in section_body:
        tbody = re.search(r'<tbody[^>]*>(.*?)</tbody>', section_body, re.DOTALL)
        if tbody:
            rows = re.findall(r'<tr[^>]*>(.*?)</tr>', tbody.group(1), re.DOTALL)
            for row in rows:
                cells = re.findall(r'<td[^>]*>(.*?)</td>', row, re.DOTALL)
                cols = [clean_html(c) for c in cells]
                if len(cols) >= 2 and cols[1]:
                    fixes.append({
                        "reference": cols[0] if cols else "",
                        "fix_area": cols[2] if len(cols) > 2 else "",
                        "component": cols[3] if len(cols) > 3 else "",
                        "description": cols[1],
                        "platform": cols[4] if len(cols) > 4 else "",
                    })
        return fixes

    # Windows Server: 불릿 리스트 파싱 (<b>[Category]</b> description)
    lis = re.findall(r'<li[^>]*>(.*?)</li>', section_body, re.DOTALL)
    for li in lis:
        cat_match = re.search(r'<b[^>]*>\[?([^\]<]{1,60})\]?</b>(.*)', li, re.DOTALL)
        if cat_match:
            fix_area = cat_match.group(1).strip().strip("[]")
            description = clean_html(cat_match.group(2))
        else:
            fix_area = ""
            description = clean_html(li)
        if description:
            fixes.append({
                "reference": "",
                "fix_area": fix_area,
                "component": "",
                "description": description,
                "platform": "",
            })

    return fixes


def get_last_6_months():
    """현재 월 포함 최근 7개월의 'YYYY-Mon' 문자열 목록 반환."""
    now = datetime.now()
    months = []
    for i in range(7):
        d = now - relativedelta(months=i)
        months.append(d.strftime("%Y-%b"))
    return sorted(months)


def build_product_map(product_tree):
    """ProductTree에서 ProductID -> 제품명 매핑 dict를 구축한다."""
    product_map = {}

    def _recurse(node):
        if isinstance(node, dict):
            fpn = find_key(node, "FullProductName")
            for item in ensure_list(fpn):
                if isinstance(item, dict):
                    pid = item.get("@ProductID", "")
                    name = item.get("#text", "")
                    if pid and name:
                        product_map[pid] = name
            branch = find_key(node, "Branch")
            for b in ensure_list(branch):
                _recurse(b)
            for v in node.values():
                if isinstance(v, (dict, list)):
                    _recurse(v)
        elif isinstance(node, list):
            for item in node:
                _recurse(item)

    if product_tree:
        _recurse(product_tree)
    return product_map


def extract_threats(vuln_node):
    """Vulnerability의 Threats에서 Type별로 정보를 분리 추출한다."""
    threats_node = find_key(vuln_node, "Threats")
    threats = ensure_list(find_key(threats_node, "Threat") if threats_node else None)

    result = {
        "impact": "",
        "severity": "",
        "exploit_status": "",
    }

    for t in threats:
        if not isinstance(t, dict):
            continue
        threat_type = t.get("@Type", "")
        desc_node = find_key(t, "Description")
        desc = text_of(desc_node)

        threat_type_lower = threat_type.lower() if isinstance(threat_type, str) else str(threat_type)
        if threat_type_lower in ("impact", "0"):
            if not result["impact"]:
                result["impact"] = desc
        elif threat_type_lower in ("severity", "1"):
            if not result["severity"]:
                result["severity"] = desc
        elif threat_type_lower in ("exploit status", "3"):
            if not result["exploit_status"]:
                result["exploit_status"] = desc

    return result


def extract_cvss(vuln_node):
    """Vulnerability에서 CVSS 점수 정보를 추출한다."""
    score_sets_node = find_key(vuln_node, "CVSSScoreSets")
    sets = ensure_list(find_key(score_sets_node, "ScoreSet") if score_sets_node else None)

    max_base = 0.0
    max_temporal = 0.0
    best_vector = ""

    for s in sets:
        if not isinstance(s, dict):
            continue
        base = float(text_of(find_key(s, "BaseScore")) or 0)
        temporal = float(text_of(find_key(s, "TemporalScore")) or 0)
        vector = text_of(find_key(s, "Vector"))

        if base > max_base:
            max_base = base
            best_vector = vector
        if temporal > max_temporal:
            max_temporal = temporal

    return {
        "max_base_score": max_base,
        "max_temporal_score": max_temporal,
        "vector": best_vector,
    }


def extract_remediations_by_pid(vuln_node):
    """Vulnerability에서 ProductID별 Remediation 정보를 추출한다.

    Returns:
        dict: {product_id: [{kb_number, url, fixed_build, supercedence, restart_required}, ...]}
    """
    rems_node = find_key(vuln_node, "Remediations")
    rems = ensure_list(find_key(rems_node, "Remediation") if rems_node else None)

    by_pid_kb = {}

    for r in rems:
        if not isinstance(r, dict):
            continue

        rem_type = r.get("@Type", "")
        desc = text_of(find_key(r, "Description"))
        url = text_of(find_key(r, "URL"))
        fixed_build = text_of(find_key(r, "FixedBuild"))
        product_ids = ensure_list(find_key(r, "ProductID"))
        supercedence = text_of(find_key(r, "Supercedence"))
        restart_req = text_of(find_key(r, "RestartRequired"))

        kb_number = ""
        kb_match = re.search(r'(\d{6,7})', desc)
        if kb_match:
            kb_number = f"KB{kb_match.group(1)}"
        elif url:
            kb_url_match = re.search(r'(\d{6,7})', url)
            if kb_url_match:
                kb_number = f"KB{kb_url_match.group(1)}"

        for pid in product_ids:
            pid_str = text_of(pid)
            if not pid_str:
                continue

            if pid_str not in by_pid_kb:
                by_pid_kb[pid_str] = {}

            kb_key = kb_number or "_unknown"
            if kb_key not in by_pid_kb[pid_str]:
                by_pid_kb[pid_str][kb_key] = {
                    "kb_number": kb_number,
                    "url": "",
                    "fixed_build": "",
                    "supercedence": "",
                    "restart_required": "",
                }

            entry = by_pid_kb[pid_str][kb_key]
            if rem_type == "Vendor Fix":
                if fixed_build:
                    entry["fixed_build"] = fixed_build
                if supercedence:
                    entry["supercedence"] = supercedence
                if restart_req:
                    entry["restart_required"] = restart_req
                if url:
                    entry["url"] = url
            elif rem_type == "Release Notes" and not entry["url"]:
                if url:
                    entry["url"] = url

    result = {}
    for pid, kb_map in by_pid_kb.items():
        result[pid] = list(kb_map.values())
    return result


def extract_affected_products(vuln_node, product_map):
    """Vulnerability의 ProductStatuses에서 영향받는 제품 목록을 추출한다."""
    statuses_node = find_key(vuln_node, "ProductStatuses")
    statuses = ensure_list(find_key(statuses_node, "Status") if statuses_node else None)

    affected = []
    for s in statuses:
        if not isinstance(s, dict):
            continue
        status_type = s.get("@Type", "")
        product_ids = ensure_list(find_key(s, "ProductID"))

        for pid in product_ids:
            pid_str = text_of(pid)
            name = product_map.get(pid_str, pid_str)
            affected.append({
                "product_id": pid_str,
                "product_name": name,
                "status": status_type,
            })

    return affected


def extract_vuln_notes(vuln_node):
    """Vulnerability의 Notes에서 설명 텍스트를 추출한다."""
    notes_node = find_key(vuln_node, "Notes")
    notes = ensure_list(find_key(notes_node, "Note") if notes_node else None)

    description = ""
    faq = ""
    for n in notes:
        note_type = n.get("@Type", "") if isinstance(n, dict) else ""
        note_title = n.get("@Title", "") if isinstance(n, dict) else ""
        note_text = clean_html(text_of(n))

        if note_type == "Description" or note_title == "Description":
            description = note_text
        elif "FAQ" in note_title.upper() or note_type == "FAQ":
            faq = note_text

    return {"description": description, "faq": faq}


def get_target_sql_name(product_name):
    """제품명에서 TARGET_SQL 이름을 반환한다.

    예: "Microsoft SQL Server 2022 for x64-based Systems (CU 23)" → "SQL Server 2022"
    """
    m = re.search(r'SQL Server (\d{4})', product_name)
    if not m:
        return None
    candidate = f"SQL Server {m.group(1)}"
    return candidate if candidate in TARGET_SQL else None


def build_sql_pid_map(product_map):
    """ProductMap에서 TARGET_SQL에 해당하는 ProductID -> SQL버전명 매핑을 구축한다.

    Returns:
        dict: {product_id: sql_name}  (예: {"12147": "SQL Server 2022"})
    """
    sql_pid_map = {}
    for pid, name in product_map.items():
        sql_name = get_target_sql_name(name)
        if sql_name:
            sql_pid_map[pid] = sql_name
    return sql_pid_map


def sql_safe_name(sql_name):
    """SQL 버전명을 파일명에 안전한 형태로 변환."""
    return sql_name.replace(" ", "_")


def parse_document_notes(doc):
    """DocumentNotes에서 Summary를 추출한다."""
    notes_node = find_key(doc, "DocumentNotes")
    notes = ensure_list(find_key(notes_node, "Note") if notes_node else None)

    summary = ""
    for n in notes:
        if not isinstance(n, dict):
            continue
        note_type = n.get("@Type", "")
        note_title = n.get("@Title", "")
        note_text = text_of(n)
        if note_type == "Summary" or note_title == "Summary":
            summary = clean_html(note_text, 3000)
            break

    return summary


OUT_DIR = Path("sql_data")
MANIFEST_FILE = OUT_DIR / "manifest.json"


def load_manifest():
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest):
    OUT_DIR.mkdir(exist_ok=True)
    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_remote_update_dates():
    """MSRC /updates API에서 각 월별 CurrentReleaseDate를 조회한다."""
    url = "https://api.msrc.microsoft.com/cvrf/v3.0/updates"
    try:
        r = requests.get(url, headers={"Accept": "application/json"}, timeout=30)
        r.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"  /updates API 조회 실패: {e}")
        return {}

    result = {}
    for item in r.json().get("value", []):
        update_id = item.get("ID", "")
        release_date = item.get("CurrentReleaseDate", "")
        if update_id and release_date:
            result[update_id] = release_date
    return result


def normalize_date(date_str):
    """날짜 문자열을 정규화하여 비교 가능하게 만든다."""
    if not date_str:
        return ""
    s = date_str.rstrip("Z")
    s = re.sub(r'\.\d+', '', s)
    s = re.sub(r'[+-]\d{2}:\d{2}$', '', s)
    return s


def needs_update(month_year, manifest, remote_dates):
    """해당 월의 데이터를 (재)수집해야 하는지 판단한다."""
    has_any = any(
        (OUT_DIR / f"SQLU-{month_year}-{sql_safe_name(sql_name)}.json").exists()
        for sql_name in TARGET_SQL
    )
    if not has_any:
        return True, "신규 수집"

    if month_year not in manifest:
        return True, "매니페스트 누락"

    local_date = normalize_date(manifest[month_year].get("current_release_date", ""))
    remote_date = normalize_date(remote_dates.get(month_year, ""))

    if not remote_date:
        return False, "원격 정보 없음"

    if local_date != remote_date:
        return True, f"업데이트 감지 ({local_date[:10]} -> {remote_date[:10]})"

    return False, "최신 상태"


def cleanup_old_months(manifest, valid_months):
    """수집 범위를 벗어난 오래된 데이터를 정리한다."""
    removed = []
    for month_year in list(manifest.keys()):
        if month_year not in valid_months:
            for sql_name in TARGET_SQL:
                f = OUT_DIR / f"SQLU-{month_year}-{sql_safe_name(sql_name)}.json"
                if f.exists():
                    f.unlink()
            del manifest[month_year]
            removed.append(month_year)
    return removed


def fetch_sql_update(month_year: str):
    """MSRC API에서 해당 월의 CVRF 데이터를 가져와 SQL Server 버전별 누적패치 JSON으로 저장한다.

    Returns:
        dict: {sql_name: stats_dict, "current_release_date": str} 또는 None (실패 시)
    """
    url = f"https://api.msrc.microsoft.com/cvrf/v3.0/cvrf/{month_year}"
    try:
        r = requests.get(url, headers={"Accept": "application/xml"}, timeout=60)
        r.raise_for_status()
    except requests.exceptions.HTTPError:
        if r.status_code == 404:
            print(f"    데이터 없음 (404), 건너뜀")
            return None
        raise
    except requests.exceptions.RequestException as e:
        print(f"    요청 실패 - {e}")
        return None

    data = xmltodict.parse(r.text, process_namespaces=False)
    doc = None
    for key in ["cvrf:cvrfdoc", "cvrfdoc"]:
        if key in data:
            doc = data[key]
            break
    if doc is None:
        doc = data.get(list(data.keys())[0], {})

    # === 1. ProductID 매핑 구축 ===
    product_tree = find_key(doc, "ProductTree")
    product_map = build_product_map(product_tree)
    sql_pid_map = build_sql_pid_map(product_map)  # {pid: sql_name}

    # === 2. 문서 메타 정보 ===
    tracking = find_key(doc, "DocumentTracking") or {}
    summary = parse_document_notes(doc)
    current_release_date = text_of(find_key(tracking, "CurrentReleaseDate"))

    # === 3. SQL Server 버전별 advisory 초기화 ===
    sql_advisories = {}
    for sql_name in TARGET_SQL:
        sql_advisories[sql_name] = {
            "id": f"SQLU-{month_year}-{sql_safe_name(sql_name)}",
            "vendor": "Microsoft",
            "product": sql_name,
            "month": month_year,
            "type": text_of(find_key(doc, "DocumentType")) or "Security Update",
            "title": text_of(find_key(doc, "DocumentTitle")),
            "initial_release_date": text_of(find_key(tracking, "InitialReleaseDate")),
            "current_release_date": current_release_date,
            "revision": text_of(find_key(tracking, "Version")),
            "url": url,
            "summary": summary,
            "cumulative_update_kb": "",
            "cumulative_update_url": "",
            "non_cve_fixes": [],
            "known_issues": [],
            "vulnerabilities": [],
            "stats": {
                "total_cves": 0,
                "critical_count": 0,
                "important_count": 0,
                "actively_exploited_count": 0,
                "max_cvss_base": 0.0,
            },
            "kb_articles": set(),
        }

    # === 4. 취약점 파싱 → SQL Server 버전별 분배 ===
    vulns = ensure_list(find_key(doc, "Vulnerability"))
    kb_freq = {sql_name: {} for sql_name in TARGET_SQL}

    for v in vulns:
        if not isinstance(v, dict):
            continue

        cve = text_of(find_key(v, "CVE"))
        if not cve:
            continue

        title = text_of(find_key(v, "Title"))
        notes = extract_vuln_notes(v)
        threats = extract_threats(v)
        cvss = extract_cvss(v)
        rems_by_pid = extract_remediations_by_pid(v)
        affected = extract_affected_products(v, product_map)

        # 악용 여부
        is_exploited = False
        exploit_status = threats["exploit_status"]
        if exploit_status and re.search(r'Exploited\s*:\s*Yes', exploit_status, re.IGNORECASE):
            is_exploited = True

        # 심각도
        severity = threats["severity"]
        if not severity:
            if cvss["max_base_score"] >= 9.0:
                severity = "Critical"
            elif cvss["max_base_score"] >= 7.0:
                severity = "Important"
            elif cvss["max_base_score"] >= 4.0:
                severity = "Moderate"
            else:
                severity = "Low"

        for a in affected:
            sql_name = get_target_sql_name(a["product_name"])
            if not sql_name:
                continue

            pid = a["product_id"]
            rem_list = rems_by_pid.get(pid, [])

            for rem in rem_list:
                kb = rem.get("kb_number", "")
                if kb:
                    sql_advisories[sql_name]["kb_articles"].add(kb)
                    kb_freq[sql_name][kb] = kb_freq[sql_name].get(kb, 0) + 1

            adv = sql_advisories[sql_name]
            if any(ve["cve"] == cve for ve in adv["vulnerabilities"]):
                continue

            rep_rem = rem_list[0] if rem_list else {}

            vuln_entry = {
                "cve": cve,
                "title": title,
                "description": notes["description"],
                "faq": notes["faq"],
                "impact": threats["impact"],
                "severity": severity,
                "exploit_status": exploit_status,
                "is_actively_exploited": is_exploited,
                "cvss_base_score": cvss["max_base_score"],
                "cvss_temporal_score": cvss["max_temporal_score"],
                "cvss_vector": cvss["vector"],
                "kb_number": rep_rem.get("kb_number", ""),
                "fixed_build": rep_rem.get("fixed_build", ""),
                "kb_url": rep_rem.get("url", ""),
                "supercedence": rep_rem.get("supercedence", ""),
                "restart_required": rep_rem.get("restart_required", ""),
            }

            adv["vulnerabilities"].append(vuln_entry)

            adv["stats"]["total_cves"] += 1
            if severity == "Critical":
                adv["stats"]["critical_count"] += 1
            elif severity == "Important":
                adv["stats"]["important_count"] += 1
            if is_exploited:
                adv["stats"]["actively_exploited_count"] += 1
            if cvss["max_base_score"] > adv["stats"]["max_cvss_base"]:
                adv["stats"]["max_cvss_base"] = cvss["max_base_score"]

    # === 5. 누적 KB 결정 (CU 경로 우선: KB 번호가 가장 큰 것) ===
    OUT_DIR.mkdir(exist_ok=True)
    result = {"current_release_date": current_release_date}

    cu_kbs = {}
    for sql_name in TARGET_SQL:
        adv = sql_advisories[sql_name]
        if not adv["vulnerabilities"]:
            continue
        freq = kb_freq[sql_name]
        if freq:
            max_count = max(freq.values())
            candidates = [kb for kb, cnt in freq.items() if cnt == max_count]
            cu_kb = max(candidates)  # KB 번호가 큰 것 = CU 경로 (GDR보다 최신)
            cu_kbs[sql_name] = cu_kb
            adv["cumulative_update_kb"] = cu_kb
            for ve in adv["vulnerabilities"]:
                if ve["kb_number"] == cu_kb and ve["kb_url"]:
                    adv["cumulative_update_url"] = ve["kb_url"]
                    break

    # === 6. 누적 KB의 non-CVE 버그패치 수집 ===
    fetched_fixes = {}  # {kb: [fixes]}
    for sql_name, cu_kb in cu_kbs.items():
        if cu_kb not in fetched_fixes:
            print(f"    Non-CVE 픽스 수집: {cu_kb}...")
            fetched_fixes[cu_kb] = fetch_kb_non_cve_fixes(cu_kb)
        sql_advisories[sql_name]["non_cve_fixes"] = fetched_fixes[cu_kb]

    # === 7. 모든 SQL Server 버전의 KB에서 Known Issues 수집 ===
    fetched_ki = {}
    all_kbs = set()
    for sql_name in TARGET_SQL:
        all_kbs.update(sql_advisories[sql_name].get("kb_articles", set()))
    for kb in all_kbs:
        if kb not in fetched_ki:
            print(f"    Known Issues 수집: {kb}...")
            fetched_ki[kb] = fetch_kb_known_issues(kb)

    # === 8. 저장 ===
    for sql_name in TARGET_SQL:
        adv = sql_advisories[sql_name]
        if not adv["vulnerabilities"]:
            continue

        # Known Issues: 해당 버전의 모든 KB에서 수집 후 제목 기준 중복 제거
        seen_titles = set()
        merged_ki = []
        for kb in sorted(adv.get("kb_articles", set())):
            for ki in fetched_ki.get(kb, []):
                if ki["title"] not in seen_titles:
                    seen_titles.add(ki["title"])
                    merged_ki.append({**ki, "source_kb": kb})
        adv["known_issues"] = merged_ki

        adv["kb_articles"] = sorted(adv["kb_articles"])
        adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)

        safe = sql_safe_name(sql_name)
        outfile = OUT_DIR / f"SQLU-{month_year}-{safe}.json"
        outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

        stats = adv["stats"]
        ki_count = len(adv["known_issues"])
        fix_count = len(adv["non_cve_fixes"])
        result[sql_name] = stats
        print(
            f"    {sql_name}: {stats['total_cves']}개 CVE "
            f"(Critical: {stats['critical_count']}, "
            f"Exploited: {stats['actively_exploited_count']}, "
            f"KB: {adv['cumulative_update_kb']}, "
            f"Known Issues: {ki_count}건, Non-CVE Fixes: {fix_count}건)"
        )

    return result


def main():
    months = get_last_6_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"대상 제품: {', '.join(TARGET_SQL)}")
    print()

    manifest = load_manifest()
    print("원격 업데이트 목록 조회 중...")
    remote_dates = fetch_remote_update_dates()
    print()

    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    fetched = 0
    skipped = 0
    sql_totals = {sql_name: {"cves": 0, "exploited": 0} for sql_name in TARGET_SQL}

    for m in months:
        update_needed, reason = needs_update(m, manifest, remote_dates)

        if not update_needed:
            for sql_name in TARGET_SQL:
                f = OUT_DIR / f"SQLU-{m}-{sql_safe_name(sql_name)}.json"
                if f.exists():
                    existing = json.loads(f.read_text(encoding="utf-8"))
                    sql_totals[sql_name]["cves"] += existing["stats"]["total_cves"]
                    sql_totals[sql_name]["exploited"] += existing["stats"]["actively_exploited_count"]
            print(f"  {m}: 건너뜀 ({reason})")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({reason})")
        result = fetch_sql_update(m)
        if result:
            manifest[m] = {
                "current_release_date": result["current_release_date"],
                "fetched_at": datetime.now().isoformat(),
            }
            for sql_name in TARGET_SQL:
                if sql_name in result:
                    sql_totals[sql_name]["cves"] += result[sql_name]["total_cves"]
                    sql_totals[sql_name]["exploited"] += result[sql_name]["actively_exploited_count"]
            fetched += 1

    save_manifest(manifest)

    print()
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    for sql_name in TARGET_SQL:
        t = sql_totals[sql_name]
        print(f"  {sql_name}: {t['cves']}개 CVE, 악용 중 {t['exploited']}개")


if __name__ == "__main__":
    main()
