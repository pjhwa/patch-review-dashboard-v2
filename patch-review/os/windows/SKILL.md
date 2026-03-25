---
name: OS Patch Review Helper (Windows Server)
description: A set of guidelines for selecting the single best Windows Server Cumulative Update per OS version based solely on the absence of Critical Known Issues — choosing the most recent patch with no Critical Known Issues.
---

# Windows Server Patch Review Guidelines

This document provides strict evaluation criteria for OpenClaw agents reviewing individual Windows Server Cumulative Update patches.

## 1. Objective

Our system collects monthly Windows Server cumulative updates for a 3-month review window (6 to 3 months ago). For each Windows Server OS version (2016, 2019, 2022, 2025), there are typically 3 candidate patches. Your job is to compare all patches for the same OS version and select the **most recent patch that has no Critical Known Issues**.

All other patches for that OS version must be explicitly excluded.

## Review Window

The preprocessing script covers patches released **6 to 3 months ago** (e.g., for a Q1 March review: October through December of the previous year). Each patch entry is an individual monthly cumulative update.

## Selection Rule (EXACTLY ONE per OS Version)

For each group of patches sharing the same `os_version` field:
- Evaluate patches in reverse chronological order (most recent first)
- Select the **most recent patch with no Critical Known Issues**: mark it `Decision: Done`
- Mark all remaining patches of the same OS version: `Decision: Exclude`
- Your `Reason` for excluded patches must state why the selected patch was chosen instead

## 2. Review Criteria

### Selection Rule: Most Recent Patch with No Critical Known Issues

For each OS version, evaluate patches in reverse chronological order (most recent first). Select the **first (most recent) patch whose Known Issues are NOT Critical**.

### Definition of Critical Known Issue

A **Critical Known Issue** is one that meets ANY of the following conditions:
1. **System Crash/Boot Failure**: Causes BSODs, kernel panics, boot loops, or unrecoverable OS hangs on production systems.
2. **Data Loss/Corruption**: Causes NTFS/ReFS filesystem corruption, RAID/Storage Spaces failures, or data integrity loss.
3. **Domain/Authentication Failure**: Breaks domain controller functionality, Active Directory replication, or Kerberos authentication.
4. **Hyper-V/Clustering Outage**: Causes Hyper-V host crashes, VM unavailability, or Windows Server Failover Clustering (WSFC) failures.
5. **Unrecoverable Service Failure**: Causes critical enterprise services (e.g., DNS, DHCP, IIS) to fail and require manual intervention to recover.

### Non-Critical Known Issues (do NOT trigger Exclude)

- UI glitches, cosmetic issues, or non-essential feature degradation
- Issues affecting only specific niche configurations not common in enterprise
- Issues with documented workarounds that do not require a rollback
- Performance degradation that is minor and does not affect service availability

### Criteria for Exclude (for non-selected patches)

- A more recent patch for the same OS version has no Critical Known Issues (preferred over this one).
- All patches for the OS version have Critical Known Issues (set all to `Exclude` and explain clearly).

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

### Response Example (3 patches for Windows Server 2025 — December has Critical Known Issue, November selected):

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
    "Description": "Excluded: November patch selected as the most recent patch with no Critical Known Issues.",
    "KoreanDescription": "제외: Critical Known Issue가 없는 가장 최신 패치인 11월 패치가 선택되었습니다.",
    "Decision": "Exclude",
    "Reason": "MSU-2025-Nov-Windows_Server_2025 (KB5045929) is more recent and has no Critical Known Issues."
  },
  {
    "IssueID": "MSU-2025-Nov-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5045929",
    "Vendor": "Windows Server",
    "OsVersion": "Windows Server 2025",
    "Date": "2025-11-11",
    "Criticality": "High",
    "Description": "Selected as the most recent patch with no Critical Known Issues. December patch was skipped due to a Critical Known Issue causing domain controller restarts.",
    "KoreanDescription": "Critical Known Issue가 없는 가장 최신 패치로 선택되었습니다. 12월 패치는 도메인 컨트롤러 재시작을 유발하는 Critical Known Issue로 인해 제외되었습니다.",
    "Decision": "Done",
    "Reason": "Most recent patch with no Critical Known Issues. December patch (KB5046617) was skipped because it has a Critical Known Issue causing domain controller restarts."
  },
  {
    "IssueID": "MSU-2025-Dec-Windows_Server_2025",
    "Component": "cumulative-update",
    "Version": "KB5046617",
    "Vendor": "Windows Server",
    "OsVersion": "Windows Server 2025",
    "Date": "2025-12-09",
    "Criticality": "Critical",
    "Description": "Excluded: Critical Known Issue reported — domain controller restart loop after installation.",
    "KoreanDescription": "제외: 설치 후 도메인 컨트롤러 재시작 루프를 유발하는 Critical Known Issue가 보고되었습니다.",
    "Decision": "Exclude",
    "Reason": "Contains a Critical Known Issue (domain controller restart loop). November patch (KB5045929) selected instead as the most recent safe patch."
  }
]
```

CRITICAL RULE: The `Description` and `KoreanDescription` for `Done` patches must state that this is the most recent patch with no Critical Known Issues, and briefly note the Known Issues status. For `Exclude` patches, state which patch was selected and why this patch was skipped (Critical Known Issue details or "a more recent patch was selected").

## 5. Strict LLM Evaluation Rules

### 5.1 Scope Constraint
- Base your evaluation **ONLY** on the literal `[BATCH DATA]` provided in the prompt
- Do NOT use RAG retrieval, workspace files, or external knowledge to supplement the data
- Do NOT read or reference any JSON files in the workspace directory

### 5.2 Per-Version Selection Logic
For each group of patches sharing the same `os_version`:
1. Identify all patches for this OS version in the batch
2. Sort them by `issued_date` descending (most recent first)
3. Starting from the most recent patch, check its `Known Issues` section
4. If the patch has **no Critical Known Issues** → select it as `Done`, set all others to `Exclude`
5. If the patch has a **Critical Known Issue** → skip it (mark `Exclude`) and check the next most recent patch
6. Repeat until a patch with no Critical Known Issues is found
7. If **all patches** for the OS version have Critical Known Issues → set all to `Exclude` with clear explanation

**Do NOT consider CVE severity or security scores in the selection decision.** Only Known Issues matter.

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
- Use ONLY the known issues data provided in the `description` field for selection decisions
- Do NOT invent KB numbers or known issues not present in the input data
- If the description says "Known Issues: None reported", treat the patch as having no Critical Known Issues
