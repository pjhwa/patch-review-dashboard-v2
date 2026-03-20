# WORKFLOWS — Patch Review Dashboard V2

## Development Workflow

### Setup (first time)
```bash
# 1. Install deps
pnpm install

# 2. Deploy skill files to openclaw workspace
cp -r ./patch-review ~/.openclaw/workspace/skills/

# 3. Configure environment
cp .env.example .env
# Edit: DATABASE_URL="file:./prisma/patch-review.db"
#       REDIS_URL="redis://127.0.0.1:6379"

# 4. Initialize database
pnpm prisma generate
pnpm prisma db push

# 5. Validate registry (all 9 products must pass)
node scripts/validate-registry.js

# 6. Start Redis (required)
sudo systemctl start redis-server

# 7. Start dev server
pnpm run dev   # → http://localhost:3001
```

### Daily Development
```bash
pnpm run dev                   # Dev server with Turbopack hot reload
node scripts/validate-registry.js  # Run after any registry change
pnpm prisma studio             # Database GUI (port 5555)
```

---

## Build Process

```bash
bash build.sh
# Equivalent to: pnpm build
```

Build includes:
- TypeScript compilation (strict mode — type errors = build failure)
- Next.js App Router optimization
- `src/lib/queue.ts` is compiled as part of the build — type errors there will fail the build

Common build failures:
- `job.log` used in wrong context → use `job.log()` callback pattern only inside `withOpenClawLock`
- Prisma `upsert` with non-`@unique` where field → runtime error (catches at runtime, not build time)
- Type mismatch in `ProductConfig` fields → caught at build time

---

## Deployment Pipeline

### Production Deploy
```bash
cd ~/patch-review-dashboard-v2
git pull origin main-work

# If patch-review/ changed, redeploy skills
cp -r ./patch-review ~/.openclaw/workspace/skills/

# Build + restart
bash build.sh
bash restart.sh
```

`restart.sh` runs `pm2 restart patch-dashboard`. If build fails, `restart.sh` is NOT run — current running instance stays live.

### Process Manager
- pm2 process name: `patch-dashboard`
- Command: `pnpm start`
- Auto-start: `pm2-citec.service` (systemd unit)
- Port: 3001

```bash
pm2 status                         # Check process status
pm2 logs patch-dashboard --lines 50  # Tail logs
pm2 restart patch-dashboard         # Restart after build
```

### Server Configuration
- nginx (if present): port 80 → redirect to port 3001
- nginx config is tracked in `infra/nginx/` — commit changes there
- If server IP changes, update nginx config accordingly

---

## Data Collection Cron

Quarterly collection schedule (installed via `bash update_cron.sh`):
```
0 6 15-21 3,6,9,12 * test $(date +%w) -eq 0 && /path/to/run_collectors_cron.sh
```
Triggers: third Sunday of March, June, September, December at 06:00

Collectors are independent of the Next.js app. They write to:
```
~/.openclaw/workspace/skills/patch-review/<category>/<product>/<product>_data/
```

---

## Pipeline Operator Workflow (User-Facing)

1. User opens `http://localhost:3001` → auto-redirects to `/category/os`
2. Clicks "Run Pipeline" on a product card → confirm dialog
3. Pipeline runs: preprocessing → RAG setup → AI review → DB ingest → passthrough
4. SSE log stream shows real-time progress in the dashboard
5. User navigates to product detail page → reviews `ReviewedPatch` table
6. User clicks "Finalize" → CSV written to skill directory
7. After all products finalized → quarterly archive auto-created

### Pipeline Options
- **Run Pipeline**: Full run (preprocessing + AI)
- **AI Only** (`isAiOnly: true`): Skip preprocessing, re-run AI on existing data
- **Retry** (`isRetry: true`): Resume from last successful point

---

## Adding a New Product

1. Write product spec: `docs/PRODUCT_SPEC_TEMPLATE.md`
2. Create skill directory: `patch-review/<category>/<id>/`
3. Write `SKILL.md` (≥100 lines, must include `## 4.` section with 4.1–4.5 subsections)
4. Write preprocessing Python script
5. Add `ProductConfig` entry to `PRODUCT_REGISTRY` in `products-registry.ts`
6. Create `src/app/api/pipeline/<id>/run/route.ts` and `finalize/route.ts`
7. Run `node scripts/validate-registry.js` — all checks must pass
8. Check `~/ADDING_NEW_PRODUCT.md` for full 7-step checklist

**Before running, verify:**
- `rawDataFilePrefix` matches actual filenames in `*_data/` directory
- `preprocessedPatchMapper` field names match the JSON keys output by the preprocessing script
- `ragExclusion` type is set correctly for the product type
- `passthrough.enabled` is `false` only if using version-grouping

---

## Agent Task Lifecycle

For AI agents performing development tasks:

```
1. Read docs_canonical/REPO_MAP.md        (orientation)
2. Read relevant docs_canonical/ docs      (domain knowledge)
3. Read affected source files              (ground truth)
4. Plan changes (minimal scope)
5. Implement
6. Run: node scripts/validate-registry.js (if registry touched)
7. Run: pnpm build                        (type check)
8. Deploy skills if patch-review/ changed: cp -r ./patch-review ~/.openclaw/workspace/skills/
9. Restart: bash restart.sh
```

---

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `file:./prisma/patch-review.db` | SQLite database path |
| `REDIS_URL` | `redis://127.0.0.1:6379` | BullMQ Redis connection |

---

## Troubleshooting Quick Reference

| Symptom | Fix |
|---------|-----|
| Redis connection refused | `sudo systemctl start redis-server` |
| Turbopack symlink panic | `find patch-review -name "venv" -type d -exec rm -rf {} +` |
| Pipeline job stuck in queue | Check BullMQ state; use Reset in UI |
| Prisma "table does not exist" | `pnpm prisma db push && pnpm prisma generate` |
| OpenClaw not responding | `openclaw agent:main --help` + check SKILL.md exists |
| Port 3001 in use | `bash fix_port.sh` |
