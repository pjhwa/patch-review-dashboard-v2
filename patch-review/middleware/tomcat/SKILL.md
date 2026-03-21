---
name: Apache Tomcat Patch Review Operation
description: Instructions for AI Agents to review and evaluate Apache Tomcat security advisories.
---

# Apache Tomcat Patch Review Operation

This skill guides the AI Agent through the process of evaluating Apache Tomcat security patches for CVEs and critical vulnerabilities.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `tomcat_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 tomcat_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_tomcat.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_tomcat.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `TOMC-2026-Jan-Apache_Tomcat_10`)
- `vendor`: `Apache Tomcat`
- `product`: Package version (e.g., `Apache Tomcat 10`)
- `version`: Fixed version (e.g., `10.1.35`)
- `published`: Release date
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `description`: CVE details including CVSS scores, affected versions, and descriptions

## 3. Evaluation Context

**Middleware Criticality**: Apache Tomcat is a widely deployed Java servlet container. Vulnerabilities can enable remote code execution, session hijacking, authentication bypass, or sensitive data exposure affecting all web applications hosted on the server.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **Remote Code Execution**: Any CVE enabling RCE on the Tomcat server
- **Authentication Bypass**: Vulnerabilities enabling unauthorized access to web applications
- **Session Hijacking / Fixation**: CVEs allowing attacker to hijack user sessions
- **Partial PUT / Request Smuggling**: HTTP request handling vulnerabilities
- **Information Disclosure**: Sensitive data exposure via headers, logs, or error messages (CVSS ≥ 5.0)
- **Denial of Service**: CVEs causing Tomcat process crash or resource exhaustion under load

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 5.0 or severity Medium/Low
- No authentication, session, or code execution risk
- No data exposure risk
- Only documentation or minor configuration updates

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "TOMC-2026-Jan-Apache_Tomcat_10",
  "Component": "tomcat",
  "Version": "10.1.35",
  "Vendor": "Apache Tomcat",
  "Date": "2026-01-15",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity CVE enabling partial PUT request vulnerability in Apache Tomcat 10"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `Apache Tomcat`
- For `Component` use `tomcat`
- For `Version` use the fixed version string from the patch (e.g., `10.1.35`)
- Descriptions must be concise executive summaries, not raw CVE dump lists

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
| `Vendor` | Must be exactly `Apache Tomcat` |
| `Date` | Format: `YYYY-MM-DD` |
| `IssueID` | Must match the input `patch_id` exactly |

### 5.3 Description Quality
- `Description`: 1–2 sentences in English, written for a middleware/DevOps administrator audience
- `KoreanDescription`: Korean translation with equivalent technical terminology
- Both fields must mention the specific CVE type or vulnerability area

### 5.4 Criticality Mapping
| Severity Condition | Criticality |
|-------------------|-------------|
| RCE, Authentication Bypass, Session Hijacking | Critical |
| Request Smuggling, CVSS ≥ 8.0 | High |
| Information Disclosure CVSS 5.0–8.0, DoS | High |
| CVSS 4.0–7.0, limited impact | Medium |
| CVSS < 4.0, documentation only | Low |

### 5.5 Version Field Rule
- `Version` field must be the fixed Tomcat version string (e.g., `9.0.99`, `10.1.35`, `11.0.3`)
- If the input contains multiple fixed versions for different major versions, use the version from the `patch_id` major version
