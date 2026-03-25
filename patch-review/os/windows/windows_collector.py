"""
Microsoft Security Update CVRF 패치 수집기
- MSRC API v3.0에서 CVRF 데이터를 가져와 AI 리뷰에 최적화된 JSON으로 변환
- Windows Server 2016/2019/2022/2025 대상
"""

import requests
import xmltodict
import json
import re
from pathlib import Path
from datetime import datetime
from dateutil.relativedelta import relativedelta

TARGET_OS = [
    "Windows Server 2016",
    "Windows Server 2019",
    "Windows Server 2022",
    "Windows Server 2025",
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
        kb_number: "KB5078752" 형태의 KB 번호

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
    # <h2> 태그
    h2_match = re.search(r'<h2[^>]*>', chunk[100:])
    if h2_match:
        end_idx = min(end_idx, 100 + h2_match.start())
    # "Known issues in this update" h3 재등장 (중복 섹션)
    second_ki = chunk.lower().find("known issues in this update", 100)
    if second_ki > 0:
        end_idx = min(end_idx, second_ki)
    chunk = chunk[:end_idx]

    # h3 태그(이슈 제목) 기준으로 분리
    # 각 이슈: <h3>title</h3> ... <b>Symptoms</b> text ... <b>Workaround</b> text ...
    issue_blocks = re.split(r'<h3[^>]*>', chunk)[1:]  # 첫 번째는 헤더 텍스트

    issues = []
    for block in issue_blocks:
        # 제목 추출
        title_match = re.match(r'(.*?)</h3>', block, re.DOTALL)
        if not title_match:
            continue
        title = re.sub(r'<[^>]+>', '', title_match.group(1)).strip()
        if not title or "known issues in this update" in title.lower():
            continue
        # Servicing stack update 등 비 Known Issues 항목 제외
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
        # 섹션 키워드와 매칭
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
            # FullProductName 처리: 단일 또는 리스트
            fpn = find_key(node, "FullProductName")
            for item in ensure_list(fpn):
                if isinstance(item, dict):
                    pid = item.get("@ProductID", "")
                    name = item.get("#text", "")
                    if pid and name:
                        product_map[pid] = name
                elif isinstance(item, str) and fpn:
                    # 속성이 없는 단순 텍스트
                    pass
            # Branch 재귀
            branch = find_key(node, "Branch")
            for b in ensure_list(branch):
                _recurse(b)
            # 나머지 하위 노드도 탐색
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
    """Vulnerability의 Threats에서 Type별로 정보를 분리 추출한다.

    Threat @Type 값:
      0 = Impact (영향 유형: RCE, EoP 등)
      1 = Severity (심각도: Critical, Important 등)
      2 = Description (기타)
      3 = Exploit Status (악용 여부)
    """
    threats_node = find_key(vuln_node, "Threats")
    threats = ensure_list(find_key(threats_node, "Threat") if threats_node else None)

    result = {
        "impact": "",
        "severity": "",
        "exploit_status": "",
        "affected_product_ids_by_threat": {},
    }

    for t in threats:
        if not isinstance(t, dict):
            continue
        threat_type = t.get("@Type", "")
        desc_node = find_key(t, "Description")
        desc = text_of(desc_node)
        product_ids = ensure_list(find_key(t, "ProductID"))

        threat_type_lower = threat_type.lower() if isinstance(threat_type, str) else str(threat_type)
        if threat_type_lower in ("impact", "0"):
            if not result["impact"]:
                result["impact"] = desc
        elif threat_type_lower in ("severity", "1"):
            if not result["severity"]:
                result["severity"] = desc
            for pid in product_ids:
                pid_str = text_of(pid)
                if pid_str:
                    result["affected_product_ids_by_threat"].setdefault(pid_str, {})
                    result["affected_product_ids_by_threat"][pid_str]["severity"] = desc
        elif threat_type_lower in ("exploit status", "3"):
            if not result["exploit_status"]:
                result["exploit_status"] = desc

    return result


def extract_cvss(vuln_node):
    """Vulnerability에서 CVSS 점수 정보를 추출한다. 여러 ScoreSet이 있을 수 있다."""
    score_sets_node = find_key(vuln_node, "CVSSScoreSets")
    sets = ensure_list(find_key(score_sets_node, "ScoreSet") if score_sets_node else None)

    scores = []
    max_base = 0.0
    max_temporal = 0.0
    best_vector = ""

    for s in sets:
        if not isinstance(s, dict):
            continue
        base = float(text_of(find_key(s, "BaseScore")) or 0)
        temporal = float(text_of(find_key(s, "TemporalScore")) or 0)
        vector = text_of(find_key(s, "Vector"))
        product_ids = ensure_list(find_key(s, "ProductID"))

        entry = {
            "base_score": base,
            "temporal_score": temporal,
            "vector": vector,
            "product_ids": [text_of(p) for p in product_ids if text_of(p)],
        }
        scores.append(entry)

        if base > max_base:
            max_base = base
            best_vector = vector
        if temporal > max_temporal:
            max_temporal = temporal

    return {
        "scores": scores,
        "max_base_score": max_base,
        "max_temporal_score": max_temporal,
        "vector": best_vector,
    }


def extract_remediations_by_pid(vuln_node):
    """Vulnerability에서 ProductID별 Remediation 정보를 추출한다.

    동일 PID에 여러 KB가 적용될 수 있으므로 (예: Server 2025에 KB5078736과 KB5078740 모두 적용),
    KB별로 별도 엔트리를 유지한다.

    Returns:
        dict: {product_id: [{kb_number, url, fixed_build, supercedence, restart_required}, ...]}
              Vendor Fix와 Release Notes 항목을 KB 단위로 병합한다.
    """
    rems_node = find_key(vuln_node, "Remediations")
    rems = ensure_list(find_key(rems_node, "Remediation") if rems_node else None)

    # pid -> {kb -> entry}
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

        # KB 번호 추출
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

    # pid -> list of entries
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


def get_target_os_name(product_name):
    """제품명에서 TARGET_OS 이름 반환."""
    for os_name in TARGET_OS:
        if os_name in product_name:
            return os_name
    return None


def build_os_pid_map(product_map):
    """ProductMap에서 TARGET_OS에 해당하는 ProductID -> OS이름 매핑을 구축한다.

    Returns:
        dict: {product_id: os_name}  (예: {"10816": "Windows Server 2016"})
    """
    os_pid_map = {}
    for pid, name in product_map.items():
        os_name = get_target_os_name(name)
        if os_name:
            os_pid_map[pid] = os_name
    return os_pid_map


def os_safe_name(os_name):
    """OS 이름을 파일명에 안전한 형태로 변환."""
    return os_name.replace(" ", "_")


def parse_document_notes(doc):
    """DocumentNotes에서 타입별 노트를 분리 추출."""
    notes_node = find_key(doc, "DocumentNotes")
    notes = ensure_list(find_key(notes_node, "Note") if notes_node else None)

    result = {
        "summary": "",
        "known_issues": "",
        "legal": "",
        "general": "",
    }

    for n in notes:
        if not isinstance(n, dict):
            continue
        note_type = n.get("@Type", "")
        note_title = n.get("@Title", "")
        note_text = text_of(n)

        if note_type == "Summary" or note_title == "Summary":
            result["summary"] = clean_html(note_text, 3000)
        elif "Known Issues" in (note_title or ""):
            result["known_issues"] = clean_html(note_text, 2000)
        elif note_type == "Legal Disclaimer":
            result["legal"] = clean_html(note_text, 500)
        elif note_type == "General":
            result["general"] = clean_html(note_text, 2000)

    return result


OUT_DIR = Path("windows_data")
MANIFEST_FILE = OUT_DIR / "manifest.json"


def load_manifest():
    """수집 이력 매니페스트를 로드한다."""
    if MANIFEST_FILE.exists():
        return json.loads(MANIFEST_FILE.read_text(encoding="utf-8"))
    return {}


def save_manifest(manifest):
    """수집 이력 매니페스트를 저장한다."""
    OUT_DIR.mkdir(exist_ok=True)
    MANIFEST_FILE.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")


def fetch_remote_update_dates():
    """MSRC /updates API에서 각 월별 CurrentReleaseDate를 조회한다.

    Returns:
        dict: {"2025-Oct": "2025-10-15T...", ...}
    """
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
    """날짜 문자열을 정규화하여 비교 가능하게 만든다. (Z, 밀리초, 타임존 차이 제거)"""
    if not date_str:
        return ""
    # 후행 Z 제거
    s = date_str.rstrip("Z")
    # 밀리초 제거 (.000 등)
    s = re.sub(r'\.\d+', '', s)
    # 타임존 오프셋 제거 (+00:00 등)
    s = re.sub(r'[+-]\d{2}:\d{2}$', '', s)
    return s


def needs_update(month_year, manifest, remote_dates):
    """해당 월의 데이터를 (재)수집해야 하는지 판단한다.

    수집이 필요한 경우:
      1. OS별 JSON 파일이 하나도 없는 경우
      2. 매니페스트에 기록이 없는 경우
      3. 원격 CurrentReleaseDate가 매니페스트 기록과 다른 경우 (Microsoft가 업데이트)
    """
    # OS별 파일이 하나라도 있는지 확인
    has_any = any(
        (OUT_DIR / f"MSU-{month_year}-{os_safe_name(os_name)}.json").exists()
        for os_name in TARGET_OS
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
            # OS별 파일 및 기존 통합 파일 삭제
            for os_name in TARGET_OS:
                f = OUT_DIR / f"MSU-{month_year}-{os_safe_name(os_name)}.json"
                if f.exists():
                    f.unlink()
            old_combined = OUT_DIR / f"MSU-{month_year}.json"
            if old_combined.exists():
                old_combined.unlink()
            del manifest[month_year]
            removed.append(month_year)
    return removed


def fetch_ms_update(month_year: str):
    """MSRC API에서 해당 월의 CVRF 데이터를 가져와 OS별 누적패치 JSON으로 저장한다.

    Returns:
        dict: {os_name: stats_dict} 또는 None (실패 시)
              current_release_date 키도 포함
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
    os_pid_map = build_os_pid_map(product_map)  # {pid: os_name}

    # === 2. 문서 메타 정보 ===
    tracking = find_key(doc, "DocumentTracking") or {}
    doc_notes = parse_document_notes(doc)
    current_release_date = text_of(find_key(tracking, "CurrentReleaseDate"))

    # === 3. OS별 advisory 초기화 ===
    os_advisories = {}
    for os_name in TARGET_OS:
        os_advisories[os_name] = {
            "id": f"MSU-{month_year}-{os_safe_name(os_name)}",
            "vendor": "Microsoft",
            "os": os_name,
            "month": month_year,
            "type": text_of(find_key(doc, "DocumentType")) or "Security Update",
            "title": text_of(find_key(doc, "DocumentTitle")),
            "initial_release_date": text_of(find_key(tracking, "InitialReleaseDate")),
            "current_release_date": current_release_date,
            "revision": text_of(find_key(tracking, "Version")),
            "url": url,
            "summary": doc_notes["summary"],
            "known_issues": doc_notes["known_issues"],
            "cumulative_update_kb": "",
            "cumulative_update_url": "",
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

    # === 4. 취약점 파싱 → OS별 분배 ===
    vulns = ensure_list(find_key(doc, "Vulnerability"))

    # 누적 KB 후보 카운트: {os_name: {kb: count}}
    kb_freq = {os_name: {} for os_name in TARGET_OS}

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

        # 이 CVE가 어떤 OS에 영향을 주는지, OS별로 분배
        for a in affected:
            os_name = get_target_os_name(a["product_name"])
            if not os_name:
                continue

            pid = a["product_id"]
            rem_list = rems_by_pid.get(pid, [])

            # 이 PID의 모든 KB를 OS의 kb_articles와 kb_freq에 반영
            for rem in rem_list:
                kb = rem.get("kb_number", "")
                if kb:
                    os_advisories[os_name]["kb_articles"].add(kb)
                    kb_freq[os_name][kb] = kb_freq[os_name].get(kb, 0) + 1

            # 해당 OS advisory에 이미 이 CVE가 있으면 건너뜀
            adv = os_advisories[os_name]
            if any(ve["cve"] == cve for ve in adv["vulnerabilities"]):
                continue

            # 대표 remediation: 첫 번째 Vendor Fix 엔트리 사용
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

            # 통계
            adv["stats"]["total_cves"] += 1
            if severity == "Critical":
                adv["stats"]["critical_count"] += 1
            elif severity == "Important":
                adv["stats"]["important_count"] += 1
            if is_exploited:
                adv["stats"]["actively_exploited_count"] += 1
            if cvss["max_base_score"] > adv["stats"]["max_cvss_base"]:
                adv["stats"]["max_cvss_base"] = cvss["max_base_score"]

    # === 5. 누적 KB 결정 ===
    OUT_DIR.mkdir(exist_ok=True)
    result = {"current_release_date": current_release_date}

    # 먼저 모든 OS의 누적 KB를 결정
    cu_kbs = {}
    for os_name in TARGET_OS:
        adv = os_advisories[os_name]
        if not adv["vulnerabilities"]:
            continue
        freq = kb_freq[os_name]
        if freq:
            # 동률 시 KB 번호가 큰 것(최신)을 선택
            max_count = max(freq.values())
            candidates = [kb for kb, cnt in freq.items() if cnt == max_count]
            cu_kb = max(candidates)  # 문자열 비교로 KB 번호 큰 것 선택
            cu_kbs[os_name] = cu_kb
            adv["cumulative_update_kb"] = cu_kb
            for ve in adv["vulnerabilities"]:
                if ve["kb_number"] == cu_kb and ve["kb_url"]:
                    adv["cumulative_update_url"] = ve["kb_url"]
                    break

    # === 6. cumulative_update_kb에서만 Known Issues 수집 ===
    # 전체 kb_articles 대신 누적 업데이트 KB 페이지만 스크래핑한다.
    # Microsoft KB 페이지는 현재 활성 이슈만 유지하므로 이전 달에 해결된 이슈가 섞이지 않는다.
    fetched_ki = {}  # {kb: [issues]}
    for os_name in TARGET_OS:
        adv = os_advisories[os_name]
        cu_kb = adv.get("cumulative_update_kb", "")
        if cu_kb and cu_kb not in fetched_ki:
            print(f"    Known Issues 수집: {cu_kb}...")
            fetched_ki[cu_kb] = fetch_kb_known_issues(cu_kb)

    # === 7. 저장 ===
    for os_name in TARGET_OS:
        adv = os_advisories[os_name]
        if not adv["vulnerabilities"]:
            continue

        # Known Issues: cumulative_update_kb 페이지에서만 수집
        # (전체 kb_articles 병합 시 이전 달 KB의 해결된 이슈가 섞이는 문제 방지)
        cu_kb = adv.get("cumulative_update_kb", "")
        merged_ki = []
        if cu_kb:
            for ki in fetched_ki.get(cu_kb, []):
                merged_ki.append({**ki, "source_kb": cu_kb})
        adv["known_issues"] = merged_ki

        # set -> sorted list
        adv["kb_articles"] = sorted(adv["kb_articles"])

        # CVSS 내림차순 정렬
        adv["vulnerabilities"].sort(key=lambda x: x["cvss_base_score"], reverse=True)

        # 저장
        safe = os_safe_name(os_name)
        outfile = OUT_DIR / f"MSU-{month_year}-{safe}.json"
        outfile.write_text(json.dumps(adv, ensure_ascii=False, indent=2), encoding="utf-8")

        stats = adv["stats"]
        ki_count = len(adv["known_issues"])
        result[os_name] = stats
        print(
            f"    {os_name}: {stats['total_cves']}개 CVE "
            f"(Critical: {stats['critical_count']}, "
            f"Exploited: {stats['actively_exploited_count']}, "
            f"KB: {adv['cumulative_update_kb']}, "
            f"Known Issues: {ki_count}건)"
        )

    return result


def main():
    months = get_last_6_months()
    print(f"수집 대상 기간: {months[0]} ~ {months[-1]}")
    print(f"대상 OS: {', '.join(TARGET_OS)}")
    print()

    # 1. 매니페스트 로드 및 원격 업데이트 날짜 조회
    manifest = load_manifest()
    print("원격 업데이트 목록 조회 중...")
    remote_dates = fetch_remote_update_dates()
    print()

    # 2. 범위 밖 오래된 데이터 정리
    removed = cleanup_old_months(manifest, set(months))
    if removed:
        print(f"범위 밖 데이터 정리: {', '.join(removed)}")
        print()

    # 3. 각 월별 incremental 수집
    fetched = 0
    skipped = 0
    os_totals = {os_name: {"cves": 0, "exploited": 0} for os_name in TARGET_OS}

    for m in months:
        update_needed, reason = needs_update(m, manifest, remote_dates)

        if not update_needed:
            # 기존 per-OS 파일에서 통계 로드
            for os_name in TARGET_OS:
                f = OUT_DIR / f"MSU-{m}-{os_safe_name(os_name)}.json"
                if f.exists():
                    existing = json.loads(f.read_text(encoding="utf-8"))
                    os_totals[os_name]["cves"] += existing["stats"]["total_cves"]
                    os_totals[os_name]["exploited"] += existing["stats"]["actively_exploited_count"]
            print(f"  {m}: 건너뜀 ({reason})")
            skipped += 1
            continue

        print(f"  {m}: 수집 중... ({reason})")
        result = fetch_ms_update(m)
        if result:
            manifest[m] = {
                "current_release_date": result["current_release_date"],
                "fetched_at": datetime.now().isoformat(),
            }
            for os_name in TARGET_OS:
                if os_name in result:
                    os_totals[os_name]["cves"] += result[os_name]["total_cves"]
                    os_totals[os_name]["exploited"] += result[os_name]["actively_exploited_count"]
            fetched += 1

    # 4. 매니페스트 저장
    save_manifest(manifest)

    # 5. OS별 요약 출력
    print()
    total_cves = sum(t["cves"] for t in os_totals.values())
    total_exploited = sum(t["exploited"] for t in os_totals.values())
    print(f"수집 완료 (신규/갱신: {fetched}, 건너뜀: {skipped})")
    for os_name in TARGET_OS:
        t = os_totals[os_name]
        print(f"  {os_name}: {t['cves']}개 CVE, 악용 중 {t['exploited']}개")


if __name__ == "__main__":
    main()
