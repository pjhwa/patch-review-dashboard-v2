# Technology Stack

The Patch Review Dashboard V2 is built on a modern, decoupled stack. This document describes each technology choice and its role in the system.

---

## 1. Frontend & API Layer

### Framework: Next.js 16 (App Router)
- **Why**: Provides both the React UI and the API routes in a single deployment. App Router enables server components for data fetching and client components for interactive pipeline controls.
- **Key use**: `app/category/[categoryId]/[productId]/ClientPage.tsx` is a client component that manages patch review state. `app/api/pipeline/*/route.ts` files are the API handlers.
- **Dev server**: Runs with Turbopack (`next dev --turbo`) for sub-second hot reloads.
- **Port**: 3001 (configured in `package.json`)

### Language: TypeScript 5
- Strict type safety across all API routes, queue workers, and registry definitions.
- `ProductConfig` interface in `products-registry.ts` is the central typed contract.

### Styling: Tailwind CSS v4 + shadcn/ui
- Utility-first CSS with the new v4 CSS-native configuration (no `tailwind.config.js`).
- shadcn/ui components: `Table`, `Badge`, `Button`, `Dialog`, `Accordion`, `Sheet`, `ScrollArea` used across the dashboard.

### Real-Time Streaming: Server-Sent Events (SSE)
- `GET /api/pipeline/stream?jobId=X` maintains a persistent SSE connection.
- The BullMQ worker calls `job.log(message)` which is forwarded to connected SSE clients.
- `ProductGrid.tsx` parses log tags like `[REDHAT-PREPROCESS_DONE]`, `[MARIADB-PIPELINE]` using generic regex — no per-product code needed.

### Package Manager: pnpm
- Workspace managed via `pnpm-lock.yaml`.

---

## 2. Job Queue: BullMQ + Redis

### BullMQ v5
- **Why**: Replaces the v1 `child_process.spawn()` + `pipeline_status.json` file-lock approach. BullMQ provides reliable job queuing, concurrency control, job persistence across restarts, and log streaming.
- **Queue name**: `patch-pipeline`
- **Job names**: one per product — `run-redhat-pipeline`, `run-oracle-pipeline`, `run-ubuntu-pipeline`, `run-windows-pipeline`, `run-ceph-pipeline`, `run-mariadb-pipeline`, `run-sqlserver-pipeline`, `run-pgsql-pipeline`, `run-vsphere-pipeline`
- **Worker**: single worker in `src/lib/queue.ts` handles all job names via `PRODUCT_MAP` lookup

### ioredis v5
- Redis client used by BullMQ for job persistence.
- Connection configured via `REDIS_URL` environment variable.

### Redis 6+
- Must be running before the Next.js application starts.
- Default: `redis://127.0.0.1:6379`

---

## 3. Database Layer

### SQLite via Prisma ORM
- **Database file**: `prisma/patch-review.db`
- **Why SQLite**: Single-file database suitable for a dedicated compliance operations server with no concurrent write contention from external systems.
- **ORM**: Prisma 5 for type-safe queries, schema migrations (`prisma db push`), and schema introspection.

### Schema Models
| Model | Purpose |
|-------|---------|
| `RawPatch` | Raw vendor API JSON (caching layer, indexed by `vendor + originalId`) |
| `PreprocessedPatch` | Normalized patches ready for AI, indexed by `vendor + issueId` |
| `ReviewedPatch` | Final AI-reviewed patches (`issueId` is `@unique` — no duplicates) |
| `UserFeedback` | Admin exclusion history for RAG context |
| `PipelineRun` | Execution metadata (status, timestamps, logs) |

---

## 4. Pipeline Execution

### Python 3 (Preprocessing)
- Vendor-specific scripts: `patch_preprocessing.py`, `windows_preprocessing.py`, `mariadb_preprocessing.py`, etc.
- All scripts support `--vendor` or equivalent flags for individual product processing.
- Standard library only: `json`, `sqlite3`, `argparse`, `datetime`, `uuid`.
- Writes output to `patches_for_llm_review_<vendor>.json`.

### Node.js (Collectors)
- `rhsa_collector.js`, `rhba_collector.js` — Red Hat Errata API
- `oracle_collector.sh` + `oracle_parser.py` — Oracle Linux advisories
- `ubuntu_collector.sh` — Ubuntu Security Notices
- Other vendor-specific collection scripts in each product's skill directory.

### OpenClaw CLI (AI Agent)
- Internal AI orchestration tool that wraps Google Gemini.
- Invoked as: `openclaw agent:main --json-mode --message "<prompt>"`
- The `--json-mode` flag enforces structured JSON output.
- Context instructions come from `SKILL.md` in the skill directory.
- Sessions are isolated per batch by deleting `~/.openclaw/agents/main/sessions/sessions.json` before each call.

---

## 5. AI & Validation Layer

### Google Gemini (via openclaw)
- Accessed through the internal openclaw router network.
- Configured per product via `ProductConfig.buildPrompt()` — each product has its own prompt template.

### Zod v3 (Schema Validation)
- `ReviewSchema` validates AI output JSON arrays.
- Required fields: `IssueID`, `Component`, `Version`, `Vendor`, `Date`, `Criticality`, `Description`, `KoreanDescription`
- Optional fields: `Decision`, `Reason`, `OsVersion`
- Validation failures trigger self-healing retries (up to 2x per batch).

### RAG (Retrieval-Augmented Generation)
Two strategies based on product type:
- **Prompt-injection** (Linux products): `query_rag.py` queries `UserFeedback` and injects exclusion context into the AI prompt.
- **File-hiding** (Windows, Ceph, databases): Normalized data directories are temporarily renamed before AI runs to prevent workspace tool access.

---

## 6. Infrastructure

### Process Manager: pm2
- Production process: `pm2 start "pnpm start" --name patch-dashboard`
- Auto-started via `pm2-citec.service` systemd unit on boot.

### CRON
- `update_cron.sh` installs quarterly collection schedule.
- Runs the third Sunday of March, June, September, December at 06:00.
- Triggers vendor-specific data collectors (independent of the Next.js application).

---

## Version Summary

| Package | Version |
|---------|---------|
| next | 16.1.6 |
| react | 19.2.3 |
| typescript | ^5 |
| tailwindcss | ^4 |
| @prisma/client | ^5.22.0 |
| bullmq | ^5.70.4 |
| ioredis | ^5.10.0 |
| zod | ^3.25.76 |
| framer-motion | ^12.34.3 |
| radix-ui | ^1.4.3 |
| lucide-react | ^0.575.0 |
| papaparse | ^5.5.3 |
