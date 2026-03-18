---
name: Red Hat Enterprise Linux Patch Review Operation
description: Instructions for AI Agents to perform the quarterly Patch Review process for Red Hat Enterprise Linux (RHSA/RHBA advisories).
---

# Red Hat Enterprise Linux Patch Review Operation

This skill guides the AI Agent through the end-to-end process of generating a validated RHEL Patch Recommendation Report. The process involves collecting RHSA/RHBA advisory data, filtering against the Core Component whitelist, performing a deep impact analysis (LLM Check), and generating a final CSV report.

## 1. Prerequisites & Setup

Ensure the following scripts are available in your workspace (GitHub: `https://github.com/pjhwa/patch-review-dashboard-v2`, under `patch-review/os/linux/`):

**Red Hat Collectors (run via CRON):**
- `redhat/rhsa_collector.js` — Red Hat Security Advisories (CSAF API)
- `redhat/rhba_collector.js` — Red Hat Bug Fix Advisories (Hydra API)

**Preprocessing:**
- `patch_preprocessing.py` (Pruning & Aggregation — triggered by Dashboard pipeline)

> [!NOTE]
> **Orchestration:** Collectors are invoked by `run_collectors_cron.sh` and scheduled via Linux CRON. Data collection runs **independently** from the AI review pipeline and cannot be manually triggered from the Dashboard.

## 2. Process Workflow

### Step 1: Data Collection & Ingestion
Data collection is fully automated via **Linux CRON** (3rd Sunday of Mar/Jun/Sep/Dec at 06:00).

| Vendor | Collector | Output Directory |
|--------|-----------|-----------------|
| Red Hat | `redhat/rhsa_collector.js` (CSAF API) + `redhat/rhba_collector.js` (Hydra API) | `redhat/redhat_data/` |

**Key collection behaviors:**
- **Lookback period**: 180 days (6 months) per collector
- **Incremental mode**: Already-collected advisory IDs are skipped automatically
- **Retry logic**: Each collector retries failed requests with backoff before skipping

**To manually trigger collection (server only):**
```bash
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
cd redhat && node rhsa_collector.js && node rhba_collector.js && cd ..
```

> [!IMPORTANT]
> **Collection is CRON-only.** Do NOT invoke collector scripts from within `queue.ts` or the Dashboard pipeline.

### Step 2: Pruning & Aggregation (Automated)
The preprocessing script is triggered automatically by the Dashboard pipeline (`POST /api/pipeline/run` → BullMQ → `queue.ts`).

```bash
# Triggered by queue.ts (Dashboard pipeline) — default 90-day window:
python3 patch_preprocessing.py --vendor redhat --days 90

# Manual execution (server only):
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
python3 patch_preprocessing.py --vendor redhat --days 90
```

**What this step does:**
1. Reads JSON files from `redhat/redhat_data/` (files prefixed `RHSA-` or `RHBA-`)
2. Applies 90-day date filter (pipeline window; collectors use 180-day window)
3. Filters against **SYSTEM_CORE_COMPONENTS whitelist** (kernel, filesystem, cluster, systemd, libvirt, etc.)
4. Aggregates multiple updates for the same component into unified history
5. Writes results to `PreprocessedPatch` DB table (Prisma upsert)
6. Generates `patches_for_llm_review_redhat.json` for LLM review

### Step 3: Impact Analysis (Actual Agent Review)
**Action Required:** Read the `patches_for_llm_review_redhat.json` file. The Agent must **manually analyze** each candidate's `full_text` and `history` to determine if it meets the **Critical System Impact** criteria.

**Cumulative Recommendation Logic (CRITICAL):**
If a component has multiple updates within the quarter (e.g., kernel-5, kernel-4, kernel-3, kernel-2, kernel-1):
1. **Identify Critical Versions:** Determine which versions contain *Critical* fixes (e.g., kernel-3 and kernel-1 are Critical).
2. **Recommend Latest CRITICAL Version:** Select the **latest version that is Critical** (e.g., **kernel-3**). Do NOT simply recommend the absolute latest if it is a minor/non-critical update.
3. **Aggregate Critical Descriptions:** In the **Description**, merge only the critical fix details from the selected version and any older critical versions. Do not include noise from non-critical versions.

### Step 4: Final Report Generation
Output your final review decision for ALL candidates strictly as a JSON array named `patch_review_ai_report_redhat.json`. Do NOT wrap the output in markdown code blocks.

**Format:**
```json
[
  {
    "IssueID": "RHSA-2026:1234",
    "Component": "kernel",
    "Version": "5.14.0-503.26.2.el9_5",
    "Vendor": "Red Hat",
    "Date": "2026-01-15",
    "Criticality": "Critical",
    "Description": "Resolves use-after-free in kernel network stack allowing privilege escalation.",
    "KoreanDescription": "커널 네트워크 스택의 Use-After-Free 취약점으로 인한 권한 상승 위험 해결.",
    "Decision": "Approve",
    "Reason": "Critical RCE/privilege escalation risk."
  }
]
```

## 3. Strict LLM Evaluation Rules

### 3.1 Inclusion Criteria
Include a patch ONLY if it meets at least one of the following:
- **System Hang/Crash**: Kernel panics, deadlocks, OOM kills, boot failures.
- **Data Loss/Corruption**: Filesystem errors (XFS/ext4/btrfs), RAID failures, data integrity issues.
- **Critical Performance**: Severe memory leak or CPU regression affecting service capability.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Root), Authentication Bypass.
- **Failover Failure**: Issues affecting HA clusters (Pacemaker, Corosync, keepalived).
- **Hardware Compatibility**: Firmware or driver issues causing hardware failure or data loss.

### 3.2 Exclusion Criteria
Exclude a patch if:
- It is a minor bug fix (typos, log messages, edge cases not affecting stability).
- It is a "Moderate" security issue (local DoS, info disclosure) with limited impact.
- The patch is already superseded by a newer critical patch for the same component.
- It is an RHBA advisory for cosmetic or documentation changes only.

### 3.3 Output Format (JSON Schema)
Return ONLY a pure JSON array. Each object must have exactly these fields:
```json
{
  "IssueID": "RHSA-2026:1234 or RHBA-2026:1234",
  "Component": "kernel",
  "Version": "exact value from specific_version field",
  "Vendor": "Red Hat",
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
- For `Vendor` field: use exactly `"Red Hat"` (not "RHEL" or "Red Hat Enterprise Linux").
- For `Version` field: ALWAYS use the exact value from `specific_version` field. NEVER output "Unknown" or placeholder strings.
- For `OsVersion` field: preserve the `os_version` field as-is (e.g., `"RHEL 8, RHEL 9"`).
- Do NOT include raw `.patch` or `.rpm` filenames, CVE ID lists, or changelog copy-pastes in descriptions.
- Do NOT make up CVE numbers or version numbers.

### 3.5 Hallucination Prevention Rules
- NEVER invent CVE numbers not present in the source data.
- NEVER guess version numbers — use `specific_version` or `patch_name_suggestion` exactly.
- NEVER say "See the following advisory" — write actual content.
- NEVER output generic descriptions like "Security update for kernel".
- If `specific_version` is empty, use the latest version from `history` array.
- For multi-distribution patches, combine OS versions as a single comma-separated string.

## 4. Red Hat Specific Rules

- **Advisories**: RHSA (Security Advisory) and RHBA (Bug Fix Advisory).
- **Data location**: `redhat/redhat_data/` — files prefixed `RHSA-` or `RHBA-`.
- **Core whitelist**: kernel, kernel-uek, filesystem (xfs, ext4, btrfs), cluster tools (pacemaker, corosync), systemd, libvirt, glibc, openssl.
- **Vendor value**: `"Red Hat"` exactly.
- **Version format**: `"kernel-5.14.0-503.26.2.el9_5"` — use `specific_version` from source.
- **IssueID format**: `"RHSA-2026:1234"` or `"RHBA-2026:1234"` (colon separator, not hyphen).
- **Exclusion**: RHBA advisories for cosmetic/documentation changes only.
- **OsVersion**: String such as `"RHEL 8"` or `"RHEL 8, RHEL 9"` — from `os_version` field.

## 5. Description Quality Rules

- **Korean Description**:
  - **MUST** be a highly condensed, synthesized summary (1-2 sentences maximum).
  - **Do NOT** use generic phrases like "Security update for kernel" or simply list CVE IDs.
  - **Do NOT** include boilerplate text, URL links, or release note references.
  - **Do NOT** include raw `.patch` or `.rpm` filenames, or raw changelog snippets (e.g., `"[9.1.0-29] - kvm-target-i386..."`). Abstract these into a single summary sentence.
  - *Example (Bad):* `"[9.1.0-29] - kvm-target-i386-Expose-IBPB-BRTYPE-and-SBPB-CPUID-bits-t.patch (VM reports Vulnerable...)"`
  - *Example (Good):* `"메모리 부족 상황에서 데이터 손실을 유발할 수 있는 zswap 경쟁 상태 해결 및 nilfs_mdt_destroy의 GPF로 인한 시스템 크래시 방지."`
- **English Description**:
  - Synthesized summary matching the Korean description.
  - *Example (Good):* `"Resolves race condition in zswap causing potential data loss under memory pressure. Fixes GPF in nilfs_mdt_destroy preventing system crashes."`

## 6. Output Validation Rules
Before submitting your JSON response, verify:
1. Array length exactly matches the batch size.
2. Every object has all required fields (IssueID, Component, Version, Vendor, Date, Criticality, Description, KoreanDescription).
3. `IssueID` matches the source advisory ID exactly (e.g., `RHSA-2026:1234` with colon).
4. `Version` is not "Unknown", not empty, not a placeholder string.
5. `Vendor` is exactly `"Red Hat"` (case-sensitive).
6. Descriptions are 1-2 sentences maximum and contain no raw changelog snippets.
