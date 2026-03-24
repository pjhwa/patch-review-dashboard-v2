# Pipeline Execution Flow

The Patch Review Dashboard V2 executes a structured autonomous workflow for each product. This document traces the complete flow from the moment a user clicks "Run Pipeline" to the final CSV export.

---

## Overview

```
[User clicks "Run Pipeline"]
         │
         ▼
  POST /api/pipeline/{product}/run
         │  enqueue BullMQ job
         ▼
  BullMQ Queue (Redis)
         │  Worker picks up
         ▼
  runProductPipeline(job, productCfg)
    │
    ├─ Phase 1: Preprocessing
    ├─ Phase 2: RAG Exclusion Setup
    ├─ Phase 3: AI Review Loop (batches of 5)
    ├─ Phase 4: Database Ingest
    └─ Phase 5: Passthrough Safety Net
         │
         ▼
  User reviews in dashboard → clicks "Finalize"
         │
         ▼
  POST /api/pipeline/{product}/finalize
  → writes final_approved_patches_{product}.csv
```

---

## Phase 0: Job Dispatch

### Web Dashboard Trigger
The user clicks **"Run Pipeline"** (or **"AI Only"** / **"Retry"**) on the `ProductGrid` component. A confirmation dialog is shown. On confirm, `ProductGrid.tsx` calls the product-specific run endpoint:

```
POST /api/pipeline/run             (Red Hat / Oracle / Ubuntu)
POST /api/pipeline/windows/run     (Windows Server)
POST /api/pipeline/ceph/run        (Ceph)
POST /api/pipeline/mariadb/run     (MariaDB)
POST /api/pipeline/sqlserver/run   (SQL Server)
POST /api/pipeline/pgsql/run       (PostgreSQL)
POST /api/pipeline/mysql/run       (MySQL Community)
POST /api/pipeline/vsphere/run     (VMware vSphere)
POST /api/pipeline/jboss_eap/run   (JBoss EAP)
POST /api/pipeline/tomcat/run      (Apache Tomcat)
POST /api/pipeline/wildfly/run     (WildFly)
```

Request body:
```json
{ "providers": ["redhat"], "isRetry": false, "isAiOnly": false }
```

For category-level products (storage, virtualization) `providers` is omitted.

### BullMQ Enqueue
The run API adds a named job to the `patch-pipeline` BullMQ queue:

```typescript
await pipelineQueue.add('run-redhat-pipeline', { isRetry, isAiOnly, category: 'os' });
```

The response returns `{ jobId: "..." }` which the client uses to open an SSE stream.

### SSE Connection
`ProductGrid.tsx` immediately opens:
```
GET /api/pipeline/stream?jobId=<jobId>
```
All `job.log()` calls from the worker are forwarded to this stream as `data: {...}` events.

---

## Phase 1: Preprocessing

The worker calls `runPreprocessing()` unless `isAiOnly = true`.

### What it does
1. Resolves the skill directory: `~/.openclaw/workspace/skills/patch-review/<skillDirRelative>`
2. Runs the product's Python preprocessing script:
   ```bash
   python3 patch_preprocessing.py --vendor redhat --days 90
   ```
   For version-grouped products (Windows, SQL Server):
   ```bash
   python3 windows_preprocessing.py --days 180 --days_end 90
   ```
3. The script reads raw data files from `<dataSubDir>/` (e.g., `redhat_data/`), filters by date window, deduplicates against `PreprocessedPatch` in the SQLite DB, and writes:
   - `patches_for_llm_review_<vendor>.json` — patches ready for AI review

### Log tag emitted
```
[REDHAT-PREPROCESS_DONE] count=42
```
This triggers a `router.refresh()` in the dashboard to show updated stage counts.

---

## Phase 2: RAG Exclusion Setup

Before AI review begins, the worker applies the product's RAG exclusion strategy to prevent the AI from re-reviewing previously excluded patches.

### Strategy 1: Prompt-Injection (Linux, vSphere)
Used by: Red Hat, Oracle Linux, Ubuntu, VMware vSphere

1. Calls `query_rag.py` in the `os/linux/` shared directory (fixed cwd for all products)
2. Retrieves `UserFeedback` records (past admin exclusion reasons) based on similarity
3. Injects a `CRITICAL INSTRUCTION: ... EXCLUDED PATCHES ...` block into every AI batch prompt

```
prompt = buildPrompt(skillDir, batchSize, prunedBatch)
       + "\n\nCRITICAL INSTRUCTION: ... [exclusion context from query_rag.py]"
```

### Strategy 2: Both (Windows, Ceph, MariaDB, SQL Server, PostgreSQL, MySQL, JBoss EAP, Tomcat, WildFly)
Used by non-Linux products with normalized data directories

These products use **both** file-hiding AND prompt-injection:

1. **File-hiding**: Renames `<dataSubDir>/normalized/` → `<dataSubDir>/normalized_hidden/` and renames `patches_for_llm_review_<vendor>.json` → `patches_for_llm_review_<vendor>.json.hidden` before AI runs, restoring them afterward
2. **Prompt-injection**: Also calls `query_rag.py` (cwd: `os/linux/`) to inject past exclusion context

This prevents the OpenClaw agent from accessing previously reviewed files via its workspace tools, while also injecting historical exclusion context.

---

## Phase 3: AI Review Loop

`runAiReviewLoop()` processes all patches in batches of 5.

### Batch Execution

For each batch:
1. **Session cleanup**: Delete `~/.openclaw/agents/main/sessions/sessions.json` — prevents context bleed from previous batches
2. **Build prompt**: `productCfg.buildPrompt(skillDir, batchSize, prunedBatch)`
3. **Run OpenClaw**:
   ```bash
   openclaw agent:main --json-mode --message "<prompt>"
   ```
4. **Extract JSON**: Parse the AI output with `extractJsonArray()` — handles markdown code fences and partial JSON
5. **Zod validation**: Validate against `ReviewSchema`
   - Fields required: `IssueID`, `Component`, `Version`, `Vendor`, `Date`, `Criticality`, `Description`, `KoreanDescription`
   - Optional: `Decision`, `Reason`, `OsVersion`

### Self-Healing Retry

If Zod validation fails:
```
Attempt 1: initial prompt
  → FAIL: "IssueID missing in item 3"
Attempt 2: same prompt + "\n이전 응답 실패. Zod 에러: [exact error]"
  → FAIL: malformed JSON
Attempt 3: same prompt + updated error
  → PASS or give up (batch skipped)
```

Retry delays: 3s → 9s (exponential backoff).

### Version-Grouped Products (Windows, SQL Server)

For `aiVersionGrouped: true` products:
- Patches are pre-grouped by OS version before batching
- Each batch item is a version group containing multiple monthly patches
- AI selects ONE patch per group (the most recent critical one)
- Validation uses `aiBatchValidation: 'nonEmpty'` (≥1 result acceptable)

### Rate Limit Handling

If the AI returns a `429 rate limit` response:
1. Sets `/tmp/.rate_limit_<product>` flag file
2. Waits with exponential backoff
3. Retries the batch

---

## Phase 4: Database Ingest

`ingestToDb()` writes results to SQLite via Prisma.

### PreprocessedPatch upsert
All patches from `patches_for_llm_review_<vendor>.json` are upserted into `PreprocessedPatch` using `issueId + vendor` as the key.

### ReviewedPatch upsert
All AI-reviewed patches are upserted into `ReviewedPatch` (unique by `issueId`).

If `isResumeMode = true` (AI-only re-run): only updates existing records, does not insert new ones.

---

## Phase 5: Passthrough Safety Net

`runPassthrough()` is called after `ingestToDb()` for all products where `passthrough.enabled = true` (all except Windows Server and SQL Server, which use version-grouping and require AI review for meaningful results).

### What it does
1. Queries all `PreprocessedPatch` records for this product's vendor
2. Finds records whose `issueId` is NOT in the set of AI-reviewed IDs
3. For each missing patch:
   ```typescript
   prisma.reviewedPatch.upsert({
     where: { issueId: pp.issueId },
     create: {
       criticality: 'Important',
       decision: 'Pending',
       ...pp fields
     }
   })
   ```

This ensures patches skipped by the AI (due to rate limits, context overflow, or retries exhausted) still appear in the dashboard with `Pending` status for human review.

---

## Phase 6: Finalization (User Action)

After the pipeline completes, the user reviews patches in the dashboard:

1. Navigate to `/category/<categoryId>/<productId>`
2. Review the `ReviewedPatch` records loaded from the DB
3. Modify decisions if needed (Approve / Exclude)
4. Click **"Finalize"** → `POST /api/pipeline/<product>/finalize`

The finalize endpoint:
1. Reads `ReviewedPatch` records with `decision: 'Approve'`
2. Formats them into CSV rows
3. Prepends UTF-8 BOM (`\uFEFF`) for Excel compatibility
4. Writes `final_approved_patches_<vendor>.csv` to the skill directory
5. Sets `isReviewCompleted: true` on the product's `PipelineRun`

---

## Phase 7: CSV Export

The user can download the final CSV at any time after finalization:

```
GET /api/pipeline/export?categoryId=os
```

For Linux products, this merges the CSVs for all active Linux vendors (redhat + oracle + ubuntu) into a single download. For other categories, it returns the single product CSV.

---

## Resume Mode

If a pipeline is interrupted mid-run (e.g., server restart), on next trigger the worker detects that `patches_for_llm_review_<vendor>.json` already exists with AI-reviewed data and enters **resume mode**:

- Skips preprocessing
- Re-runs AI only on patches not yet in `ReviewedPatch`
- Skips already-reviewed patches to avoid duplicate DB writes

This is equivalent to the **"AI Only"** button in the UI, which explicitly sets `isAiOnly: true` in the job payload.
