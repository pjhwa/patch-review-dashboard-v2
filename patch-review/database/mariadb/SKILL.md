---
name: MariaDB Patch Review Operation
description: Instructions for AI Agents to review and evaluate MariaDB database security advisories and bug fix releases.
---

# MariaDB Patch Review Operation

This skill guides the AI Agent through the process of evaluating MariaDB patches for security vulnerabilities and critical bug fixes.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `mariadb_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 mariadb_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_mariadb.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_mariadb.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `RHSA-2026-0333`)
- `vendor`: `MariaDB`
- `product`: Package name (e.g., `mariadb`)
- `version`: Package version
- `severity`: Overall severity (`Critical`, `High`, `Moderate`, `Low`)
- `description`: Vulnerability and fix details
- `issued_date`: Release date

## 3. Evaluation Context

**Database Criticality**: MariaDB is a core database engine. Vulnerabilities can expose sensitive data, allow unauthorized access, or cause service disruption affecting all applications using the database.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **SQL Injection / Auth Bypass**: Any vulnerability enabling unauthorized data access
- **Remote Code Execution**: Any CVE enabling RCE on the database server
- **Data Corruption**: Bugs causing InnoDB corruption, replication failure, or data loss
- **Privilege Escalation**: Vulnerabilities allowing non-privileged access to sensitive data
- **Service Crash**: Bugs causing mysqld to crash or hang under production load

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 7.0 or severity Moderate/Low
- No data loss or corruption risk
- No authentication or privilege concerns
- Only minor GUI or documentation updates

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "RHSA-2026-0333",
  "Component": "mariadb",
  "Version": "10.5.27",
  "Vendor": "MariaDB",
  "Date": "2026-01-15",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity CVE with SQL injection risk in MariaDB server"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `MariaDB`
- For `Component` use the specific package name (e.g., `mariadb`, `mariadb-server`)
- Descriptions must be concise executive summaries, not raw changelogs
