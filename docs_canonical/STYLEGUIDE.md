# STYLEGUIDE — Patch Review Dashboard V2

## Language & Type Safety

- **TypeScript strict mode** across all source files
- All API route handlers, queue workers, and registry definitions must be fully typed
- `ProductConfig` interface in `products-registry.ts` is the central typed contract — do not bypass it with `any`
- Zod schemas are the validation contract between AI output and the database — do not relax them

---

## Naming Conventions

### Product IDs
- Always lowercase, no hyphens: `redhat`, `oracle`, `ubuntu`, `windows`, `ceph`, `mariadb`, `sqlserver`, `pgsql`, `vsphere`
- Used as: URL path segments, BullMQ job names, DB vendor strings derivation

### BullMQ Job Names
- Convention: `run-{id}-pipeline`
- Examples: `run-redhat-pipeline`, `run-pgsql-pipeline`
- The `{id}` segment must exactly match the `ProductConfig.id` field

### Log Tags
- Convention: `{LOGTAG}` is the uppercase version of the product-specific identifier
- Example: product `redhat` → `logTag: 'REDHAT'` → emits `[REDHAT-PREPROCESS_DONE]`
- Used in `ProductGrid.tsx` regex for SSE event parsing — no per-product code needed

### File Naming
- Raw advisory files: `{PREFIX}-{ID}.json` where prefix is defined in `rawDataFilePrefix[]`
- PostgreSQL prefix: `PGSL-` (not `PGSQL-` — note the abbreviation)
- Preprocessing output: `patches_for_llm_review_{vendor}.json`
- AI report: `patch_review_ai_report_{vendor}.json`
- Final CSV: `final_approved_patches_{vendor}.csv`

### API Routes
- Run endpoint: `POST /api/pipeline/{id}/run`
- Finalize endpoint: `POST /api/pipeline/{id}/finalize`
- Exception: Linux (redhat/oracle/ubuntu) shares `POST /api/pipeline/run` and `POST /api/pipeline/finalize`

---

## ProductConfig Patterns

### skillDirRelative Sharing
Linux products (redhat, oracle, ubuntu) share `skillDirRelative: 'os/linux'`. This means they share the same physical skill directory. `buildPrompt` must be defined separately per product — do not reference a shared constant that all three point to.

```typescript
// CORRECT — each product has its own buildPrompt
{ id: 'redhat', skillDirRelative: 'os/linux', buildPrompt: (skillDir, batchSize, batch) => `...redhat prompt...` }
{ id: 'oracle', skillDirRelative: 'os/linux', buildPrompt: (skillDir, batchSize, batch) => `...oracle prompt...` }

// WRONG — do not share buildPrompt reference across products
const linuxBuildPrompt = ...
{ id: 'redhat', buildPrompt: linuxBuildPrompt }
{ id: 'oracle', buildPrompt: linuxBuildPrompt }  // oracle and redhat get same prompt
```

### preprocessedPatchMapper Field Names
The `preprocessedPatchMapper` function maps preprocessing script JSON output to the `PreprocessedPatch` schema. Field names in this function must exactly match the JSON keys output by the Python script — not the Prisma model field names.

```typescript
// Verify against actual JSON output from the preprocessing script:
// patches_for_llm_review_pgsql.json → { "issue_id": ..., "component": ... }
preprocessedPatchMapper: (raw) => ({
  issueId: raw.issue_id,    // must match JSON key exactly
  component: raw.component,
})
```

### passthrough.enabled
- `false` for `windows` and `sqlserver` only (version-grouping makes auto-insertion meaningless)
- `true` for all other 7 products

### csvBOM
- `false` for Linux products (redhat, oracle, ubuntu) — these CSV files don't need BOM
- `true` for Windows, Ceph, MariaDB, SQL Server, PostgreSQL, vSphere

---

## Queue Worker Patterns

### withOpenClawLock Callback
The callback passed to `withOpenClawLock` must return `Promise<void>`. Always wrap the body in curly braces:

```typescript
// CORRECT
await withOpenClawLock(async () => {
  await runAiReviewLoop(...)
})

// WRONG — arrow function body without curly braces returns the Promise value
await withOpenClawLock(async () => runAiReviewLoop(...))
```

### job.log() Usage
`job.log()` is only valid inside the BullMQ worker context. Do not call it outside `withOpenClawLock` or after the job completes.

### Session Cleanup
`cleanupSessions()` must be called at the start of every AI batch, not just the first one:
```typescript
for (const batch of batches) {
  await cleanupSessions()  // ALWAYS before openclaw invocation
  const result = await runOpenClaw(prompt)
  ...
}
```

---

## AI / OpenClaw Patterns

### Gateway Closed Handling
Do NOT immediately reject on "gateway closed" response. The connection may self-heal. Wait for the complete response before triggering the Zod retry loop.

### Zod Retry Injection
Inject the exact Zod error message string into the retry prompt. Do not paraphrase or summarize the error — the AI needs the exact field path to fix the output.

### SKILL.md Requirements
Every product's `SKILL.md` must:
- Be ≥100 lines
- Contain a `## 4.` section titled "Strict LLM Evaluation Rules"
- Contain subsections `### 4.1` through `### 4.5`
- The validator (`scripts/validate-registry.js`) enforces this — build/deploy will fail without it

---

## Python Scripts

- Standard library only: `json`, `sqlite3`, `argparse`, `datetime`, `uuid`
- No `pip install` required
- All scripts support `--vendor` flag (or equivalent) for per-product invocation
- Output to stdout: `[{LOGTAG}-PREPROCESS_DONE] count=N` as the final line
- No Python `venv/` inside the project tree

---

## Database / Prisma

- `upsert` where-clause fields must have `@unique` in `schema.prisma`
- If `@unique` cannot be added, use `deleteMany` + `createMany` instead of upsert
- `ReviewedPatch.issueId` is `@unique` — one row per advisory ID
- `PreprocessedPatch` is unique on `(vendor, issueId)` composite — check schema before adding new upsert

---

## Frontend

### Theme / Dark Mode
- Dark mode via `html.dark` class toggle + cookie persistence
- Use CSS variables for colors — do not hardcode dark-mode-only Tailwind classes
- Solid color buttons: use `text-white`, never `text-foreground` (foreground inverts with theme)
- Semi-transparent backgrounds (`bg-foreground/5`) are near-invisible in light mode — use `bg-muted` for badges instead

### i18n
- Language toggle: cookie `NEXT_LOCALE`
- All UI strings must be in the i18n dictionary
- After adding a new key to the dict, verify the component is actually reading from the dict (not hardcoded)

---

## Export / Archive

### Export "All" Filter
`GET /api/pipeline/export?categoryId=os` returns a merged CSV for all active Linux vendors (redhat + oracle + ubuntu). When filtering in the export API, do not include inactive/placeholder products in the merge.

### Archive Auto-Trigger
Archive is auto-created client-side (fire-and-forget) when all products reach `isReviewCompleted: true`. This check runs on the category page load — no server-side cron needed.

---

## Anti-Patterns to Avoid

- Adding `faq` field to `ReviewSchema` — this field does not exist
- Sharing `buildPrompt` across Linux products — each needs its own
- Putting `venv/` inside the project directory
- Calling `sessions.json` deletion only once (must be per-batch)
- Using `rebase` without verifying all conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) are fully resolved before commit
- Checking only `linux-v2` when searching for Linux-related identifiers — search for both `linux-v2` and `linux` patterns
