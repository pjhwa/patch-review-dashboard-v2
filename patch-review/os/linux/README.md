<div align="center">

# Linux OS Patch Review Automation

[![OS](https://img.shields.io/badge/OS-Linux-FCC624?logo=linux&logoColor=black)](#)
[![Automation](https://img.shields.io/badge/Process-Automated-0078D6?logo=githubactions&logoColor=white)](#)
[![Target](https://img.shields.io/badge/Target-RHEL%20%7C%20Oracle%20%7C%20Ubuntu-E95420)](#)

*An end-to-end automated pipeline for collecting, preprocessing, analyzing, and reporting critical infrastructure patches.*

</div>

---

## Overview

The **Linux OS Patch Review Automation** sets the standard for proactive infrastructure stability. By leveraging web scraping, intelligent preprocessing, and LLM-based deep impact analysis, this pipeline filters through thousands of vendor advisories to pinpoint only the updates that prevent **System Crashes**, **Data Loss**, and **Critical Security Breaches**.

Each Linux distribution runs as an independent BullMQ queue job, allowing parallel execution across RHEL, Oracle Linux, and Ubuntu.

## Architecture & Workflow

The patch review process is divided into **five highly specialized stages**, ensuring zero noise and maximum operational stability.

```mermaid
graph TD
    classDef script fill:#2d3436,stroke:#74b9ff,stroke-width:2px,color:#fff;
    classDef data fill:#0984e3,stroke:#0984e3,stroke-width:2px,color:#fff;
    classDef llm fill:#6c5ce7,stroke:#a29bfe,stroke-width:2px,color:#fff;
    classDef db fill:#00b894,stroke:#00b894,stroke-width:2px,color:#fff;

    subgraph "Phase 1: Data Collection (per distro)"
        A1[Red Hat Errata Web] --> B1["redhat_collector.py"]:::script
        A2[Oracle UEK Mailing List] --> B2["oracle_collector.py"]:::script
        A3[Ubuntu Security API] --> B3["ubuntu_collector.py"]:::script
        B1 & B2 & B3 --> C[("*_data/*.json (180-day window)")]:::data
    end

    subgraph "Phase 2: Preprocessing (per distro)"
        C --> D["*_preprocessing.py"]:::script
        D --> E[("patches_for_llm_review_*.json")]:::data
    end

    subgraph "Phase 3: RAG + AI Review"
        E --> F1["query_rag.py (exclusion injection)"]:::script
        F1 --> F2{"LLM Agent Review (SKILL.md)"}:::llm
        F2 --> G[("patch_review_ai_report_*.json")]:::data
    end

    subgraph "Phase 4: DB Ingestion"
        G --> H["ingestToDb()"]:::script
        H --> I[("PostgreSQL PreprocessedPatch / ReviewedPatch")]:::db
    end

    subgraph "Phase 5: Export"
        I --> J[["final_approved_patches_*.csv (Dashboard Export)"]]:::data
    end
```

---

## Core Components

<details>
<summary><b>1. Per-Distro Collectors (Data Collection)</b></summary>
<br>

Three independent Python collectors, each fault-tolerant and purpose-built for its source:

- **`redhat/`** -- `redhat_collector.py`: Scrapes Red Hat Errata web pages using DOM parsing. Handles pagination and rate limiting.
- **`oracle/`** -- `oracle_collector.py`: Parses Oracle UEK mailing list archives (Mailman). Extracts advisory metadata from plain-text email threads.
- **`ubuntu/`** -- `ubuntu_collector.py`: Queries the Ubuntu Security Notices API and traverses HTML advisories.

All collectors write normalized JSON to their respective `*_data/` directories with a **180-day collection window**.

</details>

<details>
<summary><b>2. patch_preprocessing.py (Pruning & Aggregation)</b></summary>
<br>

A per-product Python engine that translates chaotic vendor HTML/text into a standardized, parsed JSON payload.
- **Strict Whitelisting**: Only evaluates `SYSTEM_CORE_COMPONENTS` (e.g., kernel, filesystem, cluster, systemd, libvirt).
- **Distro Intelligence**: Filters out EOL Ubuntu versions, ignores unrelated OpenShift data, extracts specific component variants.
- **Aggregation**: Groups multiple minor point-releases of the same component into a unified cumulative history timeline to prevent LLM hallucination.
- **Review Scope**: From the 180-day collected pool, focuses AI review on the most recent **90-180 days** (kernel and critical components may use the full window).

</details>

<details>
<summary><b>3. query_rag.py + SKILL.md (RAG-Augmented AI Review)</b></summary>
<br>

Before each AI invocation, `query_rag.py` retrieves historically excluded patch entries and injects them as hard exclusion rules into the AI prompt. This prevents re-recommending patches that the operations team has already reviewed and declined.

**SKILL.md** is the definitive prompt instruction manual:
- **Decision Matrix**: Enforces strict inclusion rules for *System Hang, Data Loss, Boot Failures, and Critical CVEs*.
- **Cumulative Selection**: Instructs the LLM to identify the *latest critical version* within the review period.
- **Formatting Directives**: Mandates exact JSON schema compliance and high-quality dual-language descriptions.
- **Self-Healing Loop**: On schema validation failure, the error is fed back to the LLM for auto-correction (up to 3 retries).

</details>

<details>
<summary><b>4. DB Ingestion (ingestToDb)</b></summary>
<br>

After AI review, the queue worker upserts results into the PostgreSQL database:
- **`PreprocessedPatch`**: All patches in the preprocessing output (full candidate list).
- **`ReviewedPatch`**: AI-selected critical patches.
- **Passthrough**: Patches in scope but not selected by AI are recorded with `passthrough = true` for audit purposes.

</details>

<details>
<summary><b>5. Dashboard Export</b></summary>
<br>

The operations team exports final results from the web dashboard as per-distro CSV files:
- `final_approved_patches_redhat.csv`
- `final_approved_patches_oracle.csv`
- `final_approved_patches_ubuntu.csv`

Each record includes dual-language (English/Korean) descriptions and CVSS severity ratings.

</details>

---

## Target Distributions

| Vendor | OS / Kernel | Versions | Status | Collection Method |
| :--- | :--- | :--- | :---: | :--- |
| **Red Hat** | RHEL (Kernel, Glibc, Systemd, ...) | 8, 9, 10 | Active | Web DOM Scraping |
| **Oracle** | Oracle Linux (UEK) | 8, 9, 10 | Active | Mailing List Archive Parsing |
| **Canonical** | Ubuntu Server LTS | 22.04, 24.04 | Active | Security API + HTML Traversal |

> **Note**: EOL versions (Ubuntu 20.04 and earlier, RHEL 7 and earlier) are explicitly excluded during preprocessing to maintain focus on supported infrastructure.

---
*Maintained by the Infrastructure AI Engineering Team.*
