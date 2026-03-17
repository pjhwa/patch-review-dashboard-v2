---
name: Virtualization Patch Review Helper (VMware vSphere)
description: A set of guidelines for determining if VMware vSphere patches apply to our production systems according to defined thresholds.
---

# VMware vSphere Patch Review Guidelines

This document provides strict evaluation criteria for OpenClaw agents reviewing VMware vSphere security advisories and bug fixes.

## 1. Objective
Our system automatically ingests VMware vSphere security advisories and bug fixes. Because these can contain multiple CVEs and fixes, evaluating an entire advisory could be overwhelming. The preprocessing script distills the advisory into the most critical CVEs, key bug fixes, and known issues. Your job is to decide whether this advisory is **Critical/High priority** requiring immediate deployment, or if it can be deployed in the standard patch cycle.

## Review Window
The preprocessing script covers patches released **6 to 3 months ago** (e.g., for a Q1 March review: September through December of the previous year). This quarterly lookback window ensures the most recent stable release is evaluated rather than unreleased or very recent patches.

## Selection Rule (ONE per Component)
For each vSphere component (ESXi, vCenter Server, vSAN, NSX), the AI receives ALL advisories in the review window. The AI must select the **single most recent** advisory that addresses any Critical/High criteria. Output contains **exactly ONE entry per component**.

## 2. Review Criteria

We must deploy out-of-band and elevate priority if the advisory fixes any of the following constraints.

### Criteria for Inclusion (Critical Urgency)
If the advisory addresses *any* of the following critical issues, it MUST be highlighted:

1. **System Hang/Crash**: ESXi kernel panics, deadlocks, boot failures, unrecoverable hypervisor hangs.
2. **Data Loss/Corruption**: vSAN datastore corruption, VM filesystem corruption, data integrity loss.
3. **Critical Performance**: Severe CPU/Memory leak degradation affecting enterprise service capability.
4. **Security (Critical)**: Remote Code Execution (RCE) with CVSS >= 8.5, Privilege Escalation (to root/admin) actively exploited, or severe Authentication bypass.
5. **Failover Failure**: Issues affecting vSphere HA, vMotion, Storage vMotion, or active-active storage availability.

### Criteria for Exclusion / Downgrade
- If an advisory contains a **Critical Known Issue** (e.g., "After installing this update, ESXi hosts might experience network connectivity loss"), you must explicitly note this and evaluate the risk.
- Simple feature updates or low-severity/CVSS < 7.0 CVEs do not merit out-of-band emergency patching.

## 3. Input Data Format
You will receive JSON batches containing preprocessed advisories. The `Description` field will be a synthesized text block containing the "Top Critical CVEs", "Known Issues", and "Key Bug Fixes". Do not attempt to read the raw files yourself.

## 4. Output Constraints
YOUR FINAL RESPONSE MUST BE A STRICT JSON ARRAY OF OBJECTS. NO MARKDOWN SHIELDING. EACH OBJECT MUST MATCH THIS ZOD SCHEMA EXACTLY:

```json
[
  {
    "IssueID": "String (use the GROUP's patch_id from input, e.g. VSPH-VMSA-2025-0016_vCenter_Server_7.0)",
    "Component": "String (e.g., vCenter Server, ESXi, vSAN, NSX)",
    "Version": "String (version of the affected product, e.g., 7.0 U3w)",
    "Vendor": "VMware vSphere",
    "Date": "YYYY-MM-DD (publication date of the advisory)",
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
    "IssueID": "VSPH-VMSA-2025-0016_ESXi_7.0",
    "Component": "ESXi",
    "Version": "7.0 U3w",
    "Vendor": "VMware vSphere",
    "Date": "2025-09-29",
    "Criticality": "Critical",
    "Description": "Addresses critical RCE in ESXi management interface and privilege escalation. No blocking known issues.",
    "KoreanDescription": "ESXi 관리 인터페이스의 원격 코드 실행 및 권한 상승 취약점을 해결합니다. 현재 확인된 심각한 알려진 문제는 없습니다.",
    "Decision": "Done",
    "Reason": "Includes fixes for highly critical RCE and privilege escalation in hypervisor."
  }
]
```

CRITICAL RULE FOR DESCRIPTIONS: The 'Description' and 'KoreanDescription' fields MUST be a concise, executive summary of the security advisory. DO NOT copy-paste the raw descriptions or include long lists of CVE numbers. Describe WHAT the worst impact was and WHY we need to patch it.

## 5. Strict LLM Evaluation Rules

### 5.1 Scope Constraint
- Base your evaluation **ONLY** on the literal `[BATCH DATA]` provided in the prompt
- Do NOT use RAG retrieval, workspace files, or external knowledge to supplement the data
- Do NOT read or reference any JSON files in the workspace directory

### 5.2 Patch Type Handling
The input contains two types of advisories:
- `security_advisory` (VMSA-*): Always evaluate for CVE severity and impact
- `update_release` (Build/Update): Evaluate only if it addresses HA failure, data corruption, or critical performance degradation

### 5.3 Selection Logic per Component Group
For each vSphere component group:
1. If ANY advisory contains Critical CVEs (CVSS ≥ 8.5) → **Decision: Done**, select most recent
2. If ANY advisory fixes actively exploited RCE or privilege escalation → **Decision: Done**
3. If ALL advisories are Low/Moderate with no HA or data loss risk → **Decision: Exclude**
4. For `update_release` type only: include if it resolves a documented HA/vMotion/storage failure

### 5.4 Output Validation
| Field | Valid Values |
|-------|-------------|
| `Decision` | `Done` or `Exclude` only |
| `Criticality` | `Critical`, `High`, `Medium`, or `Low` only |
| `Vendor` | Must be exactly `VMware vSphere` |
| `IssueID` | Must match the GROUP's `patch_id` from input exactly |
| `Component` | e.g., `ESXi`, `vCenter Server`, `vSAN`, `NSX` |