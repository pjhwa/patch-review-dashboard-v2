#!/bin/bash
# Build and restart patch-review-dashboard-v2
set -e

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
export PATH=/home/citec/.nvm/versions/node/v22.22.0/bin:$PATH

cd /home/citec/patch-review-dashboard-v2

echo "[build] pnpm build 시작..."
pnpm run build

echo "[build] PM2 재시작..."
pm2 restart patch-dashboard

echo "[build] 완료. 상태:"
pm2 status patch-dashboard
