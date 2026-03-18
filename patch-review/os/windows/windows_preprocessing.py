#!/usr/bin/env python3
"""
windows_preprocessing.py
Windows Server cumulative patch preprocessing script.
Reads JSON files from windows_data/, filters by review window (6 to 3 months ago),
and outputs patches_for_llm_review_windows.json with individual patch records for AI review.
The AI review stage selects the single best patch per OS version based on criticality and known issues.
"""
import re
import csv
import os
import json
from datetime import datetime, timedelta, timezone
import sqlite3
import uuid
import glob
import argparse

# ==================== CONFIGURATION ====================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(SCRIPT_DIR, "windows_data")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "patches_for_llm_review_windows.json")
AUDIT_LOG_FILE = os.path.join(SCRIPT_DIR, "dropped_patches_audit_windows.csv")
DB_PATH = os.path.join(SCRIPT_DIR, "windows_patches.db")

# ==================== HELPER FUNCTIONS ====================

def parse_date(date_str):
    if not date_str:
        return "Unknown"
    # Expected format: "2026-03-10T07:00:00"
    if "T" in date_str:
        return date_str.split("T")[0]
    return date_str[:10]

def extract_top_cves(vulnerabilities, top_n=10):
    """
    Extracts the top N vulnerabilities sorted by CVSS base score descending.
    """
    if not vulnerabilities:
        return []

    # Sort by cvss_base_score descending
    def get_score(v):
        try:
            return float(v.get("cvss_base_score", 0))
        except (ValueError, TypeError):
            return 0.0

    sorted_vulns = sorted(vulnerabilities, key=get_score, reverse=True)
    return sorted_vulns[:top_n]

def synthesize_description(patch_data):
    """
    Combines Top 10 CVEs, Top 5 Bug Fixes (if available), and Known Issues into a text block.
    """
    parts = []

    # Add top CVEs
    vulnerabilities = patch_data.get("vulnerabilities", [])
    top_cves = extract_top_cves(vulnerabilities, 10)

    if top_cves:
        parts.append("### Top 10 Critical CVEs Included:")
        for v in top_cves:
            cve = v.get("cve", "Unknown CVE")
            severity = v.get("severity", "Unknown")
            cvss = v.get("cvss_base_score", "N/A")
            desc = v.get("description", "")[:300]
            parts.append(f"- **{cve}** (Severity: {severity}, CVSS: {cvss}): {desc}")
    else:
        parts.append("### Top CVEs: None reported in MSRC data.")

    # Known Issues
    known_issues = patch_data.get("known_issues", [])
    if known_issues:
        parts.append("### Known Issues:")
        for ki in known_issues:
            parts.append(f"- {ki}")
    else:
        parts.append("### Known Issues: None reported.")

    # Bug Fixes (not explicitly in current MSRC JSON layout, but added as placeholder/fallback)
    # The prompt requested top 5 bug fixes. We will state none unless we find a specific key.
    bug_fixes = patch_data.get("bug_fixes", [])
    if bug_fixes:
        parts.append("### Top 5 Critical Bug Fixes:")
        for bf in bug_fixes[:5]:
            parts.append(f"- {bf}")
    else:
        parts.append("### Bug Fixes: Refer to cumulative update KB for non-security fixes.")

    return "\n".join(parts)


def get_overall_severity(patch_data):
    """
    Returns the highest severity among the vulnerabilities.
    """
    vulns = patch_data.get("vulnerabilities", [])
    if not vulns:
        return "Unknown"

    severities = set()
    for v in vulns:
        sev = (v.get("severity") or "").lower()
        if sev:
            severities.add(sev)

    if "critical" in severities:
        return "Critical"
    elif "important" in severities:
        return "Important"
    elif "moderate" in severities:
        return "Moderate"
    elif "low" in severities:
        return "Low"
    return "Unknown"


# ==================== MAIN ====================

def main():
    parser = argparse.ArgumentParser(description="Windows Server Patch Preprocessor")
    parser.add_argument("--days", type=int, default=180, help="Look-back start in days (default: 180 = 6 months ago)")
    parser.add_argument("--days_end", type=int, default=90, help="Look-back end in days (default: 90 = 3 months ago)")
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    cutoff_start = now - timedelta(days=args.days)
    cutoff_end = now - timedelta(days=args.days_end)

    print(f"\n Windows Server Patch Preprocessor 시작")
    print(f"   리뷰 윈도우: {cutoff_start.strftime('%Y-%m-%d')} ~ {cutoff_end.strftime('%Y-%m-%d')}")

    included_patches = []
    audit_rows = []

    print(f"\n 패치 분석 중...")

    # 1. Load Windows Data (Deterministic sorted list)
    json_files = sorted(glob.glob(os.path.join(DATA_DIR, "*.json")))
    print(f"   총 {len(json_files)}개 JSON 파일 발견")

    for filepath in json_files:
        filename = os.path.basename(filepath)
        if filename == "manifest.json" or filename == "metadata.json":
            continue

        try:
            with open(filepath, "r", encoding="utf-8") as f:
                patch = json.load(f)
        except Exception as e:
            print(f"  Warning 파일 파싱 오류 [{filepath}]: {e}")
            continue

        patch_id = patch.get("id") or filename.replace(".json", "")
        published_at = patch.get("initial_release_date") or ""

        # 2. Filter by Date (both bounds)
        if published_at:
            try:
                pub_dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                if pub_dt.tzinfo is None:
                    pub_dt = pub_dt.replace(tzinfo=timezone.utc)

                if pub_dt < cutoff_start:
                    audit_rows.append({
                        "patch_id": patch_id,
                        "vendor": "Windows Server",
                        "drop_reason": f"TOO_OLD (published: {published_at[:10]})",
                        "title": patch.get("title", "")[:80]
                    })
                    continue

                if pub_dt > cutoff_end:
                    audit_rows.append({
                        "patch_id": patch_id,
                        "vendor": "Windows Server",
                        "drop_reason": f"TOO_RECENT (published: {published_at[:10]}, cutoff_end: {cutoff_end.strftime('%Y-%m-%d')})",
                        "title": patch.get("title", "")[:80]
                    })
                    continue
            except Exception:
                pass  # Include if date is unparseable

        overall_severity = get_overall_severity(patch)

        # Drop logic: Ensure it's not totally empty of vulns
        if not patch.get("vulnerabilities") and not patch.get("summary"):
            audit_rows.append({
                "patch_id": patch_id,
                "vendor": "Windows Server",
                "drop_reason": "NO_VULNERABILITIES_OR_SUMMARY",
                "title": patch.get("title", "")[:80]
            })
            continue

        # 3. Aggregation and synthesis
        description = synthesize_description(patch)
        kb_number = patch.get("cumulative_update_kb", "")
        url = patch.get("url") or patch.get("cumulative_update_url", "")
        os_version = patch.get("os", "Windows Server")

        record = {
            "patch_id": patch_id,
            "vendor": "Windows Server",
            "component": kb_number if kb_number else "cumulative-update",
            "version": kb_number,
            "os_version": os_version,
            "severity": overall_severity,
            "description": description,
            "issued_date": parse_date(published_at),
            "url": url,
        }
        included_patches.append(record)
        print(f"  OK 포함: [{patch_id}] {patch.get('title', '')[:40]}... (os={os_version}, severity={overall_severity})")

    # 4. Sort individual patches by os_version then issued_date descending
    #    so same-version patches are consecutive and AI can compare them together
    def patch_sort_key(p):
        os_v = p.get("os_version", "")
        date = p.get("issued_date", "")
        return (os_v, date if date != "Unknown" else "")
    included_patches.sort(key=patch_sort_key)

    # ---- Output ----
    print(f"\n 처리 결과:")
    print(f"   * 포함 패치: {len(included_patches)}개 (개별 레코드, AI가 OS버전별 1개 선택)")
    print(f"   * 탈락 패치: {len(audit_rows)}개")

    # Write LLM review JSON (individual records)
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(included_patches, f, ensure_ascii=False, indent=2)
    print(f"OK LLM 리뷰용 JSON 저장 (개별): {OUTPUT_FILE}")

    # Write Audit CSV
    audit_fieldnames = ["patch_id", "vendor", "drop_reason", "title"]
    with open(AUDIT_LOG_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=audit_fieldnames)
        writer.writeheader()
        for row in audit_rows:
            writer.writerow(row)
    print(f"OK Audit Log 저장: {AUDIT_LOG_FILE}")

if __name__ == "__main__":
    main()
