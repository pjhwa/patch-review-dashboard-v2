<div align="center">
  <br />
  <h1>🛡️ Patch Review Dashboard V2</h1>
  <p>
    An intelligent, autonomous compliance operations platform for enterprise patch management.<br />
    Powered by <strong>BullMQ</strong>, <strong>OpenClaw AI</strong>, and a <strong>Central Product Registry</strong>.
  </p>
  <br />

  [![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)](#)
  [![Next.js](https://img.shields.io/badge/Next.js_16-000000?style=for-the-badge&logo=nextdotjs&logoColor=white)](#)
  [![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)](#)
  [![Prisma](https://img.shields.io/badge/Prisma-3982CE?style=for-the-badge&logo=Prisma&logoColor=white)](#)
  [![BullMQ](https://img.shields.io/badge/BullMQ-FF6B6B?style=for-the-badge&logo=redis&logoColor=white)](#)
  [![OpenClaw AI](https://img.shields.io/badge/OpenClaw_AI-FF6B6B?style=for-the-badge&logo=robot&logoColor=white)](#)

</div>

---

## ✨ Features

- **🗂️ Central Product Registry** — One `products-registry.ts` file defines all 9 supported products. Adding a new product requires editing exactly one file, eliminating the scattered multi-file synchronization that caused errors in earlier versions.
- **⚡ BullMQ Job Queue** — All pipeline executions are dispatched as named BullMQ jobs (`run-redhat-pipeline`, `run-ceph-pipeline`, etc.) backed by Redis. A single persistent worker picks up jobs, preventing concurrent race conditions without file-system locks.
- **🤖 OpenClaw RAG-Powered AI Review** — Uses Gemini models locally orchestrated via `openclaw agent:main`. Each product supports one of two RAG exclusion strategies: `prompt-injection` (Linux) or `file-hiding` (Windows, Ceph, MariaDB, etc.).
- **🛡️ Self-Healing Zod Validation** — AI JSON output is validated against deterministic schemas. Invalid batches are retried with the specific Zod error injected back into the prompt (up to 2 retries with exponential backoff).
- **🔁 Passthrough Safety Net** — Patches that the AI skips (e.g., due to rate limits or context overflows) are automatically inserted into `ReviewedPatch` with `criticality: 'Important', decision: 'Pending'` — ensuring zero data loss.
- **📊 Real-Time SSE Streaming** — Live pipeline log streaming to the dashboard via Server-Sent Events without page reloads.
- **🌐 9 Supported Products** — Red Hat, Oracle Linux, Ubuntu, Windows Server, Ceph, MariaDB, SQL Server, PostgreSQL, VMware vSphere.

---

## 🏗️ Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                  Web Dashboard (Next.js)                │
│   ProductGrid → [Run Pipeline] → POST /api/pipeline/run │
└──────────────────────┬──────────────────────────────────┘
                       │ enqueue BullMQ job
                       ▼
┌──────────────────────────────────────────────────────────┐
│              BullMQ Queue  (Redis-backed)                │
│   job.name = "run-redhat-pipeline"  (or any of 9)        │
└──────────────────────┬───────────────────────────────────┘
                       │ Worker picks up job
                       ▼
┌──────────────────────────────────────────────────────────┐
│           queue.ts  Generic Worker                       │
│   1. Lookup: PRODUCT_MAP[jobName] → ProductConfig        │
│   2. runProductPipeline(job, productCfg)                 │
│      ├─ runPreprocessing (Python --vendor flag)          │
│      ├─ runAiReviewLoop (batch AI, Zod, retries)         │
│      ├─ ingestToDb (Prisma upsert)                       │
│      └─ runPassthrough (safety net for skipped patches)  │
└──────────────────────┬───────────────────────────────────┘
                       │
           ┌───────────┴────────────┐
           ▼                        ▼
    SQLite (Prisma)         OpenClaw AI Agent
    PreprocessedPatch       (Gemini via openclaw)
    ReviewedPatch
```

For detailed documentation, see the [`/docs`](docs/) directory:
| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) / [한국어](docs/architecture_ko.md) | System design & component overview |
| [Pipeline Flow](docs/pipeline_flow.md) / [한국어](docs/pipeline_flow_ko.md) | Step-by-step pipeline execution flow |
| [Product Registry](docs/product_registry.md) | Central registry design & how to add products |
| [Tech Stack](docs/tech_stack.md) / [한국어](docs/tech_stack_ko.md) | Technology choices and versions |
| [AI Review](docs/ai_review.md) / [한국어](docs/ai_review_ko.md) | AI review loop, RAG, and self-healing |
| [Deployment Guide](docs/deployment.md) | Full environment setup from scratch |
| [Product Spec Template](docs/PRODUCT_SPEC_TEMPLATE.md) | Template for onboarding new products |

---

## 🚀 Quick Start

### Requirements

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | v22+ | Runtime for Next.js and workers |
| pnpm | latest | Package manager |
| Python | 3.x | Preprocessing scripts |
| Redis | 6+ | BullMQ job queue backend |
| openclaw | latest | AI agent CLI |

### 1. Clone the repository

```bash
git clone https://github.com/your-org/patch-review-dashboard-v2.git
cd patch-review-dashboard-v2
```

### 2. Install dependencies

```bash
pnpm install
```

### 3. Deploy the pipeline skills

The AI pipeline skill logic lives in `~/.openclaw/workspace/skills/patch-review`. Copy it from the repository:

```bash
mkdir -p ~/.openclaw/workspace/skills/
cp -r ./patch-review ~/.openclaw/workspace/skills/
```

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env:
#   DATABASE_URL="file:./prisma/patch-review.db"
#   REDIS_URL="redis://localhost:6379"
```

### 5. Setup the database

```bash
pnpm prisma generate
pnpm prisma db push
```

### 6. Start Redis

```bash
# Ubuntu/Debian
sudo systemctl start redis-server

# macOS (Homebrew)
brew services start redis
```

### 7. Launch the application

```bash
pnpm run dev
# Dashboard available at http://localhost:3001
```

> **Production deployment**: Use `build.sh` and `restart.sh` with pm2. See [Deployment Guide](docs/deployment.md).

---

## 📦 Supported Products

| Product | Category | Job Name | RAG Exclusion |
|---------|----------|----------|---------------|
| Red Hat Enterprise Linux | OS | `run-redhat-pipeline` | prompt-injection |
| Oracle Linux | OS | `run-oracle-pipeline` | prompt-injection |
| Ubuntu Linux | OS | `run-ubuntu-pipeline` | prompt-injection |
| Windows Server | OS | `run-windows-pipeline` | file-hiding |
| Ceph | Storage | `run-ceph-pipeline` | file-hiding |
| MariaDB | Database | `run-mariadb-pipeline` | file-hiding |
| SQL Server | Database | `run-sqlserver-pipeline` | file-hiding |
| PostgreSQL | Database | `run-pgsql-pipeline` | file-hiding |
| VMware vSphere | Virtualization | `run-vsphere-pipeline` | none |

---

## ⏰ Autonomous CRON Scheduling

Data collection runs automatically on the **third Sunday of March, June, September, and December at 06:00** via `update_cron.sh`. The quarterly cadence aligns with enterprise patch review cycles.

---

## 🛠️ Development Scripts

```bash
node scripts/validate-registry.js    # Validate all 9 products in the registry
pnpm prisma studio                   # Open Prisma database GUI
bash build.sh                        # Production build
bash restart.sh                      # Restart pm2 process
```

---

<div align="center">
  <sub>Built with ❤️ by the Cloud & Infrastructure - Technical Expert Center (CI-TEC)</sub>
</div>
