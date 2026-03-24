# AI Review System

The Patch Review Dashboard V2 uses an autonomous AI review loop to evaluate security patches. This document describes how the AI is invoked, how past exclusions are injected, and how output validity is enforced.

---

## 1. Overview

```
patches_for_llm_review_<vendor>.json
          │
          ▼
  RAG Exclusion Setup (product-dependent)
          │
          ▼
  Batch Loop (5 patches per batch)
    │
    ├─ cleanupSessions()        ← delete sessions.json
    ├─ buildPrompt()            ← per-product prompt template
    ├─ openclaw agent:main      ← external AI model via openclaw CLI
    ├─ extractJsonArray()       ← parse AI output
    ├─ Zod validation           ← enforce schema
    └─ retry (up to 2x)        ← inject Zod error into prompt
          │
          ▼
  aiReviewedPatches[]  +  aiReviewedIds (Set)
          │
          ▼
  ingestToDb() + runPassthrough()
```

---

## 2. Session Isolation

**Problem in v1**: OpenClaw sessions accumulated context across batches. By batch 10, the AI was influenced by summaries of batches 1–9, causing hallucination and incorrect carry-over decisions.

**Solution in v2**: Before every batch, `cleanupSessions()` deletes:
```
~/.openclaw/agents/main/sessions/sessions.json
```

This forces OpenClaw to start each batch with a completely clean context. The only context the AI receives is:
1. The `SKILL.md` file (via `--json-mode` which reads it from the skill directory)
2. The current batch prompt (including RAG injection if applicable)

---

## 3. RAG Exclusion

### Strategy 1: Prompt-Injection (Red Hat, Oracle, Ubuntu, VMware vSphere)

Before the first batch:

1. `query_rag.py` is called with the current session's patch summaries as input (cwd: `os/linux/` shared directory)
2. It queries the `UserFeedback` table for similar past exclusion decisions
3. Returns an exclusion context block: a list of patch IDs and admin reasoning

This block is appended to every batch prompt:
```
CRITICAL INSTRUCTION: The following patches have been EXCLUDED by the security administrator
based on prior review cycles. Do NOT include them in your review output:
- RHSA-2024:1234 | Component: openssl | Reason: Internal systems don't use TLS 1.0
- ELSA-2024:5678 | Component: dbus | Reason: Not applicable to containerized workloads
```

**Why not file-hiding for Linux/vSphere?** These products have no `normalized/` directory structure. They use `prompt-injection` exclusively, which provides similarity-based exclusion from historical admin feedback.

### Strategy 2: Both (Windows, Ceph, MariaDB, SQL Server, PostgreSQL, MySQL, JBoss EAP, Tomcat, WildFly)

These products use both file-hiding AND prompt-injection.

**File-hiding** — Before AI runs:
```python
os.rename(normalized_dir, normalized_dir + "_hidden")
os.rename(patches_file, patches_file + ".hidden")
```

After AI runs:
```python
os.rename(normalized_dir + "_hidden", normalized_dir)
os.rename(patches_file + ".hidden", patches_file)
```

**Prompt-injection** — Also calls `query_rag.py` (cwd: `os/linux/`) to inject historical exclusion context before each batch.

**Why both?** File-hiding prevents the OpenClaw agent from reading previously processed files via workspace tools. Prompt-injection additionally injects admin feedback from prior review cycles to prevent re-recommending already-excluded patches.

---

## 4. Batch Prompt Construction

Each product defines its own `buildPrompt()` function in `products-registry.ts`. The prompt template includes:

1. **Instruction to read SKILL.md** — `Read the rules explicitly from <skillDir>/SKILL.md`
2. **Mandate to ignore past memories** — `CRITICAL MANDATE: IGNORE ANY PAST RETRIEVED MEMORIES`
3. **Output format contract** — exact JSON array structure with required fields
4. **Batch data** — `JSON.stringify(prunedBatch)` of the current 5 patches

**Standard products** (Linux, Ceph, MariaDB, PostgreSQL):
```
Return ONLY a pure JSON array containing EXACTLY {batchSize} objects.
Each object MUST contain: 'IssueID', 'Component', 'Version', 'Vendor', 'Date',
'Criticality', 'Description', 'KoreanDescription', and optionally 'Decision' and 'Reason'.
```

**Version-grouped products** (Windows Server, SQL Server):
```
INPUT FORMAT: Each entry is a VERSION GROUP containing a 'patches' array.
SELECTION RULE: Select the SINGLE MOST RECENT critical monthly patch per group.
OUTPUT RULE: Return EXACTLY {batchSize} objects, one per input VERSION GROUP.
IssueID = the GROUP's patch_id (e.g. 'WINDOWS-GROUP-Windows_Server_2025').
Version = the KB number of the selected monthly patch.
```

---

## 5. OpenClaw Invocation

```bash
openclaw agent:main --json-mode --message "<prompt>"
```

- `--json-mode`: Instructs the agent to produce structured JSON output
- `--message`: The complete prompt including SKILL.md path and batch data
- The agent reads `SKILL.md` from the skill directory to understand evaluation criteria
- Output is captured from stdout

---

## 6. Zod Validation & Self-Healing

### Schema
```typescript
const ReviewSchema = z.array(z.object({
  IssueID:            z.string(),
  Component:          z.string(),
  Version:            z.string(),
  Vendor:             z.string(),
  Date:               z.string(),
  Criticality:        z.string(),
  Description:        z.string(),
  KoreanDescription:  z.string(),
  Decision:           z.string().optional(),
  Reason:             z.string().optional(),
  OsVersion:          z.string().optional(),
}));
```

### Output Extraction

`extractJsonArray()` handles common AI output formatting issues:
1. Strips markdown code fences (` ```json ... ``` `)
2. Extracts the first `[...]` JSON array from the response
3. Parses and returns the array, or throws if no valid JSON found

### Batch Count Validation

After Zod validation:
- `aiBatchValidation: 'exact'` → output array length must equal input batch size
- `aiBatchValidation: 'nonEmpty'` → output array must have at least 1 item (version-grouped)

### Self-Healing Loop

```
Attempt 1:  buildPrompt(skillDir, batchSize, prunedBatch)
              → AI output
              → Zod fails: "Required at [2].IssueID"
              → wait 3s

Attempt 2:  same prompt + "\n\n이전 응답이 실패했습니다. 다음 Zod 구조적 에러를 해결하여
              다시 제출하세요: [exact Zod error message]"
              → AI output
              → Zod fails: malformed JSON
              → wait 9s

Attempt 3:  same prompt + updated error
              → PASS or batch is skipped (passthrough handles skipped patches)
```

---

## 7. Gateway Closed Handling

**Problem**: `openclaw agent:main` can return a "gateway closed" response when the network connection to the AI endpoint drops mid-response. In v1, this caused an immediate batch failure and retry.

**Solution in v2**: Gateway closed errors are NOT immediately rejected. The worker:
1. Detects the "gateway closed" status in the stream output
2. Waits for the full response to arrive (the connection may self-heal)
3. Only triggers the Zod retry loop if the complete response is invalid

This prevents unnecessary retries on transient network issues.

---

## 8. Rate Limiting

When the AI API returns a 429 rate limit response:

1. The rate limit flag file is created: `/tmp/.rate_limit_<productId>`
2. The worker waits with exponential backoff before retrying
3. The flag file is checked at the start of each batch — if it exists and is recent, the worker introduces additional delay

---

## 9. Passthrough (Skipped Patch Recovery)

After the AI loop completes, `runPassthrough()` ensures no patches are lost.

**Who gets passthrough**: All products except Windows Server and SQL Server (which use version-grouping — auto-insertion of incomplete groups would be misleading). Active passthrough products: redhat, oracle, ubuntu, ceph, mariadb, pgsql, mysql, vsphere, jboss_eap, tomcat, wildfly.

**What it does**:
1. Compares `PreprocessedPatch` (all preprocessed patches for this vendor) against `aiReviewedIds` (patches the AI actually reviewed this run)
2. For each patch that was preprocessed but NOT reviewed:
   ```
   ReviewedPatch.upsert({
     issueId: patch.issueId,
     criticality: 'Important',
     decision: 'Pending'
   })
   ```
3. These show up in the dashboard as "Pending" — flagged for human review

**Why 'Important' + 'Pending'**: Conservatively assumes skipped patches may be important. The human reviewer can downgrade or exclude them.

---

## 10. SKILL.md Standards

Each product's skill directory must contain a `SKILL.md` with:
- **≥100 lines** of content
- **`## 4.` section** titled "Strict LLM Evaluation Rules" containing:
  - `### 4.1` Inclusion Criteria
  - `### 4.2` Exclusion Criteria
  - `### 4.3` Output Format (JSON schema)
  - `### 4.4` General Rules
  - `### 4.5` Hallucination Prevention Rules

The validator (`scripts/validate-registry.js`) enforces these requirements.
