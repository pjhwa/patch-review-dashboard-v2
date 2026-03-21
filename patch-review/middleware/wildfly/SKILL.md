---
name: WildFly Patch Review Operation
description: Instructions for AI Agents to review and evaluate WildFly application server security advisories.
---

# WildFly Patch Review Operation

This skill guides the AI Agent through the process of evaluating WildFly (JBoss) security patches for CVEs and critical vulnerabilities.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `wildfly_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 wildfly_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_wildfly.json` with normalized patch records.*

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_wildfly.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `WFLY-2026-Jan-WildFly`)
- `vendor`: `WildFly`
- `product`: `WildFly`
- `published`: CVE publication date
- `severity`: Overall severity (`Critical`, `High`, `Medium`, `Low`)
- `description`: CVE details including CVSS scores, affected versions, fixed versions

## 3. Evaluation Context

**Middleware Criticality**: WildFly (formerly JBoss) is a widely deployed Java EE/Jakarta EE application server used in enterprise environments. Vulnerabilities can enable remote code execution, deserialization attacks, authentication bypass, or denial of service affecting all applications deployed on the server.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/High CVEs**: Any CVE with CVSS ≥ 7.0 or severity Critical/High
- **Remote Code Execution**: Any CVE enabling RCE on the WildFly server
- **Deserialization Vulnerabilities**: Java deserialization exploits via JMX, EJB, or RMI
- **Authentication Bypass**: Unauthorized access to management console or application endpoints
- **SSRF / XML External Entity (XXE)**: Server-side request forgery or XML parsing vulnerabilities
- **EL Injection / Expression Language**: Template injection enabling code execution
- **Denial of Service**: CVEs causing OutOfMemoryError, thread exhaustion, or process crash
- **Privilege Escalation**: Role-based access control bypass within deployed applications

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 5.0 or severity Medium/Low
- No authentication, deserialization, or code execution risk
- No impact on production application deployments
- Only documentation or minor configuration updates

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "WFLY-2026-Jan-WildFly",
  "Component": "wildfly",
  "Version": "34.0.1.Final",
  "Vendor": "WildFly",
  "Date": "2026-01-15",
  "Criticality": "High",
  "Description": "Concise English executive summary of what was fixed and why it matters.",
  "KoreanDescription": "한국어 요약: 무엇이 수정되었고 왜 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "High-severity deserialization vulnerability in WildFly enabling remote code execution"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `WildFly`
- For `Component` use `wildfly`
- For `Version` use the fixed_in version if available, otherwise use the month identifier
- Descriptions must be concise executive summaries highlighting specific vulnerability type

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
| `Vendor` | Must be exactly `WildFly` |
| `Date` | Format: `YYYY-MM-DD` |
| `IssueID` | Must match the input `patch_id` exactly |

### 5.3 Description Quality
- `Description`: 1–2 sentences in English, written for a Java EE/Jakarta EE administrator audience
- `KoreanDescription`: Korean translation with equivalent technical terminology
- Both fields must mention the specific CVE type and affected WildFly subsystem

### 5.4 Criticality Mapping
| Severity Condition | Criticality |
|-------------------|-------------|
| RCE, Deserialization, Auth Bypass | Critical |
| SSRF, EL Injection, CVSS ≥ 8.0 | High |
| XXE, Privilege Escalation, CVSS 7.0–8.0 | High |
| DoS, Information Disclosure, CVSS 4.0–7.0 | Medium |
| CVSS < 4.0, minor fixes | Low |

### 5.5 Version Field Rule
- `Version` field should be the WildFly version that fixes the issue (from `fixed_in` field)
- If not available, use the month identifier from the patch_id (e.g., `2026-Jan`)
