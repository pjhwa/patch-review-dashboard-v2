# 🗄️ Database Patch Guidelines

> **Domain**: Infrastructure / Databases
> **Scope**: Open Source RDBMS, MS SQL Server

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for database management systems.

## 📋 Target Products Scope

### Active Products
- **MariaDB** — `mariadb/` | RHSA-based advisories
- **Microsoft SQL Server** (2019, 2022) — `sqlserver/` | Microsoft Security Updates
- **PostgreSQL** — `pgsql/` | PostgreSQL release announcements
- **MySQL Community** — `mysql/` | MySQL Security Advisories

### Planned (Not Yet Implemented)
- Oracle Database (19c, 21c, 23c)
- Oracle Exadata
- EPAS (EnterpriseDB Postgres Advanced Server)

---

## 📄 Available Instructions

| Product | Description | Agent Instructions |
| :--- | :--- | :--- |
| **MariaDB** | RHSA-sourced MariaDB security advisories | [`mariadb/SKILL.md`](mariadb/SKILL.md) |
| **SQL Server** | Microsoft cumulative updates and security patches | [`sqlserver/SKILL.md`](sqlserver/SKILL.md) |
| **PostgreSQL** | PostgreSQL version release security advisories | [`pgsql/SKILL.md`](pgsql/SKILL.md) |
| **MySQL Community** | MySQL Security Advisories from oracle.com | [`mysql/SKILL.md`](mysql/SKILL.md) |

---

## 🎯 Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Per-product scrapers (`*_collector.py` / `*_collector.js`) pull the latest security advisories from vendor sources. Collection window: **180 days**. Raw data is normalized into JSON under each product's skill directory.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts (`*_preprocessing.py`) filter the raw data against a **Strict Whitelist** of core database components. EOL versions and unrelated updates are pruned. Related advisories are aggregated into a cumulative history.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Historical exclusion feedback is injected via `query_rag.py` before invoking the AI Agent. The Agent selects patches *only* if they prevent catastrophic failures:
1. **System/Service Stability** 🛑: Fixes for Hangs, Deadlocks, or Service Failures.
2. **Data Integrity** 💾: Fixes for Data Loss, Corruption, or Unavailability.
3. **Security** 🔒: Critical vulnerabilities (RCE, Privilege Escalation, SQL Injection risk).
4. **Hardware/Failover** 🔄: Resolving HA/replication split-brains or storage faults.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the dashboard database. Passthrough patches are also recorded with a `passthrough` flag.

### 5. Report Export
Per-product CSV (`final_approved_patches_<product>.csv`) with dual-language (English/Korean) summaries for operations team review.
