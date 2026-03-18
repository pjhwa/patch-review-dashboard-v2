# Central Product Registry

`src/lib/products-registry.ts` is the single source of truth for all product-specific configuration in the Patch Review Dashboard V2. Every route handler, the BullMQ worker, the export API, and the dashboard UI read product information from this file.

---

## Why a Central Registry?

In v1, adding a new product required manually editing 9+ files:
- `queue.ts` (a new ~250-line branch)
- `run/route.ts` (new endpoint)
- `finalize/route.ts` (new endpoint)
- `stage/[stageId]/route.ts` (vendor string mapping)
- `export/route.ts` (category filter)
- `ClientPage.tsx` (title mapping, finalize endpoint)
- `ProductGrid.tsx` (pipeline URL routing)
- `products/route.ts` (file count logic)
- Plus the SKILL.md and preprocessing script

Missed edits caused subtle bugs (e.g., SQL Server using MariaDB's finalize endpoint). In v2, all of this is driven by one `ProductConfig` entry.

---

## ProductConfig Interface

```typescript
interface ProductConfig {
  // ── Identity ──────────────────────────────────────────────
  id: string;                    // 'redhat', 'oracle', 'mariadb', etc.
  name: string;                  // Display name: 'Red Hat Enterprise Linux'
  vendorString: string;          // DB vendor field: 'Red Hat', 'MariaDB'
  category: 'os' | 'storage' | 'database' | 'virtualization';
  active: boolean;               // false = inactive placeholder

  // ── File System Layout ────────────────────────────────────
  skillDirRelative: string;      // Relative to ~/.openclaw/workspace/skills/patch-review/
                                 // e.g. 'os/linux', 'database/mariadb'
  dataSubDir: string;            // e.g. 'redhat_data', 'mariadb_data'
  rawDataFilePrefix: string[];   // Filename prefixes: ['RHSA-', 'RHBA-'], ['ELSA-']
  preprocessingScript: string;   // e.g. 'patch_preprocessing.py'
  preprocessingArgs: string[];   // e.g. ['--vendor', 'redhat', '--days', '90']
  patchesForReviewFile: string;  // Output of preprocessing: 'patches_for_llm_review_redhat.json'
  aiReportFile: string;          // AI output file: 'patch_review_ai_report_redhat.json'
  finalCsvFile: string;          // Finalized CSV: 'final_approved_patches_redhat.csv'

  // ── BullMQ ────────────────────────────────────────────────
  jobName: string;               // 'run-redhat-pipeline' (convention: run-{id}-pipeline)
  rateLimitFlag: string;         // '/tmp/.rate_limit_redhat' — touched when AI rate-limited
  logTag: string;                // 'REDHAT' → emits '[REDHAT-PREPROCESS_DONE]' in logs

  // ── AI Prompt Configuration ───────────────────────────────
  aiEntityName: string;          // Used in prompts: 'Red Hat Linux patches'
  aiVendorFieldValue: string;    // Value for 'Vendor' field in AI output: 'Red Hat'
  aiComponentDefault: string;    // Fallback if AI omits Component: 'kernel', 'mariadb'
  aiVersionGrouped: boolean;     // true = Windows/SQL Server (groups by OS version)
  aiBatchValidation: 'exact' | 'nonEmpty';
                                 // 'exact' = output count must match input count
                                 // 'nonEmpty' = at least 1 result (version-grouped)
  buildPrompt: (skillDir, batchSize, prunedBatch) => string;
                                 // Generates the full openclaw prompt for this batch

  // ── RAG Exclusion (optional) ──────────────────────────────
  ragExclusion?: {
    type: 'file-hiding' | 'prompt-injection';
    // file-hiding: rename normalized/ dir + patches file before AI runs
    normalizedDirName?: string;  // 'windows_data/normalized'
    // prompt-injection: call query_rag.py, inject result into prompt
    queryScript?: string;        // 'query_rag.py'
    queryTextSampleSize?: number; // Samples to include in prompt (default: 3)
  };

  // ── Passthrough ───────────────────────────────────────────
  passthrough: {
    enabled: boolean;            // false for version-grouped (Windows, SQL Server)
    fallbackCriticality: string; // 'Important'
    fallbackDecision: string;    // 'Pending'
  };

  // ── Data Processing ───────────────────────────────────────
  collectedFileFilter: (filename: string) => boolean;
                                 // Filter for counting raw collected files
  preprocessedPatchMapper: (raw: any) => object;
                                 // Maps preprocessing output → PreprocessedPatch shape
  csvBOM: boolean;               // true = prepend \uFEFF BOM for Excel
}
```

---

## Active Products

| id | name | category | skillDirRelative | jobName | ragExclusion | passthrough | csvBOM |
|----|------|----------|-----------------|---------|--------------|-------------|--------|
| `redhat` | Red Hat Enterprise Linux | os | `os/linux` | `run-redhat-pipeline` | prompt-injection | ✅ | ❌ |
| `oracle` | Oracle Linux | os | `os/linux` | `run-oracle-pipeline` | prompt-injection | ✅ | ❌ |
| `ubuntu` | Ubuntu Linux | os | `os/linux` | `run-ubuntu-pipeline` | prompt-injection | ✅ | ❌ |
| `windows` | Windows Server | os | `os/windows` | `run-windows-pipeline` | file-hiding | ❌ | ✅ |
| `ceph` | Ceph | storage | `storage/ceph` | `run-ceph-pipeline` | file-hiding | ✅ | ✅ |
| `mariadb` | MariaDB | database | `database/mariadb` | `run-mariadb-pipeline` | file-hiding | ✅ | ✅ |
| `sqlserver` | SQL Server | database | `database/sqlserver` | `run-sqlserver-pipeline` | file-hiding | ❌ | ✅ |
| `pgsql` | PostgreSQL | database | `database/pgsql` | `run-pgsql-pipeline` | file-hiding | ✅ | ✅ |
| `vsphere` | VMware vSphere | virtualization | `virtualization/vsphere` | `run-vsphere-pipeline` | none | ✅ | ✅ |

---

## Exported Helpers

### `PRODUCT_MAP`
A `Record<string, ProductConfig>` of all active products, keyed by `id`:

```typescript
import { PRODUCT_MAP } from '@/lib/products-registry';

const cfg = PRODUCT_MAP['redhat'];
console.log(cfg.vendorString); // 'Red Hat'
```

### `getSkillDir(cfg)`
Resolves the absolute skill directory path:

```typescript
import { getSkillDir, PRODUCT_MAP } from '@/lib/products-registry';

const skillDir = getSkillDir(PRODUCT_MAP['mariadb']);
// → '/home/citec/.openclaw/workspace/skills/patch-review/database/mariadb'
```

---

## RAG Exclusion Details

### Prompt-Injection (Linux: redhat, oracle, ubuntu)

The `query_rag.py` script is invoked before each AI batch. It:
1. Takes the current batch's patch summaries as input
2. Queries `UserFeedback` in the SQLite DB for similar past exclusions
3. Returns a text block with exclusion reasoning

The result is appended to every AI prompt:
```
CRITICAL INSTRUCTION: The following patches have been EXCLUDED by an administrator.
Do NOT include them in your output under any circumstances:
- RHSA-2024:1234 (Reason: Internal systems don't use this component)
...
```

### File-Hiding (Windows, Ceph, MariaDB, SQL Server, PostgreSQL)

Before the AI runs:
```
<skillDir>/<normalizedDirName>/  →  renamed to  <normalizedDirName>_hidden/
patches_for_llm_review_<id>.json  →  renamed to  ..._hidden
```

After the AI completes, both are restored to their original names. This prevents the OpenClaw agent's file tools from accessing previously reviewed data and introducing bias.

---

## Passthrough Mechanic

The passthrough safety net exists because AI agents can skip patches during a run — due to context limits, rate limiting, or retries being exhausted. Without passthrough, those patches would silently disappear from the dashboard.

**Enabled for:** redhat, oracle, ubuntu, ceph, mariadb, pgsql, vsphere
**Disabled for:** windows, sqlserver — because version-grouping requires AI to make the selection; automatic passthrough would insert meaningless group-level entries

When enabled, after `ingestToDb()` completes:
1. Find all `PreprocessedPatch` rows for this vendor that are NOT in the AI-reviewed set
2. Upsert each as `ReviewedPatch` with `criticality: 'Important'`, `decision: 'Pending'`
3. These appear in the dashboard highlighted for human attention

---

## Adding a New Product

1. Write the product spec using [`docs/PRODUCT_SPEC_TEMPLATE.md`](PRODUCT_SPEC_TEMPLATE.md)
2. Create the skill directory: `patch-review/<category>/<id>/`
3. Write `SKILL.md` (≥100 lines, must have `## 4.` section)
4. Write the preprocessing script
5. Add one `ProductConfig` entry to `PRODUCT_REGISTRY` in `products-registry.ts`
6. Create `src/app/api/pipeline/<id>/run/route.ts` and `finalize/route.ts`
7. Run `node scripts/validate-registry.js` — all checks must pass

See `~/ADDING_NEW_PRODUCT.md` for the full step-by-step checklist.

---

## Validation

Run the registry validator at any time:

```bash
node scripts/validate-registry.js
```

Checks performed for each active product:
- ✅ `skillDir` exists on disk
- ✅ `preprocessingScript` file exists
- ✅ `SKILL.md` exists and has ≥100 lines
- ✅ `SKILL.md` contains a `## 4.` section
- ✅ RAG exclusion config is consistent (file-hiding has `normalizedDirName`, prompt-injection has `queryScript`)
- ✅ `passthrough` is configured
- ✅ `rateLimitFlag` starts with `/tmp/`
- ✅ `jobName` follows the `run-{id}-pipeline` convention
