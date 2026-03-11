scp "pipeline_scripts\sync_rag.py" citec@172.16.10.237:/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/
scp "pipeline_scripts\query_rag.py" citec@172.16.10.237:/home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/
scp "src\lib\schema.ts" citec@172.16.10.237:/home/citec/patch-review-dashboard-v2/src/lib/
scp "src\lib\db.ts" citec@172.16.10.237:/home/citec/patch-review-dashboard-v2/src/lib/
scp "src\components\ProductGrid.tsx" citec@172.16.10.237:/home/citec/patch-review-dashboard-v2/src/components/
scp "src\app\api\pipeline\execute\route.ts" citec@172.16.10.237:/home/citec/patch-review-dashboard-v2/src/app/api/pipeline/execute/
scp "package.json" citec@172.16.10.237:/home/citec/patch-review-dashboard-v2/
ssh citec@172.16.10.237 "source ~/.nvm/nvm.sh && cd /home/citec/patch-review-dashboard-v2 && npm install --legacy-peer-deps && npm run build && pm2 restart all"
