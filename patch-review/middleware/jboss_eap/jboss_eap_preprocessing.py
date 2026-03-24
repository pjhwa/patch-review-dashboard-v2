import re
import csv
import os
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
import glob
import argparse

# NOTE: This script preprocesses JBoss Enterprise Application Platform errata
# collected from Red Hat's errata portal (RHSA/RHBA files).
# Based on mariadb_preprocessing.py pattern.

# Configuration
DATA_DIR = "jboss_eap_data"
OUTPUT_FILE = "patches_for_llm_review_jboss_eap.json"
AUDIT_LOG_FILE = "dropped_patches_audit_jboss_eap.csv"


def parse_date(date_str):
    if not date_str:
        return "Unknown"
    date_str = date_str.strip()
    if "T" in date_str:
        return date_str[:10]
    return date_str[:10]


def extract_version_from_title(title):
    """Extract version string from JBoss EAP advisory title."""
    # EAP XP pattern: "EAP XP 5.0" or "EAP XP 4.0"
    m = re.search(r'EAP XP\s+(\d+\.\d+(?:\.\d+)?)', title, re.IGNORECASE)
    if m:
        return m.group(1)
    # Standard EAP version: "7.4.0", "8.0.0", "7.4 Update"
    m = re.search(r'(?:Platform|EAP)\s+(\d+\.\d+(?:\.\d+)?)', title, re.IGNORECASE)
    if m:
        return m.group(1)
    # Fallback: any version pattern
    m = re.search(r'\b(\d+\.\d+\.\d+)\b', title)
    if m:
        return m.group(1)
    return ''


def extract_component(title, patch_id):
    """Determine component from title and patch ID."""
    title_lower = title.lower()
    if 'eap xp' in title_lower:
        return 'jboss-eap-xp'
    return 'jboss-eap'


def preprocess_patches():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=180, help="Days to look back from today")
    args = parser.parse_args()

    cutoff_date = datetime.now() - timedelta(days=args.days)
    print(f"[PREPROCESS] Filtering patches issued after {cutoff_date.strftime('%Y-%m-%d')} ({args.days} days)")

    # Audit log setup
    audit_file = open(AUDIT_LOG_FILE, 'w', newline='', encoding='utf-8')
    audit_writer = csv.writer(audit_file)
    audit_writer.writerow(['ID', 'Vendor', 'Date', 'Drop_Reason', 'Severity', 'Overview'])

    json_files = []
    if os.path.isdir(DATA_DIR):
        json_files.extend(glob.glob(os.path.join(DATA_DIR, "*.json")))

    json_files = sorted(json_files)
    print(f"Found {len(json_files)} JSON files in {DATA_DIR}.")

    processed_list = []

    for json_path in json_files:
        try:
            with open(json_path, 'r', encoding='utf-8') as jf:
                data = json.load(jf)

            if not isinstance(data, dict):
                continue

            if os.path.basename(json_path) == 'metadata.json':
                continue

            patch_id = data.get('id', os.path.basename(json_path).replace('.json', ''))
            vendor = "JBoss EAP"

            # Use issuedDate for date filtering (not updatedDate/dateStr)
            date_raw = data.get('issuedDate', data.get('pubDate', data.get('dateStr', '')))
            date_str = parse_date(date_raw)
            title = data.get('title', '')
            severity = data.get('severity', '')

            # Text aggregation
            synp = data.get('overview', '').strip()
            desc = data.get('description', '').strip()

            parts = []
            if synp:
                parts.append(synp)
            if desc and desc != synp:
                parts.append(desc)
            summary = "\n\n".join(parts)
            if not summary:
                summary = title

            full_text = data.get('full_text', f"{title}\n\n{summary}")

            # --- DATE FILTERING ---
            try:
                if len(date_str) == 10:
                    pub_dt = datetime.strptime(date_str, "%Y-%m-%d")
                    if pub_dt < cutoff_date:
                        audit_writer.writerow([patch_id, vendor, date_str, 'Date Out of Range', severity, summary[:100]])
                        continue
            except Exception:
                pass

            # --- SECURITY RELEVANCE FILTERING ---
            # Include: all RHSA (security advisories) with CVEs
            # Include: RHBA (bug fix) only if they contain CVEs
            # Exclude: RHBA with no CVEs (pure bug fixes without security impact)
            # Exclude: RHEA (enhancement) with no CVEs (product updates without security content)
            cves = data.get('cves', [])
            advisory_type = data.get('type', '')
            is_security = 'Security Advisory' in advisory_type or patch_id.startswith('RHSA-')
            is_bugfix = 'Bug Fix' in advisory_type or patch_id.startswith('RHBA-')
            is_enhancement = 'Enhancement' in advisory_type or patch_id.startswith('RHEA-')

            if (is_bugfix or is_enhancement) and not cves:
                audit_writer.writerow([patch_id, vendor, date_str, 'Non-Security Advisory With No CVEs', severity, summary[:100]])
                continue

            # Exclude Low severity RHSA only if no CVEs at all
            if is_security and severity and severity.lower() == 'low' and not cves:
                audit_writer.writerow([patch_id, vendor, date_str, 'Low Severity No CVEs', severity, summary[:100]])
                continue

            # --- COMPONENT & VERSION ---
            component = extract_component(title, patch_id)
            version = extract_version_from_title(title)

            # Try to extract version from fixes descriptions
            if not version and isinstance(data.get('fixes'), list):
                for fix in data['fixes']:
                    fix_desc = fix.get('description', '')
                    m = re.search(r'(\d+\.\d+\.\d+)', fix_desc)
                    if m:
                        version = m.group(1)
                        break

            # Build cve_list string for description
            cve_list = ', '.join(cves[:5]) if cves else ''
            full_desc = full_text[:1500] + ('...' if len(full_text) > 1500 else '')
            if cve_list:
                full_desc = f"CVEs: {cve_list}\n\n{full_desc}"

            processed_list.append({
                'id': patch_id,
                'patch_id': patch_id,
                'vendor': vendor,
                'os_version': 'All',
                'date': date_str,
                'issued_date': date_str,
                'component': component,
                'version': version,
                'summary': summary[:500],
                'severity': severity,
                'cves': cves,
                'diff_content': full_desc,
                'description': full_desc,
                'ref_url': data.get('url', f"https://access.redhat.com/errata/{patch_id}"),
            })

        except Exception as e:
            print(f"Error reading {json_path}: {e}")

    # Sort by issued date descending
    processed_list.sort(key=lambda x: x['issued_date'], reverse=True)

    audit_file.close()

    print(f"Final JBoss EAP Candidates for LLM: {len(processed_list)}")

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
            cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'JBoss EAP'")
            for p in processed_list:
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    'JBoss EAP',
                    p.get('patch_id', 'Unknown'),
                    'All',
                    p.get('component', 'jboss-eap'),
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
