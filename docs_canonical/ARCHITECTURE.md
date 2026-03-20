# ARCHITECTURE — Patch Review Dashboard V2

## System Overview

Three-tier architecture:

```
Tier 1: Frontend Presentation
  Next.js 16 App Router (React 19, TypeScript)
  Tailwind CSS v4 + shadcn/ui
  Real-time SSE log streaming

Tier 2: Backend API + Queue Orchestration
  Next.js API Routes
  BullMQ v5 Worker (src/lib/queue.ts)
  Redis 6+ (job persistence)

Tier 3: AI Pipeline Execution
  Python preprocessing scripts
  openclaw agent:main CLI
  SQLite via Prisma ORM
```

---

## Central Product Registry

`src/lib/products-registry.ts` is the single source of truth. All routes, the worker, the export API, and the UI read from this file. Never hardcode product-specific strings elsewhere.

Key exports:
- `ProductConfig` interface (38+ typed fields)
- `PRODUCT_REGISTRY` array (9 active + 2 inactive placeholders)
- `PRODUCT_MAP` — `Record<string, ProductConfig>` keyed by product `id`
- `getSkillDir(cfg)` — resolves `~/.openclaw/workspace/skills/patch-review/<skillDirRelative>`

### ProductConfig Key Fields

| Field | Purpose |
|-------|---------|
| `id` | Unique product identifier: `'redhat'`, `'pgsql'`, etc. |
| `vendorString` | DB vendor field value: `'Red Hat'`, `'PostgreSQL'` |
| `skillDirRelative` | Path relative to `~/.openclaw/.../patch-review/` |
| `dataSubDir` | Raw data directory: `'redhat_data'`, `'mariadb_data'` |
| `rawDataFilePrefix` | File prefixes for counting: `['RHSA-','RHBA-']`, `['PGSL-']` |
| `preprocessingScript` | Python script filename |
| `preprocessingArgs` | CLI args: `['--vendor','redhat','--days','90']` |
| `patchesForReviewFile` | Output file: `'patches_for_llm_review_redhat.json'` |
| `jobName` | BullMQ job name: `'run-redhat-pipeline'` (convention: `run-{id}-pipeline`) |
| `logTag` | Log prefix: `'REDHAT'` → emits `[REDHAT-PREPROCESS_DONE]` |
| `aiVersionGrouped` | `true` for Windows/SQL Server (group patches by OS version) |
| `aiBatchValidation` | `'exact'` (output count = input) or `'nonEmpty'` (≥1, version-grouped) |
| `buildPrompt` | `(skillDir, batchSize, prunedBatch) => string` — per-product prompt |
| `ragExclusion` | RAG strategy: `'prompt-injection'`, `'file-hiding'`, or omitted |
| `passthrough.enabled` | `false` for windows/sqlserver; `true` for all others |
| `preprocessedPatchMapper` | Maps preprocessing JSON → `PreprocessedPatch` shape (field names MUST match JSON exactly) |
| `csvBOM` | `true` = prepend `\uFEFF` for Excel Korean encoding |

---

## BullMQ Job Queue

Queue name: `patch-pipeline`

Each product has one named job (`run-{id}-pipeline`). A single worker in `src/lib/queue.ts` handles all jobs via `PRODUCT_MAP` lookup.

v1 → v2 improvements:
- Replaced `child_process.spawn()` + `pipeline_status.json` file lock
- BullMQ provides: serialized execution, job persistence across restarts, log streaming via `job.log()`
- `job.log()` messages are forwarded to SSE clients at `GET /api/pipeline/stream?jobId=X`

---

## Pipeline Execution (5 Phases)

`runProductPipeline(job, productCfg, isAiOnly, isRetry)` in `src/lib/queue.ts`:

```
Phase 0: Job Dispatch
  POST /api/pipeline/{product}/run
  → pipelineQueue.add(jobName, { isRetry, isAiOnly, category })
  → returns { jobId } → client opens SSE stream

Phase 1: Preprocessing (skipped if isAiOnly=true)
  python3 <preprocessingScript> <preprocessingArgs>
  Reads: <dataSubDir>/*.json (raw advisories)
  Writes: patches_for_llm_review_<vendor>.json
  Log: [LOGTAG-PREPROCESS_DONE] count=N

Phase 2: RAG Exclusion Setup
  prompt-injection (Linux): query_rag.py → inject EXCLUDED PATCHES block into every batch prompt
  file-hiding (Windows/Ceph/DB): rename normalized/ + patches file → *_hidden before AI runs
  none (vSphere): skip

Phase 3: AI Review Loop (batches of 5)
  For each batch:
    1. cleanupSessions()  ← delete ~/.openclaw/agents/main/sessions/sessions.json
    2. buildPrompt(skillDir, batchSize, prunedBatch)
    3. openclaw agent:main --json-mode --message "<prompt>"
    4. extractJsonArray() → parse stdout
    5. Zod validation (ReviewSchema) → retry up to 2x with error injected into prompt
  After loop: undo RAG exclusion (restore renamed files)

Phase 4: Database Ingest
  ingestToDb():
    PreprocessedPatch upsert (key: issueId + vendor)
    ReviewedPatch upsert (key: issueId — @unique)

Phase 5: Passthrough Safety Net
  runPassthrough() — for products with passthrough.enabled=true
  Finds PreprocessedPatch NOT in AI-reviewed set
  Upserts as ReviewedPatch with criticality='Important', decision='Pending'
```

---

## RAG Exclusion Detail

### Prompt-Injection (Red Hat, Oracle, Ubuntu)
- `query_rag.py` queries `UserFeedback` table via ChromaDB similarity search
- Returns exclusion context block prepended to every batch prompt
- Prevents re-reviewing previously admin-excluded patches
- `query_rag.py` must be invoked with `cwd=os/linux/` (fixed working directory)

### File-Hiding (Windows, Ceph, MariaDB, SQL Server, PostgreSQL)
- Before AI: rename `<normalizedDirName>/ → *_hidden/` and `patches_file → *.hidden`
- After AI: restore both in a `finally` block (must restore even on exception)
- Prevents OpenClaw workspace tools from reading stale previous-cycle data

### No RAG (VMware vSphere)
- No `ragExclusion` field — reviews all preprocessed patches fresh each run

---

## Version-Grouped Products (Windows, SQL Server)

- `aiVersionGrouped: true`
- Preprocessing groups patches by OS version; each batch item is a version group
- AI selects ONE patch per group (most recent critical monthly patch)
- `aiBatchValidation: 'nonEmpty'` (≥1 result acceptable)
- `passthrough.enabled: false` (auto-insertion of incomplete groups is misleading)
- IssueID format: `WINDOWS-GROUP-Windows_Server_2025`

---

## Database Schema (Prisma + SQLite)

File: `prisma/patch-review.db`

| Model | Key | Purpose |
|-------|-----|---------|
| `RawPatch` | `vendor + originalId` | Raw vendor API JSON cache |
| `PreprocessedPatch` | `vendor + issueId` | Normalized patches ready for AI |
| `ReviewedPatch` | `issueId` (@unique) | Final AI-reviewed or human-approved patches |
| `UserFeedback` | — | Admin exclusion history for RAG |
| `PipelineRun` | — | Execution metadata (status, logs, timestamps) |

`ReviewedPatch.issueId` is `@unique` — no duplicate patches. `Prisma upsert` `where` fields must be `@unique` in the schema.

---

## API Routes

### Product Run/Finalize
Each product has dedicated endpoints:
- `POST /api/pipeline/run` (Linux: redhat/oracle/ubuntu)
- `POST /api/pipeline/{product}/run` (all others)
- `POST /api/pipeline/{product}/finalize`

Request body: `{ providers: ["redhat"], isRetry: false, isAiOnly: false }`

### Shared Endpoints
| Endpoint | Purpose |
|----------|---------|
| `GET /api/pipeline` | Check active jobs |
| `GET /api/pipeline/stream?jobId=X` | SSE log stream |
| `GET /api/pipeline/stage/[stageId]` | Stage JSON data |
| `GET /api/pipeline/export?categoryId=X` | Download merged CSV |
| `POST /api/pipeline/feedback` | Submit exclusion feedback |
| `POST /api/pipeline/reset` | Reset pipeline state |
| `GET /api/products` | Product list with stage counts |

---

## Frontend Components

| Component | Purpose |
|-----------|---------|
| `ProductGrid.tsx` | Pipeline trigger, SSE connection, log tail, confirm dialog |
| `PremiumCard.tsx` | Individual product card with stage counters |
| `ClientPage.tsx` | Patch review table + finalize action (client component) |
| `StageJSONViewer.tsx` | Modal for raw stage JSON |
| `LanguageToggle.tsx` | KO/EN switch (cookie: `NEXT_LOCALE`) |

SSE log tag regex `\[\w+-PREPROCESS_DONE\]` and `\[\w+-PIPELINE\]` are generic — no per-product code change needed when adding products.

---

## Zod ReviewSchema

Required fields: `IssueID`, `Component`, `Version`, `Vendor`, `Date`, `Criticality`, `Description`, `KoreanDescription`
Optional fields: `Decision`, `Reason`, `OsVersion`

Self-healing retry: Attempt 1 → fail → inject Zod error into prompt → Attempt 2 → fail → Attempt 3 → skip batch (passthrough handles skipped).

---

## Resume Mode

If `patches_for_llm_review_<vendor>.json` already exists when pipeline triggers:
- Skips preprocessing
- Re-runs AI only on patches not yet in `ReviewedPatch`
- Equivalent to "AI Only" button (`isAiOnly: true`)

---

## Architectural Constraints

- Python `venv/` must NEVER be inside the project directory (Turbopack symlink panic)
- `skillDirRelative` is shared across Linux products (`os/linux`) — `buildPrompt` must be separated per product
- `withOpenClawLock` job callback must return `Promise<void>` (wrap with curly braces)
- Gateway closed responses from openclaw must NOT immediately reject — wait for full response
- `faq` field does not exist in the ReviewSchema — do not add it
