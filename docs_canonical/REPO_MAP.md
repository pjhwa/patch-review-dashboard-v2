# REPO_MAP — Patch Review Dashboard V2

## Repository Purpose

An autonomous compliance operations platform that:
1. Collects vendor security advisories quarterly (cron)
2. Preprocesses raw JSON into normalized patch records (Python)
3. AI-reviews patches via OpenClaw CLI (batches of 5)
4. Presents results for human review in a web dashboard (Next.js)
5. Finalizes approved patches to CSV for distribution

Operated by: Cloud & Infrastructure Technical Expert Center (CI-TEC)
Cadence: Quarterly (end of Mar, Jun, Sep, Dec)
Port: 3001
Process manager: pm2 (`patch-dashboard` process)

---

## Supported Products (9 active)

| ID | Name | Category |
|----|------|----------|
| `redhat` | Red Hat Enterprise Linux | os |
| `oracle` | Oracle Linux | os |
| `ubuntu` | Ubuntu Linux | os |
| `windows` | Windows Server | os |
| `ceph` | Ceph | storage |
| `mariadb` | MariaDB | database |
| `sqlserver` | SQL Server | database |
| `pgsql` | PostgreSQL | database |
| `vsphere` | VMware vSphere | virtualization |

Inactive (future): MySQL, HP-UX, IBM AIX, Oracle Solaris

---

## Top-Level Directory Structure

```
patch-review-dashboard-v2/
├── src/                        Next.js application (API + UI)
│   ├── app/                    App Router pages and API routes
│   │   ├── page.tsx            Root redirect → /category/os
│   │   ├── category/[categoryId]/[productId]/  Product detail pages
│   │   └── api/pipeline/       All pipeline API handlers
│   ├── lib/
│   │   ├── products-registry.ts  CENTRAL SOURCE OF TRUTH — all product config
│   │   ├── queue.ts              BullMQ worker + runProductPipeline()
│   │   └── prisma.ts             Prisma client singleton
│   └── components/             React UI components
├── prisma/
│   ├── schema.prisma           Database schema (5 models)
│   └── patch-review.db         SQLite database file (runtime)
├── patch-review/               AI pipeline skill files (deployed to ~/.openclaw)
│   ├── os/linux/               Red Hat, Oracle, Ubuntu
│   ├── os/windows/             Windows Server
│   ├── database/mariadb/       MariaDB
│   ├── database/sqlserver/     SQL Server
│   ├── database/pgsql/         PostgreSQL
│   ├── storage/ceph/           Ceph
│   └── virtualization/vsphere/ VMware vSphere
├── docs/                       Reference documentation (legacy)
├── docs_canonical/             THIS DIRECTORY — authoritative AI knowledge layer
├── scripts/
│   └── validate-registry.js   Registry validator (run before every deploy)
├── AGENTS.md                   AI agent operating rules
├── DOCS.md                     Document index
└── README.md                   Project overview
```

---

## Key Entry Points

| Entry Point | Purpose |
|-------------|---------|
| `src/lib/products-registry.ts` | All product config — start here for any product task |
| `src/lib/queue.ts` | Pipeline execution logic — `runProductPipeline()` |
| `src/app/api/pipeline/*/route.ts` | Per-product run/finalize API handlers |
| `src/components/ProductGrid.tsx` | UI pipeline trigger + SSE live log display |
| `prisma/schema.prisma` | Database schema |
| `scripts/validate-registry.js` | Validation tool — run after any registry change |

---

## Skill Directory (Runtime, Not in Repo)

The `patch-review/` directory is deployed at runtime to:
```
~/.openclaw/workspace/skills/patch-review/
```

Each product's skill directory contains:
- `SKILL.md` — AI evaluation rules (≥100 lines, requires `## 4.` section)
- `*_preprocessing.py` — Python preprocessing script
- `*_data/` — Collected raw advisory files
- `patches_for_llm_review_*.json` — Preprocessing output (AI input)
- `query_rag.py` — RAG exclusion script (Linux products only)

---

## High-Level Dependency Structure

```
Next.js (UI + API)
    └── BullMQ (Redis) ── queue.ts worker
              └── runProductPipeline()
                    ├── Python preprocessing script
                    ├── openclaw agent:main (AI)
                    │       └── SKILL.md (reads from skillDir)
                    └── Prisma ORM (SQLite)
```

External runtime dependencies: Redis (6+), Python (3.10+), openclaw CLI
