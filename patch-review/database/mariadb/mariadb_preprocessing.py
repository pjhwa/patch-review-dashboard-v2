import re
import csv
import os
import json
import sqlite3
import uuid
from datetime import datetime, timedelta
import glob
import argparse

# NOTE: This script is based on ceph_preprocessing.py and patch_preprocessing.py
# It performs the mechanical PRE-PROCESSING (Collection, Pruning, Aggregation) 
# for MariaDB database patches to prepare a dataset for the AI Agent.

# Configuration
DATA_DIR = "mariadb_data"
OUTPUT_FILE = "patches_for_llm_review_mariadb.json"
AUDIT_LOG_FILE = "dropped_patches_audit_mariadb.csv"

def parse_date(date_str):
    if not date_str: return "Unknown"
    date_str = date_str.strip()
    if "T" in date_str: return date_str[:10]
    return date_str[:10]

def extract_diff_content(text):
    return text[:500] + "..." if len(text) > 500 else text

def preprocess_patches():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=180, help="Days to look back")
    args = parser.parse_args()
    
    cutoff_date = datetime.now() - timedelta(days=args.days)
    print(f"[PREPROCESS] Filtering patches strictly newer than {cutoff_date.strftime('%Y-%m-%d')} ({args.days} days)")
    
    # Audit log setup
    audit_writer = None
    audit_file = open(AUDIT_LOG_FILE, 'w', newline='', encoding='utf-8')
    audit_writer = csv.writer(audit_file)
    audit_writer.writerow(['ID', 'Vendor', 'Date', 'Drop_Reason', 'Severity', 'Overview'])
    
    json_files = []
    if os.path.isdir(DATA_DIR):
        json_files.extend(glob.glob(os.path.join(DATA_DIR, "*.json")))
    
    # Sorting to ensure determinism
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
            vendor = "MariaDB" # Force vendor context
            
            date_raw = data.get('pubDate', data.get('dateStr', data.get('issuedDate', '')))
            date_str = parse_date(date_raw)
            title = data.get('title', '')
            severity = data.get('severity', '')
            
            # Text aggregation
            synp = data.get('overview', '').strip()
            desc = data.get('description', '').strip()
            
            parts = []
            if synp: parts.append(synp)
            if desc and desc != synp: parts.append(desc)
            summary = "\n\n".join(parts)
            if not summary: summary = title
            
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
            
            # --- SEVERITY FILTERING ---
            # MariaDB typically uses Critical, Important, Moderate, Low. We want Critical/Important/None (for enhancements)
            if severity:
                sev_lower = severity.lower()
                if "moderate" in sev_lower or "low" in sev_lower:
                    audit_writer.writerow([patch_id, vendor, date_str, 'Severity Under Threshold', severity, summary[:100]])
                    continue
                    
            # Component logic
            component = data.get("component") or "mariadb"
            if isinstance(data.get("packages"), list) and data["packages"]:
                pkgs = sorted(list(set(data["packages"])))
                if any("galera" in p.lower() for p in pkgs):
                    component = "mariadb-galera"
            
            version = data.get('mariadbVersion') or data.get('version', '')
            # Extract version from package if not set
            if not version and isinstance(data.get("packages"), list) and data["packages"]:
                for pkg in data["packages"]:
                    m = re.search(r'mariadb[:_.-](\d+\.\d+\.\d+)', str(pkg))
                    if m:
                        version = m.group(1)
                        break

            diff_content = extract_diff_content(full_text)
            # --- ENVIRONMENT FILTERING ---
            affected_prods = data.get('affected_products', [])
            os_version_val = "All"
            
            valid_envs = [
                "Red Hat Enterprise Linux AppStream (v. 8)",
                "Red Hat Enterprise Linux AppStream (v. 9)",
                "Red Hat Enterprise Linux AppStream (v. 10)"
            ]
            
            # Check if any of the valid environments are in the affected products
            has_valid_env = False
            if isinstance(affected_prods, list):
                for prod in affected_prods:
                    if str(prod) in valid_envs:
                        has_valid_env = True
                        break
                
                if not has_valid_env and affected_prods:
                    audit_writer.writerow([patch_id, vendor, date_str, 'Missing Specific AppStream Env', severity, summary[:100]])
                    continue
                    
                os_version_val = ", ".join(sorted(set([str(p) for p in affected_prods if str(p) in valid_envs])))
                if not os_version_val:
                    os_version_val = "All"
            
            processed_list.append({
                'id': patch_id,
                'patch_id': patch_id,
                'vendor': vendor,
                'os_version': os_version_val,
                'date': date_str,
                'issued_date': date_str,
                'component': component,
                'version': version,
                'summary': summary,
                'severity': severity,
                'diff_content': diff_content, 
                'description': desc if desc else full_text,
                'ref_url': data.get('url', f"https://access.redhat.com/errata/{patch_id}")
            })
            
        except Exception as e:
            print(f"Error reading {json_path}: {e}")

    # Aggregation & sorting
    processed_list.sort(key=lambda x: x['id'], reverse=True)
    
    audit_file.close()

    print(f"Final MariaDB Candidates for LLM: {len(processed_list)}")
    
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
            cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'MariaDB'")
            for p in processed_list:
                cursor.execute('''
                    INSERT INTO PreprocessedPatch
                      (id, vendor, issueId, osVersion, component, version, severity, releaseDate, description, url, isReviewed, pipelineRunId, collectedAt)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                ''', (
                    str(uuid.uuid4()),
                    'MariaDB',
                    p.get('patch_id', 'Unknown'),
                    p.get('os_version', '') or 'Unknown',
                    p.get('component', 'mariadb'),
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
