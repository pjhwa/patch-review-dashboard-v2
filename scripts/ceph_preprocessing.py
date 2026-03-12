#!/usr/bin/env python3
"""
ceph_preprocessing.py
Ceph patch preprocessing script.
Reads security + release JSON files from ceph_data/, applies recommendation filters,
and outputs patches_for_llm_review_ceph.json for AI review.

Filter Criteria (same as OS pipeline):
  - System Hang/Crash: Panics, deadlocks, OSD crashes, monitor failures.
  - Data Loss/Corruption: Data integrity issues, filesystem/object store corruption.
  - Critical Performance: Severe throughput/IOPS/latency degradation.
  - Security (Critical): RCE, Privilege Escalation, Auth Bypass.
  - Failover Failure: Issues affecting HA, monitor quorum, OSD failover.
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
CEPH_DATA_DIR = os.path.join(SCRIPT_DIR, "ceph_data")
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "patches_for_llm_review_ceph.json")
AUDIT_LOG_FILE = os.path.join(SCRIPT_DIR, "dropped_patches_audit_ceph.csv")
DB_PATH = os.path.join(SCRIPT_DIR, "ceph_patches.db")

# ==================== FILTER KEYWORDS ====================
# Keyword groups for release note analysis (Ceph-specific)
CRITICAL_CRASH_KEYWORDS = [
    "panic", "crash", "deadlock", "hang", "osd crash", "monitor crash",
    "mon crash", "mds crash", "stuck", "segfault", "abort", "oops",
    "unexpected shutdown", "unresponsive", "lockup", "sigabrt", "sigsegv",
    "fatal error", "kernel oops", "object store crash",
]

DATA_LOSS_KEYWORDS = [
    "data loss", "data corruption", "corruption", "data integrity",
    "bluestore", "rocksdb corruption", "object corruption", "erasure code",
    "inconsistency", "mismatch", "scrub error", "unfound object",
    "checksum error", "bit rot", "data unavailable", "lost pg",
    "degraded", "lost object",
]

CRITICAL_PERFORMANCE_KEYWORDS = [
    "severe performance", "performance regression", "throughput degradation",
    "iops degradation", "latency spike", "severe degradation",
    "service unavailable", "unacceptable performance",
    "extreme latency", "io stall", "io halt", "backpressure",
    "throttle stuck",
]

SECURITY_CRITICAL_KEYWORDS = [
    "remote code execution", "rce", "privilege escalation", "root escalation",
    "authentication bypass", "auth bypass", "arbitrary code execution",
    "unauthenticated access", "unauthorized access", "security advisory",
    "critical vulnerability", "critical cve",
    "injection", "buffer overflow", "heap overflow",
]

FAILOVER_KEYWORDS = [
    "failover", "high availability", "ha", "monitor quorum", "quorum loss",
    "osd failover", "osd recovery failure", "recovery stall",
    "replication failure", "peering failure", "cluster unavailable",
    "corosync", "pacemaker", "split brain",
]

ALL_CRITICAL_KEYWORDS = (
    CRITICAL_CRASH_KEYWORDS +
    DATA_LOSS_KEYWORDS +
    CRITICAL_PERFORMANCE_KEYWORDS +
    SECURITY_CRITICAL_KEYWORDS +
    FAILOVER_KEYWORDS
)

# Security severity levels that qualify as "critical"
CRITICAL_SEVERITIES = {"critical", "high"}

# ==================== HELPER FUNCTIONS ====================

def normalize_text(text: str) -> str:
    """Lowercase and clean text for keyword matching."""
    if not text:
        return ""
    return text.lower().strip()


def classify_drop_reason(text: str) -> tuple[bool, str]:
    """
    Returns (should_include, drop_reason).
    True = include, False = drop with reason.
    """
    norm = normalize_text(text)
    if not norm:
        return False, "EMPTY_CONTENT"
    return True, ""


def match_keywords(text: str, keywords: list) -> str | None:
    """Returns first matched keyword or None."""
    norm = normalize_text(text)
    for kw in sorted(keywords):  # sorted for determinism
        if kw in norm:
            return kw
    return None


def determine_severity_from_text(text: str) -> tuple[str, str]:
    """
    Returns (severity_label, matched_category).
    severity_label: 'CRITICAL', 'HIGH', 'MEDIUM', 'LOW'
    matched_category: e.g. 'DATA_LOSS', 'SECURITY', etc.
    """
    categories_map = [
        ("SECURITY", SECURITY_CRITICAL_KEYWORDS),
        ("DATA_LOSS", DATA_LOSS_KEYWORDS),
        ("CRASH", CRITICAL_CRASH_KEYWORDS),
        ("FAILOVER", FAILOVER_KEYWORDS),
        ("PERFORMANCE", CRITICAL_PERFORMANCE_KEYWORDS),
    ]
    for cat, keywords in categories_map:
        hit = match_keywords(text, keywords)
        if hit:
            # Determine severity based on category
            if cat in ("SECURITY", "DATA_LOSS", "CRASH"):
                return "CRITICAL", cat
            elif cat in ("FAILOVER", "PERFORMANCE"):
                return "HIGH", cat
    return "LOW", "NONE"


def qualify_security_patch(patch: dict) -> tuple[bool, str]:
    """
    Evaluate a security advisory patch.
    Returns (passes, reason_if_dropped).
    """
    severity = (patch.get("severity") or "").lower()
    cvss_score = None
    try:
        cvss_v3 = patch.get("cvss_severities", {}).get("cvss_v3", {})
        cvss_score = cvss_v3.get("score") if cvss_v3 else None
        if cvss_score is None:
            cvss_legacy = patch.get("cvss", {})
            cvss_score = cvss_legacy.get("score") if cvss_legacy else None
    except Exception:
        pass

    summary = patch.get("summary") or patch.get("title") or ""
    description = patch.get("description", "")
    combined_text = f"{summary} {description}"

    # Always include if critical/high severity
    if severity in CRITICAL_SEVERITIES:
        return True, ""

    # Include if CVSS >= 7.0
    if cvss_score is not None and float(cvss_score) >= 7.0:
        return True, ""

    # Include if matched to critical keywords
    sev_label, _ = determine_severity_from_text(combined_text)
    if sev_label in ("CRITICAL", "HIGH"):
        return True, ""

    return False, f"SEVERITY_UNDER_THRESHOLD (severity={severity}, cvss={cvss_score})"


def qualify_release_patch(patch: dict) -> tuple[bool, str]:
    """
    Evaluate a release note patch.
    Returns (passes, reason_if_dropped).
    """
    body = patch.get("body") or patch.get("description") or ""
    name = patch.get("name") or patch.get("title") or ""
    tag_name = patch.get("tag_name", "")
    combined_text = f"{name} {tag_name} {body}"

    if not combined_text.strip():
        return False, "EMPTY_RELEASE_BODY"

    # Only include releases that contain at least one critical-category keyword
    hit = match_keywords(combined_text, ALL_CRITICAL_KEYWORDS)
    if hit:
        return True, ""

    return False, "NO_CRITICAL_KEYWORD_MATCH"


def extract_ceph_version(patch: dict, source_type: str) -> str:
    """Extract Ceph version string from release metadata."""
    if source_type == "release":
        tag = patch.get("tag_name", "")
        # e.g. "v18.2.4" or "quincy-18.2.4"
        return tag.lstrip("v") or "unknown"
    elif source_type == "security":
        vulns = patch.get("vulnerabilities", [])
        if vulns:
            ver_range = vulns[0].get("vulnerable_version_range", "")
            return ver_range or "unknown"
    return "unknown"


def parse_patch_date(patch: dict, source_type: str) -> str:
    """Extract ISO date string from patch."""
    pub = patch.get("issuedDate") or patch.get("pubDate") or patch.get("published_at") or patch.get("created_at") or patch.get("updated_at") or ""
    if pub:
        return pub[:10]
    return "Unknown"


def determine_category(text: str) -> str:
    """Classify patch into one of the 5 critical categories."""
    norm = normalize_text(text)
    if match_keywords(norm, SECURITY_CRITICAL_KEYWORDS):
        return "Security (Critical)"
    if match_keywords(norm, DATA_LOSS_KEYWORDS):
        return "Data Loss/Corruption"
    if match_keywords(norm, CRITICAL_CRASH_KEYWORDS):
        return "System Hang/Crash"
    if match_keywords(norm, FAILOVER_KEYWORDS):
        return "Failover Failure"
    if match_keywords(norm, CRITICAL_PERFORMANCE_KEYWORDS):
        return "Critical Performance"
    return "General"


# ==================== DB SETUP ====================

def init_db(db_path: str):
    """Initialize local SQLite DB for preprocessed patches."""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS preprocessed_patch (
            id TEXT PRIMARY KEY,
            patch_id TEXT NOT NULL,
            vendor TEXT NOT NULL,
            component TEXT,
            version TEXT,
            os_version TEXT,
            severity TEXT,
            category TEXT,
            title TEXT,
            description TEXT,
            issued_date TEXT,
            source_type TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    return conn


def try_write_prisma_db(patches: list) -> int:
    """
    Try to write to the Next.js Prisma SQLite DB (PreprocessedPatch table).
    Falls back gracefully if the DB path is not found.
    Returns number of records written.
    """
    # Common Prisma DB paths
    candidate_paths = [
        os.path.expanduser("~/patch-review-dashboard-v2/prisma/patch-review.db"),
        os.path.expanduser("~/patch-review-dashboard-v2/prisma/dev.db"),
        os.path.expanduser("~/patch-review-dashboard-v2/prisma/prod.db"),
    ]
    prisma_db = None
    for c in candidate_paths:
        if os.path.exists(c):
            prisma_db = c
            break

    if not prisma_db:
        print(f"⚠️  Prisma DB를 찾을 수 없습니다. 로컬 SQLite에만 저장합니다.")
        return 0

    try:
        conn = sqlite3.connect(prisma_db)
        cursor = conn.cursor()

        # Check table schema
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='PreprocessedPatch'")
        if not cursor.fetchone():
            print("⚠️  PreprocessedPatch 테이블이 Prisma DB에 없습니다.")
            conn.close()
            return 0

        # Delete existing Ceph records
        cursor.execute("DELETE FROM PreprocessedPatch WHERE vendor = 'Ceph'")

        count = 0
        for p in patches:
            try:
                cursor.execute("""
                    INSERT OR REPLACE INTO PreprocessedPatch
                    (id, issueId, vendor, component, version, osVersion, severity, releaseDate, description, url, collectedAt, isReviewed, isAiReviewRequested)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)
                """, (
                    p["id"],
                    p["patch_id"],
                    p["vendor"],
                    p.get("component", "ceph"),
                    p.get("version", ""),
                    p.get("os_version", ""),
                    p.get("severity", ""),
                    p.get("issued_date", ""),
                    (p.get("description") or p.get("title") or "")[:4000],
                    p.get("url", ""),
                    datetime.now().isoformat(),
                ))
                count += 1
            except Exception as e:
                print(f"  ⚠️  Prisma DB 삽입 오류 [{p['patch_id']}]: {e}")

        conn.commit()
        conn.close()
        print(f"✅ Prisma DB에 {count}개 저장 완료 (vendor=Ceph)")
        return count
    except Exception as e:
        print(f"⚠️  Prisma DB 연결 오류: {e}")
        return 0


# ==================== MAIN ====================

def main():
    parser = argparse.ArgumentParser(description="Ceph Patch Preprocessor")
    parser.add_argument("--days", type=int, default=180, help="Look-back period in days (default: 180)")
    parser.add_argument("--data-dir", type=str, default=CEPH_DATA_DIR, help="Path to ceph_data JSON dir")
    args = parser.parse_args()

    cutoff_date = datetime.now(timezone.utc) - timedelta(days=args.days)
    print(f"\n🚀 Ceph Patch Preprocessor 시작")
    print(f"   기간: 최근 {args.days}일 ({cutoff_date.strftime('%Y-%m-%d')} 이후)")
    print(f"   데이터 디렉토리: {args.data_dir}")

    included_patches = []
    audit_rows = []

    # ---- 1. Security Advisories ----
    print(f"\n🔍 [1/2] 보안 패치 분석 중...")
    
    security_files = sorted(glob.glob(os.path.join(args.data_dir, "GHSA-*.json")) + glob.glob(os.path.join(args.data_dir, "CVE-*.json")))
    security_patches = []
    for filepath in security_files:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list): security_patches.extend(data)
                else: security_patches.append(data)
        except Exception as e:
            print(f"  ⚠️  파일 파싱 오류 [{filepath}]: {e}")
            
    print(f"   총 {len(security_patches)}개 항목 발견")

    for patch in security_patches:
        if not isinstance(patch, dict):
            continue
        patch_id = patch.get("id") or patch.get("ghsa_id") or patch.get("cve_id") or patch.get("patch_id") or str(uuid.uuid4())
        summary = patch.get("summary") or patch.get("title") or ""
        description = patch.get("description", "")
        published_at = patch.get("issuedDate") or patch.get("published_at") or patch.get("updated_at") or ""

        # Date filter
        if published_at and args.days > 0:
            try:
                pub_dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                if pub_dt < cutoff_date:
                    reason = f"TOO_OLD (published: {published_at[:10]})"
                    audit_rows.append({
                        "patch_id": patch_id,
                        "vendor": "Ceph",
                        "source_type": "security",
                        "drop_reason": reason,
                        "title": summary[:80] if summary else "",
                    })
                    continue
            except Exception:
                pass  # If date parsing fails, include it

        passes, reason = qualify_security_patch(patch)
        if not passes:
            audit_rows.append({
                "patch_id": patch_id,
                "vendor": "Ceph",
                "source_type": "security",
                "drop_reason": reason,
                "title": summary[:80] if summary else "",
            })
            continue

        combined_text = f"{summary} {description}"
        category = determine_category(combined_text)
        _, sev_cat = determine_severity_from_text(combined_text)

        severity_str = (patch.get("severity") or "").capitalize()
        cvss_v3 = (patch.get("cvss_severities") or {}).get("cvss_v3") or {}
        cvss_score = cvss_v3.get("score") or (patch.get("cvss") or {}).get("score") or ""
        cve_id = patch.get("cve_id", "")
        cwe_ids = ",".join(patch.get("cwe_ids") or [])
        version = extract_ceph_version(patch, "security")

        record = {
            "id": str(uuid.uuid4()),
            "patch_id": patch_id,
            "vendor": "Ceph",
            "source_type": "security",
            "component": "ceph",
            "version": version,
            "os_version": "",
            "severity": severity_str,
            "cvss_score": str(cvss_score),
            "cve_id": cve_id,
            "cwe_ids": cwe_ids,
            "category": category,
            "title": summary,
            "description": description,
            "issued_date": parse_patch_date(patch, "security"),
            "url": patch.get("html_url", ""),
        }
        included_patches.append(record)
        print(f"  ✅ 포함: [{patch_id}] {summary[:60]}... (severity={severity_str}, category={category})")

    # ---- 2. Release Notes & Tracker ----
    print(f"\n🔍 [2/2] 릴리즈 패치 분석 중...")
    
    all_release_files = sorted(glob.glob(os.path.join(args.data_dir, "REDMINE-*.json")))
    
    release_patches = []
    for filepath in all_release_files:
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list): release_patches.extend(data)
                else: release_patches.append(data)
        except Exception as e:
            print(f"  ⚠️  파일 파싱 오류 [{filepath}]: {e}")
            
    print(f"   총 {len(release_patches)}개 항목 발견")

    for patch in release_patches:
        if not isinstance(patch, dict):
            continue
        patch_id = patch.get("id") or patch.get("tag_name") or patch.get("patch_id") or str(uuid.uuid4())
        name = patch.get("name") or patch.get("title") or ""
        body = patch.get("body") or patch.get("description") or ""
        published_at = patch.get("issuedDate") or patch.get("published_at") or patch.get("created_at") or ""

        # Date filter
        if published_at and args.days > 0:
            try:
                pub_dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
                if pub_dt < cutoff_date:
                    reason = f"TOO_OLD (published: {published_at[:10]})"
                    audit_rows.append({
                        "patch_id": patch_id,
                        "vendor": "Ceph",
                        "source_type": "release",
                        "drop_reason": reason,
                        "title": name[:80] if name else "",
                    })
                    continue
            except Exception:
                pass

        passes, reason = qualify_release_patch(patch)
        if not passes:
            audit_rows.append({
                "patch_id": patch_id,
                "vendor": "Ceph",
                "source_type": "release",
                "drop_reason": reason,
                "title": name[:80] if name else "",
            })
            continue

        combined_text = f"{name} {body}"
        category = determine_category(combined_text)
        severity_label, _ = determine_severity_from_text(combined_text)
        version = extract_ceph_version(patch, "release")

        record = {
            "id": str(uuid.uuid4()),
            "patch_id": patch_id,
            "vendor": "Ceph",
            "source_type": "release",
            "component": "ceph",
            "version": version,
            "os_version": "",
            "severity": severity_label,
            "cvss_score": "",
            "cve_id": "",
            "cwe_ids": "",
            "category": category,
            "title": name,
            "description": body[:8000] if body else "",
            "issued_date": parse_patch_date(patch, "release"),
            "url": patch.get("html_url", ""),
        }
        included_patches.append(record)
        print(f"  ✅ 포함: [{patch_id}] {name[:60]}... (severity={severity_label}, category={category})")

    # ---- 3. Output ----
    print(f"\n📊 처리 결과:")
    print(f"   • 포함 패치: {len(included_patches)}개")
    print(f"   • 탈락 패치: {len(audit_rows)}개")

    # Write LLM review JSON
    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump(included_patches, f, ensure_ascii=False, indent=2)
    print(f"✅ LLM 리뷰용 JSON 저장: {OUTPUT_FILE}")

    # Write Audit CSV
    audit_fieldnames = ["patch_id", "vendor", "source_type", "drop_reason", "title"]
    with open(AUDIT_LOG_FILE, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=audit_fieldnames)
        writer.writeheader()
        for row in audit_rows:
            writer.writerow(row)
    print(f"✅ Audit Log 저장: {AUDIT_LOG_FILE}")

    # Write Local SQLite DB
    conn = init_db(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM preprocessed_patch WHERE vendor = 'Ceph'")
    for p in included_patches:
        cursor.execute("""
            INSERT OR REPLACE INTO preprocessed_patch
            (id, patch_id, vendor, component, version, os_version, severity, category, title, description, issued_date, source_type)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            p["id"], p["patch_id"], p["vendor"], p.get("component", "ceph"),
            p.get("version", ""), p.get("os_version", ""),
            p.get("severity", ""), p.get("category", ""),
            p.get("title", ""), (p.get("description", "") or "")[:4000],
            p.get("issued_date", ""), p.get("source_type", ""),
        ))
    conn.commit()
    conn.close()
    print(f"✅ 로컬 SQLite DB 업데이트 완료 ({DB_PATH})")

    # Try Prisma DB
    try_write_prisma_db(included_patches)

    print(f"\n🎉 전처리 완료!")
    print(f"   포함: {len(included_patches)}개 패치 → {OUTPUT_FILE}")
    print(f"   탈락: {len(audit_rows)}개 패치 → {AUDIT_LOG_FILE}")


if __name__ == "__main__":
    main()
