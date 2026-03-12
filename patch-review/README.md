# 🛡️ Patch Review Board (PRB) Job Instructions

> **Operational Guidelines for AI Agents in Infrastructure Stability Assurance**

This repository hosts the canonical job instructions for **AI Agents** serving as members of the **Patch Review Board (PRB)**. These instructions define the logic, criteria, and automated processes for selecting and recommending critical updates to ensure the stability and security of enterprise infrastructure.

---

## 📂 Repository Structure & Target Products

The instructions are organized by infrastructure domain. Each directory contains detailed guidelines and automated pipelines for the specific technology stack.

### 🐧 [os/](os/linux/README.md) (Operating Systems)
> **Representative Products**: RHEL, Ubuntu, Windows Server, Oracle Linux, Unix (AIX, HP-UX, Solaris)
- Detailed Analysis & Automation: [`os/linux/README.md`](os/linux/README.md)
- Instructions: [`os/linux/SKILL.md`](os/linux/SKILL.md)

### 🗄️ [database/](database/README.md) (Databases)
> **Representative Products**: Oracle Database, Microsoft SQL Server, MySQL, PostgreSQL
- Detailed Analysis: [`database/README.md`](database/README.md)

### 🌐 [network/](network/README.md) (Network)
> **Representative Products**: Cisco (Catalyst, Nexus, ASR), F5 BIG-IP, Fortinet Fortigate
- Detailed Analysis: [`network/README.md`](network/README.md)

### 💾 [storage/](storage/README.md) (Storage)
> **Representative Products**: Dell EMC (PowerStore, VMAX), Hitachi VSP, NetApp AFF/FAS
- Detailed Analysis: [`storage/README.md`](storage/README.md)

### 🔗 [middleware/](middleware/README.md) (Middleware)
> **Representative Products**: Apache Tomcat, Oracle WebLogic, JBoss EAP, Nginx
- Detailed Analysis: [`middleware/README.md`](middleware/README.md)

### ☁️ [virtualization/](virtualization/README.md) (Virtualization)
> **Representative Products**: VMware vSphere, Citrix Hypervisor, VMware NSX
- Detailed Analysis: [`virtualization/README.md`](virtualization/README.md)

---

## 🤖 Operating Model

### Role & Objective
- **Role**: Infrastructure Operations Stability AI Agent
- **Objective**: Proactively identify specific, critical patches to prevent service disruptions in On-Premise and Cloud environments.
- **Cadence**: Quarterly (End of Mar, Jun, Sep, Dec)
- **Scope**: Patches released within the last **3 months** (90 days).

---

## 🎯 Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated 4-step pipeline designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Automated scrapers pull the latest security and bugfix advisories directly from vendor sources (e.g., Red Hat Web, Oracle Mailing Lists, Ubuntu Security API). This stage handles pagination, retries, and normalizes the raw data into JSON format.

### 2. Preprocessing & Pruning (Signal Extraction)
The chaotic raw data is computationally filtered against a **Strict Whitelist** of core system components (Kernel, Systemd, NetworkManager, File Systems). Non-critical packages (e.g., desktop apps), End-of-Life (EOL) OS versions, and unrelated updates are aggressively pruned. Multiple updates for the same component are aggregated to provide a clean history.

### 3. Impact Analysis (LLM Intelligent Review)
The AI Agent performs a deep contextual analysis on the pruned dataset. Patches are selected for the final report *only* if they prevent catastrophic failures. The Agent evaluates based on:
1.  **System Stability** 🛑: Fixes for Hangs, Deadlocks, or Boot Failures.
2.  **Data Integrity** 💾: Fixes for Data Loss (DL), Data Corruption, or Unavailability.
3.  **Security** 🔒: Mitigation of Critical vulnerabilities (RCE, Privilege Escalation).
4.  **Hardware/Failover** 🔄: Resolving High Availability (HA) split-brains or hardware faults.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. Final Report Generation
The Agent synthesizes the critical insights into a standardized `patch_review_final_report.csv`. This final artifact enforces strict version mapping and generates executive dual-language (English/Korean) summaries, ready for immediate deployment review by the operations team.

---
*Maintained by Infrastructure Operation Team*
