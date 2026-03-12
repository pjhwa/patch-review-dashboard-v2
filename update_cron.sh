#!/bin/bash
crontab -l | grep -v 'run_collectors_cron.sh' > tmp_cron
echo "0 6 15-21 3,6,9,12 * test \$(date +\%w) -eq 0 && /home/citec/.openclaw/workspace/skills/patch-review/os/linux-v2/run_collectors_cron.sh >> /home/citec/patch_collector_cron.log 2>&1" >> tmp_cron
crontab tmp_cron
rm tmp_cron
echo "Crontab updated successfully."
