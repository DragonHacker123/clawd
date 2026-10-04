#!/bin/bash
# Dev test: leave Clawd completely alone for increasing periods (1, 2, 4, 8, 16,
# 32 min), then really click him once each time (tools/click-monitor.ps1 only
# clicks if Windows says the point belongs to Clawd). Meant to run unattended,
# e.g. overnight from a one-off scheduled task, so nothing else stimulates him.
# Results: %APPDATA%\clawd-desktop\idle-click-test.log
cd "$(dirname "$0")/.."
LOG="$APPDATA/clawd-desktop/idle-click-test.log"
echo "=== idle click test started $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
for m in 1 2 4 8 16 32; do
  sleep $((m * 60))
  echo "after ${m} min alone: $(powershell -NoProfile -ExecutionPolicy Bypass -File tools/click-monitor.ps1 -Rounds 1 -Every 0)" >> "$LOG"
done
echo "=== finished $(date '+%Y-%m-%d %H:%M:%S')" >> "$LOG"
