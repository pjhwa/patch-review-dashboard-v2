---
name: Oracle Linux Patch Review Operation
description: Instructions for AI Agents to perform the quarterly Patch Review process for Oracle Linux (ELSA advisories).
---

# Oracle Linux Patch Review Operation

This skill guides the AI Agent through the end-to-end process of generating a validated Oracle Linux Patch Recommendation Report. The process involves collecting ELSA advisory data from yum updateinfo.xml, filtering against the Core Component whitelist, performing a deep impact analysis (LLM Check), and generating a final CSV report.

## 1. Prerequisites & Setup

Ensure the following scripts are available in your workspace (GitHub: `https://github.com/pjhwa/patch-review-dashboard-v2`, under `patch-review/os/linux/`):

**Oracle Linux Collectors (run via CRON):**
- `oracle/oracle_collector.sh` — Downloads Oracle Linux yum updateinfo.xml
- `oracle/oracle_parser.py` — Parses updateinfo.xml and writes ELSA/ELBA JSON files

**Preprocessing:**
- `patch_preprocessing.py` (Pruning & Aggregation — triggered by Dashboard pipeline)

> [!NOTE]
> **Orchestration:** Collectors are invoked by `run_collectors_cron.sh` and scheduled via Linux CRON. Data collection runs **independently** from the AI review pipeline and cannot be manually triggered from the Dashboard.

## 2. Process Workflow

### Step 1: Data Collection & Ingestion
Data collection is fully automated via **Linux CRON** (3rd Sunday of Mar/Jun/Sep/Dec at 06:00).

| Vendor | Collector | Output Directory |
|--------|-----------|-----------------|
| Oracle Linux | `oracle/oracle_collector.sh` + `oracle/oracle_parser.py` (yum updateinfo.xml) | `oracle/oracle_data/` |

**Key collection behaviors:**
- **Lookback period**: 180 days (6 months)
- **Incremental mode**: Already-collected advisory IDs are skipped automatically
- Oracle issues two advisory types: **ELSA** (Security Advisory) and **ELBA** (Bug Fix Advisory), both prefixed accordingly
- Oracle mirrors RHEL advisories closely, but uses ELSA/ELBA numbering (not RHSA/RHBA)

**To manually trigger collection (server only):**
```bash
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
cd oracle && bash oracle_collector.sh && python3 oracle_parser.py && cd ..
```

> [!IMPORTANT]
> **Collection is CRON-only.** Do NOT invoke collector scripts from within `queue.ts` or the Dashboard pipeline.

### Step 2: Pruning & Aggregation (Automated)
The preprocessing script is triggered automatically by the Dashboard pipeline (`POST /api/pipeline/run` → BullMQ → `queue.ts`).

```bash
# Triggered by queue.ts (Dashboard pipeline) — full 180-day collection window:
python3 patch_preprocessing.py --vendor oracle --days 180

# Manual execution (server only):
cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux
python3 patch_preprocessing.py --vendor oracle --days 180
```

**What this step does:**
1. Reads JSON files from `oracle/oracle_data/` (files prefixed `ELSA-` for Security Advisories, `ELBA-` for Bug Fix Advisories)
2. Applies 180-day date filter to capture the full collection window
3. Filters against **SYSTEM_CORE_COMPONENTS whitelist** (kernel, kernel-uek, filesystem, cluster, systemd, libvirt, etc.)
4. Aggregates multiple updates for the same component into unified history
5. Writes results to `PreprocessedPatch` DB table (Prisma upsert)
6. Generates `patches_for_llm_review_oracle.json` for LLM review

### Step 3: Impact Analysis (Actual Agent Review)
**Action Required:** Read the `patches_for_llm_review_oracle.json` file. The Agent must **manually analyze** each candidate's `full_text` and `history` to determine if it meets the **Critical System Impact** criteria.

**Kernel Dual-Window Evaluation (CRITICAL — applies to `kernel`, `kernel-uek`, and kernel-related patches only):**
The preprocessing script filters kernel patches into two windows indicated by the `window_type` field in the JSON:
- `"recent"` — patch from the last 3 months (0~90 days); **Critical-severity only**
- `"early"` — patch from 3~6 months ago (90~180 days); **Critical or Important severity**; most recent per (vendor, OS version, component) — fallback candidate

**Evaluation Order for kernel/kernel-related patches (per Oracle Linux major version, both UEK and RHCK):**
1. Find the `window_type: "recent"` kernel patch for this OL version.
   - If it meets at least one Inclusion Criterion (Section 3.1) → **Decision: Approve**. Mark any `window_type: "early"` patch for the same OL version/component as **Decision: Exclude** (reason: "Recent Critical patch sufficient").
2. If the recent patch does NOT meet any Inclusion Criterion → **Decision: Exclude** for that patch, then evaluate the `window_type: "early"` patch (Critical or Important) for the same OL version/component.
   - If the early patch meets at least one criterion → **Decision: Approve** (reason: "Recent Critical patch insufficient; fallback to early Critical/Important patch").
   - If the early patch also does not qualify → **Decision: Exclude** both.
3. If there is no `window_type: "recent"` patch but a `window_type: "early"` patch exists → evaluate the early patch directly.
4. If an OL version has no kernel/kernel-related Critical or Important patches in either window → skip (no output row required).

> **Note:** Non-kernel patches (`glibc`, `systemd`, `openssl`, etc.) always have `window_type: "recent"`. Apply the standard single-window evaluation (Inclusion Criteria) for those.

**Cumulative Recommendation Logic (CRITICAL):**
If a component has multiple updates within the window (e.g., kernel-5, kernel-4, kernel-3, kernel-2, kernel-1):
1. **Identify Critical Versions:** Determine which versions contain *Critical* fixes.
2. **Recommend Latest CRITICAL Version:** Select the **latest version that is Critical**. Do NOT simply recommend the absolute latest if it is a minor/non-critical update.
3. **Aggregate Critical Descriptions:** Merge only the critical fix details from the selected and any older critical versions.

### Step 4: Final Report Generation
Output your final review decision for ALL candidates strictly as a JSON array named `patch_review_ai_report_oracle.json`. Do NOT wrap the output in markdown code blocks.

**Format:**
```json
[
  {
    "IssueID": "ELSA-2026-1234",
    "Component": "kernel-uek",
    "Version": "5.15.0-210.157.7.el8uek",
    "Vendor": "Oracle",
    "OsVersion": "OL8, OL9",
    "Date": "2026-01-15",
    "Criticality": "Critical",
    "Description": "Resolves critical vulnerability in Oracle UEK kernel network stack allowing privilege escalation.",
    "KoreanDescription": "Oracle UEK 커널 네트워크 스택의 권한 상승 취약점 해결.",
    "Decision": "Approve",
    "Reason": "Critical privilege escalation in UEK kernel."
  }
]
```

> **Note**: `IssueID` uses hyphen separator for both ELSA and ELBA (e.g., `ELSA-2026-1234`, `ELBA-2026-5678`), unlike Red Hat which uses colon (`RHSA-2026:1234`).

## 3. Strict LLM Evaluation Rules

### 3.1 Inclusion Criteria
Include a patch ONLY if it meets at least one of the following:
- **System Hang/Crash**: Kernel panics, deadlocks, OOM kills, boot failures (UEK or RHCK).
- **Data Loss/Corruption**: Filesystem errors (XFS/ext4/btrfs/OCFS2), RAID failures, data integrity issues.
- **Critical Performance**: Severe memory leak or CPU regression affecting service capability.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Root), Authentication Bypass.
- **Failover Failure**: Issues affecting HA clusters (Pacemaker, Corosync).
- **Hardware Compatibility**: Firmware or driver issues causing hardware failure or data loss.

### 3.2 Exclusion Criteria
Exclude a patch if:
- It is a minor bug fix (typos, log messages, edge cases not affecting stability).
- It is a "Moderate" security issue (local DoS, info disclosure) with limited impact.
- The patch is already superseded by a newer critical patch for the same component.
- **Early-window fallback rule**: Do NOT approve a `window_type: "early"` kernel patch without first confirming no `window_type: "recent"` Critical kernel patch exists and meets the Inclusion Criteria for the same OL version (applies to both UEK and RHCK).

### 3.3 Output Format (JSON Schema)
Return ONLY a pure JSON array. Each object must have exactly these fields:
```json
{
  "IssueID": "ELSA-2026-1234 or ELBA-2026-1234",
  "Component": "kernel-uek",
  "Version": "exact value from specific_version field",
  "Vendor": "Oracle",
  "OsVersion": "OL8, OL9",
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
- For `Vendor` field: use exactly `"Oracle"` (not "Oracle Linux").
- For `Version` field: ALWAYS use the exact value from `specific_version` field. NEVER output "Unknown" or placeholder strings.
- For `OsVersion` field: preserve the `os_version` field as-is (e.g., `"OL8"`, `"OL8, OL9"`). The preprocessor outputs Oracle Linux version in `OL{N}` format.
- Do NOT include raw `.patch` or `.rpm` filenames, CVE ID lists, or changelog copy-pastes in descriptions.
- Do NOT make up CVE numbers or version numbers.

### 3.5 Hallucination Prevention Rules
- NEVER invent CVE numbers not present in the source data.
- NEVER guess version numbers — use `specific_version` exactly.
- NEVER confuse ELSA/ELBA advisory numbers with RHSA/RHBA numbers.
- NEVER confuse UEK (Unbreakable Enterprise Kernel) versions with RHCK (Red Hat Compatible Kernel) versions.
- NEVER say "See the following advisory" — write actual content.
- NEVER output generic descriptions like "Security update for kernel".
- NEVER include non-kernel patches issued within the last 90 days — these are outside the current review window.

## 4. Oracle Linux Specific Rules

- **Advisories**:
  - **ELSA** (Oracle Linux Security Advisory) — security fixes; files prefixed `ELSA-`.
  - **ELBA** (Oracle Linux Bug Fix Advisory) — bug fix and enhancement updates; files prefixed `ELBA-`.
  - Both are collected by `oracle_parser.py` and stored in `oracle/oracle_data/`.
- **Data location**: `oracle/oracle_data/` — files prefixed `ELSA-` (security) or `ELBA-` (bug fix).
- **Core whitelist**: kernel, kernel-uek, filesystem (xfs, ext4, btrfs, ocfs2), cluster tools (pacemaker, corosync), systemd, libvirt, glibc, openssl.
- **Vendor value**: `"Oracle"` exactly (not "Oracle Linux").
- **IssueID format**: `"ELSA-2026-1234"` or `"ELBA-2026-1234"` (hyphen separator, not colon).
- **Kernel variants**: Oracle Linux supports both UEK (Unbreakable Enterprise Kernel) and RHCK (Red Hat Compatible Kernel). Both are valid targets.
  - UEK versions: `kernel-uek-*` — Oracle's own kernel with different version numbers from RHCK.
  - RHCK versions: `kernel-*` — mirrors Red Hat kernel versions.
- **UEK Version Matrix** (OL 배포본 버전별 UEK 릴리즈 매핑):

  | OS | OL Minor Version | UEK Release | UEK Kernel Version |
  |----|-----------------|-------------|-------------------|
  | OL8 | 8.1 ~ 8.4 | UEK R6 (UEKR6) | kernel-uek-5.4.17-* |
  | OL8 | 8.5 ~ 8.10 | UEK R7 (UEKR7) | kernel-uek-5.15.0-* |
  | OL9 | 9.0 ~ 9.5 | UEK R7 (UEKR7) | kernel-uek-5.15.0-* |
  | OL9 | 9.6 ~ | UEK 8 (UEKR8) | kernel-uek-6.12.0-* |
  | OL10 | 10.0 ~ | UEK 8 (UEKR8) | kernel-uek-6.12.0-* |

  > **Important:** OL8은 UEKR6(5.4.x)과 UEKR7(5.15.x) 패치가 모두 수집된다. 두 UEK 시리즈는 **각각 독립적으로 평가**해야 하며, 결과 JSON에 별도 항목으로 출력한다(다른 마이너 버전 환경에 적용). OL9도 UEKR7과 UEKR8 패치가 공존할 수 있으므로 동일하게 처리한다.
- **OsVersion**: String from `os_version` field (e.g., `"OL8"`, `"OL8, OL9"`). Note: preprocessor uses `OL{N}` format (not "Oracle Linux N").

## 5. Description Quality Rules

- **Korean Description**:
  - **MUST** be a highly condensed, synthesized summary (1-2 sentences maximum).
  - **Do NOT** use generic phrases like "Security update for kernel" or simply list CVE IDs.
  - **Do NOT** include boilerplate text, URL links, or release note references.
  - **Do NOT** include raw `.patch` or `.rpm` filenames, or raw changelog snippets. Abstract these into a single summary sentence.
  - Clearly state whether the fix is for UEK or RHCK if applicable.
  - *Example (Good):* `"Oracle UEK 커널의 네트워크 드라이버에서 발생하는 Use-After-Free 취약점으로 인한 권한 상승 위험 해결."`
- **English Description**:
  - Synthesized summary matching the Korean description.
  - *Example (Good):* `"Resolves use-after-free vulnerability in UEK kernel network driver preventing privilege escalation."`

## 6. Output Validation Rules
Before submitting your JSON response, verify:
1. Array length exactly matches the batch size.
2. Every object has all required fields (IssueID, Component, Version, Vendor, OsVersion, Date, Criticality, Description, KoreanDescription).
3. `IssueID` matches the source advisory ID exactly (e.g., `ELSA-2026-1234` or `ELBA-2026-1234` with hyphens, not colons).
4. `Version` is not "Unknown", not empty, not a placeholder string.
5. `Vendor` is exactly `"Oracle"` (case-sensitive, not "Oracle Linux").
6. Descriptions are 1-2 sentences maximum and contain no raw changelog snippets.
7. UEK and RHCK patches are clearly distinguished in the Component field (`kernel-uek` vs `kernel`).
8. Kernel `window_type: "recent"` patches were evaluated first; `window_type: "early"` patches are only Approved if the recent patch did not meet criteria.
9. No `window_type: "early"` kernel patch is Approved when a `window_type: "recent"` Critical patch for the same OL version already meets criteria.
