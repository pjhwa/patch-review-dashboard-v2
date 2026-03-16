---
name: Ceph Storage Patch Review Operation
description: Instructions for AI Agents to review and evaluate Ceph storage security advisories and bug fix releases.
---

# Ceph Storage Patch Review Operation

This skill guides the AI Agent through the process of evaluating Ceph storage patches for security vulnerabilities and critical bug fixes.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `ceph_preprocessing.py` to extract key information from collected data.
```bash
python3 ceph_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_ceph.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_ceph.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `GHSA-mgrm-g92q-f8h8`)
- `vendor`: `Ceph`
- `component`: Component name (e.g., `ceph`, `rgw`, `osd`)
- `version`: Affected version
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `cvss_score`: CVSS score if available
- `cve_id`: CVE identifier if available
- `category`: Issue category (e.g., `Security (Critical)`, `Data Integrity`)
- `title`: Short description of the issue
- `description`: Detailed description of the fix
- `issued_date`: Release date

## 3. Evaluation Context

**Storage Criticality**: Ceph is a distributed storage system underpinning block, object, and filesystem storage. Vulnerabilities or bugs can cause data loss, corruption, or complete storage cluster unavailability affecting all dependent workloads.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **Denial of Service**: Vulnerabilities enabling DoS attacks on storage services (RGW, MON, OSD)
- **Data Loss / Corruption**: Bugs causing object loss, OSD corruption, or filesystem damage
- **Authentication Bypass**: Vulnerabilities enabling unauthorized access to storage
- **Remote Code Execution**: Any CVE enabling RCE on Ceph daemons
- **Cluster Unavailability**: Bugs causing MON quorum loss or OSD cascading failure
- **Replication / Consistency**: Issues breaking data replication or CRUSH map consistency

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 7.0 or severity Medium/Low
- No data loss or corruption risk
- No authentication or access control concerns
- Only minor performance improvements or documentation updates

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "GHSA-mgrm-g92q-f8h8",
  "Component": "ceph-rgw",
  "Version": "18.2.x",
  "Vendor": "Ceph",
  "Date": "2025-11-11",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity DoS vulnerability in RGW object storage service"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `Ceph`
- For `Component` use the specific Ceph component (e.g., `ceph-osd`, `ceph-rgw`, `ceph-mon`, `ceph`)
- Descriptions must be concise executive summaries, not raw changelogs
