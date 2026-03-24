#!/bin/bash
# vSphere Collector Cron Wrapper (venv 지원 + 로그 기록)

PROJECT_DIR="/home/citec/.openclaw/workspace/skills/patch-review/virtualization/vsphere"
SHARED_VENV="/home/citec/.openclaw/workspace/skills/patch-review/shared-venv"
VENV_PYTHON="$SHARED_VENV/bin/python"
SCRIPT="$PROJECT_DIR/vsphere_collector.py"
LOG="$PROJECT_DIR/cron_vsphere.log"

cd "$PROJECT_DIR" || { echo "[$(date)] cd 실패" >> "$LOG"; exit 1; }

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 시작 ===" >> "$LOG"

if [ -x "$VENV_PYTHON" ]; then
    "$VENV_PYTHON" "$SCRIPT" >> "$LOG" 2>&1
    EXIT_CODE=$?
else
    echo "[$(date)] shared-venv 없음! ($SHARED_VENV/bin/python 미발견)" >> "$LOG"
    EXIT_CODE=1
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 종료 (코드: $EXIT_CODE) ===" >> "$LOG"
echo "" >> "$LOG"
exit $EXIT_CODE
