## Repository Knowledge Harness

This repository uses a canonical documentation layer for repository knowledge.

Repository architecture, workflows, coding conventions, and testing policies are defined in:

docs_canonical/

Agents must read these documents before performing repository tasks.

Canonical documentation is the authoritative source for repository behavior.

Legacy documentation may be used only for reference.

If canonical documentation conflicts with legacy documentation, canonical documentation takes precedence.

---

## Repository Overview

Patch Review Dashboard V2 is an autonomous compliance operations platform.
It collects, preprocesses, AI-reviews, and finalizes enterprise security patches
for 9 products across 4 categories (OS, Database, Storage, Virtualization).

## Agent Operating Rules

1. Before any task, read `docs_canonical/REPO_MAP.md` for orientation.
2. For pipeline or AI behavior changes, read `docs_canonical/ARCHITECTURE.md`.
3. For build, deploy, or workflow tasks, read `docs_canonical/WORKFLOWS.md`.
4. For coding patterns and naming, read `docs_canonical/STYLEGUIDE.md`.
5. For validation before committing, read `docs_canonical/TESTING.md`.
6. For current backlog and priorities, read `docs_canonical/TASKS.md`.

## Task Execution Loop

plan → implement → verify (validate-registry + build) → document

## Critical Invariants (Never Violate)

- `src/lib/products-registry.ts` is the single source of truth for all product config.
- `SKILL.md` per product must have ≥100 lines and a `## 4.` section.
- `sessions.json` must be deleted between every AI batch (cleanupSessions).
- `preprocessedPatchMapper` field names must exactly match the JSON output of the preprocessing script.
- `pgsql` raw data file prefix is `PGSL-` (not `PGSQL-`).
- Python `venv/` directories must NEVER exist inside the project tree.
- Prisma `upsert` where-clause fields must have `@unique` in the schema.
