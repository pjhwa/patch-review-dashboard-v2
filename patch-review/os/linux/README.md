<div align="center">

# 🐧 Linux OS Patch Review Automation

[![OS](https://img.shields.io/badge/OS-Linux-FCC624?logo=linux&logoColor=black)](#)
[![Automation](https://img.shields.io/badge/Process-Automated-0078D6?logo=githubactions&logoColor=white)](#)
[![Target](https://img.shields.io/badge/Target-RHEL%20%7C%20Oracle%20%7C%20Ubuntu-E95420)](#)

*An end-to-end automated pipeline for collecting, preprocessing, analyzing, and reporting critical infrastructure patches.*

</div>

---

## 🚀 Overview

The **Linux OS Patch Review Automation** sets the standard for proactive infrastructure stability. By leveraging web scraping, intelligent preprocessing, and LLM-based deep impact analysis, this pipeline filters through thousands of vendor advisories to pinpoint only the updates that prevent **System Crashes**, **Data Loss**, and **Critical Security Breaches**.

## 🏗️ Architecture & Workflow

The patch review process is divided into four highly specialized stages, ensuring zero noise and maximum operational stability.

```mermaid
graph TD
    classDef script fill:#2d3436,stroke:#74b9ff,stroke-width:2px,color:#fff,rx:5px,ry:5px;
    classDef data fill:#0984e3,stroke:#0984e3,stroke-width:2px,color:#fff,rx:5px,ry:5px;
    classDef llm fill:#6c5ce7,stroke:#a29bfe,stroke-width:2px,color:#fff,rx:5px,ry:5px;
    
    subgraph Phase 1: Data Collection
        A1[Red Hat Web] & A2[Oracle Mail Archive] & A3[Ubuntu Security Web] -.-> B["batch_collector.js"]:::script
        B --> C[("batch_data/*.json")]:::data
    end

    subgraph Phase 2: Preprocessing
        C -.-> D["patch_preprocessing.py"]:::script
        D --> E>["patches_for_llm_review.json"]:::data
    end

    subgraph Phase 3: Impact Analysis
        E -.-> F{"LLM Agent Review<br/>(SKILL.md)"}:::llm
    end

    subgraph Phase 4: Report Generation
        F -.-> G["perform_actual_review.py"]:::script
        G --> H[["patch_review_final_report.csv"]]:::data
    end

```

---

## 🧩 Core Components

<details>
<summary><b>1️⃣ batch_collector.js (Data Collection)</b></summary>
<br>

A robust Playwright-based Node.js scraper designed for fault tolerance and comprehensive data gathering.
- **Target Sources**: Red Hat Errata, Oracle UEK Mailing Archive, Ubuntu Security Notices.
- **Key Features**: 
  - Automated pagination and historical lookback (`--quarter` or `--days`).
  - Strict anti-hang watchdog logic (60s timeout handling).
  - Global retry queues and comprehensive failure logging (`collection_failures.json`).
  - Isolated browser contexts per scraping task.

</details>

<details>
<summary><b>2️⃣ patch_preprocessing.py (Pruning & Aggregation)</b></summary>
<br>

A Python engine that translates chaotic vendor HTML/text into a standardized, parsed JSON payload.
- **Strict Whitelisting**: Only evaluates `SYSTEM_CORE_COMPONENTS` (e.g., kernel, filesystem, cluster, systemd, libvirt).
- **Distro Intelligence**: Filters out EOL (End of Life) Ubuntu versions, ignores unrelated Red Hat OpenShift data, and extracts specific component versions (e.g., `linux-image-generic` vs `linux-image-aws`).
- **Aggregation**: Groups multiple minor point-releases of the same component into a unified cumulative history timeline to prevent LLM hallucination.

</details>

<details>
<summary><b>3️⃣ SKILL.md (Agent Operation Protocol)</b></summary>
<br>

The definitive prompt instruction manual designed to guide the AI Agent.
- **Decision Matrix**: Enforces strict inclusion rules for *System Hang, Data Loss, Boot Failures, and Critical CVEs*.
- **Cumulative Selection**: Instructs the LLM to identify the *latest critical version* within a quarter, discarding newer but superficial updates.
- **Formatting Directives**: Mandates exact CSV schema compliance and high-quality, synthesized dual-language descriptions.

</details>

<details>
<summary><b>4️⃣ perform_actual_review.py (Report Generation)</b></summary>
<br>

The final step for formatting the output into an actionable, enterprise-ready CSV.
- **Keyword-Driven Validation**: Failsafe mechanism executing keyword matches (e.g., "deadlock", "memory leak") against LLM output.
- **Description Generation**: Automatically synthesizes Korean and English impact summaries.
- **Output**: Generates `patch_review_final_report.csv` formatted exactly for the Infrastructure Operation Team.

</details>

---

## 🎯 Target Distributions

| Vendor | OS / Kernel | Status | Approach |
| :--- | :--- | :---: | :--- |
| **Red Hat** | Red Hat Enterprise Linux (RHEL 8, 9) | ✅ Active | Web DOM Scraping |
| **Oracle** | Oracle Linux (UEK - Unbreakable Enterprise Kernel) | ✅ Active | Mailing List Archival parsing |
| **Canonical**| Ubuntu Server (LTS: 22.04, 24.04) | ✅ Active | Search API & HTML traversal |

> **Note**: EOL versions (e.g., Ubuntu 18.04, RHEL 7) are explicitly excluded during the preprocessing phase to maintain focus on modern infrastructure.

---
*Maintained by the Infrastructure AI Engineering Team.*
