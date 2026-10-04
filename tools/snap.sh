#!/bin/bash
# Dev helper: grab the live pet's rendering (transparent PNG) and brain state.
# usage: tools/snap.sh out.png
T=$(cat "$APPDATA/clawd-desktop/token.txt")
curl -s -H "X-Clawd-Token: $T" http://127.0.0.1:47321/debug/snap -o "${1:-snap.png}"
curl -s -H "X-Clawd-Token: $T" http://127.0.0.1:47321/debug/state; echo
