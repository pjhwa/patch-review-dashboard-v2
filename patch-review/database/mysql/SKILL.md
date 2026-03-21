---
name: MySQL Community Patch Review Operation
description: Instructions for AI Agents to review and evaluate MySQL Oracle Critical Patch Updates (CPU).
---

# MySQL Community Patch Review Operation

This skill guides the AI Agent through the process of evaluating MySQL security patches from Oracle Critical Patch Updates (CPU) for CVEs and critical vulnerabilities.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `mysql_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 mysql_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_mysql.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_mysql.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `MYSQ-2026-Jan-MySQL_CPU`)
- `vendor`: `MySQL Community`
- `product`: `MySQL Community`
- `version`: Affected version range (e.g., `8.0.41 and prior, 9.2.0 and prior`)
- `issued_date`: CPU publication date
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `description`: CVE details including CVSS scores, sub-components, protocols, and remote exploit flag

## 3. Evaluation Context

**Database Criticality**: MySQL is a core relational database engine widely used in production environments. Oracle CPU patches are released quarterly (January, April, July, October). Vulnerabilities can enable unauthorized data access, remote code execution, privilege escalation, or denial of service affecting all applications using the database.

**Oracle CPU Specifics**: Each patch entry includes the affected sub-component (e.g., `Server: DDL`, `InnoDB`), protocol (e.g., `MySQL Protocol`), and whether it is remotely exploitable without authentication.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **Remotely Exploitable**: Any CVE marked as remotely exploitable (especially without authentication)
- **SQL Injection / Auth Bypass**: Vulnerabilities enabling unauthorized data access or privilege escalation
- **Remote Code Execution**: Any CVE enabling RCE on the MySQL server
- **Data Corruption**: Bugs causing InnoDB corruption, replication failure, or data loss
- **Service Crash**: CVEs causing mysqld to crash or hang under production load

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 5.0 or severity Medium/Low
- No remotely exploitable CVEs without authentication
- No data loss or corruption risk
- No authentication or privilege concerns
- Only local privilege manipulation with minimal production impact

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "MYSQ-2026-Jan-MySQL_CPU",
  "Component": "mysql",
  "Version": "8.0.41",
  "Vendor": "MySQL Community",
  "Date": "2026-01-15",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "Oracle CPU contains remotely exploitable High-severity CVEs affecting MySQL Server"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `MySQL Community`
- For `Component` use `mysql`
- For `Version` use the most recent fixed version from the affected_versions field
- Descriptions must emphasize remotely exploitable CVEs and affected sub-components

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
| `Vendor` | Must be exactly `MySQL Community` |
| `Date` | Format: `YYYY-MM-DD` |
| `IssueID` | Must match the input `patch_id` exactly |

### 5.3 Description Quality
- `Description`: 1–2 sentences in English, written for a database administrator audience
- `KoreanDescription`: Korean translation with equivalent technical terminology
- Both fields must mention the number of remotely exploitable CVEs if any, and the most critical sub-component affected

### 5.4 Criticality Mapping
| Severity Condition | Criticality |
|-------------------|-------------|
| RCE, Remote Auth Bypass, Data Loss | Critical |
| Remotely Exploitable CVSS ≥ 8.0, Privilege Escalation | High |
| Multiple Remote CVEs CVSS 7.0–8.0, InnoDB/Replication issues | High |
| Local CVEs CVSS 4.0–7.0, limited production impact | Medium |
| CVSS < 4.0, local only, documentation | Low |

### 5.5 Version Field Rule
- `Version` field should be the patched MySQL version (extract from affected_versions, e.g., `8.0.41`, `9.2.0`)
- Oracle CPU typically patches to the latest minor version; use that as the fixed version
