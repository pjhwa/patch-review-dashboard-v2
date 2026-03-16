import csv
import os
import json
from datetime import datetime, timedelta
import glob
import argparse

# NOTE: Preprocesses VMware vSphere patch data files (VSPH-*.json) for AI review.
# Two types of files:
#   - security_advisory: VMSA advisories with CVEs
#   - update_release: Build/Update releases with bug fixes

DATA_DIR = "vsphere_data"
OUTPUT_FILE = "patches_for_llm_review_vsphere.json"
AUDIT_LOG_FILE = "dropped_patches_audit_vsphere.csv"

def parse_date(date_str):
    if not date_str:
        return "Unknown"
    date_str = date_str.strip()
    if "T" in date_str:
        return date_str[:10]
    return date_str[:10]

def determine_severity(data):
    """Determine overall severity from stats or advisory_severity."""
    # For security advisories
    advisory_severity = data.get('advisory_severity', '')
    if advisory_severity:
        adv_lower = advisory_severity.lower()
        if adv_lower in ('critical',):
            return 'Critical'
        if adv_lower in ('high',):
            return 'High'
        if adv_lower in ('moderate', 'medium'):
            return 'Medium'

    # From stats
    stats = data.get('stats', {})
    if stats.get('critical_count', 0) > 0:
        return 'Critical'
    if stats.get('high_count', 0) > 0:
        return 'High'
    if stats.get('medium_count', 0) > 0:
        return 'Medium'
    return 'Low'

def build_description(data):
    """Build a concise description for AI review."""
    parts = []
    patch_type = data.get('type', '')

    if patch_type == 'security_advisory':
        title = data.get('title', '')
        if title:
            parts.append(f"[SECURITY ADVISORY] {title}")

        vulns = data.get('vulnerabilities', [])
        high_vulns = [v for v in vulns if v.get('severity', '').lower() in ('critical', 'high')]
        other_vulns = [v for v in vulns if v.get('severity', '').lower() not in ('critical', 'high')]

        if high_vulns:
            parts.append("=== Critical/High CVEs ===")
            for v in high_vulns:
                cve = v.get('cve', '')
                title_v = v.get('title', '')
                desc = v.get('description', '')
                score = v.get('cvss_base_score', '')
                exploited = v.get('is_actively_exploited', False)
                exploit_note = " [ACTIVELY EXPLOITED]" if exploited else ""
                parts.append(f"[{cve}] (CVSS {score}){exploit_note} {title_v}: {desc[:300]}")

        if other_vulns:
            parts.append("=== Other CVEs ===")
            for v in other_vulns:
                cve = v.get('cve', '')
                score = v.get('cvss_base_score', '')
                title_v = v.get('title', '')
                parts.append(f"[{cve}] (CVSS {score}) {title_v}")

        required_version = data.get('required_version', '')
        if required_version:
            parts.append(f"Required version: {required_version}")

        workaround = data.get('workaround_available', False)
        parts.append(f"Workaround available: {'Yes' if workaround else 'No'}")

    elif patch_type == 'update_release':
        version = data.get('version', '')
        build = data.get('build', '')
        if version:
            parts.append(f"[UPDATE RELEASE] {version} (Build {build})")

        # Included VMSA fixes
        vmsa_fixes = data.get('included_vmsa_fixes', [])
        if vmsa_fixes:
            parts.append(f"=== Included VMSA Security Fixes ({len(vmsa_fixes)}) ===")
            for fix in vmsa_fixes[:5]:
                parts.append(f"- {fix}")

        # Non-CVE fixes
        non_cve = data.get('non_cve_fixes', [])
        high_noncve = [f for f in non_cve if f.get('severity', '').lower() in ('critical', 'high')]
        other_noncve = [f for f in non_cve if f.get('severity', '').lower() not in ('critical', 'high')]

        if high_noncve:
            parts.append("=== High-severity Bug Fixes ===")
            for f in high_noncve[:5]:
                desc = f.get('description', '')
                sev = f.get('severity', '')
                parts.append(f"[{sev}] {desc[:400]}")

        if other_noncve:
            parts.append(f"=== Other Bug Fixes ({len(other_noncve)} total) ===")
            for f in other_noncve[:3]:
                desc = f.get('description', '')
                parts.append(f"- {desc[:300]}")

    if not parts:
        parts.append(data.get('type', 'VMware Update'))

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

    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "VSPH-*.json")))
    print(f"Found {len(json_files)} JSON files in {DATA_DIR}.")

    processed_list = []

    for json_path in json_files:
        try:
            with open(json_path, 'r', encoding='utf-8') as jf:
                data = json.load(jf)

            if not isinstance(data, dict):
                continue

            patch_id = data.get('id', os.path.basename(json_path).replace('.json', ''))
            vendor = data.get('vendor', 'VMware (Broadcom)')
            product = data.get('product', 'vSphere')
            major_version = data.get('major_version', '')
            patch_type = data.get('type', '')

            # Date field depends on type
            if patch_type == 'security_advisory':
                raw_date = data.get('published', '')
            else:
                raw_date = data.get('release_date', data.get('month', ''))

            patch_date = parse_date(raw_date)

            # Date filter
            if patch_date != 'Unknown':
                try:
                    pd = datetime.strptime(patch_date[:10], '%Y-%m-%d')
                    if pd < cutoff_date:
                        audit_writer.writerow([patch_id, vendor, patch_date, f'TOO_OLD (cutoff={cutoff_date.strftime("%Y-%m-%d")})', '', ''])
                        continue
                except ValueError:
                    pass

            severity = determine_severity(data)
            description = build_description(data)

            # URL
            if patch_type == 'security_advisory':
                url = data.get('vmsa_url', '')
            else:
                url = data.get('release_notes_url', '')

            stats = data.get('stats', {})
            total_cves = stats.get('total_cves', 0)
            max_cvss = stats.get('max_cvss_base', 0)

            processed_list.append({
                "patch_id": patch_id,
                "vendor": vendor,
                "product": f"{product} {major_version}".strip(),
                "type": patch_type,
                "published": patch_date,
                "severity": severity,
                "total_cves": total_cves,
                "max_cvss": max_cvss,
                "description": description,
                "url": url,
            })

        except Exception as e:
            print(f"[PREPROCESS] Error processing {json_path}: {e}")
            continue

    audit_file.close()

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as out:
        json.dump(processed_list, out, ensure_ascii=False, indent=2)

    print(f"[PREPROCESS] Output: {len(processed_list)} patches -> {OUTPUT_FILE}")
    return len(processed_list)

if __name__ == '__main__':
    count = preprocess_patches()
    print(f"[PREPROCESS_DONE] count={count}")
