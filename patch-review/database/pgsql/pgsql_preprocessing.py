import csv
import os
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
import glob
import argparse

# NOTE: Preprocesses PostgreSQL patch data files (PGSL-*.json) for AI review.
# Each file represents one PostgreSQL version's monthly release.

DATA_DIR = "pgsql_data"
OUTPUT_FILE = "patches_for_llm_review_pgsql.json"
AUDIT_LOG_FILE = "dropped_patches_audit_pgsql.csv"

def parse_date(date_str):
    if not date_str:
        return "Unknown"
    date_str = date_str.strip()
    if "T" in date_str:
        return date_str[:10]
    return date_str[:10]

def determine_severity(stats):
    """Determine overall severity from stats."""
    if stats.get('critical_count', 0) > 0:
        return 'Critical'
    if stats.get('high_count', 0) > 0:
        return 'High'
    if stats.get('medium_count', 0) > 0:
        return 'Medium'
    return 'Low'

def build_description(data):
    """Build a concise description from vulnerabilities and key non-CVE fixes."""
    parts = []

    vulns = data.get('vulnerabilities', [])
    high_vulns = [v for v in vulns if v.get('severity', '').lower() in ('critical', 'high')]
    other_vulns = [v for v in vulns if v.get('severity', '').lower() not in ('critical', 'high')]

    if high_vulns:
        parts.append("=== Critical/High CVEs ===")
        for v in high_vulns:
            cve = v.get('cve', '')
            title = v.get('title', '')
            desc = v.get('description', '')
            score = v.get('cvss_base_score', '')
            parts.append(f"[{cve}] (CVSS {score}) {title}: {desc[:300]}")

    if other_vulns:
        parts.append("=== Other CVEs ===")
        for v in other_vulns:
            cve = v.get('cve', '')
            title = v.get('title', '')
            score = v.get('cvss_base_score', '')
            parts.append(f"[{cve}] (CVSS {score}) {title}")

    non_cve = data.get('non_cve_fixes', [])
    high_noncve = [f for f in non_cve if f.get('severity', '').lower() in ('critical', 'high')]
    if high_noncve:
        parts.append("=== High-severity Bug Fixes ===")
        for f in high_noncve[:5]:
            desc = f.get('description', '')
            detail = f.get('detail', '')
            text = desc
            if detail:
                text += f" — {detail[:200]}"
            parts.append(f"- {text[:400]}")

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

    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "PGSL-*.json")))
    print(f"Found {len(json_files)} JSON files in {DATA_DIR}.")

    processed_list = []

    for json_path in json_files:
        try:
            with open(json_path, 'r', encoding='utf-8') as jf:
                data = json.load(jf)

            if not isinstance(data, dict):
                continue

            patch_id = data.get('id', os.path.basename(json_path).replace('.json', ''))
            vendor = "PostgreSQL"

            date_str = parse_date(data.get('release_date', ''))
            product = data.get('product', '')
            release_version = data.get('release_version', '')
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

            severity = determine_severity(stats)

            # --- SEVERITY FILTERING: skip Low-only releases ---
            total_cves = stats.get('total_cves', 0)
            if total_cves == 0 and severity == 'Low':
                audit_writer.writerow([patch_id, vendor, date_str, 'No CVEs and Low severity', severity, product])
                continue

            description = build_description(data)
            summary = (f"{product} {release_version} — {data.get('type', 'Security Update')} "
                       f"({stats.get('total_cves', 0)} CVEs, max CVSS {stats.get('max_cvss_base', 'N/A')})")

            processed_list.append({
                'id': patch_id,
                'patch_id': patch_id,
                'vendor': vendor,
                'os_version': 'All',
                'date': date_str,
                'issued_date': date_str,
                'component': 'postgresql-server',
                'version': release_version,
                'product': product,
                'summary': summary,
                'severity': severity,
                'description': description,
                'ref_url': data.get('release_url', 'https://www.postgresql.org/support/security/'),
                'stats': stats,
            })

        except Exception as e:
            print(f"Error reading {json_path}: {e}")

    processed_list.sort(key=lambda x: x['patch_id'], reverse=True)

    audit_file.close()

    print(f"Final PostgreSQL Candidates for LLM: {len(processed_list)}")

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
            cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'PostgreSQL'")
            for p in processed_list:
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    'PostgreSQL',
                    p.get('patch_id', 'Unknown'),
                    'All',
                    'postgresql-server',
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
