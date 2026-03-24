# 🐧 Operating System Patch Guidelines

> **Domain**: Infrastructure / Operating Systems
> **Scope**: Windows, Linux, Unix

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for operating systems.

## 📋 Target Products Scope

The following operating systems are within the scope of the Patch Review Board:

### Linux
- **Red Hat Enterprise Linux (RHEL)** (8, 9, 10)
- **Ubuntu LTS** (22.04, 24.04)
- **Oracle Linux** (8, 9, 10)

### Windows
- **Microsoft Windows Server** (2019, 2022, 2025)

### Unix
- **HP-UX**
- **IBM AIX**
- **Oracle Solaris**

---

## 📄 Available Instructions

| OS Family | Description | Target Agent Protocol |
| :--- | :--- | :--- |
| **Linux** | Complete automation pipeline for RHEL, Ubuntu, and Oracle Linux. | [`linux/SKILL.md`](linux/SKILL.md) |
| **Windows** | Full automation pipeline for Windows Server 2019/2022/2025. | [`windows/SKILL.md`](windows/SKILL.md) |
| **Unix** | *Under development. Will follow the identical Automated Pipeline.* | *TBD* |

> **Note**: HP-UX, AIX, and Oracle Solaris instructions are under development and will enforce the same pipeline established for Linux and Windows.

---

## 🎯 Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Per-product automated scrapers pull the latest security and bugfix advisories directly from vendor sources. This stage handles pagination, retries, and normalizes raw data into JSON format. Collection window: **180 days**.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts computationally filter raw data against a **Strict Whitelist** of core system components. Non-critical packages, End-of-Life (EOL) versions, and unrelated updates are aggressively pruned. Multiple updates for the same component are aggregated into a cumulative history timeline.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Historical exclusion feedback is injected into the AI prompt via `query_rag.py` before invoking the agent. The Agent selects patches *only* if they prevent catastrophic failures:
1. **System/Service Stability** 🛑: Fixes for Hangs, Deadlocks, or Boot/Service Failures.
2. **Data Integrity** 💾: Fixes for Data Loss, Data Corruption, or Unavailability.
3. **Security** 🔒: Mitigation of Critical vulnerabilities (RCE, Privilege Escalation).
4. **Hardware/Failover** 🔄: Resolving High Availability (HA) split-brains or hardware faults.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the dashboard database for display and export. Passthrough patches (in scope but not AI-selected) are also recorded with a `passthrough` flag.

### 5. Report Export
Final results are available as per-product CSV (`final_approved_patches_<product>.csv`) with dual-language (English/Korean) summaries for operations team review.
