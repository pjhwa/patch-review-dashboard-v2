# TESTING — Patch Review Dashboard V2

## Testing Philosophy

This project is an operational tool without a dedicated automated test suite. Validation is performed through:
1. **Registry Validator** — structural correctness of all 9 product configs
2. **Build validation** — TypeScript type checking
3. **Manual end-to-end** — running the pipeline against real data

The registry validator is the primary safety gate before any deploy.

---

## Registry Validator (Primary)

```bash
node scripts/validate-registry.js
```

Run this after any change to:
- `src/lib/products-registry.ts`
- Any `SKILL.md` file
- Adding or removing skill directories
- Changing preprocessing script locations

### Checks Performed (per active product)

| Check | Requirement |
|-------|-------------|
| `skillDir` exists on disk | `~/.openclaw/workspace/skills/patch-review/<skillDirRelative>` |
| `preprocessingScript` exists | File present in skill directory |
| `SKILL.md` exists | File present in skill directory |
| `SKILL.md` line count | ≥100 lines |
| `SKILL.md` has `## 4.` section | Required for AI evaluation rules |
| `ragExclusion` consistency | `file-hiding` requires `normalizedDirName`; `prompt-injection` requires `queryScript` |
| `passthrough` configured | Must not be undefined |
| `rateLimitFlag` path | Must start with `/tmp/` |
| `jobName` convention | Must follow `run-{id}-pipeline` pattern |

### Expected Output (all passing)
```
=== Patch Review Dashboard — Product Registry Validator ===

── redhat ──
  [redhat] skillDir exists
  [redhat] preprocessingScript exists: patch_preprocessing.py
  [redhat] SKILL.md: 280 lines (>=100)
  ...

Validation: 69 passed, 0 failed

All checks passed!
```

If any check fails, fix before proceeding. Do not deploy with failing checks.

---

## Build Validation

```bash
pnpm build
```

TypeScript strict mode is enforced. Common build-time errors:

| Error Pattern | Cause |
|---------------|-------|
| `job.log is not a function` | Incorrect BullMQ job reference scope |
| `Type ... is not assignable to type 'exact' | 'nonEmpty'` | Wrong `aiBatchValidation` value |
| `Property 'faq' does not exist on type ReviewSchema` | `faq` field was added — remove it |
| `Argument of type ... not assignable to parameter` | `preprocessedPatchMapper` return type mismatch |

`src/lib/queue.ts` is included in the build. Type errors there fail the build.

---

## Preprocessing Script Verification

Before running a new product's pipeline, verify the preprocessing script output:

```bash
cd ~/.openclaw/workspace/skills/patch-review/<category>/<id>
python3 <script>.py --vendor <id> --days 90

# Check the output file
cat patches_for_llm_review_<vendor>.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(list(d[0].keys()))"
```

Verify that field names in the JSON output match `preprocessedPatchMapper` in `products-registry.ts`.

---

## Spec-to-Reality Verification

When adding a new product, verify the spec matches reality:

```bash
# Verify rawDataFilePrefix matches actual files
ls ~/.openclaw/workspace/skills/patch-review/<category>/<id>/<product>_data/ | head -5
# File names should start with the configured rawDataFilePrefix values

# Verify sample JSON structure matches spec
cat docs/specs/<product>_spec.md  # Check the sample JSON section
cat ~/.openclaw/workspace/skills/patch-review/<category>/<id>/<product>_data/<SAMPLE>.json
# Compare: are the field names the same?
```

---

## Manual End-to-End Test

After building and deploying:

```bash
# 1. Verify app is running
curl http://localhost:3001/api/products

# 2. Verify all 9 products are returned
# Expected: JSON array with 9 objects

# 3. Check pm2 is healthy
pm2 status
pm2 logs patch-dashboard --lines 20
```

Pipeline smoke test (in UI):
1. Navigate to a product with small data volume (e.g., vSphere or PostgreSQL)
2. Click "Run Pipeline" → confirm
3. Observe SSE log stream in dashboard
4. Verify `[LOGTAG-PREPROCESS_DONE] count=N` appears
5. Verify pipeline completes and patches appear in product detail page

---

## Database Integrity Checks

```bash
pnpm prisma studio  # → http://localhost:5555

# Check ReviewedPatch has no duplicates (issueId is @unique, but verify)
# Check PreprocessedPatch has the expected count after preprocessing

# Direct SQLite query if needed:
sqlite3 prisma/patch-review.db "SELECT COUNT(*) FROM ReviewedPatch WHERE vendor='Red Hat';"
```

---

## SKILL.md Compliance Check

Before adding any SKILL.md to production:

```bash
wc -l <SKILL.md>              # Must be ≥100
grep "## 4." <SKILL.md>       # Must exist
grep "### 4.1" <SKILL.md>     # Inclusion Criteria
grep "### 4.2" <SKILL.md>     # Exclusion Criteria
grep "### 4.3" <SKILL.md>     # Output Format
grep "### 4.4" <SKILL.md>     # General Rules
grep "### 4.5" <SKILL.md>     # Hallucination Prevention
```

The registry validator checks for `## 4.` but does not check subsections. Manual verification is required for new SKILL.md files.
