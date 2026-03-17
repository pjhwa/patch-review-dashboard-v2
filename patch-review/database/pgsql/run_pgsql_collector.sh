#!/bin/bash
# PostgreQL Collector Cron Wrapper (venv 지원 + 로그 기록)

PROJECT_DIR="/home/citec/.openclaw/workspace/skills/patch-review/database/pgsql"
VENV_PYTHON="$PROJECT_DIR/venv/bin/python"
SCRIPT="$PROJECT_DIR/pgsql_collector.py"
LOG="$PROJECT_DIR/cron_pgsql.log"

cd "$PROJECT_DIR" || { echo "[$(date)] cd 실패" >> "$LOG"; exit 1; }

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 시작 ===" >> "$LOG"

if [ -x "$VENV_PYTHON" ]; then
    "$VENV_PYTHON" "$SCRIPT" >> "$LOG" 2>&1
    EXIT_CODE=$?
else
    echo "[$(date)] venv 없음! (venv/bin/python 미발견)" >> "$LOG"
    EXIT_CODE=1
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') 종료 (코드: $EXIT_CODE) ===" >> "$LOG"
echo "" >> "$LOG"
exit $EXIT_CODE
