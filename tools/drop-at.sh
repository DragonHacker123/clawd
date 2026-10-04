#!/bin/bash
# Dev helper: drop the live pet so his feet are at screen (FX, FY) (same code path as
# finishing a drag), wait for him to settle, and print where his feet ended up.
# usage: tools/drop-at.sh FX FY
FX=$1; FY=$2
T=$(cat "$APPDATA/clawd-desktop/token.txt")
S="$APPDATA/clawd-desktop/state.json"
X=$((FX - 75)); Y=$(node -e "console.log(Math.round($FY - 133.333))")
curl -s -H "X-Clawd-Token: $T" -H "Content-Type: application/json" -d "{\"x\":$X,\"y\":$Y}" http://127.0.0.1:47321/debug/drop >/dev/null
sleep ${3:-2.5}
node -e "const s=require(process.argv[1]);console.log('dropped feet at', $FX, $FY, '-> landed feet at', s.x+75, (s.y+133.333).toFixed(1))" "$S"
