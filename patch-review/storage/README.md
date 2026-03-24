# Storage Patch Guidelines

> **Domain**: Infrastructure / Storage
> **Scope**: Software-Defined Storage, Enterprise Storage Arrays

This directory contains the job instructions for AI Agents to perform quarterly patch analysis for enterprise storage systems.

## Target Products Scope

### Active Products
- **Ceph** (Reef) -- `ceph/` | Ceph release announcements and CVE advisories

### Planned (Not Yet Implemented)

#### Dell EMC
- Block & Unified: PowerStore, PowerMAX, VMAX, VNX, Unity, XtremIO
- File & Object: Isilon (PowerScale), ECS (Elastic Cloud Storage)
- Networking: Connectrix (Brocade, Cisco MDS)

#### Hitachi Vantara
- VSP Series: VSP 5000, G/F/E Series, VSP One Block/File
- Midrange/Legacy: HUS, AMS, HNAS, USP

#### HPE (Hewlett Packard Enterprise)
- Alletra, Primera, 3PAR StoreServ

#### NetApp
- AFF (All Flash FAS), FAS (Fabric Attached Storage)

---

## Available Instructions

| Product | Description | Agent Instructions |
| :--- | :--- | :--- |
| **Ceph** | Ceph release security and stability advisories | [`ceph/SKILL.md`](ceph/SKILL.md) |
| *Dell EMC* | *Under development* | *TBD* |
| *NetApp ONTAP* | *Under development* | *TBD* |
| *Hitachi VSP* | *Under development* | *TBD* |

---

## Patch Review Methodology (Automated Pipeline)

The AI Agent evaluates patches using a highly structured, automated **5-step pipeline** designed to filter out noise and focus purely on critical infrastructure impact.

### 1. Data Collection (Ingestion)
Per-product scrapers (`*_collector.py`) pull the latest security advisories from vendor sources. Collection window: **180 days**. Raw data is normalized into JSON under each product's skill directory.

### 2. Preprocessing & Pruning (Signal Extraction)
Per-product preprocessing scripts (`*_preprocessing.py`) filter the raw data against a **Strict Whitelist** of core storage components. EOL versions and unrelated updates are pruned. Related advisories are aggregated into a cumulative history.

### 3. RAG-Augmented AI Review (LLM Intelligent Review)
Historical exclusion feedback is injected via `query_rag.py` before invoking the AI Agent. The Agent selects patches *only* if they prevent catastrophic failures:
1. **System/Service Stability**: Fixes for Hangs, Deadlocks, or Storage Service Failures.
2. **Data Integrity**: Fixes for Data Loss, Silent Corruption, or I/O errors.
3. **Security**: Critical vulnerabilities (RCE, Privilege Escalation, unauthorized data access).
4. **Hardware/Failover**: Resolving HA failover, RAID rebuild, or replication failures.

*Minor bug fixes and non-critical security patches are actively excluded.*

### 4. DB Ingestion
Reviewed patches are upserted into the dashboard database. Passthrough patches are also recorded with a `passthrough` flag.

### 5. Report Export
Per-product CSV (`final_approved_patches_<product>.csv`) with dual-language (English/Korean) summaries for operations team review.
