#!/bin/bash
# Dev experiment: every 10 min really click Clawd (tools/click-monitor.ps1); when a
# click is lost, record the page state, then try each candidate repair in turn
# with a click after each, logging which one brings clicks back.
cd "$(dirname "$0")/.."
LOG="$APPDATA/clawd-desktop/heal-experiment.log"
T=$(cat "$APPDATA/clawd-desktop/token.txt")
click() { powershell -NoProfile -ExecutionPolicy Bypass -File tools/click-monitor.ps1 -Rounds 1 -Every 0; }
echo "=== heal experiment $(date '+%F %T')" >> "$LOG"
for i in $(seq 1 7); do
  sleep 600
  r=$(click); echo "$r" >> "$LOG"
  case "$r" in *BROKEN-DELIVERY*) ;; *) continue ;; esac
  echo "page state: $(curl -s -H "X-Clawd-Token: $T" http://127.0.0.1:47321/debug/page-state)" >> "$LOG"
  for m in recreate; do
    curl -s -H "X-Clawd-Token: $T" -H "Content-Type: application/json" -d "{\"method\":\"$m\"}" http://127.0.0.1:47321/debug/heal >/dev/null
    sleep 2
    r=$(click); echo "  after heal '$m': $r" >> "$LOG"
    case "$r" in *"ok: press"*) echo "=== FIXED BY: $m" >> "$LOG"; exit 0 ;; esac
  done
  echo "=== nothing fixed it" >> "$LOG"; exit 0
done
echo "=== no failure in 70 min" >> "$LOG"
