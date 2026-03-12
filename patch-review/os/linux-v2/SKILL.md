---
name: Patch Review Board (PRB) Operation
description: Instructions for AI Agents to perform the quarterly OS Patch Review process for Red Hat, Oracle Linux, and Ubuntu.
---

# Patch Review Board (PRB) Operation

This skill guides the AI Agent through the end-to-end process of generating a validated OS Patch Recommendation Report. The process involves collecting patch data, filtering out non-critical components, performing a deep impact analysis (LLM Check), and generating a final CSV report.

## 1. Prerequisites & Setup

Ensure the following scripts are available in your workspace (or download them from the internal repository `github.com/my-org/patch-review-automation`):

- `batch_collector.js` (Data Collection)
- `patch_preprocessing.py` (Pruning & Aggregation)

## 2. Process Workflow

### Step 1: Data Collection & Ingestion
Execute the collection scripts to gather the latest advisory data from vendor sources (RSS/Web).

```bash
# Option A: Collect by quarter (recommended for scheduled PRB)
node batch_collector.js --quarter 2026-Q1

# Option B: Collect last N days (default: 90 days from today)
node batch_collector.js --days 90

# Option C: Default mode (no args = last 90 days)
node batch_collector.js
```
*Goal: Ensure `batch_data/` is populated with advisory JSON files.*

> [!NOTE]
> **Date Range Logic:** `--quarter 2026-Q1` collects from **December 1, 2025** (1-month buffer before Q1) through **March 31, 2026**. `--days 90` collects from 90 days before today, snapped to the first of that month.

> [!IMPORTANT]
> **Timeout Failure Handling (v9+):**
> The collector automatically retries failed advisories once with a 3-second backoff. If an advisory still fails (e.g., website timeout), it is **skipped** and recorded in `batch_data/collection_failures.json`.
>
> **After collection completes:**
> 1. Check the console output for `[REPORT] ⚠ N advisory(ies) failed to collect`.
> 2. If failures exist, open `batch_data/collection_failures.json` and review each entry.
> 3. For each failed advisory, either:
>    - Re-run the collector later (transient network issue), or
>    - Manually visit the `url` field and save the advisory data, or
>    - Mark as "manually reviewed — not critical" and proceed.
> 4. Document any unrecoverable failures in the final report notes.

### Step 2: Pruning & Aggregation (Automated)
Run the preprocessing script to filter out non-critical components and aggregate multiple patches. **Use the same date arguments as Step 1** to ensure consistency.

```bash
# Must match the date range used in Step 1:
python3 patch_preprocessing.py --quarter 2026-Q1
# or: python3 patch_preprocessing.py --days 90
# or: python3 patch_preprocessing.py  (default: 90 days)
```
*Goal: Generate `patches_for_llm_review.json`. This file contains the filtered, consolidated list of candidates within the target date range.*

### Step 3: Impact Analysis (Actual Agent Review)
**Action Required:** Read the `patches_for_llm_review.json` file. The Agent must **manually analyze** each candidate's `full_text` and `history` to determine if it meets the **Critical System Impact** criteria. **Do not rely on simple scripts for this step.**

**Cumulative Recommendation Logic (CRITICAL):**
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
    "id": "USN-7851-2",
    "vendor": "Ubuntu",
    "OsVersion": "22.04 LTS, 24.04 LTS",
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
    - If a patch covers multiple distributions, they will be combined in the source field. Preserve them as a single string (e.g. `"22.04 LTS, 24.04 LTS"` or `"RHEL 8, RHEL 9"`).
    - **Do NOT create multiple rows** for a single patch. Output exactly one JSON object per input advisory!
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
1.  Run `node batch_collector.js --quarter 2026-Q1`
2.  Run `python3 patch_preprocessing.py --quarter 2026-Q1`
3.  Read `patches_for_llm_review.json`.
4.  Check `batch_data/collection_failures.json` if any advisories failed.
5.  *Thinking Process*:
    *   "Candidate: kernel-uek... Impacts: Data Loss. -> **INCLUDE**."
    *   "Candidate: python-libs... Impacts: Minor fix. -> **EXCLUDE**."
6.  Create `patch_review_ai_report.json` with the approved JSON array list.
7.  Notify User: "Report generated at [path]."
