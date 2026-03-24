# 🔗 Middleware Patch Guidelines

> **Domain**: Infrastructure / Middleware
> **Scope**: Web Servers, WAS, Integration

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for middleware and application servers.

## 📋 Target Products Scope

The following middleware platforms are within the scope of the Patch Review Board:

### Web Application Servers (WAS)
- **TmaxSoft JEUS** (Major version upgrades, Fixpacks)
- **Apache Tomcat** (Minor versions, Security patches)
- **Red Hat JBoss EAP** (Enterprise Application Platform)
- **Wildfly** (Community Edition)
- **Oracle WebLogic Server**

### Web Servers
- **TmaxSoft WebtoB**
- **Nginx** (Stable vs Mainline)
- **Apache HTTP Server** (httpd)

---

## 📄 Available Instructions

| File | Description | Target Agent |
| :--- | :--- | :--- |
| *TBD* | *Instructions for Middleware patching are under development.* | - |

---

## 🎯 Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated 4-step pipeline designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Automated scrapers pull the latest security and bugfix advisories directly from vendor sources. This stage handles pagination, retries, and normalizes the raw data into JSON format.

### 2. Preprocessing & Pruning (Signal Extraction)
The chaotic raw data is computationally filtered against a **Strict Whitelist** of core system components. Non-critical packages, End-of-Life (EOL) versions, and unrelated updates are aggressively pruned. Multiple updates for the same component are aggregated to provide a clean history.

### 3. Impact Analysis (LLM Intelligent Review)
The AI Agent performs a deep contextual analysis on the pruned dataset. Patches are selected for the final report *only* if they prevent catastrophic failures. The Agent evaluates based on:
1.  **System/Service Stability** 🛑: Fixes for Hangs, Deadlocks, or Boot/Service Failures.
2.  **Data Integrity** 💾: Fixes for Data Loss (DL), Data Corruption, or Unavailability.
3.  **Security** 🔒: Mitigation of Critical vulnerabilities (RCE, Privilege Escalation).
4.  **Hardware/Failover** 🔄: Resolving High Availability (HA) split-brains or hardware faults.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. Final Report Generation
The Agent synthesizes the critical insights into a standardized `patch_review_final_report.csv`. This final artifact enforces strict version mapping and generates executive dual-language (English/Korean) summaries, ready for immediate deployment review by the operations team.
