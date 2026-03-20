---
name: JBoss EAP Patch Review Operation
description: Instructions for AI Agents to review and evaluate JBoss Enterprise Application Platform security advisories and bug fix releases.
---

# JBoss EAP Patch Review Operation

This skill guides the AI Agent through the process of evaluating Red Hat JBoss Enterprise Application Platform (EAP) patches for security vulnerabilities and critical bug fixes. JBoss EAP is a mission-critical Java application server widely deployed in enterprise environments.

## 1. Process Workflow

### Step 1: Preprocessing (Automated)
Run `jboss_eap_preprocessing.py` to extract key information from collected JSON files.
```bash
python3 jboss_eap_preprocessing.py --days 180
```
*Goal: Generate `patches_for_llm_review_jboss_eap.json` with normalized patch records.*

The script filters:
- Only patches issued within the specified date window (using `issuedDate`)
- Security advisories (RHSA) with CVEs are always included
- Bug fix advisories (RHBA) are included only if they contain CVEs
- RHBA with no CVEs are excluded (pure maintenance, no security impact)

### Step 2: Impact Analysis (AI Review)
Read `patches_for_llm_review_jboss_eap.json` and evaluate each patch.

**Fields available:**
- `patch_id`: Unique identifier (e.g., `RHSA-2025-12345`)
- `vendor`: Always `JBoss EAP`
- `component`: `jboss-eap` or `jboss-eap-xp`
- `version`: EAP version (e.g., `7.4.0`, `8.0.0`, `5.0` for XP)
- `severity`: Advisory severity (`Critical`, `Important`, `Moderate`, `Low`)
- `cves`: List of CVE identifiers fixed in this advisory
- `description`: Full advisory text including CVE list and fix details
- `issued_date`: Date this advisory was first published

### Step 3: Output Generation
Return a JSON array with one object per input patch following the Output Format in Section 4.3.

## 2. Data Source Reference

| Field | Source | Notes |
|-------|--------|-------|
| `patch_id` | File ID (RHSA-/RHBA- prefix) | Red Hat Errata identifier |
| `vendor` | Hardcoded | Always "JBoss EAP" |
| `component` | Derived from title | `jboss-eap` or `jboss-eap-xp` |
| `version` | Extracted from title | EAP major.minor.patch version |
| `severity` | Red Hat advisory severity | Critical/Important/Moderate/Low |
| `cves` | Advisory CVE list | CVE identifiers (may be multiple) |
| `description` | overview + description fields | Includes CVE summary and fix details |
| `issued_date` | `issuedDate` from JSON | Date advisory was first published |
| `ref_url` | Advisory URL | access.redhat.com/errata link |

## 3. Evaluation Context

**Middleware Criticality**: JBoss EAP is a Java EE application server that runs business-critical applications. Vulnerabilities may allow:
- Remote code execution via deserialization attacks
- Authentication bypass in EJB or REST endpoints
- Information disclosure through mishandled exceptions
- Denial-of-service via resource exhaustion in HTTP connectors
- XML/JNDI injection (e.g., Log4Shell affects EAP deployments)

**EAP XP Context**: JBoss EAP XP (Expansion Pack) extends EAP with MicroProfile APIs. EAP XP advisories may affect reactive/cloud-native deployments.

**Deployment Environments**: JBoss EAP typically runs on Red Hat Enterprise Linux and is often configured in clustered HA setups. Vulnerabilities in clustering (e.g., JGroups, Infinispan) can affect entire clusters.

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria (Recommend patching if ANY of the following apply)
- **Critical/Important CVEs**: Any CVE with CVSS >= 7.0 or severity Critical/Important
- **Remote Code Execution**: Any vulnerability enabling RCE on the application server
- **Authentication Bypass**: Vulnerabilities bypassing EJB, REST, or web authentication
- **Deserialization Attacks**: Known deserialization gadget chains (common in Java EE)
- **JNDI/Log4Shell variants**: Any JNDI lookup or Log4j related vulnerability
- **XML External Entity (XXE)**: XML processing vulnerabilities exposing server-side files
- **Privilege Escalation**: Vulnerabilities allowing non-privileged access to admin functions
- **Clustering/Replication Issues**: Bugs causing data loss or split-brain in HA deployments
- **Low/Moderate severity with high-profile CVEs**: e.g., Log4Shell CVE-2021-44228 (CVSS 10.0 despite being listed as Low in some advisories)

### 4.2 Exclusion Criteria (Exclude if ALL of the following apply)
- Only CVEs with CVSS < 7.0 or severity Moderate/Low
- No RCE, authentication bypass, or privilege escalation risk
- Only minor UI, documentation, or non-critical dependency updates
- No impact on clustered or production deployments
- No publicly known exploits or PoCs referenced

### 4.3 Output Format (CRITICAL)
Return a **pure JSON array** with EXACTLY the same number of objects as patches provided.

Each object MUST contain:
```json
{
  "IssueID": "RHSA-2025-12345",
  "Component": "jboss-eap",
  "Version": "7.4.0",
  "Vendor": "JBoss EAP",
  "Date": "2025-09-15",
  "Criticality": "High",
  "Description": "Concise English executive summary of what CVEs were fixed and why this patch is critical for JBoss EAP deployments.",
  "KoreanDescription": "한국어 요약: 어떤 취약점이 수정되었고 왜 JBoss EAP 환경에서 중요한지 간결하게.",
  "Decision": "Include",
  "Reason": "Important-severity CVE fixing authentication bypass in EJB remote interface"
}
```

**Decision values**: `Include` (meets criteria) or `Exclude` (does not meet criteria)

**Criticality values**: `Critical`, `High`, `Medium`, `Low`

### 4.4 General Rules
- DO NOT read or search workspace JSON files — use only the [BATCH DATA] provided
- DO NOT skip any patch — output exactly one object per input patch
- For `Vendor` always use `JBoss EAP`
- For `Component` use `jboss-eap` or `jboss-eap-xp` based on the patch_id/description
- Descriptions must be concise executive summaries, not raw changelogs or CVE lists
- When multiple CVEs are present, summarize the most critical one and note the count
- IMPORTANT: Low-severity advisories may still contain critical CVEs (e.g., Log4Shell was rated Low in some EAP advisories but has CVSS 10.0) — always check the CVE list

### 4.5 Hallucination Prevention Rules
- DO NOT invent CVE scores not present in the batch data
- DO NOT assume a CVE is Critical based on CVE ID alone — use the severity field
- DO NOT reference EAP versions or components not mentioned in the input data
- DO NOT merge or split patches — one input patch = one output object exactly
- If `version` field is empty, use an empty string `""` — do not invent a version

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
| `Vendor` | Must be exactly `JBoss EAP` |
| `Date` | Format: `YYYY-MM-DD` |
| `IssueID` | Must match the input `patch_id` exactly |
| `Component` | `jboss-eap` or `jboss-eap-xp` |

### 5.3 Description Quality
- `Description`: 1-2 sentences in English, written for a system administrator audience
- `KoreanDescription`: Korean translation with equivalent technical terminology
- Both fields must mention the specific vulnerability type or fix area
- Generic summaries ("security update applied") are not acceptable
- If multiple CVEs: "Fixes N CVEs including [most critical type] (CVE-XXXX-YYYY)"

### 5.4 Criticality Mapping
| Severity Condition | Criticality |
|-------------------|-------------|
| RCE, Auth Bypass, JNDI Injection, CVSS >= 9.0 | Critical |
| Privilege Escalation, Deserialization, CVSS 7.0-8.9 | High |
| XSS, Information Disclosure, CVSS 4.0-6.9 | Medium |
| Low-impact, documentation, CVSS < 4.0 | Low |

### 5.5 Special Cases
- **Log4Shell (CVE-2021-44228, CVE-2021-45046)**: Always `Criticality: Critical`, `Decision: Include` regardless of advisory severity label
- **Multi-CVE advisories**: Use the highest CVSS score to determine Criticality
- **EAP XP advisories**: Treat same as standard EAP — XP is a production component
