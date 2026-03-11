import xml.etree.ElementTree as ET
import gzip
import json
import datetime
import os
import sys

def parse_updateinfo(updateinfo_gz, ol_version, kernel_type, repo_type, days_ago=90):
    try:
        with gzip.open(updateinfo_gz, 'rb') as f:
            tree = ET.parse(f)
        root = tree.getroot()
    except Exception as e:
        print(f"   ❌ 파싱 실패 (파일 손상 또는 없음): {e}")
        return

    today = datetime.datetime.now()
    cutoff = today - datetime.timedelta(days=days_ago)
    count_new = 0

    for update in root.findall('update'):
        advisory_id = update.findtext('id')
        if not advisory_id: continue

        issued_elem = update.find('issued')
        issued_str = issued_elem.get('date') if issued_elem is not None else "2000-01-01"
        try:
            issued_date = datetime.datetime.strptime(issued_str, '%Y-%m-%d %H:%M:%S')
        except ValueError:
            try:
                issued_date = datetime.datetime.fromisoformat(issued_str.replace('Z', '+00:00')).replace(tzinfo=None)
            except:
                continue

        if issued_date < cutoff: continue

        filename = f"oracle_data/{advisory_id}.json"
        if os.path.exists(filename): continue

        is_security = update.get('type') == "security"
        full_type = "Security Advisory (ELSA)" if is_security else "Bug Fix Advisory (ELBA)"

        title = update.findtext('title', '')
        severity = update.findtext('severity') or "None"
        description = update.findtext('description', '').strip()
        issued_iso = issued_date.strftime("%Y-%m-%dT%H:%M:%SZ")

        references = [ref.get('href') for ref in update.findall('.//reference') if ref.get('href')]
        cves = [ref.get('id') for ref in update.findall('.//reference') if ref.get('id','').startswith('CVE-')]

        packages = []
        for pkg in update.findall('.//pkglist/collection/package'):
            name = pkg.get('name','')
            ver = pkg.get('version','')
            rel = pkg.get('release','')
            arch = pkg.get('arch','')
            if name and ver:
                full_pkg = f"{name}-{ver}"
                if rel: full_pkg += f"-{rel}"
                if arch: full_pkg += f".{arch}"
                packages.append(full_pkg)

        data = {
            "id": advisory_id,
            "vendor": "Oracle",
            "type": full_type,
            "kernel_type": kernel_type,
            "title": title,
            "issuedDate": issued_iso,
            "updatedDate": issued_iso,
            "pubDate": issued_iso,
            "dateStr": issued_date.strftime("%Y-%m-%d"),
            "url": f"https://linux.oracle.com/errata/{advisory_id}.html",
            "severity": severity,
            "overview": f"An update for Oracle Linux is now available for Oracle Linux {ol_version}.",
            "description": description,
            "affected_products": [f"Oracle Linux {ol_version} for x86_64", f"Oracle Linux {ol_version} for aarch64"],
            "cves": cves,
            "packages": packages,
            "full_text": description + "\n\nReferences:\n" + "\n".join(references)
        }

        with open(filename, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        count_new += 1
        print(f"   ✅ 생성 ({repo_type}): {filename}")

    print(f"   🎉 {ol_version} {repo_type} 완료! 신규 {count_new}개 추가")

if __name__ == "__main__":
    if len(sys.argv) < 5:
        print("Usage: python oracle_parser.py <updateinfo_gz> <ol_version> <kernel_type> <repo_type> [days]")
        sys.exit(1)
    days = int(sys.argv[5]) if len(sys.argv) > 5 else 90
    parse_updateinfo(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], days)
