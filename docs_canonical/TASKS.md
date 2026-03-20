# TASKS — Patch Review Dashboard V2

> Last updated: 2026-03-20
> This file tracks current development backlog, active initiatives, and expansion targets.

---

## Active System Status

- 9 products fully operational: redhat, oracle, ubuntu, windows, ceph, mariadb, sqlserver, pgsql, vsphere
- Quarterly pipeline cadence running
- Archive system operational
- i18n (KO/EN) deployed
- Dark/light theme toggle deployed

---

## Known Open Items

### Oracle Linux Review
- Verify Oracle Linux patch review logic aligns with Red Hat review criteria
- Reference TODO in `patch-review/TODO.md`

---

## Product Expansion (Inactive Placeholders)

The following products are defined as inactive placeholders in `PRODUCT_REGISTRY` (`active: false`). Activation requires:
1. Product spec doc in `docs/specs/<id>_spec.md`
2. Skill directory at `patch-review/<category>/<id>/`
3. `SKILL.md` (≥100 lines, `## 4.` section)
4. Preprocessing script
5. Data collectors
6. `ProductConfig` entry updated to `active: true`
7. API routes: `run/route.ts` + `finalize/route.ts`

### Planned Products
| Product | Category | Notes |
|---------|----------|-------|
| MySQL | database | Common pairing with MariaDB; similar preprocessing pattern |
| HP-UX | os | Unix variant; data collection from vendor advisories |
| IBM AIX | os | Unix variant; data collection from IBM Fix Central |
| Oracle Solaris | os | Unix variant; data collection from Oracle security advisories |

---

## Engineering Initiatives

### Harness Engineering (completed 2026-03-20)
- Created `docs_canonical/` layer with REPO_MAP, ARCHITECTURE, WORKFLOWS, STYLEGUIDE, TESTING, TASKS
- Added `AGENTS.md` with Repository Knowledge Harness directive
- Goal: reduce per-session AI re-exploration cost; provide stable navigation layer

### Recurring Improvements (ongoing)
- SKILL.md quality: each product's SKILL.md should remain ≥100 lines and reflect current evaluation criteria
- Registry validator: extend checks when new `ProductConfig` fields are added
- docs_canonical/ maintenance: update ARCHITECTURE.md when pipeline phases change

---

## Completed Initiatives

- v1 → v2 migration: central product registry, BullMQ queue, generic pipeline worker
- RAG exclusion system (prompt-injection + file-hiding strategies)
- Self-healing Zod validation with retry
- Passthrough safety net
- Quarterly archive system
- i18n (KO/EN) dictionary + cookie-based toggle
- Dark/light theme system (CSS variable-based)
- docs/plan/ rebuild: 5 canonical Korean planning documents
