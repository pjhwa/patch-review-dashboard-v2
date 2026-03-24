import csv
import os
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
import glob
import argparse

# NOTE: Preprocesses Apache Tomcat security patch data files (TOMC-*.json) for AI review.
# Each file represents one Tomcat major version's monthly security advisory.

DATA_DIR = "tomcat_data"
OUTPUT_FILE = "patches_for_llm_review_tomcat.json"
AUDIT_LOG_FILE = "dropped_patches_audit_tomcat.csv"


def parse_date(date_str):
    if not date_str:
        return "Unknown"
    date_str = date_str.strip()
    if "T" in date_str:
        return date_str[:10]
    return date_str[:10]


def determine_severity(stats):
    if stats.get('critical_count', 0) > 0:
        return 'Critical'
    if stats.get('high_count', 0) > 0:
        return 'High'
    if stats.get('medium_count', 0) > 0:
        return 'Medium'
    return 'Low'


def build_description(data):
    parts = []

    vulns = data.get('vulnerabilities', [])
    high_vulns = [v for v in vulns if v.get('severity', '').lower() in ('critical', 'high')]
    other_vulns = [v for v in vulns if v.get('severity', '').lower() not in ('critical', 'high')]

    if high_vulns:
        parts.append("=== Critical/High CVEs ===")
        for v in high_vulns:
            cve = v.get('cve', '')
            desc = v.get('description', '')
            score = v.get('cvss_base_score', '')
            affected = v.get('affected_versions', '')
            fixed = v.get('fixed_in_version', '')
            line = f"[{cve}] (CVSS {score}) {desc[:300]}"
            if affected:
                line += f" | Affects: {affected}"
            if fixed:
                line += f" | Fixed in: {fixed}"
            parts.append(line)

    if other_vulns:
        parts.append("=== Other CVEs ===")
        for v in other_vulns:
            cve = v.get('cve', '')
            score = v.get('cvss_base_score', '')
            desc = v.get('description', '')
            parts.append(f"[{cve}] (CVSS {score}) {desc[:200]}")

    if not parts:
        parts.append(data.get('type', 'Security Update'))

    return "\n".join(parts)


def preprocess_patches():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=180, help="Days to look back")
    args = parser.parse_args()

    cutoff_date = datetime.now() - timedelta(days=args.days)
    print(f"[PREPROCESS] Filtering patches newer than {cutoff_date.strftime('%Y-%m-%d')} ({args.days} days)")

    audit_file = open(AUDIT_LOG_FILE, 'w', newline='', encoding='utf-8')
    audit_writer = csv.writer(audit_file)
    audit_writer.writerow(['ID', 'Vendor', 'Date', 'Drop_Reason', 'Severity', 'Overview'])

    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "TOMC-*.json")))
    print(f"Found {len(json_files)} JSON files in {DATA_DIR}.")

    processed_list = []

    for json_path in json_files:
        try:
            with open(json_path, 'r', encoding='utf-8') as jf:
                data = json.load(jf)

            if not isinstance(data, dict):
                continue

            patch_id = data.get('id', os.path.basename(json_path).replace('.json', ''))
            vendor = "Apache Tomcat"

            date_str = parse_date(data.get('release_date', ''))
            product = data.get('product', '')
            fixed_version = data.get('fixed_version', '')
            stats = data.get('stats', {})

            # --- DATE FILTERING ---
            try:
                if len(date_str) == 10:
                    pub_dt = datetime.strptime(date_str, "%Y-%m-%d")
                    if pub_dt < cutoff_date:
                        audit_writer.writerow([patch_id, vendor, date_str, 'Date Out of Range', '', product])
                        continue
            except Exception:
                pass

            # Skip files with no vulnerabilities
            total_cves = stats.get('total_cves', 0)
            if total_cves == 0:
                audit_writer.writerow([patch_id, vendor, date_str, 'No CVEs', 'Low', product])
                continue

            severity = determine_severity(stats)
            description = build_description(data)
            summary = (f"{product} {fixed_version} — {data.get('type', 'Security Update')} "
                       f"({total_cves} CVEs, max CVSS {stats.get('max_cvss_base', 'N/A')})")

            processed_list.append({
                'id': patch_id,
                'patch_id': patch_id,
                'vendor': vendor,
                'os_version': 'All',
                'date': date_str,
                'issued_date': date_str,
                'component': 'tomcat',
                'version': fixed_version,
                'product': product,
                'summary': summary,
                'severity': severity,
                'description': description,
                'ref_url': data.get('release_url', 'https://tomcat.apache.org/security.html'),
                'stats': stats,
            })

        except Exception as e:
            print(f"Error reading {json_path}: {e}")

    processed_list.sort(key=lambda x: x['patch_id'], reverse=True)
    audit_file.close()

    print(f"Final Apache Tomcat Candidates for LLM: {len(processed_list)}")

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(processed_list, f, indent=2, ensure_ascii=False)

    print(f"Saved review packet to {OUTPUT_FILE}")
    print(f"Audit log saved to {AUDIT_LOG_FILE}")

    # --- Save to SQLite Database (for immediate dashboard count display) ---
    db_path = os.path.expanduser("~/patch-review-dashboard-v2/prisma/patch-review.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path, timeout=20.0)
            cursor = conn.cursor()
            run_id = str(uuid.uuid4())
            cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'Apache Tomcat'")
            for p in processed_list:
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    'Apache Tomcat',
                    p.get('patch_id', 'Unknown'),
                    'All',
                    'tomcat',
                    p.get('version', '') or 'Unknown',
                    p.get('severity', ''),
                    p.get('date', ''),
                    p.get('summary', ''),
                    p.get('ref_url', ''),
                    False,
                    run_id
                ))
            conn.commit()
            conn.close()
            print(f"[DB] Saved {len(processed_list)} preprocessed patches to SQLite.")
        except Exception as e:
            print(f"[DB WARNING] Failed to save to SQLite: {e}")


if __name__ == "__main__":
    preprocess_patches()
