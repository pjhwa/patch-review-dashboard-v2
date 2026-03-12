# 🌐 Network Equipment Patch Guidelines

> **Domain**: Infrastructure / Networking
> **Scope**: Cisco, F5, Fortinet, Secui

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for network infrastructure.

## 📋 Target Products Scope

The following network devices and platforms are within the scope of the Patch Review Board:

### Cisco Systems
- **Catalyst Series** (Access/Core Switching):
    - Catalyst 2960, 3650, 3850
    - Catalyst 6500 (Legacy Core)
    - Catalyst 9200, 9300, 9400, 9600 (Modern Intent-Based Networking)
- **Nexus Series** (Data Center Switching):
    - Nexus 3K, 5K, 7K, 9K
    - Cisco NDFC (Nexus Dashboard Fabric Controller)
- **Routing**:
    - ASR (Aggregation Services Routers)
    - ISR (Integrated Services Routers)

### Load balancers & ADC
- **F5 Networks**: BIG-IP LTM (Local Traffic Manager)
- **A10 Networks**: Thunder Series (TH)

### Security / Firewalls
- **Fortinet**: Fortigate Next-Generation Firewalls
- **Secui**:
    - BLUEMAX (NGFW)
    - MF2 (Multifunction Firewall)

---

## 📄 Available Instructions

| File | Description | Target Agent |
| :--- | :--- | :--- |
| *TBD* | *Instructions for Network OS (IOS-XE, NX-OS, TMOS, FortiOS) are under development.* | - |

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
