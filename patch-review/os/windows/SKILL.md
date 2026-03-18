---
name: OS Patch Review Helper (Windows Server)
description: A set of guidelines for selecting the single best Windows Server Cumulative Update per OS version based on critical security/stability fixes and absence of blocking known issues.
---

# Windows Server Patch Review Guidelines

This document provides strict evaluation criteria for OpenClaw agents reviewing individual Windows Server Cumulative Update patches.

## 1. Objective

Our system collects monthly Windows Server cumulative updates for a 3-month review window (6 to 3 months ago). For each Windows Server OS version (2016, 2019, 2022, 2025), there are typically 3 candidate patches. Your job is to compare all patches for the same OS version and select the **single best patch** that:

1. Fixes the most critical security vulnerabilities or system stability issues, AND
2. Has no blocking known issues that would harm production systems

All other patches for that OS version must be explicitly excluded.

## Review Window

The preprocessing script covers patches released **6 to 3 months ago** (e.g., for a Q1 March review: October through December of the previous year). Each patch entry is an individual monthly cumulative update.

## Selection Rule (EXACTLY ONE per OS Version)

For each group of patches sharing the same `os_version` field:
- Compare all candidate patches on security severity, critical bug fixes, and known issues
- Select **exactly one** patch: mark it `Decision: Done`
- Mark all remaining patches of the same OS version: `Decision: Exclude`
- Your `Reason` for excluded patches must state why the selected patch was chosen instead

## 2. Review Criteria

### Criteria for Selection (prefer the patch that fixes these)

1. **System Hang/Crash**: Kernel panics, deadlocks, boot failures (BSODs), unrecoverable OS hangs.
2. **Data Loss/Corruption**: NTFS/ReFS filesystem corruption, RAID/Storage Spaces failures, data integrity loss.
3. **Critical Performance**: Severe CPU/Memory leak degradation affecting enterprise service availability.
4. **Security (Critical)**: Remote Code Execution (RCE) with CVSS >= 8.5, Privilege Escalation (to SYSTEM/Admin) actively exploited, or severe Authentication bypass (e.g., Active Directory/Kerberos flaws).
5. **Failover Failure**: Issues affecting Windows Server Failover Clustering (WSFC), Hyper-V high availability, or active-active storage availability.

**Tiebreaker**: If multiple patches meet the same severity threshold, prefer the most recent one (highest `issued_date`), unless it has a blocking known issue that the older patch does not have.

### Criteria for Known Issues Evaluation

- A **blocking known issue** is one that directly causes domain controller restarts, boot failures, data loss, or Hyper-V/clustering outages on production systems.
- If the most critical patch has a blocking known issue, evaluate whether an earlier patch fixes the same critical vulnerabilities without the known issue.
- Known issues alone do NOT automatically trigger `Exclude` — weigh security risk vs. stability risk and document your reasoning in `Reason`.
- If no patch is safe to apply (all have blocking known issues), set `Decision: Exclude` for all and explain clearly.

### Criteria for Exclude (for non-selected patches)

- Not selected because a better patch exists for the same OS version (state which patch was chosen and why).
- Simple feature updates or low-severity CVEs (CVSS < 7.0) with no HA/data loss risk.

## 3. Input Data Format

You will receive a JSON array of individual patch records. Each patch has these fields:

```json
{
  "patch_id": "MSU-2025-Oct-Windows_Server_2016",
  "vendor": "Windows Server",
  "component": "cumulative-update",
  "os_version": "Windows Server 2016",
  "version": "KB5066836",
  "severity": "Critical",
  "description": "### Top 10 Critical CVEs Included:\n...\n### Known Issues:\n...",
  "issued_date": "2025-10-14",
  "url": "..."
}
```

The `description` field contains the synthesized evaluation text with Top 10 CVEs, Known Issues, and Bug Fixes. Evaluate based solely on this text. Do NOT attempt to read raw files from the workspace.

Patches are sorted by `os_version` so all patches for the same OS version appear consecutively in the input.

## 4. Output Constraints

YOUR FINAL RESPONSE MUST BE A STRICT JSON ARRAY OF OBJECTS. NO MARKDOWN SHIELDING. EACH OBJECT MUST MATCH THIS ZOD SCHEMA EXACTLY:

```json
[
  {
    "IssueID": "String (patch_id from input, e.g. 'MSU-2025-Dec-Windows_Server_2025')",
    "Component": "cumulative-update",
    "Version": "String (KB number from the version field, e.g. 'KB5046617')",
    "Vendor": "Windows Server",
    "OsVersion": "String (os_version field value, e.g. 'Windows Server 2025')",
    "Date": "YYYY-MM-DD (issued_date field value)",
    "Criticality": "Critical | High | Medium | Low",
    "Description": "A concise 1-2 sentence summary of the most critical issue fixed (for Done) or why excluded (for Exclude).",
    "KoreanDescription": "Description translated into enterprise-grade Korean.",
    "Decision": "Done | Exclude",
    "Reason": "For Done: why this patch was selected over others. For Exclude: which patch was selected instead and why."
  }
]
```

### Response Example (3 patches for Windows Server 2025, selecting December):

```json
[
  {
    "IssueID": "MSU-2025-Oct-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5044284",
    "Vendor": "Windows Server",
    "OsVersion": "Windows Server 2025",
    "Date": "2025-10-14",
    "Criticality": "High",
    "Description": "Excluded: December patch selected instead as it is the most recent cumulative update with additional RCE fix in LDAP.",
    "KoreanDescription": "제외: 12월 패치에 LDAP 원격 코드 실행 수정이 추가로 포함된 최신 누적 업데이트로 해당 패치를 선택하였습니다.",
    "Decision": "Exclude",
    "Reason": "MSU-2025-Dec-Windows_Server_2025 (KB5046617) was selected because it is cumulative and includes all prior fixes plus an additional LDAP RCE fix."
  },
  {
    "IssueID": "MSU-2025-Nov-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5045929",
    "Vendor": "Windows Server",
    "OsVersion": "Windows Server 2025",
    "Date": "2025-11-11",
    "Criticality": "High",
    "Description": "Excluded: December patch selected as it supersedes this update with no additional blocking known issues.",
    "KoreanDescription": "제외: 12월 패치가 이 업데이트를 포함하며 추가 차단 문제도 없어 선택하였습니다.",
    "Decision": "Exclude",
    "Reason": "MSU-2025-Dec-Windows_Server_2025 (KB5046617) supersedes this patch and is the most recent in the review window."
  },
  {
    "IssueID": "MSU-2025-Dec-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5046617",
    "Vendor": "Windows Server",
    "OsVersion": "Windows Server 2025",
    "Date": "2025-12-09",
    "Criticality": "Critical",
    "Description": "Addresses critical RCE in LDAP and Active Directory privilege escalation. No blocking known issues.",
    "KoreanDescription": "LDAP 원격 코드 실행 및 Active Directory 권한 상승 취약점을 해결합니다. 차단 알려진 문제 없음.",
    "Decision": "Done",
    "Reason": "Most recent patch in review window with Critical RCE fix. No blocking known issues reported."
  }
]
```

CRITICAL RULE: The `Description` and `KoreanDescription` for `Done` patches must describe WHAT the most critical vulnerability/bug fix was. For `Exclude` patches, state which patch was selected and the core reason.

## 5. Strict LLM Evaluation Rules

### 5.1 Scope Constraint
- Base your evaluation **ONLY** on the literal `[BATCH DATA]` provided in the prompt
- Do NOT use RAG retrieval, workspace files, or external knowledge to supplement the data
- Do NOT read or reference any JSON files in the workspace directory

### 5.2 Per-Version Selection Logic
For each group of patches sharing the same `os_version`:
1. Identify all patches for this OS version in the batch
2. Find the patch with the highest severity CVEs (CVSS ≥ 8.5 or actively exploited)
3. Check its `Known Issues` section for blocking issues
4. If no blocking known issues → select it as `Done`, set others to `Exclude`
5. If it has a blocking known issue → evaluate whether an earlier patch in the window covers the same critical fix without the known issue; prefer the safer patch
6. If all patches have blocking known issues → set all to `Exclude` with clear explanation

### 5.3 Output Count Validation
- You MUST return **EXACTLY** the same number of objects as patches in `[BATCH DATA]`
- Every input patch must appear in the output — do not drop or merge any
- Each OS version must have **exactly one** `Decision: Done` entry (unless all are excluded for blocking known issues)

### 5.4 Output Field Validation
| Field | Valid Values |
|-------|-------------|
| `Decision` | `Done` or `Exclude` only |
| `Criticality` | `Critical`, `High`, `Medium`, or `Low` only |
| `Vendor` | Must be exactly `Windows Server` |
| `IssueID` | Must match the input patch's `patch_id` exactly (e.g., `MSU-2025-Dec-Windows_Server_2025`) |
| `Version` | KB number from the input patch's `version` field (e.g., `KB5046617`) |
| `OsVersion` | Must match the input patch's `os_version` field exactly |

### 5.5 Hallucination Prevention
- Use ONLY the CVE data, severity scores, and known issues provided in the `description` field
- Do NOT invent CVE numbers, KB numbers, or known issues not present in the input data
- If the description says "Known Issues: None reported", treat the patch as having no blocking known issues
