#!/usr/bin/env python3
import requests
import json
import os
import re
from datetime import datetime, timedelta, timezone
import sys

# ============== .env 로더 ==============
def load_dotenv(dotenv_path=".env"):
    if not os.path.exists(dotenv_path):
        print(f"⚠️  .env 파일이 없습니다.")
        return
    with open(dotenv_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip().strip("\"'")
                os.environ[key] = value
    print(f"✅ .env 파일 로드 완료")

load_dotenv()

# ============== 설정 ==============
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN")
CUTOFF_DAYS = 180
BASE_DIR = "ceph_data"
HEADERS = {"Accept": "application/vnd.github+json", "User-Agent": "Ceph-Patch-Downloader"}
if GITHUB_TOKEN:
    HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"

os.makedirs(BASE_DIR, exist_ok=True)   # 루트만 생성

def clean_text(text):
    if not text:
        return ""
    text = re.sub(r'<pre>.*?</pre>', '', text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r'\{[\s\S]*?\}', '', text, flags=re.DOTALL)
    lines = text.splitlines()
    cleaned = []
    skip_patterns = [
        'smb.smb1', 'ceph orch', 'ceph smb', 'ceph fs subvolume', 'smbclient', 'mount.cifs',
        'ping ', 'tree connect', 'Sharename', 'IPC$', 'Digest:', 'Status: Image', 'quay.ceph.io',
        'NAME                            HOST', 'crash.', 'mgr.', 'osd.', 'mon.', 'rgw.', 'data:',
        'pgs:', 'Module .* has failed dependency', 'cluster:', 'services:', 'objects:', 'usage:',
        'rtt min/avg/max', 'packets transmitted', 'results":', 'resource":', 'success":',
        'login_control', 'restrict_access'
    ]
    for line in lines:
        stripped = line.strip()
        if not stripped: continue
        lower = stripped.lower()
        if any(p.lower() in lower for p in skip_patterns): continue
        if re.match(r'^\s*[\[\#\$]', stripped) or re.match(r'^\s*\[.*@\w+', stripped): continue
        if re.search(r'^\s*\{|\}\s*$|":\s*["{]', stripped): continue
        cleaned.append(stripped)
    return '\n'.join(cleaned).strip()

def fetch_paginated_github(url_base):
    items = []
    page = 1
    while True:
        url = f"{url_base}?per_page=100&page={page}"
        resp = requests.get(url, headers=HEADERS)
        if resp.status_code == 403 and "rate limit" in resp.text.lower():
            print("❌ Rate limit 초과!")
            sys.exit(1)
        if resp.status_code != 200:
            print(f"❌ GitHub API 오류: {resp.status_code}")
            sys.exit(1)
        data = resp.json()
        if not isinstance(data, list) or len(data) == 0:
            break
        items.extend(data)
        print(f"✅ GitHub 페이지 {page} 수집 완료 ({len(data)}개)")
        if len(data) < 100: break
        page += 1
    return items

def normalize_to_rhsa(raw, source_type):
    if source_type == "security":
        adv = raw
        desc = clean_text(adv.get("description", ""))
        return {
            "id": adv.get("ghsa_id"),
            "vendor": "Ceph Community",
            "type": "Security Advisory (GHSA)",
            "title": adv.get("summary", ""),
            "issuedDate": adv.get("published_at"),
            "updatedDate": adv.get("updated_at"),
            "pubDate": adv.get("published_at"),
            "dateStr": adv.get("published_at", "")[:10] if adv.get("published_at") else "",
            "url": adv.get("html_url"),
            "severity": adv.get("severity", "Unknown"),
            "overview": adv.get("summary", ""),
            "description": desc,
            "cves": [v.get("cve_id") for v in adv.get("vulnerabilities", []) if v.get("cve_id")],
            "packages": [],
            "full_text": desc,
            "applied_releases": ["main"],
            "source": "github_security"
        }
    elif source_type == "release":
        rel = raw
        desc = clean_text(rel.get("body", ""))
        tag = rel.get("tag_name", "")
        return {
            "id": tag,
            "vendor": "Ceph Community",
            "type": "Release Patch",
            "title": rel.get("name", tag),
            "issuedDate": rel.get("published_at"),
            "updatedDate": rel.get("published_at"),
            "pubDate": rel.get("published_at"),
            "dateStr": rel.get("published_at", "")[:10] if rel.get("published_at") else "",
            "url": rel.get("html_url"),
            "severity": "Medium",
            "overview": f"Ceph {tag} release",
            "description": desc,
            "cves": [],
            "packages": [],
            "full_text": desc,
            "applied_releases": [tag],
            "source": "github_release"
        }
    elif source_type == "tracker":
        issue = raw
        raw_desc = issue.get("description", "") or ""
        desc = clean_text(raw_desc)
        
        applied = ["main"]
        for cf in issue.get("custom_fields", []):
            name = cf.get("name", "")
            value = cf.get("value")
            if name in ["Fixed In", "Released In", "Backport"] and value and str(value).strip():
                applied.append(str(value).strip())
        
        for rel in issue.get("relations", []):
            to_issue = rel.get("issue_to", {})
            subj = to_issue.get("subject", "").lower()
            version_match = re.search(r'(squid|reef|tentacle|quincy|pacific|octopus|nautilus)\s*(\d+\.\d+\.?\d*)', subj)
            if version_match:
                branch = version_match.group(1).capitalize()
                ver = version_match.group(2)
                applied.append(f"{branch} {ver}")
            elif any(v in subj for v in ["squid", "reef", "tentacle", "quincy", "pacific", "octopus", "nautilus"]):
                for v in ["squid", "reef", "tentacle", "quincy", "pacific", "octopus", "nautilus"]:
                    if v in subj:
                        applied.append(v.capitalize())
                        break
        
        return {
            "id": f"REDMINE-{issue.get('id')}",
            "vendor": "Ceph Community",
            "type": "Bug Fix (Resolved + Backport)",
            "title": issue.get("subject", ""),
            "issuedDate": issue.get("created_on"),
            "updatedDate": issue.get("updated_on"),
            "pubDate": issue.get("updated_on"),
            "dateStr": issue.get("updated_on", "")[:10] if issue.get("updated_on") else "",
            "url": f"https://tracker.ceph.com/issues/{issue.get('id')}",
            "severity": issue.get("priority", {}).get("name", "Unknown"),
            "overview": issue.get("subject", ""),
            "description": desc,
            "cves": [word for word in desc.split() if word.upper().startswith("CVE-")],
            "packages": [],
            "full_text": desc,
            "applied_releases": list(dict.fromkeys(applied)),
            "source": "redmine_resolved"
        }

print("🚀 Ceph Patch Collector (모든 개별 JSON → ./ceph_data/ 루트 저장) 시작\n")

# ==================== GitHub Security ====================
print("🔄 [GitHub Security] 수집 중...")
security_all = fetch_paginated_github("https://api.github.com/repos/ceph/ceph/security-advisories")

# ==================== GitHub Releases ====================
print("🔄 [GitHub Releases] 수집 중...")
releases_all = fetch_paginated_github("https://api.github.com/repos/ceph/ceph/releases")
cutoff_date = datetime.now(timezone.utc) - timedelta(days=CUTOFF_DAYS)
releases_recent = [
    rel for rel in releases_all
    if rel.get("published_at") and datetime.fromisoformat(rel["published_at"].replace("Z", "+00:00")) >= cutoff_date
]

# ==================== Redmine Resolved + relations ====================
print("🔄 [Redmine] Resolved + relations 파싱 중...")
cutoff_str = cutoff_date.strftime("%Y-%m-%d")
REDMINE_URL = "https://tracker.ceph.com/issues.json"
params = {
    "project_id": "ceph",
    "tracker_id": 1,
    "status_id": 5,
    "updated_on": f">={cutoff_str}",
    "sort": "updated_on:desc",
    "limit": 100,
    "include": "relations"
}

redmine_issues = []
page = 1
while True:
    resp = requests.get(REDMINE_URL, params={**params, "page": page}, timeout=15)
    if resp.status_code != 200:
        print(f"❌ Redmine 오류: {resp.status_code}")
        break
    data = resp.json()
    issues = data.get("issues", [])
    if not issues: break
    redmine_issues.extend(issues)
    print(f"✅ Redmine 페이지 {page} 수집 완료 ({len(issues)}개)")
    if len(issues) < 100: break
    page += 1

# ==================== 정규화 및 루트 저장 ====================
print("\n🔄 모든 패치를 ./ceph_data/ 루트에 저장 중...")

def save_to_root(items, source_type):
    new_count = 0
    for item in items:
        norm = normalize_to_rhsa(item, source_type)
        filename = f"{norm['id']}.json"
        filepath = f"{BASE_DIR}/{filename}"
        
        if os.path.exists(filepath):
            continue
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(norm, f, ensure_ascii=False, indent=2)
        new_count += 1
    print(f"✅ {source_type} 개별 파일 저장 완료: 신규 {new_count}개 (루트에 저장)")

save_to_root(security_all, "security")
save_to_root(releases_recent, "release")
save_to_root(redmine_issues, "tracker")

print(f"\n🎉 모든 작업 완료!")
print(f"   • 모든 패치ID별 JSON → ./ceph_data/ 루트에 저장")
print(f"   • normalized, security, releases, tracker 폴더 완전 삭제")
print(f"   • 확인 명령어: ls ceph_data/*.json")
