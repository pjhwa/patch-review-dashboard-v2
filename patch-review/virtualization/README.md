# Virtualization Patch Guidelines

> **Domain**: Infrastructure / Virtualization
> **Scope**: VMware, Citrix, Cloud Management

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for virtualization platforms and cloud management tools.

## Target Products Scope

### Active Products
- **VMware vSphere** — `vsphere/` | VMware Security Advisories (VMSA) for ESXi and vCenter Server

### Planned (Not Yet Implemented)

#### VMware by Broadcom (extended)
- vSAN (Virtual SAN)
- NSX (Network Virtualization)
- Aria (formerly vRealize Suite)
- VMware Live Site Recovery (formerly SRM)

#### Citrix
- Citrix Hypervisor (formerly XenServer)
- XenCenter (Management Console)

---

## Available Instructions

| Product | Description | Agent Instructions |
| :--- | :--- | :--- |
| **VMware vSphere** | VMware Security Advisories for ESXi and vCenter | [`vsphere/SKILL.md`](vsphere/SKILL.md) |
| *VMware vSAN / NSX* | *Under development* | *TBD* |
| *Citrix Hypervisor* | *Under development* | *TBD* |

---

## Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Per-product scrapers (`*_collector.py`) pull the latest VMware Security Advisories (VMSA) from vendor sources. Collection window: **180 days**. Raw data is normalized into JSON under each product's skill directory.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts (`*_preprocessing.py`) filter raw data against a **Strict Whitelist** of core hypervisor and management components. EOL versions and low-severity advisories are pruned. Related advisories are aggregated.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Historical exclusion feedback is injected via `query_rag.py` before invoking the AI Agent. The Agent selects patches *only* if they prevent catastrophic failures:
1. **System/Service Stability**: Fixes for ESXi/vCenter Hangs, Deadlocks, or PSOD.
2. **Data Integrity**: Fixes for VM data loss, vSAN corruption, or storage I/O errors.
3. **Security**: Critical vulnerabilities (VM Escape, Privilege Escalation, RCE via VMSA).
4. **Hardware/Failover**: Resolving HA/DRS failover or vSAN cluster issues.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the dashboard database. Passthrough patches are also recorded with a `passthrough` flag.

### 5. Report Export
Per-product CSV (`final_approved_patches_<product>.csv`) with dual-language (English/Korean) summaries for operations team review.
