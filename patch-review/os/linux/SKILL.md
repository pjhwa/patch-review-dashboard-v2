---
name: Patch Review Board (PRB) Operation
description: Instructions for AI Agents to perform the quarterly OS Patch Review process for Red Hat, Oracle Linux, Ubuntu, and Windows Server.
---

# Patch Review Board (PRB) Operation

This skill guides the AI Agent through the end-to-end process of generating a validated OS Patch Recommendation Report. The process involves collecting patch data, filtering out non-critical components, performing a deep impact analysis (LLM Check), and generating a final CSV report.

## 1. Prerequisites & Setup

Ensure the following scripts are available in your workspace (GitHub: `https://github.com/pjhwa/patch-review-dashboard-v2`, under `patch-review/os/linux/`):

**Linux OS Collectors (per-vendor, run via CRON):**
- `redhat/rhsa_collector.js` — Red Hat Security Advisories (CSAF API)
- `redhat/rhba_collector.js` — Red Hat Bug Fix Advisories (Hydra API)
- `oracle/oracle_collector.sh` + `oracle/oracle_parser.py` — Oracle Linux (yum updateinfo.xml)
- `ubuntu/ubuntu_collector.sh` — Ubuntu (Canonical GitHub clone + jq)

**Preprocessing:**
- `patch_preprocessing.py` (Pruning & Aggregation — triggered by Dashboard pipeline)

> [!NOTE]
> **Orchestration:** All Linux collectors are invoked by `run_collectors_cron.sh` and scheduled via Linux CRON on the server. Data collection runs **independently** from the AI review pipeline and cannot be manually triggered from the Dashboard.

## 2. Process Workflow

### Step 1: Data Collection & Ingestion
Data collection is fully automated via **Linux CRON** (3rd Sunday of Mar/Jun/Sep/Dec at 06:00). Each vendor has a dedicated collector script that writes normalized advisory JSON files to its own data directory.

| Vendor | Collector | Output Directory |
|--------|-----------|-----------------|
| Red Hat | `redhat/rhsa_collector.js` (CSAF API) + `redhat/rhba_collector.js` (Hydra API) | `redhat/redhat_data/` |
| Oracle Linux | `oracle/oracle_collector.sh` + `oracle/oracle_parser.py` (yum updateinfo.xml) | `oracle/oracle_data/` |
| Ubuntu | `ubuntu/ubuntu_collector.sh` (Canonical GitHub + jq) | `ubuntu/ubuntu_data/` |

**Key collection behaviors:**
- **Lookback period**: 180 days (6 months) per collector
- **Incremental mode**: Already-collected advisory IDs are skipped automatically
- **Retry logic**: Each collector retries failed requests with backoff before skipping

**To manually trigger collection (server only):**
```bash
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
bash run_collectors_cron.sh
```

*Goal: Ensure `redhat/redhat_data/`, `oracle/oracle_data/`, `ubuntu/ubuntu_data/` are populated with advisory JSON files before running the preprocessing step.*

> [!IMPORTANT]
> **Collection is CRON-only.** Do NOT invoke collector scripts from within `queue.ts` or the Dashboard pipeline. The Dashboard pipeline (Step 2 onward) assumes collection has already been completed by CRON.

### Step 2: Pruning & Aggregation (Automated)
The preprocessing script is triggered automatically by the Dashboard pipeline (`POST /api/pipeline/run` → BullMQ → `queue.ts`). It reads all vendor data directories, applies the Core Component whitelist filter, and writes results to both the database and a JSON file for LLM review.

```bash
# Triggered by queue.ts (Dashboard pipeline) — 180-day window (6 months):
python3 patch_preprocessing.py --days 180

# Manual execution (server only):
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
python3 patch_preprocessing.py --days 180
# or: python3 patch_preprocessing.py --quarter 2026-Q1
```

**What this step does:**
1. Reads JSON files from `redhat/redhat_data/`, `oracle/oracle_data/`, `ubuntu/ubuntu_data/`
2. Applies **180-day date filter** (6-month lookback), internally split into two windows:
   - **Recent window** (0~90 days ago): **Critical-severity kernel patches only** + all whitelisted non-kernel patches
   - **Early window** (90~180 days ago): **Critical or Important severity kernel patches only**; the most recent one per (vendor, component, OS version) group — used as fallback if recent Critical patch does not meet review criteria
3. Filters against **SYSTEM_CORE_COMPONENTS whitelist** (kernel, filesystem, cluster, systemd, libvirt, etc.)
4. Aggregates multiple updates for the same component into unified history
5. Writes results to `PreprocessedPatch` DB table (Prisma upsert)
6. Generates `patches_for_llm_review.json` for LLM review (Step 3)
7. Emits `[PREPROCESS_DONE] count=N` log → Dashboard counter updates in real time

**Kernel dual-window output:** Each item in `patches_for_llm_review.json` has a `window_type` field:
- `"recent"`: patch is from the last 3 months (0~90 days ago); **Critical-severity only**
- `"early"`: patch is from 3~6 months ago (90~180 days ago); **Critical or Important severity**; one per (vendor, component, OS version) group (most recent only) — fallback candidate

*Goal: Generate `patches_for_llm_review.json` and populate `PreprocessedPatch` DB table. This file contains the filtered, consolidated list of candidates within the target date range.*

### Step 3: Impact Analysis (Actual Agent Review)
**Action Required:** Read the `patches_for_llm_review.json` file. The Agent must **manually analyze** each candidate's `full_text` and `history` to determine if it meets the **Critical System Impact** criteria. **Do not rely on simple scripts for this step.**

---

### Kernel Dual-Window Evaluation (CRITICAL — applies to kernel and kernel-related patches)

Each kernel patch in `patches_for_llm_review.json` has a `window_type` field:
- `"recent"` — patch from the last 3 months (0~90 days). **Critical-severity only.** All patches that passed the Critical threshold are included.
- `"early"` — patch from 3~6 months ago (90~180 days). **Critical or Important severity.** Only the most recent patch per (vendor, OS version, component) is included as a fallback candidate.

**Evaluation Order for kernel/kernel-related patches (per vendor, per OS version):**

1. **Find the `window_type: "recent"` kernel patch** (Critical-severity) for this OS version.
   - Evaluate it against the Inclusion Criteria (Section 4.1).
   - If it meets at least one criterion → **Decision: Approve**. Mark any `window_type: "early"` patch for the same OS version/component as **Decision: Exclude** (reason: "Recent Critical patch is sufficient").
2. **If the `window_type: "recent"` kernel patch does NOT meet any criterion** → **Decision: Exclude** for that patch, then evaluate the `window_type: "early"` patch (Critical or Important) for the same OS version/component.
   - If the early patch meets at least one Inclusion Criterion → **Decision: Approve** (reason: "Recent Critical patch insufficient; fallback to early Critical/Important patch").
   - If the early patch also does not qualify → **Decision: Exclude** both.
3. **If there is no `window_type: "recent"` patch** but a `window_type: "early"` patch exists → evaluate the early patch directly against Inclusion Criteria.
4. **If a specific OS version has no kernel or kernel-related patches** in either window → skip (no output row required for that version).

> **Note:** Non-kernel patches (filesystem, cluster, security, etc.) always have `window_type: "recent"`. Apply the standard single-window evaluation for those.

---

**Cumulative Recommendation Logic (CRITICAL — for recent-window patches with multiple history entries):**
If a component has multiple updates within the quarter (e.g., kernel-5, kernel-4, kernel-3, kernel-2, kernel-1):
1.  **Identify Critical Versions:** Determine which versions in the history contain *Critical* fixes (e.g., kernel-3 and kernel-1 are Critical; kernel-5, kernel-4, kernel-2 are Not Critical).
2.  **Recommend Latest CRITICAL Version:** Select the **latest version that is Critical** (e.g., **kernel-3**). cannot simply recommend the absolute latest (kernel-5) if it is just a minor/non-critical update.
3.  **Aggregate Critical Descriptions:** In the **Description**, merge only the critical fix details from the selected version (kernel-3) and any older critical versions (kernel-1). Do not include noise from non-critical versions.

**Criteria for Inclusion:**
- **System Hang/Crash**: Kernel panics, deadlocks, boot failures.
- **Data Loss/Corruption**: Filesystem errors, raid failures, data integrity issues.
- **Critical Performance**: Severe degradation affecting service capability.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Root), Auth Bypass.
- **Failover Failure**: Issues affecting High Availability (Pacemaker, Corosync).

**Criteria for Exclusion:**
- Minor bug fixes (typos, logging noise).
- Edge cases not affecting stability.
- "Moderate" security issues (local DoS, info leak) unless widespread.
- **Support Window Exclusion (Ubuntu)**:
    - **Do NOT** include patches affecting *only* non-LTS versions (e.g., Ubuntu 25.10, 24.10).
    - **MUST** prioritize LTS versions (24.04, 22.04, 20.04).
    - *Example:* "USN-7906-1 affects only Ubuntu 25.10 -> **EXCLUDE**."
- **Specific Version Lookup**:
    - **CRITICAL:** Use the pre-calculated `specific_version` (or `patch_name_suggestion`) explicitly provided in the `patches_for_llm_review.json` input data block!
    - DO NOT output "Unknown" if `specific_version` has a valid string.

### Step 4: Final Report Generation
Output your final review decision for ALL candidates strictly as a JSON Data file named `patch_review_ai_report.json`.
Do NOT wrap the output in any markdown code blocks, just output the raw JSON array containing the decisions.

**Format:**
```json
[
  {
    "id": "USN-7851-2-2204",
    "vendor": "Ubuntu",
    "OsVersion": "22.04 LTS",
    "distVersion": "22.04 LTS",
    "component": "runc",
    "version": "1.3.3-0ubuntu1~24.04.3",
    "date": "2026-02-14",
    "criticality": "Critical",
    "description": "Resolves container escape vulnerabilities.",
    "koreanDescription": "컨테이너 탈취 취약점 해결.",
    "decision": "Approve",
    "reason": "High risk of host compromise.",
    "reference": "https://ubuntu.com/security/notices/USN-7851-2"
  }
]
```

**Content Guidelines (CRITICAL):**
- **OsVersion**:
    - **MUST** be populated with the specific OS version from the JSON `os_version` field.
    - For Red Hat / Oracle: a patch may cover multiple versions combined in `os_version` (e.g. `"RHEL 8, RHEL 9"`). Preserve as a single string.
    - For Ubuntu: each input entry is already split per LTS version (e.g. `"22.04 LTS"`). Return that single value. Do NOT combine or expand.
    - **Do NOT create multiple rows** for a single input entry. Output exactly one JSON object per input item.
- **Dist Version**:
    - **MUST** be populated with the primary OS version from the JSON `dist_version` field.
- **Ubuntu Variant-Specific USNs**: Some USNs only cover a specific kernel variant (FIPS, GCP, NVIDIA, Tegra). Verify the `Releases` section in the advisory `full_text`.
    - USN-8033-3 (FIPS): covers 22.04 LTS only.
    - USN-8031-1 (GCP): covers 22.04 LTS only.
- **Reference**:
    - **MUST** be populated with the `ref_url` (or `url`) field from the source JSON.
    - **Do NOT** leave as "Unknown" if a URL is available in the source data.
- **Version**:
    - **CRITICAL INSTRUCTION:** YOU MUST USE THE EXACT VALUE PROVIDED IN THE `specific_version` FIELD (or `patch_name_suggestion`) OF THE SOURCE JSON INPUT!! 
    - Do NOT attempt to manually extract or guess the version from the `full_text` or `diff_content` unless the `specific_version` field is literally empty or missing.
    - **NEVER** use placeholder strings like `"(latest for 22.04)"`, `"1.1.x"`, or `"5.15.0 (linux-hwe)"` or `"Unknown"`.
- **한글 설명 (Korean Description)**:
    - **Do NOT** use generic phrases like "Security update for kernel" or simply list CVE IDs.
    - **Do NOT** include boilerplate text, URL links, update instructions, or release note references (e.g., "See the following advisory for the RPM packages", "Space precludes documenting...").
    - **Do NOT** include raw lists of `.patch` or `.rpm` filenames, or raw changelog snippets (e.g., "[9.1.0-29] - kvm-target-i386..."). You MUST abstract these into a single summary sentence describing the actual bug fixed.
    - **MUST** be a highly condensed, synthesized summary (1-2 sentences maximum). Explain exactly **what** functionality is broken and **how** it affects the system.
    - **Keywords to look for**: "System Hang", "Memory Leak", "Race Condition", "Use-After-Free", "Data Corruption", "Panic".
    - *Example (Bad 1):* "커널 보안 업데이트. 다음 문제를 해결함: See the following advisory for the RPM packages for this release... Space precludes documenting..."
    - *Example (Bad 2):* "[9.1.0-29] - kvm-target-i386-Expose-IBPB-BRTYPE-and-SBPB-CPUID-bits-t.patch (VM reports Vulnerable to spec_rstack_overflow...)"
    - *Example (Good):* "메모리 부족 상황에서 데이터 손실을 유발할 수 있는 zswap 경쟁 상태 해결 및 `nilfs_mdt_destroy`의 일반 보호 오류(GPF)로 인한 시스템 크래시 방지."

- **Patch Description (English)**:
    - **Do NOT** simply copy/paste the `diff_summary` or log, and **NEVER** include raw advisory paragraphs, `.patch` lists, or raw changelog lines.
    - **MUST** be a **synthesized summary** of the **Korean Description** (1-2 sentences maximum).
    - It should convey the exact same critical impact and specific fix details as the Korean text, but in English.
    - *Example (Bad):* "[9.1.0-29] - kvm-target-i386-Expose-IBPB-BRTYPE...patch Resolves: RHEL-17614"
    - *Example (Good):* "Resolves Race Condition in zswap causing potential data loss under memory pressure. Fixes General Protection Fault (GPF) in `nilfs_mdt_destroy` preventing system crashes."

**Note:** Ensure the description reflects that it is a cumulative update if applicable (e.g., appending "(누적 패치 포함: 3건)").

## 3. Execution Example

**User Request:** "Run the PRB for Q1 2026."

**Agent Actions:**
1.  *(Pre-condition)* Confirm CRON has already run `run_collectors_cron.sh` and `redhat/redhat_data/`, `oracle/oracle_data/`, `ubuntu/ubuntu_data/` contain current advisory JSON files.
    - Manual check: `ls -lh redhat/redhat_data/ oracle/oracle_data/ ubuntu/ubuntu_data/`
    - If collection has not run yet, manually trigger: `bash run_collectors_cron.sh`
2.  Run preprocessing via Dashboard pipeline (`POST /api/pipeline/run`) **or** manually:
    `python3 patch_preprocessing.py --quarter 2026-Q1`
3.  Read `patches_for_llm_review.json`.
4.  *Thinking Process*:
    *   "Candidate: kernel-uek... Impacts: Data Loss. -> **INCLUDE**."
    *   "Candidate: python-libs... Impacts: Minor fix. -> **EXCLUDE**."
5.  Create `patch_review_ai_report.json` with the approved JSON array list.
6.  Notify User: "Report generated at [path]."

## 4. Strict LLM Evaluation Rules

These rules apply to all Linux vendor pipelines (Red Hat, Oracle Linux, Ubuntu). The AI must evaluate each patch according to this section.

### 4.1 Inclusion Criteria

Include a patch ONLY if it meets at least one of the following:
- **System Hang/Crash**: Kernel panics, deadlocks, OOM kills, boot failures.
- **Data Loss/Corruption**: Filesystem errors, RAID failures, write barriers, data integrity.
- **Critical Performance**: Severe memory leak or CPU regression affecting service capability.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Root), Authentication Bypass.
- **Failover Failure**: Issues affecting HA clusters (Pacemaker, Corosync, keepalived).
- **Hardware Compatibility**: Firmware or driver issues causing hardware failure or data loss.

### 4.2 Exclusion Criteria

Exclude a patch if:
- It is a minor bug fix (typos, log messages, edge cases not affecting stability).
- It is a "Moderate" security issue (local DoS, info disclosure) with limited impact.
- **Ubuntu**: Only affects non-LTS versions (e.g., 25.10, 24.10). Must support LTS (24.04, 22.04, 20.04).
- The patch is already superseded by a newer critical patch for the same component.

### 4.3 Output Format (JSON Schema)

Return ONLY a pure JSON array. Each object must have exactly these fields:
```json
{
  "IssueID": "RHSA-2026-1234 or USN-7851-2-2204 or ELSA-2026-0001",
  "Component": "kernel (or specific component name)",
  "Version": "exact version from specific_version field",
  "Vendor": "Red Hat | Oracle | Ubuntu",
  "Date": "YYYY-MM-DD",
  "Criticality": "Critical | High | Moderate | Low",
  "Description": "1-2 sentence English executive summary",
  "KoreanDescription": "1-2 sentence Korean executive summary",
  "Decision": "Approve | Exclude",
  "Reason": "Brief justification"
}
```

### 4.4 General Rules

- Return EXACTLY the same number of objects as input patches in the batch.
- For `Vendor` field: use exactly `"Red Hat"`, `"Oracle"`, or `"Ubuntu"` (no abbreviations).
- For `Version` field: ALWAYS use the exact value from `specific_version` field in source data. NEVER output "Unknown" or placeholder strings.
- For `OsVersion` field: preserve the `os_version` field from source JSON as-is.
- Do NOT include raw `.patch` filenames, CVE IDs list, or changelog copy-pastes in descriptions.
- Do NOT make up CVE numbers or version numbers.

### 4.5 Hallucination Prevention Rules

- NEVER invent CVE numbers not present in the source data.
- NEVER guess version numbers — use `specific_version` or `patch_name_suggestion` exactly.
- NEVER say "See the following advisory" — write actual content.
- NEVER output generic descriptions like "Security update for kernel".
- If `specific_version` is empty, use the latest version from `history` array.
- For Ubuntu: do NOT strip the `-2204` / `-2404` OS version suffix from `IssueID`. Return it exactly as given in the input `id` field.

## 5. Output Validation Rules

Before submitting your JSON response, verify:
1. Array length exactly matches the batch size.
2. Every object has all required fields (IssueID, Component, Version, Vendor, Date, Criticality, Description, KoreanDescription).
3. `IssueID` matches the source advisory ID (not made up).
4. `Version` is not "Unknown", not empty, not a placeholder string.
5. `Vendor` is exactly "Red Hat", "Oracle", or "Ubuntu" (case-sensitive).
6. Descriptions are 1-2 sentences maximum and contain no raw changelog snippets.

## 6. Vendor-Specific Rules

### 6.1 Red Hat (RHSA-*/RHBA-*)

- **Advisories**: RHSA (Security), RHBA (Bug Fix) from CSAF API and Hydra API.
- **Data location**: `redhat/redhat_data/` — files prefixed `RHSA-` or `RHBA-`.
- **Core whitelist**: kernel, kernel-uek, filesystem (xfs, ext4, btrfs), cluster tools (pacemaker, corosync), systemd, libvirt, glibc.
- **Vendor value**: `"Red Hat"` (not "RHEL" or "Red Hat Enterprise Linux").
- **Version**: Use `specific_version` from source. Format: `"kernel-5.14.0-503.26.2.el9_5"`.
- **IssueID format**: `"RHSA-2026:1234"` or `"RHBA-2026:1234"`.
- **Exclusion**: RHBA advisories for cosmetic/documentation changes only.

### 6.2 Oracle Linux (ELSA-*)

- **Advisories**: ELSA (Oracle Linux Security Advisories) from yum updateinfo.xml.
- **Data location**: `oracle/oracle_data/` — files prefixed `ELSA-`.
- **Vendor value**: `"Oracle"` (not "Oracle Linux").
- **Version**: Use `specific_version` from source. Oracle mirrors RHEL package versions closely.
- **IssueID format**: `"ELSA-2026-1234"`.
- **Note**: Oracle Linux uses UEK (Unbreakable Enterprise Kernel) alongside RHCK. Both are valid.

### 6.3 Ubuntu (USN-*)

- **Advisories**: USN (Ubuntu Security Notices) from Canonical GitHub.
- **Data location**: `ubuntu/ubuntu_data/` — files prefixed `USN-`.
- **Vendor value**: `"Ubuntu"` (not "Canonical").
- **LTS ONLY**: Only include patches affecting LTS versions (24.04, 22.04, 20.04). Skip 25.10, 24.10.
- **Variant USNs**: Some USNs cover FIPS, GCP, NVIDIA, or Tegra kernels only. Include if relevant to server environments.
- **IssueID format**: `"USN-7851-2-2204"` (original USN ID + `-XXYY` OS version suffix). The suffix identifies the target LTS: `2204` = 22.04 LTS, `2404` = 24.04 LTS. Return this full ID as-is; do NOT strip the suffix.
- **Per-OS-version entries**: Each USN is split into one entry per active LTS version during preprocessing. A USN covering both 22.04 and 24.04 appears as two separate input items (`USN-7851-2-2204`, `USN-7851-2-2404`). Treat each independently.
- **Version**: Use `specific_version` field (already extracted for this specific LTS version) exactly.
