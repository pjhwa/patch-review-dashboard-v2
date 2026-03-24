# 🛡️ Patch Review Board (PRB) Job Instructions

> **Operational Guidelines for AI Agents in Infrastructure Stability Assurance**

This repository hosts the canonical job instructions for **AI Agents** serving as members of the **Patch Review Board (PRB)**. These instructions define the logic, criteria, and automated processes for selecting and recommending critical updates to ensure the stability and security of enterprise infrastructure.

---

## 📂 Repository Structure & Active Products

The instructions are organized by infrastructure domain. Each directory contains detailed guidelines and automated pipelines for the specific technology stack.

### 🐧 [os/](os/linux/README.md) (Operating Systems)
> **Active Products**: RHEL (8, 9, 10), Ubuntu LTS (22.04, 24.04), Oracle Linux (8, 9, 10), Windows Server (2019, 2022, 2025)
- Linux Automation: [`os/linux/README.md`](os/linux/README.md) | [`os/linux/SKILL.md`](os/linux/SKILL.md)
- Windows Instructions: [`os/windows/SKILL.md`](os/windows/SKILL.md)

### 🗄️ [database/](database/README.md) (Databases)
> **Active Products**: MariaDB, Microsoft SQL Server, PostgreSQL, MySQL Community
- Detailed Analysis: [`database/README.md`](database/README.md)

### 🌐 [network/](network/README.md) (Network)
> **Planned Products**: Cisco (Catalyst, Nexus, ASR), F5 BIG-IP, Fortinet Fortigate
- Detailed Analysis: [`network/README.md`](network/README.md)

### 💾 [storage/](storage/README.md) (Storage)
> **Active Products**: Ceph (Reef)  |  **Planned**: Dell EMC, Hitachi VSP, NetApp
- Detailed Analysis: [`storage/README.md`](storage/README.md)

### 🔗 [middleware/](middleware/README.md) (Middleware)
> **Active Products**: Red Hat JBoss EAP, Apache Tomcat, WildFly
- Detailed Analysis: [`middleware/README.md`](middleware/README.md)

### ☁️ [virtualization/](virtualization/README.md) (Virtualization)
> **Active Products**: VMware vSphere (ESXi, vCenter)  |  **Planned**: Citrix Hypervisor
- Detailed Analysis: [`virtualization/README.md`](virtualization/README.md)

---

## 🤖 Operating Model

### Role & Objective
- **Role**: Infrastructure Operations Stability AI Agent
- **Objective**: Proactively identify specific, critical patches to prevent service disruptions in On-Premise and Cloud environments.
- **Cadence**: Quarterly (End of Mar, Jun, Sep, Dec)
- **Collection Window**: Advisories from the last **6 months (180 days)**
- **Review Scope**: Patches released within the last **90–180 days** (kernel/critical components may extend to full 180 days)

### Execution Architecture
The pipeline runs on a **BullMQ queue worker** embedded in the Next.js server process. Each product receives an independent queue job, allowing parallel execution across domains. The `withOpenClawLock` file mutex prevents concurrent AI agent sessions.

---

## 🎯 Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Automated per-product scrapers (`*_collector.py` / `*_collector.js`) pull the latest security and bugfix advisories directly from vendor sources. This stage handles pagination, retries, and normalizes the raw data into JSON format stored under each product's skill directory.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts (`*_preprocessing.py`) computationally filter the raw data against a **Strict Whitelist** of core system components. Non-critical packages, End-of-Life (EOL) versions, and unrelated updates are aggressively pruned. Multiple updates for the same component are aggregated into a cumulative history timeline. Output: `patches_for_llm_review_<product>.json`.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Before invoking the AI Agent, historical exclusion feedback is retrieved via `query_rag.py` and injected as hard exclusion rules into the prompt (prompt-injection RAG). The AI Agent then performs a deep contextual analysis, selecting patches *only* if they prevent catastrophic failures:
1. **System/Service Stability** 🛑: Fixes for Hangs, Deadlocks, or Boot/Service Failures.
2. **Data Integrity** 💾: Fixes for Data Loss, Data Corruption, or Unavailability.
3. **Security** 🔒: Mitigation of Critical vulnerabilities (RCE, Privilege Escalation).
4. **Hardware/Failover** 🔄: Resolving High Availability (HA) split-brains or hardware faults.

The loop includes automatic retry with self-healing prompts on schema validation failure. Output: `patch_review_ai_report_<product>.json`.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the PostgreSQL database (`PreprocessedPatch`, `ReviewedPatch` tables) for dashboard display, search, and export. Passthrough patches (not selected by AI but still in scope) are also recorded with a `passthrough` flag.

### 5. Report Export
The operations team exports final results as per-product CSV files (`final_approved_patches_<product>.csv`) from the dashboard. Dual-language (English/Korean) descriptions are embedded in each record for executive review.

---
*Maintained by Infrastructure Operation Team*
