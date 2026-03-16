---
name: VMware vSphere Patch Review Operation
description: Instructions for AI Agents to review and evaluate VMware vSphere security advisories and update releases for ESXi and vCenter Server.
---

# VMware vSphere Patch Review Operation

This skill guides the AI Agent through the process of evaluating VMware vSphere patches (security advisories and update releases) for ESXi and vCenter Server.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `vsphere_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 vsphere_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_vsphere.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_vsphere.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `VSPH-VMSA-2025-0016_vCenter_Server_8.0`)
- `vendor`: `VMware (Broadcom)`
- `product`: Product name and version (e.g., `ESXi 8.0`, `vCenter Server 7.0`)
- `type`: `security_advisory` (VMSA CVE advisories) or `update_release` (Build/Update releases)
- `published`: Release date
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `total_cves`: Number of CVEs addressed
- `max_cvss`: Maximum CVSS base score
- `description`: Detailed description of fixes and vulnerabilities
- `url`: Link to release notes or security advisory

## 3. Evaluation Context

**Infrastructure Criticality**: ESXi and vCenter Server are foundational hypervisor infrastructure. Vulnerabilities can affect all hosted virtual machines and the entire virtualized environment.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Security Advisory (VMSA)**: Any VMSA with `advisory_severity` of Critical or High, or CVSS ≥ 7.0
- **Actively Exploited**: Any CVE marked `is_actively_exploited: true` — ALWAYS include regardless of severity
- **RCE / Privilege Escalation**: Any CVE enabling Remote Code Execution or Privilege Escalation on hypervisor
- **Authentication Bypass**: Any CVE enabling unauthorized access to vCenter or ESXi
- **Host Crash (PSOD)**: Update releases with High-severity Purple Screen of Death (PSOD) fixes
- **Data Loss Risk**: Fixes for VM disk corruption, vSAN data loss, snapshot corruption

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- No CVEs, or only CVEs with CVSS < 7.0
- No actively exploited vulnerabilities
- All non-CVE fixes are severity Medium or Low
- No host crash or data loss risk

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "VSPH-VMSA-2025-0016_vCenter_Server_8.0",
  "Component": "vCenter Server",
  "Version": "8.0 U3g",
  "Vendor": "VMware vSphere",
  "Date": "2025-09-29",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity VMSA with CVSS 8.5 RCE vulnerability in vCenter"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `VMware vSphere`
- For `Component` use the specific product: `ESXi`, `vCenter Server`, or `vSphere`
- Descriptions must be concise executive summaries, not raw changelogs
