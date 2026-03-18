# 🛡️ Patch Review Board (PRB) — AI Skill Library

This directory contains the AI pipeline skill files for the Patch Review Dashboard V2. It is deployed to `~/.openclaw/workspace/skills/patch-review/` on the operations server, where the OpenClaw AI agent and preprocessing scripts run.

> **Deployment**: `cp -r ./patch-review ~/.openclaw/workspace/skills/`

---

## Directory Structure

```
patch-review/
├── os/
│   ├── linux/              ← Red Hat, Oracle Linux, Ubuntu (shared preprocessing)
│   │   ├── SKILL.md           ← AI evaluation rules (280+ lines, §4 Strict Rules)
│   │   ├── patch_preprocessing.py   ← --vendor redhat/oracle/ubuntu
│   │   ├── query_rag.py       ← RAG exclusion (prompt-injection strategy)
│   │   ├── rhsa_collector.js
│   │   ├── rhba_collector.js
│   │   ├── oracle_collector.sh
│   │   ├── oracle_parser.py
│   │   ├── ubuntu_collector.sh
│   │   ├── redhat_data/       ← Collected RHSA-*.json / RHBA-*.json files
│   │   ├── oracle_data/       ← Collected ELSA-*.json files
│   │   └── ubuntu_data/       ← Collected USN-*.json files
│   └── windows/               ← Windows Server
│       ├── SKILL.md
│       ├── windows_preprocessing.py
│       ├── windows_data/
│       └── windows_data/normalized/
│
├── database/
│   ├── mariadb/               ← MariaDB
│   │   ├── SKILL.md
│   │   ├── mariadb_preprocessing.py
│   │   ├── mariadb_collector.js
│   │   ├── mariadb_data/
│   │   └── mariadb_data/normalized/
│   ├── sqlserver/             ← Microsoft SQL Server
│   │   ├── SKILL.md
│   │   ├── sqlserver_preprocessing.py
│   │   ├── sql_data/
│   │   └── sql_data/normalized/
│   └── pgsql/                 ← PostgreSQL
│       ├── SKILL.md
│       ├── pgsql_preprocessing.py
│       ├── pgsql_data/
│       └── pgsql_data/normalized/
│
├── storage/
│   └── ceph/                  ← Ceph Storage
│       ├── SKILL.md
│       ├── ceph_preprocessing.py
│       ├── ceph_data/
│       └── ceph_data/normalized/
│
├── virtualization/
│   └── vsphere/               ← VMware vSphere
│       ├── SKILL.md
│       ├── vsphere_preprocessing.py
│       └── vsphere_data/
│
├── network/                   ← Placeholder (not yet active)
│   └── README.md
│
├── middleware/                 ← Placeholder (not yet active)
│   └── README.md
│
└── scripts/                   ← Shared collection utility scripts
```

---

## Active Products

| Product | Directory | BullMQ Job | RAG Strategy |
|---------|-----------|------------|--------------|
| Red Hat Enterprise Linux | `os/linux` | `run-redhat-pipeline` | prompt-injection |
| Oracle Linux | `os/linux` | `run-oracle-pipeline` | prompt-injection |
| Ubuntu Linux | `os/linux` | `run-ubuntu-pipeline` | prompt-injection |
| Windows Server | `os/windows` | `run-windows-pipeline` | file-hiding |
| Ceph | `storage/ceph` | `run-ceph-pipeline` | file-hiding |
| MariaDB | `database/mariadb` | `run-mariadb-pipeline` | file-hiding |
| SQL Server | `database/sqlserver` | `run-sqlserver-pipeline` | file-hiding |
| PostgreSQL | `database/pgsql` | `run-pgsql-pipeline` | file-hiding |
| VMware vSphere | `virtualization/vsphere` | `run-vsphere-pipeline` | none |

---

## Pipeline Methodology

### 1. Data Collection
Each product has dedicated collectors that pull security advisories from vendor sources:
- **Red Hat**: RHSA/RHBA Errata API → `redhat_data/RHSA-*.json`
- **Oracle Linux**: Oracle Linux Errata → `oracle_data/ELSA-*.json`
- **Ubuntu**: Ubuntu Security Notices → `ubuntu_data/USN-*.json`
- **Windows**: Windows Update Catalog → `windows_data/WIN-*.json`
- **Databases & Storage**: Vendor-specific APIs → respective `*_data/` directories

Collection is triggered by CRON (quarterly: 3rd Sunday of Mar, Jun, Sep, Dec) or manually via the dashboard.

### 2. Preprocessing
Python scripts normalize raw JSON into a standardized patch format:
```bash
# Linux (individual vendor processing)
python3 patch_preprocessing.py --vendor redhat --days 90
python3 patch_preprocessing.py --vendor oracle --days 90
python3 patch_preprocessing.py --vendor ubuntu --days 90

# Other products
python3 mariadb_preprocessing.py --days 90
python3 windows_preprocessing.py --days 180 --days_end 90
```

Output: `patches_for_llm_review_<vendor>.json`

### 3. AI Review (via OpenClaw)
The BullMQ worker in the dashboard invokes:
```bash
openclaw agent:main --json-mode --message "<SKILL.md path + batch data>"
```
The AI evaluates patches according to `SKILL.md` Section 4 (Strict LLM Evaluation Rules) and outputs structured JSON.

### 4. Finalization
The dashboard user reviews AI output, modifies decisions as needed, then finalizes to produce:
```
final_approved_patches_<vendor>.csv   (UTF-8 BOM encoded for Excel)
```

---

## SKILL.md Requirements

Every product's `SKILL.md` must meet these standards (enforced by `scripts/validate-registry.js`):
- **≥100 lines** of content
- **`## 4.`** section "Strict LLM Evaluation Rules" with subsections:
  - `### 4.1` Inclusion Criteria
  - `### 4.2` Exclusion Criteria
  - `### 4.3` Output Format
  - `### 4.4` General Rules
  - `### 4.5` Hallucination Prevention Rules
- **`## 5.`** Output Validation Rules

---

## Adding a New Product

1. Create a new directory under the appropriate category (e.g., `database/mysql/`)
2. Write `SKILL.md` following the standard structure above
3. Write a preprocessing script
4. Add a `ProductConfig` entry in `src/lib/products-registry.ts`
5. Create `run/route.ts` and `finalize/route.ts` API routes
6. Run `node scripts/validate-registry.js` — all checks must pass

See `docs/PRODUCT_SPEC_TEMPLATE.md` for the full specification template and `~/ADDING_NEW_PRODUCT.md` for the step-by-step checklist.

---

*Maintained by Infrastructure Operation Team — Cloud & Infrastructure Technical Expert Center (CI-TEC)*
