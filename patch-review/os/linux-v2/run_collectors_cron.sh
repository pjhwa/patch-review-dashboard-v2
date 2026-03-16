#!/bin/bash
# Wrapper script for Patch Review Data Collection
# Scheduled to run on the 3rd Sunday of Mar, Jun, Sep, Dec at 06:00

export PATH=$PATH:/home/citec/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin
source ~/.bashrc

cd /home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2

echo "[$(date)] Starting Red Hat Collection..."
cd redhat
node rhsa_collector.js
node rhba_collector.js
cd ..

echo "[$(date)] Starting Oracle Collection..."
cd oracle
bash oracle_collector.sh
python3 oracle_parser.py
cd ..

echo "[$(date)] Starting Ubuntu Collection..."
cd ubuntu
bash ubuntu_collector.sh
cd ..

echo "[$(date)] All collections finished successfully."
