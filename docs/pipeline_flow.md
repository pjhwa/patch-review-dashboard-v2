# Data Pipeline & Workflow Flow

The Patch Review Dashboard V2 operates on a strict 5-Phase autonomous workflow that handles collecting, cleaning, evaluating, and storing security patches. 

---

## Phase 1: Initiation
The pipeline can be triggered in two ways:
- **Manual Trigger** via the Web Dashboard clicking `Execute Pipeline`.
- **Scheduled Trigger** via the `run_collectors_cron.sh` cron job set on the server (running quarterly: Mar, Jun, Sep, Dec).
Both execution paths call the `/api/pipeline/execute` API endpoint, sending the category (`os`) and product (`redhat`, `oracle`, `ubuntu`, etc.). The server drops a `pipeline_status.json` file to establish an OS-level lock, preventing concurrent executions that may overwrite critical data.

## Phase 2: Unstructured Data Collection
The Node.js backend spawns a detached child process inside `~/.openclaw/workspace/skills/patch-review/os/linux-v2` and triggers vendor-specific fetch routines:
- **Red Hat:** Uses `rhsa_collector.js` and `rhba_collector.js` fetching Red Hat Errata APIs.
- **Oracle:** Uses `oracle_collector.sh` and parses output using `oracle_parser.py` extracting Eln advisories.
- **Ubuntu:** Uses `ubuntu_collector.sh` downloading raw CVE details.
- **Others (Ceph, MariaDB):** Sits in their respective `storage/ceph` and `database/mariadb` directories for parallel collections.

## Phase 3: Preprocessing & deduplication
Once raw collections finish, the Python engine (`patch_preprocessing.py`) executes.
1. Consolidates all varying JSON arrays from Phase 2 into a single unified list.
2. Applies a 90-day time boundary limitation `--days 90` to restrict excessive LLM context lengths.
3. Automatically connects to the Next.js `prisma/patch-review.db` SQLite database to check `PreprocessedPatch`. If an `IssueID` already exists, it is marked as a skipped duplicate.
4. Outputs the final, clean, and deduplicated targets to `patches_for_llm_review.json`.

## Phase 4: RAG Injection & AI Analysis (Self-Healing)
1. **RAG Injection:** `query_rag.py` compares the new target patches against past `UserFeedback` using similarity thresholds. If previous admins marked a similar patch as "Excluded", the reasoning is dumped directly into the runtime AI prompt context.
2. **AI Action:** The system spawns `openclaw agent:main` using `SKILL.md` in `--json-mode`. OpenClaw acts as the Patch Review Board, generating descriptions in both English and Korean while judging severity.
3. **Zod Validation & Auto-Healing:** The emitted `patch_review_ai_report.json` is piped through a native Zod `ReviewSchema`. If validation fails, the API engine catches the specific path error, appends the error to the prompt, and restarts Openclaws with exponential backoff (up to 2 times).

## Phase 5: DB Finalization & Archiving
When the JSON validation is 100% successful, the dashboard UI displays the final result block. Selecting `Submit` hits `/api/pipeline/finalize`, writing the JSON payloads directly into Prisma's `ReviewedPatch` records. Logs and JSON artifacts are then timestamped and moved into an isolated `/archive/YYYY-MM-DD` directory.
