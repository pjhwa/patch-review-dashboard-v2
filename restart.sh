#!/bin/bash
source ~/.bashrc
source ~/.profile
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

cd ~/patch-review-dashboard-v2
pm2 restart all || npx pm2 restart all || /home/citec/.nvm/nvm-exec pm2 restart all || echo "Could not find pm2. Attempting to restart via npm start directly if not backgrounded."
