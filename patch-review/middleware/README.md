# Middleware Patch Guidelines

> **Domain**: Infrastructure / Middleware
> **Scope**: WAS (Web Application Servers), Web Servers

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for middleware and application servers.

## Target Products Scope

### Active Products
- **Red Hat JBoss EAP** — `jboss_eap/` | RHSA-based advisories for Enterprise Application Platform
- **Apache Tomcat** — `tomcat/` | Apache Tomcat security release notes
- **WildFly** — `wildfly/` | WildFly community release advisories

### Planned (Not Yet Implemented)
- TmaxSoft JEUS (Major version upgrades, Fixpacks)
- Oracle WebLogic Server
- TmaxSoft WebtoB
- Nginx (Stable vs Mainline)
- Apache HTTP Server (httpd)

---

## Available Instructions

| Product | Description | Agent Instructions |
| :--- | :--- | :--- |
| **JBoss EAP** | RHSA-sourced JBoss EAP security and critical advisories | [`jboss_eap/SKILL.md`](jboss_eap/SKILL.md) |
| **Apache Tomcat** | Tomcat security release notes and CVE advisories | [`tomcat/SKILL.md`](tomcat/SKILL.md) |
| **WildFly** | WildFly community security and stability advisories | [`wildfly/SKILL.md`](wildfly/SKILL.md) |

---

## Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Per-product scrapers (`*_collector.js`) pull the latest security advisories from vendor sources. Collection window: **180 days**. Raw data is normalized into JSON under each product's skill directory.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts (`*_preprocessing.py`) filter the raw data against a **Strict Whitelist** of core middleware components. EOL versions and unrelated updates are pruned. Related advisories are aggregated into a cumulative history.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Historical exclusion feedback is injected via `query_rag.py` before invoking the AI Agent. The Agent selects patches *only* if they prevent catastrophic failures:
1. **System/Service Stability**: Fixes for Hangs, Deadlocks, or Application Server Crashes.
2. **Data Integrity**: Fixes for Session Corruption, Data Loss, or Unavailability.
3. **Security**: Critical vulnerabilities (RCE, Privilege Escalation, Deserialization attacks).
4. **Hardware/Failover**: Resolving clustering or HA failover issues.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the dashboard database. Passthrough patches are also recorded with a `passthrough` flag.

### 5. Report Export
Per-product CSV (`final_approved_patches_<product>.csv`) with dual-language (English/Korean) summaries for operations team review.
