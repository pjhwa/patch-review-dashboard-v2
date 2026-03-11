#!/bin/bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

redis-cli FLUSHALL
pkill -f 'batch_collector.js'
pkill -f 'openclaw'
pkill -f 'patch-pipeline'

cd /home/citec/patch-review-dashboard-v2
npm run build
npx pm2 restart all
sleep 3
npx pm2 logs --nostream --lines 20
