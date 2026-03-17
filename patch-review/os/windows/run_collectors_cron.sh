#!/bin/bash
# Wrapper script for Patch Review Data Collection
# Scheduled to run on the 3rd Sunday of Mar, Jun, Sep, Dec at 06:00

export PATH=$PATH:/home/citec/.nvm/versions/node/v22.22.0/bin:/usr/local/bin:/usr/bin:/bin
source ~/.bashrc

cd /home/citec/.openclaw/workspace/skills/patch-review/os/windows

echo "[$(date)] Starting Windows Server Collection..."
python3 windows_collector.py
cd ..

echo "[$(date)] All collections finished successfully."
