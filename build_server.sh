#!/bin/bash
export PATH=/home/citec/.nvm/versions/node/v22.22.0/bin:$PATH
cd /home/citec/patch-review-dashboard-v2
npm run build
pm2 restart all
