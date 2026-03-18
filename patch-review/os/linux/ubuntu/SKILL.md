---
name: Ubuntu Linux Patch Review Operation
description: Instructions for AI Agents to perform the quarterly Patch Review process for Ubuntu Linux (USN advisories), covering LTS versions only.
---

# Ubuntu Linux Patch Review Operation

This skill guides the AI Agent through the end-to-end process of generating a validated Ubuntu Patch Recommendation Report. The process involves collecting USN (Ubuntu Security Notice) data from Canonical GitHub, filtering against LTS versions and the Core Component whitelist, performing a deep impact analysis (LLM Check), and generating a final CSV report.

## 1. Prerequisites & Setup

Ensure the following scripts are available in your workspace (GitHub: `https://github.com/pjhwa/patch-review-dashboard-v2`, under `patch-review/os/linux/`):

**Ubuntu Collectors (run via CRON):**
- `ubuntu/ubuntu_collector.sh` — Clones Canonical's ubuntu-security-notices GitHub repo and converts USN JSON files

**Preprocessing:**
- `patch_preprocessing.py` (Pruning & Aggregation — triggered by Dashboard pipeline)

> [!NOTE]
> **Orchestration:** Collectors are invoked by `run_collectors_cron.sh` and scheduled via Linux CRON. Data collection runs **independently** from the AI review pipeline and cannot be manually triggered from the Dashboard.

## 2. Process Workflow

### Step 1: Data Collection & Ingestion
Data collection is fully automated via **Linux CRON** (3rd Sunday of Mar/Jun/Sep/Dec at 06:00).

| Vendor | Collector | Output Directory |
|--------|-----------|-----------------|
| Ubuntu | `ubuntu/ubuntu_collector.sh` (Canonical GitHub + jq) | `ubuntu/ubuntu_data/` |

**Key collection behaviors:**
- **Lookback period**: 180 days (6 months)
- **Incremental mode**: Already-collected USN IDs are skipped automatically
- Ubuntu publishes multiple USN revisions for the same vulnerability (e.g., USN-5376-1, USN-5376-2, USN-5376-4)

**To manually trigger collection (server only):**
```bash
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
cd ubuntu && bash ubuntu_collector.sh && cd ..
```

> [!IMPORTANT]
> **Collection is CRON-only.** Do NOT invoke collector scripts from within `queue.ts` or the Dashboard pipeline.

### Step 2: Pruning & Aggregation (Automated)
The preprocessing script is triggered automatically by the Dashboard pipeline (`POST /api/pipeline/run` → BullMQ → `queue.ts`).

```bash
# Triggered by queue.ts (Dashboard pipeline) — full 180-day collection window:
python3 patch_preprocessing.py --vendor ubuntu --days 180

# Manual execution (server only):
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
python3 patch_preprocessing.py --vendor ubuntu --days 180
```

**What this step does:**
1. Reads JSON files from `ubuntu/ubuntu_data/` (files prefixed `USN-`)
2. Applies 180-day date filter to capture the full collection window
3. **LTS filter**: Discards USNs that only affect non-LTS versions (25.10, 24.10, etc.)
4. Filters against **SYSTEM_CORE_COMPONENTS whitelist** (kernel, linux-hwe, filesystem, cluster, systemd, etc.)
5. Aggregates multiple updates for the same component into unified history
6. Writes results to `PreprocessedPatch` DB table (Prisma upsert)
7. Generates `patches_for_llm_review_ubuntu.json` for LLM review

### Step 3: Impact Analysis (Actual Agent Review)
**Action Required:** Read the `patches_for_llm_review_ubuntu.json` file. The Agent must **manually analyze** each candidate's `full_text` and `history` to determine if it meets the **Critical System Impact** criteria.

**Review Date Window (CRITICAL):**
The preprocessing dataset covers the full 180-day collection window. Apply the following date-based filtering rules during review:
- **Non-kernel USNs** (openssl, systemd, runc, containerd, openssh, etc.): Include ONLY USNs issued between **180 days ago and 90 days ago**. USNs issued within the most recent 90 days are not yet mature for this review cycle — **exclude them**.
- **Kernel USNs** (`linux`, `linux-hwe`, `linux-image-*`, and kernel variant packages): Include USNs across the **full 0–180 day window**, including the most recent. Kernel security fixes require immediate attention regardless of age.

> Example: Today is 2026-03-18.
> - Non-kernel review window: 2025-09-19 ~ 2025-12-18 (180→90 days ago)
> - Kernel review window: 2025-09-19 ~ 2026-03-18 (full 180 days)

**Cumulative Recommendation Logic (CRITICAL):**
If a component has multiple updates within the quarter:
1. **Identify Critical Versions:** Determine which versions contain *Critical* fixes.
2. **Recommend Latest CRITICAL Version:** Select the **latest version that is Critical**. Do NOT simply recommend the absolute latest if it is a minor/non-critical update.
3. **Aggregate Critical Descriptions:** Merge only the critical fix details. Do not include noise from non-critical versions.

### Step 4: Final Report Generation
Output your final review decision for ALL candidates strictly as a JSON array named `patch_review_ai_report_ubuntu.json`. Do NOT wrap the output in markdown code blocks.

**Format:**
```json
[
  {
    "IssueID": "USN-7851-2",
    "Component": "runc",
    "Version": "1.3.3-0ubuntu1~24.04.3",
    "Vendor": "Ubuntu",
    "OsVersion": "22.04 LTS, 24.04 LTS",
    "Date": "2026-02-14",
    "Criticality": "Critical",
    "Description": "Resolves container escape vulnerabilities in runc allowing host compromise.",
    "KoreanDescription": "컨테이너 탈출 취약점으로 호스트 시스템 침해 가능성 차단.",
    "Decision": "Approve",
    "Reason": "High risk of host compromise via container escape."
  }
]
```

**Content Guidelines (CRITICAL):**
- **OsVersion**: MUST be populated from the JSON `os_version` field. Preserve as a single string (e.g., `"22.04 LTS, 24.04 LTS"`). **Do NOT create multiple rows** for a single patch.
- **Reference**: MUST be populated with the `ref_url` (or `url`) field from source JSON. Do NOT leave as "Unknown".
- **Version**: YOU MUST USE THE EXACT VALUE FROM THE `specific_version` FIELD. NEVER output `"Unknown"`, `"1.1.x"`, or placeholder strings.

## 3. Strict LLM Evaluation Rules

### 3.1 Inclusion Criteria
Include a patch ONLY if it meets at least one of the following:
- **System Hang/Crash**: Kernel panics, deadlocks, OOM kills, boot failures.
- **Data Loss/Corruption**: Filesystem errors, RAID failures, data integrity issues.
- **Critical Performance**: Severe memory leak or CPU regression affecting service capability.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Root), Authentication Bypass, Container Escape.
- **Failover Failure**: Issues affecting HA clusters (Pacemaker, Corosync, keepalived).

### 3.2 Exclusion Criteria
Exclude a patch if:
- It is a minor bug fix (typos, log messages, edge cases not affecting stability).
- It is a "Moderate" security issue (local DoS, info disclosure) with limited impact.
- **LTS ONLY**: Only affects non-LTS versions (e.g., Ubuntu 25.10, 24.10). MUST support LTS (24.04, 22.04, 20.04).
  - *Example:* "USN-7906-1 affects only Ubuntu 25.10 → **EXCLUDE**."
- The patch is already superseded by a newer critical patch for the same component.
- **Date Window (non-kernel)**: The USN was issued within the last 90 days AND the component is NOT a kernel package (`linux`, `linux-hwe`, `linux-image-*`). These are excluded from the current review cycle.
- **Exception**: Kernel USNs (`linux`, `linux-hwe`, `linux-azure`, `linux-aws`, `linux-gcp`, `linux-fips`, etc.) issued within the last 90 days are **NOT** excluded — they must be reviewed regardless of age.

### 3.3 Output Format (JSON Schema)
Return ONLY a pure JSON array. Each object must have exactly these fields:
```json
{
  "IssueID": "USN-7851-2",
  "Component": "runc (or specific component name)",
  "Version": "exact version from specific_version field",
  "Vendor": "Ubuntu",
  "OsVersion": "22.04 LTS, 24.04 LTS",
  "Date": "YYYY-MM-DD",
  "Criticality": "Critical | High | Moderate | Low",
  "Description": "1-2 sentence English executive summary",
  "KoreanDescription": "1-2 sentence Korean executive summary",
  "Decision": "Approve | Exclude",
  "Reason": "Brief justification"
}
```

### 3.4 General Rules
- Return EXACTLY the same number of objects as input patches in the batch.
- For `Vendor` field: use exactly `"Ubuntu"` (not "Canonical").
- For `Version` field: ALWAYS use the exact value from `specific_version` field. NEVER output "Unknown" or placeholder strings.
- For `OsVersion` field: preserve the `os_version` field as-is (e.g., `"22.04 LTS, 24.04 LTS"`).
- Do NOT create multiple JSON objects for one USN (even if it covers multiple LTS releases).
- Do NOT include raw package filenames, CVE ID lists, or changelog copy-pastes in descriptions.
- Do NOT make up CVE numbers or version numbers.

### 3.5 Hallucination Prevention Rules
- NEVER invent CVE numbers not present in the source data.
- NEVER guess version numbers — use `specific_version` exactly.
- NEVER include USNs that only affect non-LTS versions.
- NEVER confuse kernel variants (FIPS, GCP, NVIDIA, Tegra) — these USNs cover specific kernel builds only.
- NEVER say "See the following advisory" — write actual content.
- NEVER output generic descriptions like "Security update for kernel".
- If `specific_version` is empty, use the version from the `packages` array for the target LTS release.
- NEVER include non-kernel USNs issued within the last 90 days — these are outside the current review window.

## 4. Ubuntu Specific Rules

- **Advisories**: USN (Ubuntu Security Notices) from Canonical's ubuntu-security-notices GitHub repository.
- **Data location**: `ubuntu/ubuntu_data/` — files prefixed `USN-`.
- **Core whitelist**: kernel, linux-hwe, filesystem (ext4, xfs), systemd, openssl, glibc, runc, containerd.
- **Vendor value**: `"Ubuntu"` exactly (not "Canonical").
- **IssueID format**: `"USN-7851-2"` (hyphen separator).
- **LTS Target Versions**: Ubuntu 20.04 LTS, 22.04 LTS, 24.04 LTS.
  - Non-LTS versions (25.10, 24.10, 23.10, etc.) are **excluded** unless they also affect an LTS version.
- **Kernel Variants**: Some USNs cover specific kernel variants only:
  - FIPS kernels: only for certified environments
  - GCP/AWS/Azure kernels: cloud-specific builds
  - NVIDIA kernels: GPU-specific builds
  - Tegra kernels: ARM/embedded specific
  - Include variant USNs only if they are relevant to the server environment (FIPS, cloud).
- **OsVersion**: Preserve as a single comma-separated string (e.g., `"22.04 LTS, 24.04 LTS"`). Do NOT split into multiple records.

## 5. Description Quality Rules

- **Korean Description**:
  - **MUST** be a highly condensed, synthesized summary (1-2 sentences maximum).
  - **Do NOT** use generic phrases like "Security update for kernel" or simply list CVE IDs.
  - **Do NOT** include boilerplate text, URL links, or release note references.
  - **Do NOT** include raw package filenames. Abstract into a summary sentence.
  - Mention the specific vulnerability type and affected LTS version(s).
  - *Example (Good):* `"컨테이너 런타임 runc의 경계 검사 오류로 인한 컨테이너 탈출 취약점 해결 (22.04 LTS, 24.04 LTS)."`
- **English Description**:
  - Synthesized summary matching the Korean description.
  - *Example (Good):* `"Resolves boundary check error in runc container runtime preventing container escape on Ubuntu 22.04 and 24.04 LTS."`

## 6. Output Validation Rules
Before submitting your JSON response, verify:
1. Array length exactly matches the batch size.
2. Every object has all required fields (IssueID, Component, Version, Vendor, OsVersion, Date, Criticality, Description, KoreanDescription).
3. `IssueID` matches the source USN ID exactly (e.g., `USN-7851-2`).
4. `Version` is not "Unknown", not empty, not a placeholder string.
5. `Vendor` is exactly `"Ubuntu"` (case-sensitive, not "Canonical").
6. NO USN is included that only affects non-LTS Ubuntu versions.
7. Each USN produces exactly ONE output object (not one per LTS version).
8. Descriptions are 1-2 sentences maximum and contain no raw package filenames.
9. Non-kernel USNs issued within the last 90 days are excluded (date window rule).
10. Kernel USNs (`linux`, `linux-hwe`, `linux-*` variants) issued within the last 90 days are included (kernel exception).
