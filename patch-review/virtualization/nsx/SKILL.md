---
name: Virtualization Patch Review Helper (VMware NSX)
description: A set of guidelines for determining if VMware NSX patches apply to our production systems according to defined thresholds.
---

# VMware NSX Patch Review Guidelines

This document provides strict evaluation criteria for OpenClaw agents reviewing VMware NSX security advisories and bug fixes.

## 1. Process Workflow

### 1.1 Objective
Our system automatically ingests VMware NSX security advisories and bug fixes from Broadcom Security Advisory API and NSX release notes. Because these can contain multiple CVEs and fixes, evaluating an entire advisory could be overwhelming. The preprocessing script distills the advisory into the most critical CVEs, key bug fixes, and known issues. Your job is to decide whether this advisory is **Critical/High priority** requiring immediate deployment, or if it can be deployed in the standard patch cycle.

### 1.2 Review Window
The preprocessing script covers patches released within the last **180 days** (6 months). This lookback window ensures the most recent stable releases are evaluated.

### 1.3 NSX Components in Scope
- **NSX Manager**: Control plane, API server, policy management
- **NSX Edge**: Data plane gateway, north-south traffic, NAT, Load Balancer
- **Host Transport Node**: Hypervisor-level overlay networking, VTEP
- **NSX Intelligence / NSX Application Platform**: Analytics, distributed firewall
- **NSX Federation**: Multi-site management

### 1.4 NSX Upgrade Order (Critical Context)
When evaluating upgrade urgency, account for NSX's rolling upgrade procedure:
1. NSX Manager (Primary → Standby, rolling upgrade)
2. NSX Edge nodes (Edge cluster rolling upgrade, service-uninterrupted)
3. Host Transport Nodes (host maintenance mode + vMotion)
The NSX Upgrade Coordinator orchestrates the full sequence. Upgrades require NSX ↔ vCenter ↔ ESXi compatibility matrix validation.

### 1.5 Advisory Types
- **security_advisory** (VMSA-*): Broadcom Security Advisories for NSX — always evaluate for CVE severity
- **update_release** (NSX-Build-*): General maintenance releases with resolved bug fixes and included VMSA fixes

## 2. Data Source Reference

### 2.1 Input JSON Fields (security_advisory)
| Field | Description |
|-------|-------------|
| `patch_id` | File identifier (e.g., `NSX-VMSA-2025-0014_NSX_4.2`) |
| `product` | NSX product variant (e.g., `NSX 4.2`, `NSX-T Data Center 3.2`) |
| `type` | `security_advisory` |
| `published` | VMSA publication date (YYYY-MM-DD) |
| `severity` | Derived severity level (Critical/High/Medium/Low) |
| `description` | Synthesized text block with Critical/High CVEs, required version, workaround info |
| `url` | Broadcom VMSA advisory URL |

### 2.2 Input JSON Fields (update_release)
| Field | Description |
|-------|-------------|
| `patch_id` | File identifier (e.g., `NSX-Build-4.2.1.0_NSX_4.2`) |
| `product` | NSX product variant (e.g., `NSX 4.2`) |
| `type` | `update_release` |
| `published` | Release date (YYYY-MM-DD) |
| `description` | Text with included VMSA fixes and high-severity bug fixes |
| `url` | Broadcom techdocs release notes URL |

## 3. Evaluation Context

### 3.1 NSX in Enterprise Infrastructure
NSX provides software-defined networking and security for the entire virtualized infrastructure. Failures or unpatched vulnerabilities affect:
- **Network availability**: All east-west traffic between VMs flows through NSX overlay
- **Security posture**: Distributed Firewall (DFW) enforces micro-segmentation
- **vSphere HA integration**: NSX Edge failure can disrupt north-south traffic and load balancing

### 3.2 Criticality Thresholds for NSX
Apply out-of-band patching urgency for:
- CVSS base score >= 8.5 (Critical/High RCE, privilege escalation)
- Authentication bypass on NSX Manager API
- Actively exploited CVEs (in-the-wild exploitation confirmed)
- Control plane outage or data plane disruption affecting production traffic

## 4. Strict LLM Evaluation Rules

### 4.1 Inclusion Criteria
Include (Decision: Done) if the advisory addresses **any** of the following:

1. **Remote Code Execution (RCE)**: Any RCE on NSX Manager, NSX Edge, or Host Transport Node with CVSS >= 7.0
2. **Authentication Bypass**: Unauthorized API access to NSX Manager or NSX Fabric
3. **Privilege Escalation**: Elevation to root/admin on NSX components, especially if actively exploited
4. **Control Plane Crash**: NSX Manager failure, clustering split-brain, policy sync failure
5. **Data Plane Disruption**: NSX Edge crash causing network outage, DFW policy flush
6. **Actively Exploited CVEs**: Any CVE with confirmed in-the-wild exploitation (marked ACTIVELY EXPLOITED in description)
7. **Significant Bug Fix Build**: Update release that resolves a data plane crash, DFW rule loss, or manager outage

### 4.2 Exclusion Criteria
Exclude (Decision: Exclude) only if ALL of the following are true:
- No CVE with CVSS >= 7.0
- No RCE, privilege escalation, or authentication bypass
- No control plane or data plane disruption risk
- No active exploitation
- Advisory is purely cosmetic, documentation, or low-impact UI fix
- Known issue in the advisory explicitly breaks the environment more than the fix helps

When in doubt, **include** (Decision: Done) rather than exclude.

### 4.3 Output Format (JSON Schema)
YOUR FINAL RESPONSE MUST BE A STRICT JSON ARRAY. NO MARKDOWN FENCING. Each object:

```json
[
  {
    "IssueID": "String (use the patch_id from input exactly, e.g. NSX-VMSA-2025-0014_NSX_4.2)",
    "Component": "String (NSX component: NSX Manager, NSX Edge, Host Transport Node, NSX Intelligence, NSX Federation)",
    "Version": "String (affected NSX version, e.g. 4.2, 3.2, 4.1)",
    "Vendor": "VMware NSX",
    "Date": "YYYY-MM-DD (publication or release date)",
    "Criticality": "Critical | High | Medium | Low",
    "Description": "Concise executive summary: what threat or failure is addressed. Focus on worst-case impact. No CVE list dumps. 1-3 sentences.",
    "KoreanDescription": "Description translated into enterprise-grade Korean.",
    "Decision": "Done | Exclude",
    "Reason": "Brief justification referencing the inclusion/exclusion criteria above."
  }
]
```

### 4.4 General Rules
- **One entry per patch_id**: Do not merge or split patches
- **IssueID must match exactly**: Copy the `patch_id` field from the input verbatim
- **Vendor field**: Always `VMware NSX` — not `VMware`, not `Broadcom`, not `NSX`
- **Component**: Use the primary NSX component most affected (NSX Manager, NSX Edge, Host Transport Node, etc.)
- **Version**: Use `major_version` from the input (e.g., `4.2`, `3.2`)
- **Date**: Use `published` field from input (YYYY-MM-DD format)
- **Batch completeness**: Return EXACTLY the same number of objects as patches in the batch

### 4.5 Hallucination Prevention Rules
- Base evaluation SOLELY on `[BATCH DATA]` provided in the prompt
- Do NOT use RAG retrieval, workspace files, or external knowledge
- Do NOT read or reference any JSON files in the workspace directory
- Do NOT invent CVE scores not present in the input
- Do NOT generate IssueIDs that differ from the `patch_id` field
- If a field is missing in the input, use reasonable defaults: `Version` → `Unknown`, `Component` → `NSX`

## 5. Output Validation Rules

### 5.1 Required Field Check
Before finalizing your response, verify each object has ALL required fields:
- `IssueID` — present and matches patch_id from input
- `Component` — one of the NSX components listed in 4.3
- `Version` — not empty
- `Vendor` — exactly `VMware NSX`
- `Date` — YYYY-MM-DD format
- `Criticality` — one of: Critical, High, Medium, Low
- `Description` — concise, non-empty, no raw CVE list
- `KoreanDescription` — Korean translation, non-empty
- `Decision` — exactly `Done` or `Exclude`
- `Reason` — non-empty justification

### 5.2 Count Validation
The JSON array length MUST equal the number of patches in the input batch.
If a patch cannot be evaluated, still include it with `Decision: Exclude` and explain in `Reason`.

### 5.3 Response Example
```json
[
  {
    "IssueID": "NSX-VMSA-2025-0014_NSX_4.2",
    "Component": "NSX Manager",
    "Version": "4.2",
    "Vendor": "VMware NSX",
    "Date": "2025-09-10",
    "Criticality": "Critical",
    "Description": "Addresses critical RCE vulnerability (CVE-2025-XXXX, CVSS 9.8) in NSX Manager API authentication. Remote unauthenticated attackers can gain root access. No blocking known issues.",
    "KoreanDescription": "NSX Manager API 인증의 원격 코드 실행 취약점(CVE-2025-XXXX, CVSS 9.8)을 해결합니다. 인증되지 않은 원격 공격자가 루트 권한을 획득할 수 있습니다. 알려진 심각한 이슈 없음.",
    "Decision": "Done",
    "Reason": "Critical RCE with CVSS 9.8 on NSX Manager. Immediate patching required per inclusion criteria 4.1.1."
  },
  {
    "IssueID": "NSX-Build-4.2.1.0_NSX_4.2",
    "Component": "NSX Edge",
    "Version": "4.2",
    "Vendor": "VMware NSX",
    "Date": "2025-10-15",
    "Criticality": "Medium",
    "Description": "General maintenance release including 3 VMSA security fixes and 12 bug fixes. Resolves an NSX Edge crash under high traffic load on specific NIC configurations.",
    "KoreanDescription": "3개의 VMSA 보안 수정 사항과 12개의 버그 수정이 포함된 일반 유지보수 릴리스입니다. 특정 NIC 구성에서 고부하 트래픽 시 NSX Edge 충돌 문제를 해결합니다.",
    "Decision": "Done",
    "Reason": "Update release includes critical VMSA fixes and resolves an Edge data plane crash affecting production traffic stability."
  }
]
```
