---
name: OS Patch Review Helper (Windows Server)
description: A set of guidelines for determining if a Windows Server Cumulative Update applies to our production systems according to defined thresholds.
---

# Windows Server Patch Review Guidelines

This document provides strict evaluation criteria for OpenClaw agents reviewing Windows Server Cumulative Updates (MSUs).

## 1. Objective
Our system automatically ingests monthly Windows Server updates. Because these are cumulative, evaluating an entire update containing hundreds of CVEs could be overwhelming. The `windows_preprocessing.py` script distills the update into the top 10 most critical CVEs, top 5 bug fixes, and known issues. Your job is to decide whether this cumulative update is **Critical/High priority** requiring immediate deployment, or if it can be deployed in the standard monthly cycle.

## Review Window
The preprocessing script covers patches released **6 to 3 months ago** (e.g., for a Q1 March review: September through December of the previous year). This quarterly lookback window ensures the most recent stable release is evaluated rather than unreleased or very recent patches.

## Selection Rule (ONE per Version)
For each Windows Server version (2016, 2019, 2022, 2025), the AI receives ALL monthly cumulative updates in the review window. The AI must select the **single most recent** cumulative update that addresses any Critical/High criteria. Output contains **exactly ONE entry per OS version**.

## 2. Review Criteria

We must deploy out-of-band and elevate priority if the update fixes any of the following constraints.

### Criteria for Inclusion (Critical Urgency)
If the cumulative update addresses *any* of the following critical issues, it MUST be highlighted:

1. **System Hang/Crash**: Kernel panics, deadlocks, boot failures (e.g., BSODs), unrecoverable OS hangs.
2. **Data Loss/Corruption**: NTFS/ReFS filesystem corruption, RAID/Storage Spaces failures, data integrity loss.
3. **Critical Performance**: Severe CPU/Memory leak degradation affecting enterprise service capability.
4. **Security (Critical)**: Remote Code Execution (RCE) with CVSS >= 8.5, Privilege Escalation (to SYSTEM/Admin) actively exploited, or severe Authentication bypass (e.g., Active Directory/Kerberos flaws).
5. **Failover Failure**: Issues affecting Windows Server Failover Clustering (WSFC), Hyper-V high availability, or active-active storage availability.

### Criteria for Exclusion / Downgrade
- If a Cumulative Update contains a **Critical Known Issue** (e.g., "After installing this update, domain controllers might restart unexpectedly"), you must explicitly note this and evaluate the risk.
- Simple feature updates or low-severity/CVSS < 7.0 CVEs do not merit out-of-band emergency patching.

## 3. Input Data Format
You will receive JSON batches containing preprocessed cumulative updates. The `Description` field will be a synthesized text block containing the "Top 10 Critical CVEs", "Known Issues", and "Top 5 Bug Fixes". Do not attempt to read the raw files yourself.

## 4. Output Constraints
YOUR FINAL RESPONSE MUST BE A STRICT JSON ARRAY OF OBJECTS. NO MARKDOWN SHIELDING. EACH OBJECT MUST MATCH THIS ZOD SCHEMA EXACTLY:

```json
[
  {
    "IssueID": "String (use the GROUP's patch_id from input, e.g. WINDOWS-GROUP-Windows_Server_2025)",
    "Component": "String (e.g., cumulative-update)",
    "Version": "String (KB number of the SELECTED monthly patch, e.g., KB5078740)",
    "Vendor": "Windows Server",
    "Date": "YYYY-MM-DD (release date of the SELECTED monthly patch)",
    "Criticality": "Critical | High | Medium | Low",
    "Description": "A highly concise summary focusing ONLY on the most severe RCEs, crashes, or data loss prevented by the selected patch. DO NOT list all CVEs. Say what the worst threats are.",
    "KoreanDescription": "Description translated into enterprise-grade Korean.",
    "Decision": "Done | Exclude (Exclude only if strictly irrelevant or breaks the environment based on known issues)",
    "Reason": "Why you made this decision based on the criteria above."
  }
]
```

### Response Example:
```json
[
  {
    "IssueID": "WINDOWS-GROUP-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5078740",
    "Vendor": "Windows Server",
    "Date": "2025-12-10",
    "Criticality": "Critical",
    "Description": "Addresses critical RCE in Print Spooler and Active Directory privilege escalation. No blocking known issues.",
    "KoreanDescription": "Print Spooler의 원격 코드 실행 및 Active Directory 권한 상승 취약점을 해결합니다. 현재 확인된 심각한 알려진 문제는 없습니다.",
    "Decision": "Done",
    "Reason": "Includes fixes for highly critical RCE and AD privilege escalation."
  }
]
```

CRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the update. DO NOT copy-paste the raw descriptions or include long lists of CVE numbers. Describe WHAT the worst impact was and WHY we need to patch it.
