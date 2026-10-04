#!/bin/bash
# Dev helper: send synthetic mouse events (JSON array) into the pet window.
T=$(cat "$APPDATA/clawd-desktop/token.txt")
curl -s -H "X-Clawd-Token: $T" -H "Content-Type: application/json" -d "{\"events\": $1}" http://127.0.0.1:47321/debug/input; echo
