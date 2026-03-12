# Technology Stack

The Patch Review Dashboard V2 is built using a modern, decoupled architecture allowing for dynamic scaling between the Frontend UI and the heavy backend data pipelines.

## 1. Frontend & API Layer
- **Framework:** Next.js 15 (App Router)
- **Language:** TypeScript
- **Styling:** Tailwind CSS (via `postcss`) with Shadcn/UI for consistent component design (`components.json`).
- **State & Data Fetching:** React Hooks, Server-Sent Events (SSE) for real-time pipeline log streaming.
- **Package Manager:** `pnpm` (Workspace managed via `pnpm-lock.yaml`).

## 2. Backend & Database
- **Database:** SQLite (`prisma/patch-review.db`)
- **ORM:** Prisma (`schema.prisma`) for type-safe database queries.
- **API Runtime:** Node.js (v22.22.0)
- **Job Orchestration:** Asynchronous `child_process.spawn()` triggered by Next.js API Routes, featuring built-in state locks (`pipeline_status.json`) to prevent concurrent race conditions.

## 3. Data Pipeline & Collectors
- **Scripting Languages:** Node.js, Python 3, Bash
- **Python Libraries (Pre-processing):** `json`, `sqlite3`, `uuid`, custom argument parsing (`argparse`).
- **Data Structuring:** Raw outputs are saved in vendor-specific JSON formats and sanitized into a standardized `PreprocessedPatch` object shape across Red Hat, Oracle, Ubuntu, Ceph, and MariaDB.

## 4. Artificial Intelligence & RAG
- **Core Agent Utility:** `openclaw` (Internal AI orchestration CLI Tool)
- **Model:** Google Gemini (Accessible via the internal openclaw router network).
- **RAG Generation:** Python implementations (`query_rag.py`) fetching stored similarity embeddings of user exclusion reasoning from the Prisma database using heuristic context matching.
- **Validation:** `zod` schema definitions strictly enforcing `ReviewSchema` output formats matching `patch_review_ai_report.json`.
