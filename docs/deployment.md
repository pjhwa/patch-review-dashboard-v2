# Deployment Guide

This guide walks through setting up the Patch Review Dashboard V2 on a fresh Linux server from scratch.

---

## System Requirements

| Component | Minimum Version | Notes |
|-----------|----------------|-------|
| OS | Linux (Ubuntu 22.04+ recommended) | Server must have internet access |
| Node.js | v22+ | Use `nvm` for version management |
| pnpm | latest | `npm install -g pnpm` |
| Python | 3.10+ | For preprocessing scripts |
| Redis | 6+ | BullMQ backend — must run on same host or be accessible |
| openclaw | latest | Internal AI agent CLI — must be globally installed |
| pm2 | latest | Process manager for production |

---

## Step 1: Install Prerequisites

### Node.js (via nvm)
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash
source ~/.bashrc
nvm install 22
nvm use 22
node --version   # Should output v22.x.x
```

### pnpm
```bash
npm install -g pnpm
```

### Redis
```bash
# Ubuntu/Debian
sudo apt update
sudo apt install -y redis-server
sudo systemctl enable redis-server
sudo systemctl start redis-server
redis-cli ping   # Should output PONG
```

### Python dependencies
```bash
# The preprocessing scripts use standard library only (json, sqlite3, argparse)
# No pip install required unless individual scripts specify additional deps
python3 --version   # Should output 3.10+
```

### openclaw
Follow the internal openclaw installation guide. After installation:
```bash
openclaw --version   # Verify installation
```

### pm2 (production)
```bash
npm install -g pm2
```

---

## Step 2: Clone the Repository

```bash
git clone https://github.com/your-org/patch-review-dashboard-v2.git
cd patch-review-dashboard-v2
```

---

## Step 3: Deploy Pipeline Skills

The AI pipeline logic (preprocessing scripts, SKILL.md files, data directories) must reside in the OpenClaw workspace:

```bash
mkdir -p ~/.openclaw/workspace/skills/
cp -r ./patch-review ~/.openclaw/workspace/skills/
```

Verify the deployment:
```bash
ls ~/.openclaw/workspace/skills/patch-review/
# Should list: os/  database/  storage/  virtualization/  network/  middleware/
```

> **Important**: Python virtual environments (`venv/`) must NEVER be inside the `patch-review-dashboard-v2` project directory. Turbopack will panic on absolute symlinks within the project tree. If any `venv/` directories exist under `patch-review/`, remove them:
> ```bash
> find patch-review -name "venv" -type d -exec rm -rf {} +
> ```
> Install Python dependencies globally or in a venv located outside the project.

---

## Step 4: Install Node Dependencies

```bash
pnpm install
```

---

## Step 5: Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env`:
```bash
# Database
DATABASE_URL="file:./prisma/patch-review.db"

# Redis (BullMQ backend)
REDIS_URL="redis://127.0.0.1:6379"
```

If Redis requires authentication:
```bash
REDIS_URL="redis://:yourpassword@127.0.0.1:6379"
```

---

## Step 6: Initialize the Database

```bash
pnpm prisma generate
pnpm prisma db push
```

Verify:
```bash
pnpm prisma studio   # Opens database GUI at http://localhost:5555
```

---

## Step 7: Validate the Product Registry

Before first run, verify all 13 products are correctly configured:

```bash
node scripts/validate-registry.js
```

Expected output:
```
=== Patch Review Dashboard — Product Registry Validator ===

── redhat ──
  ✅ [redhat] skillDir exists
  ✅ [redhat] preprocessingScript exists: patch_preprocessing.py
  ✅ [redhat] SKILL.md: 280 lines (≥100)
  ...

Validation: 105 passed, 0 failed

✅ All checks passed!
```

If any checks fail, fix the issues before proceeding. Common failures:
- `skillDir missing` → Re-run Step 3 (skills deployment)
- `SKILL.md missing ## 4. section` → Add the required section to the SKILL.md file
- `preprocessingScript missing` → Verify the script file exists in the skill directory

---

## Step 8: Development Server

```bash
pnpm run dev
```

The application starts on `http://localhost:3001` (Turbopack enabled for fast refresh).

---

## Step 9: Production Deployment

### Build
```bash
bash build.sh
```
Or manually:
```bash
pnpm build
```

### Start with pm2
```bash
pm2 start "pnpm start" --name patch-dashboard
pm2 save
pm2 startup   # Follow the displayed command to enable auto-start on boot
```

### Verify
```bash
pm2 status
pm2 logs patch-dashboard --lines 50
curl http://localhost:3001/api/products   # Should return JSON array
```

---

## Step 10: Configure systemd Auto-Start (Optional)

The server uses `pm2-citec.service` for automatic start on boot. If not already configured:

```bash
pm2 startup systemd -u citec --hp /home/citec
# Run the command output by the above
pm2 save
```

---

## Step 11: Configure CRON for Data Collection

Data collection runs quarterly. Set up the cron schedule:

```bash
bash update_cron.sh
```

This installs a cron entry that runs the third Sunday of March, June, September, and December at 06:00:
```
0 6 15-21 3,6,9,12 * test $(date +\%w) -eq 0 && /path/to/run_collectors_cron.sh
```

---

## Step 12: Configure Port (if needed)

The application runs on port 3001 by default. If port 3001 is already in use:

```bash
bash fix_port.sh   # Kills any process occupying port 3001
```

Or change the port in `package.json`:
```json
"dev": "next dev -p 3002 --turbo",
"start": "next start -p 3002"
```

---

## Directory Layout After Deployment

```
/home/citec/
├── patch-review-dashboard-v2/          # This repository
│   ├── src/                            # Next.js application
│   ├── prisma/patch-review.db          # SQLite database
│   ├── .env                            # Environment variables
│   └── scripts/validate-registry.js   # Registry validator
│
└── .openclaw/
    └── workspace/
        └── skills/
            └── patch-review/           # Deployed from repo's patch-review/
                ├── os/
                │   ├── linux/       # Red Hat, Oracle, Ubuntu
                │   │   ├── patch_preprocessing.py
                │   │   ├── SKILL.md
                │   │   ├── query_rag.py
                │   │   ├── redhat_data/    # Collected raw data
                │   │   ├── oracle_data/
                │   │   └── ubuntu_data/
                │   └── windows/
                ├── database/
                │   ├── mariadb/
                │   ├── sqlserver/
                │   ├── pgsql/
                │   └── mysql/
                ├── storage/ceph/
                ├── virtualization/vsphere/
                └── middleware/
                    ├── jboss_eap/
                    ├── tomcat/
                    └── wildfly/
```

---

## Troubleshooting

### Redis connection refused
```bash
sudo systemctl status redis-server
sudo systemctl start redis-server
# Check REDIS_URL in .env matches actual Redis address
```

### Turbopack build panic (symlink error)
```
Symlink patch-review/xxx/venv/bin/python is invalid, it points out of the filesystem root
```
Remove all Python venvs from the project directory:
```bash
find patch-review -name "venv" -type d -exec rm -rf {} +
pnpm build   # Retry
```

### Pipeline job stuck in queue
```bash
# Check BullMQ queue state
node -e "
const { Queue } = require('bullmq');
const q = new Queue('patch-pipeline', { connection: { host: '127.0.0.1', port: 6379 } });
q.getJobs(['active','waiting','failed']).then(jobs => {
  jobs.forEach(j => console.log(j.name, j.id, j.opts?.attempts));
  q.close();
});
"
```

### Build fails with TypeScript errors
```bash
pnpm install   # Ensure all deps are installed
pnpm build 2>&1 | head -50   # See first errors
```

### OpenClaw agent not responding
```bash
openclaw agent:main --help   # Verify openclaw is working
# Ensure the SKILL.md is in place:
ls ~/.openclaw/workspace/skills/patch-review/os/linux/SKILL.md
```

### Prisma "table does not exist"
```bash
pnpm prisma db push   # Recreate schema
pnpm prisma generate  # Regenerate client
pm2 restart patch-dashboard
```

---

## Updating the Application

```bash
cd patch-review-dashboard-v2
git pull origin main-work

# Update skills (if patch-review/ changed)
cp -r ./patch-review ~/.openclaw/workspace/skills/

# Rebuild and restart
bash build.sh
bash restart.sh
```
