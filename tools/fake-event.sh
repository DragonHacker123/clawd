#!/bin/bash
# Dev helper: send a fake Claude Code hook event through the real hook script.
# usage: tools/fake-event.sh <EventName> [tool_name] [prompt]
ev="$1"; tool="${2:-}"; prompt="${3:-}"
node -e '
const [ev, tool, prompt] = process.argv.slice(1);
process.stdout.write(JSON.stringify({ session_id: "fake-1", cwd: "C:\fake", hook_event_name: ev, tool_name: tool || undefined, tool_input: {}, prompt: prompt || undefined }));
' "$ev" "$tool" "$prompt" | node "$(dirname "$0")/../hooks/clawd-hook.js"
