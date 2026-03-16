import os
import json
import glob
import argparse
import uuid
import sqlite3
import re
from datetime import datetime, timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.expanduser("~/.openclaw/workspace/skills/patch-review/database/sqlserver/sql_data/")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "patches_for_llm_review_sqlserver.json")

def parse_date(date_str):
    if not date_str: return None
    try:
        return datetime.fromisoformat(date_str.replace('Z', '+00:00'))
    except:
        try:
            return datetime.strptime(date_str[:10], "%Y-%m-%d")
        except:
            return None

def preprocess():
    parser = argparse.ArgumentParser(description="SQL Server Preprocessing")
    parser.add_argument('--days', type=int, default=180, help="Days to look back (start of review window, default: 180 = 6 months ago)")
    parser.add_argument('--days_end', type=int, default=90, help="Days to end look-back (end of review window, default: 90 = 3 months ago)")
    args = parser.parse_args()

    now = datetime.now()
    cutoff_start = now - timedelta(days=args.days)
    cutoff_end = now - timedelta(days=args.days_end)
    print(f"[SQL-PREPROCESS] Review window: {cutoff_start.strftime('%Y-%m-%d')} ~ {cutoff_end.strftime('%Y-%m-%d')}")

    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "SQLU-*.json")))
    print(f"Found {len(json_files)} SQL Server JSON files")

    individual_patches = []

    for file_path in json_files:
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                data = json.load(f)

            release_date_raw = data.get('initial_release_date')
            pub_dt = parse_date(release_date_raw)

            # Filter by both date bounds
            if pub_dt:
                # Make pub_dt naive if it has tzinfo for comparison
                if pub_dt.tzinfo is not None:
                    pub_dt_naive = pub_dt.replace(tzinfo=None)
                else:
                    pub_dt_naive = pub_dt

                if pub_dt_naive < cutoff_start:
                    continue
                if pub_dt_naive > cutoff_end:
                    continue

            # Extract fields for AI
            vulnerabilities = data.get('vulnerabilities', [])
            vulnerabilities.sort(key=lambda x: x.get('cvss_base_score', 0), reverse=True)
            top_10_cves = vulnerabilities[:10]

            non_cve_fixes = data.get('non_cve_fixes', [])
            top_5_fixes = non_cve_fixes[:5]

            known_issues = data.get('known_issues', [])

            product = data.get('product', 'SQL Server')
            kb = data.get('cumulative_update_kb', 'Unknown')
            url = data.get('cumulative_update_url', '')
            date_str = pub_dt_naive.strftime('%Y-%m-%d') if pub_dt else data.get('month', '')
            important_count = data.get('stats', {}).get('important_count', 0)

            record = {
                'patch_id': data.get('id'),
                'vendor': 'SQL Server',
                'product': product,
                'month': data.get('month'),
                'os_version': 'Windows, Linux',
                'date': date_str,
                'component': 'SQL Server',
                'kb': kb,
                'url': url,
                'severity': 'Important' if important_count > 0 else 'Moderate',
                'top_10_cves': top_10_cves,
                'top_5_bug_fixes': top_5_fixes,
                'known_issues': known_issues,
                'important_count': important_count,
            }

            individual_patches.append(record)
        except Exception as e:
            print(f"Error processing {file_path}: {e}")

    print(f"Individual patches in window: {len(individual_patches)}")

    # Group by SQL Server version (product)
    version_groups = {}
    for patch in individual_patches:
        product = patch.get('product', 'SQL Server')
        if product not in version_groups:
            version_groups[product] = []
        version_groups[product].append(patch)

    # Build one group record per SQL Server version
    group_records = []
    for product, patches in version_groups.items():
        # Sort by date descending (most recent first)
        patches_sorted = sorted(patches, key=lambda p: p.get('date', ''), reverse=True)

        most_recent = patches_sorted[0]
        most_recent_kb = most_recent.get('kb', '')
        most_recent_date = most_recent.get('date', '')
        most_recent_url = most_recent.get('url', '')

        # Severity: Important if any patch in group has important_count > 0
        any_important = any(p.get('important_count', 0) > 0 for p in patches_sorted)
        group_severity = 'Important' if any_important else 'Moderate'

        # Build patches array
        patches_array = []
        for p in patches_sorted:
            patches_array.append({
                'patch_id': p['patch_id'],
                'kb': p.get('kb', ''),
                'date': p.get('date', ''),
                'severity': p.get('severity', 'Moderate'),
                'top_10_cves': p.get('top_10_cves', []),
                'top_5_bug_fixes': p.get('top_5_bug_fixes', []),
                'known_issues': p.get('known_issues', []),
            })

        group_patch_id = f"SQLS-GROUP-{product.replace(' ', '_')}"
        group_record = {
            'patch_id': group_patch_id,
            'vendor': 'SQL Server',
            'component': 'SQL Server',
            'os_version': 'Windows, Linux',
            'version': most_recent_kb,
            'issued_date': most_recent_date,
            'severity': group_severity,
            'url': most_recent_url,
            'review_window': f"{cutoff_start.strftime('%Y-%m-%d')} ~ {cutoff_end.strftime('%Y-%m-%d')}",
            'candidate_count': len(patches_sorted),
            'description': f"[Review Window: {len(patches_sorted)} monthly CUs for {product}]",
            'patches': patches_array,
        }
        group_records.append(group_record)
        print(f"  GROUP: {group_patch_id} ({len(patches_sorted)} CUs, severity={group_severity})")

    print(f"Final SQL Server Version Groups: {len(group_records)}")

    # Write to file
    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(group_records, f, indent=2, ensure_ascii=False)
    print(f"[SQL-PREPROCESS] Output written to {OUTPUT_FILE}")

    # DB Insertion (one record per version group)
    db_path = os.path.expanduser("~/patch-review-dashboard-v2/prisma/patch-review.db")
    if os.path.exists(db_path):
        try:
            conn = sqlite3.connect(db_path, timeout=20.0)
            cursor = conn.cursor()
            run_id = str(uuid.uuid4())
            inserted = 0

            # Delete old SQL Server preprocessed data for this vendor to refresh
            cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'SQL Server'")

            for g in group_records:
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    'SQL Server',
                    g['patch_id'],
                    g['os_version'],
                    g['component'],
                    g['version'],
                    g['severity'],
                    g['issued_date'],
                    g['description'],
                    g['url'],
                    False,
                    run_id
                ))
                inserted += 1

            conn.commit()
            conn.close()
            print(f"[DB SUCCESS] Inserted {inserted} SQL Server version groups into PreprocessedPatch")
        except Exception as e:
            print(f"[DB ERROR] SQLite insertion failed: {e}")

if __name__ == "__main__":
    preprocess()
