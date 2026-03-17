---
name: SQL Server Patch Review Operation
description: Instructions for AI Agents to review and summarize monthly cumulative patches (CU) for SQL Server 2016, 2017, 2019, 2022, and 2025.
---

# SQL Server Patch Review Operation

This skill guides the AI Agent through the process of summarizing and evaluating monthly cumulative patches for SQL Server. Unlike individual OS patches, SQL Server patches are **Cumulative Updates (CU)**. The goal is to synthesize the most critical security fixes and bug fixes into a concise report.

## 1. Process Workflow

### Step 1: Preprocessing & Data Extraction (Automated)
Run the `sqlserver_preprocessing.py` script to extract key information from the monthly JSON files.
```bash
# Review window: 6 months ago to 3 months ago (quarterly lookback)
python3 sqlserver_preprocessing.py --days 180 --days_end 90
```
*Goal: Generate `patches_for_llm_review_sqlserver.json` containing one version group record per SQL Server version (e.g., SQL Server 2022), with all monthly CUs in the review window bundled inside a `patches` array.*

### Step 2: Impact Analysis & Summarization (AI Review)
**Action Required:** Read the `patches_for_llm_review_sqlserver.json` file. The Agent must analyze the version group contents and generate a synthesized summary.

**Fields available in Preprocessed Data:**
- `patches`: Array of monthly CUs in the review window (sorted newest first)
- `review_window`: Date range string (e.g., "2025-09-16 ~ 2025-12-16")
- `candidate_count`: Number of monthly CUs in the window
- `top_10_cves`: List of the most critical vulnerabilities per patch (CVE ID, Title, Severity, Description).
- `top_5_bug_fixes`: List of the most critical non-CVE fixes per patch (Area, Component, Description).
- `known_issues`: List of known issues for each patch.
- `issued_date`: Most recent patch release date in the group.
- `os_version`: Platforms listed in the update (e.g., Windows, Linux).

**Criteria for Inclusion (Focus for Summary):**
Identify if the cumulative patch addresses any of the following critical issues:
- **System Hang/Crash**: Service deadlocks, engine crashes, unexpected shutdowns.
- **Data Loss/Corruption**: Integrity errors, page corruption, log file issues.
- **Critical Performance**: Severe degradation affecting production workloads.
- **Security (Critical)**: RCE (Remote Code Execution), Privilege Escalation (Sysadmin), Auth Bypass.
- **Failover Failure**: Issues affecting High Availability (Always On, Failover Cluster).

**ONE per Version Rule (CRITICAL):** For each SQL Server version group, select ONLY the single most recent CU that meets critical criteria. Output exactly ONE JSON object per version. Use the GROUP's `patch_id` (e.g., 'SQLS-GROUP-SQL_Server_2022') as the `id`/`IssueID` field.

**Exclusion Logic (Noise Reduction):**
- Do not spend much detail on minor GUI bugs, documentation updates, or low-severity logging issues.
- Focus on the "Top 10 CVEs" and "Top 5 Bug Fixes" provided in the preprocessed data.

### Step 3: Final Report Generation
Output the final review decision strictly as a JSON Data file named `patch_review_ai_report.json`.

**Format:**
```json
[
  {
    "id": "SQLS-GROUP-SQL_Server_2022",
    "IssueID": "SQLS-GROUP-SQL_Server_2022",
    "vendor": "SQL Server",
    "component": "SQL Server",
    "version": "KB5046862",
    "selected_kb": "KB5046862",
    "date": "2025-11-13",
    "criticality": "Critical",
    "description": "Cumulative update addressing RCE and SQL injection vulnerabilities. Resolves engine crashes during Always On failover.",
    "koreanDescription": "RCE 및 SQL 인젝션 취약점을 해결하는 누적패치. Always On 장애 조치 시 발생하는 엔진 크래시 수정 포함.",
    "Decision": "Done",
    "Reason": "Includes critical security fixes (CVE-2025-21262) and HA stability improvements."
  }
]
```

## 2. Content Guidelines

- **한글 설명 (Korean Description)**:
    - **MUST** be a highly condensed, synthesized summary of the cumulative patch.
    - Mention the most critical CVE and the most impactful bug fix.
    - Use technical terms appropriately (Always On, Sysadmin, Deadlock, etc.).
    - *Example:* "CVE-2026-21262(권한 상승) 등 보안 취약점 3건 해결 및 가용성 그룹(Always On) 동기화 오류로 인한 데이터 불일치 가능성 차단."

- **Patch Description (English)**:
    - Synthesized summary mirroring the Korean description.
    - Focus on impact: "Resolves potential data loss in AG", "Fixes buffer overflow", etc.

- **Decision Logic**:
    - For SQL Server, since it is a cumulative patch, the decision is almost always **Approve** unless the patch is known to be retracted or extremely unstable. However, the `criticality` should reflect the highest severity of included fixes.

## 3. Output Validation Rules

- Output must be valid JSON only — no markdown fences, no commentary.
- Array length must equal the number of input VERSION GROUPs.
- All required fields must be present in each object.
- `IssueID` must match the input `patch_id` exactly.

## 4. LLM Evaluation Rules (Strict)

These rules govern how the AI agent evaluates and selects SQL Server patches.

### 4.1 Scope Constraint
- Base your evaluation **ONLY** on the literal `[BATCH DATA]` provided in the prompt.
- Do NOT use RAG retrieval, workspace files, or any external knowledge to supplement the data.
- Do NOT read or reference any JSON files in the workspace directory.

### 4.2 Selection Criteria per Version Group
For each VERSION GROUP, identify if any monthly CU in the `patches` array addresses:
1. **Critical/High Security**: RCE, Privilege Escalation, Auth Bypass (CVSS ≥ 7.5 preferred)
2. **Data Integrity Risk**: Corruption, data loss, log file damage
3. **Availability Risk**: Engine crash, deadlock, Always On / FCI failure
4. **Critical Performance**: Severe degradation blocking production workloads

If ANY of the above criteria are met by any CU in the group → **Decision: Done**, select most recent qualifying CU.
If NONE of the criteria are met → **Decision: Exclude**, `criticality: Low`.

### 4.3 Criticality Mapping
| Condition | Criticality |
|-----------|-------------|
| RCE, Auth Bypass, Data Loss | Critical |
| Privilege Escalation (CVSS ≥ 8.0), HA Failure | High |
| Important severity CVE (CVSS 7.0–8.0) | Important |
| Only low-severity fixes | Low |

### 4.4 Output Format Enforcement
- Return a JSON **array** (even for a single item).
- `Version` field = KB number of the selected monthly patch (e.g., `KB5046862`).
- `OsVersion` field = SQL Server version string (e.g., `SQL Server 2022`).
- `Vendor` = `"Microsoft"`, `Component` = `"SQL Server"` always.
- `KoreanDescription` must be in Korean (한국어).
- `Description` must be in English.
