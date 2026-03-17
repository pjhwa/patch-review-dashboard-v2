---
name: PostgreSQL Patch Review Operation
description: Instructions for AI Agents to review and evaluate PostgreSQL database security advisories and bug fix releases.
---

# PostgreSQL Patch Review Operation

This skill guides the AI Agent through the process of evaluating PostgreSQL patches for security vulnerabilities and critical bug fixes.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `pgsql_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 pgsql_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_pgsql.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_pgsql.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `PGSL-2025-Nov-PostgreSQL_14`)
- `vendor`: `PostgreSQL`
- `product`: Package version (e.g., `postgresql 14`)
- `published`: Release date
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `total_cves`: Number of CVEs addressed
- `max_cvss`: Maximum CVSS base score
- `description`: Vulnerability and fix details with CVE information

## 3. Evaluation Context

**Database Criticality**: PostgreSQL is a core relational database engine. Vulnerabilities can expose sensitive data, allow unauthorized access, cause data corruption, or disrupt all dependent applications.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **SQL Injection / Auth Bypass**: Any vulnerability enabling unauthorized data access
- **Remote Code Execution**: Any CVE enabling RCE on the database server
- **Data Corruption**: Bugs causing index corruption, WAL failure, or data loss
- **Privilege Escalation**: Vulnerabilities allowing non-privileged role to gain superuser access
- **Service Crash**: Bugs causing postgres process to crash under production load
- **Replication Failure**: Issues breaking streaming replication or logical replication

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 7.0 or severity Medium/Low
- No data loss or corruption risk
- No authentication or privilege concerns
- Only minor performance improvements or documentation updates

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "PGSL-2025-Nov-PostgreSQL_14",
  "Component": "postgresql",
  "Version": "14.14",
  "Vendor": "PostgreSQL",
  "Date": "2025-11-21",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity CVE addressing privilege escalation in PostgreSQL"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `PostgreSQL`
- For `Component` use the specific package name (e.g., `postgresql`, `postgresql-server`)
- Descriptions must be concise executive summaries, not raw changelogs

## 5. Output Validation Rules

### 5.1 JSON Structure
- Output must be a valid JSON array — no markdown fences, no explanatory text outside the array
- Array length must equal the number of input patches exactly
- All required fields must be present in every object

### 5.2 Field Validation
| Field | Valid Values |
|-------|-------------|
| `Decision` | `Include` or `Exclude` only |
| `Criticality` | `Critical`, `High`, `Medium`, or `Low` only |
| `Vendor` | Must be exactly `PostgreSQL` |
| `Date` | Format: `YYYY-MM-DD` |
| `IssueID` | Must match the input `patch_id` exactly |

### 5.3 Description Quality
- `Description`: 1–2 sentences in English, written for a database administrator audience
- `KoreanDescription`: Korean translation with equivalent technical terminology
- Both fields must mention the specific CVE ID (if applicable) or the fix area

### 5.4 Criticality Mapping
| Severity Condition | Criticality |
|-------------------|-------------|
| RCE, Auth Bypass, WAL corruption | Critical |
| Privilege Escalation, CVSS ≥ 8.0 | High |
| SQL Injection, index corruption, CVSS 7.0–8.0 | High |
| Replication failure, CVSS 4.0–7.0 | Medium |
| CVSS < 4.0, minor fixes only | Low |

### 5.5 Version Field Rule
- `Version` field must be the PostgreSQL version string (e.g., `14.14`, `16.6`)
- If the input `patch_id` is `PGSL-2025-Nov-PostgreSQL_14`, Version should be `14.x` where x is the patch release number
