# Clawd v2 — brainstorm

Goal (from Cameron): Clawd reacts to what Claude is doing (Code AND chat), can be dragged and remembers
where he was left, reacts to clicks, uses the unused SVG animations, wears seasonal gear
(Santa hat all December, party hat on 4 June, Easter bunny companion on Easter Sunday), and gets a
topic accessory generated LIVE when a conversation starts (talk about DofE -> backpack). Topic sprites
must be generated at conversation time, not shipped/pre-made.

## Facts established so far (tested on this machine, 2026-10-04)

- Windows 11, Node 24, Electron 30 (from the repo). Claude desktop app is MSIX (`Claude.exe`, v2.19675).
- Stock pet: 128px transparent always-on-top window, plays a random GIF every 1-2 min then hides
  off-screen. `-webkit-app-region: drag` covers the window (so no click events reach JS today).
- 40 SVGs in `assets/svg`, CSS-keyframe animated, viewBox `-15 -25 45 45` (body 15x16 units at 0..15).
  38/40 contain the torso `<rect x="2" y="6" width="11" height="7">` inside the animated body groups
  (exceptions: clawd-error.svg, clawd-sleeping.svg). The GIFs are renders of a subset of these.
- `claude` CLI 2.1.288 at `~/.local/bin/claude`, logged in with OAuth (Pro). `claude -p --model haiku
  --no-session-persistence --tools "" --output-format json` works without an API key; took ~52 s with
  default thinking (4.9k thinking tokens) and the naive prompt drew a whole crab instead of an accessory.
  `--bare` is NOT usable (needs ANTHROPIC_API_KEY). `--effort` and `--json-schema` flags exist.
- User-level `~/.claude/settings.json` already has a PreToolUse hook (`bash ~/.claude/hooks/usage-guard.sh`).
  The desktop Code tab runs Claude Code, so user-level hooks fire there too. Cameron also runs
  autonomous/scheduled Claude Code sessions (Tetris/Hollow Knight supervisor) — hooks fire for those.
- Chat: Windows UI Automation on the Claude window exposes only 14 elements (title bar buttons) — the
  Chromium accessibility tree is not enabled, so chat text can't be scraped. Forcing it would need the
  system screen-reader flag (a system setting: not acceptable).
- `%APPDATA%\Claude\claude_desktop_config.json` exists (MSIX-redirected, same file), has no `mcpServers`
  key yet. The app rewrites this file for its own `preferences`.

## Idea list

### A. Knowing what Claude Code is doing
- A1 **Hooks -> local HTTP.** Add user-level hooks (SessionStart, UserPromptSubmit, PreToolUse,
  PostToolUse, Notification, Stop, SessionEnd) that pipe the hook JSON to `http://127.0.0.1:<port>/event`
  on the pet with `curl -s -m 1 -o /dev/null ... || true` (must print nothing: UserPromptSubmit stdout
  becomes model context; must never block or fail Claude). Map tools -> animations:
  Edit/Write/NotebookEdit -> typing, Read/Grep/Glob -> reading/debugger, Bash -> building,
  WebSearch/WebFetch -> carrying, Agent/Task -> conducting/juggling, TodoWrite -> sweeping,
  UserPromptSubmit -> thinking, Notification(permission) -> notification, Stop -> happy, then idle,
  long idle -> doze -> sleeping, SessionStart -> wake.
- A2 **Tail transcripts** in `~/.claude/projects/**.jsonl` with fs.watch. No settings change, but
  heavier, format is internal and can change, and it lags.
- A3 Scrape the desktop app UI — ruled out (see facts).

### B. Making it work in chat (claude.ai chat inside the desktop app)
- B1 **Local MCP server "clawd"** registered in `claude_desktop_config.json` -> `mcpServers`. Tools:
  `clawd_set_topic({topic, accessory?})` and `clawd_react({mood})`. Server instructions + tool
  descriptions ask the model to call `clawd_set_topic` at the start of a conversation. The chat model
  can draw the accessory ITSELF in the tool arguments (rect list) — zero extra latency/cost. Cameron
  can add one line to his claude.ai profile preferences to make it reliable. Needs a Claude app restart
  (Cameron does it; never restart the app from inside a session — it would kill the session).
- B2 UI Automation — ruled out. B3 browser extension — only claude.ai in Chrome, not the app.
- B4 Chromium remote-debugging port on Claude.exe — invasive, opens a debug port, fragile. Rejected.

### C. Rendering
- C1 **Switch from GIFs to inline SVG DOM.** Fetch SVG text, DOMParser, find the torso rect, inject an
  accessory `<g>` next to it so it inherits every body transform (bounce, jump, squash). Seasonal hats and
  topic accessories then move with him for free. Error/sleeping SVGs: fallback to wrap-root placement
  or skip accessories for those two.
- C2 Keep GIFs + overlay accessories at a fixed offset — misaligns whenever he jumps/bobs. Rejected.

### D. Drag + remember position
- Replace `-webkit-app-region: drag` with JS pointer handling: pointerdown -> track screen deltas ->
  IPC `setPosition`; small movement threshold separates click from drag; play react-drag while dragging;
  clamp to the display work area on drop; persist `{x,y,displayId}` to `app.getPath('userData')/state.json`;
  restore on launch (validate still on-screen, else default bottom-left).
- Stop the "hide off-screen between animations" loop by default (he should be visible while you work);
  tray toggle for the old "peekaboo" mode.

### E. Click reactions
- Single click: react-left / react-right depending on which half was clicked. Double click:
  double-jump. 5+ pokes in 3 s: annoyed. While dragged: react-drag. Hover: idle-look/follow.

### F. Seasonal (static, hand-drawn pixel SVG — allowed, only *topic* sprites must be live)
- Santa hat: whole of December. Party hat: 4 June. Easter: compute Easter Sunday (Anonymous Gregorian /
  Meeus algorithm) — a little white bunny companion sitting beside him (separate sprite next to the
  body, not on it). Evaluate date on each state change (app may run for weeks). Topic accessory +
  seasonal hat can coexist if they occupy different slots (head vs back/hand/face/companion).

### G. Live topic accessories
- G1 **Code:** on the first UserPromptSubmit of a session, pet spawns `claude -p --model haiku
  --effort low --json-schema ...` with env `CLAWD_GEN=1` (hook script exits early when set, so the
  generator can't recurse into the pet). Output = JSON `{topic, name, slot, rects:[{x,y,w,h,fill}]}`
  in the 15x16 body grid. Rects only (no raw SVG) -> safe to render, easy to validate/clamp.
  Cache by topic slug so the same topic later is instant (still generated live the first time).
- G2 **Chat:** model passes rects in `clawd_set_topic` (B1). Fallback to G1 generator if it only gives
  a topic string.
- G3 Keyword -> preset table. Rejected: Cameron explicitly wants live generation.
- Open questions: topic drift mid-conversation (re-check every N prompts? only when a prompt looks like
  a new subject?), which session "owns" the pet when several run at once (autonomous supervisor
  sessions would hijack him), how much Pro usage this burns, latency (~50 s -> must show a "thinking up
  an outfit" state or just pop it on when ready).

### H. Concurrency / ownership
- H1 Track sessions by `session_id`; show the activity of the session that most recently had a
  UserPromptSubmit (a human typing) — autonomous sessions rarely do... except scheduled tasks do submit
  a prompt. H2 Ignore sessions whose `cwd`/transcript matches an ignore list in config.
  H3 Treat sessions started with `permission_mode`/entrypoint "sdk"/scheduled differently, if the hook
  payload exposes that.

## Decisions after the independent review (2026-10-04)

A second Claude instance pulled every idea apart, with real hook captures, timings and renders. Outcomes:
- **A1 kept, changed to `type:"http"` hooks** (no process per tool call; curl took 1 s when the pet was down, node 82 ms,
  http added nothing). `timeout: 2` is set explicitly because the default is 600 s. Merged into existing arrays so
  usage-guard survives. http hooks never fire SessionStart, so sessions start on their first event.
- **H2/H3 failed**: scheduled tasks share cwd, entrypoint and permission mode with interactive sessions. The only
  reliable signal is the `<scheduled-task` prefix on the prompt, which marks the session background for good.
- **G1**: `--effort low` does NOT stop haiku thinking (85 s). Sonnet with `MAX_THINKING_TOKENS=0` and
  `alwaysThinkingEnabled:false` takes 7-12 s and draws much better. The generator runs with `disableAllHooks`
  (http hooks can't see env vars, so the old CLAWD_GEN guard was useless), `--setting-sources ""`,
  `--strict-mcp-config`, a custom system prompt (about 2k tokens instead of 40-60k), and the prompt on stdin.
  Output arrives in `structured_output`.
- **B1 kept as a `.mcpb` extension**: it runs on the app's built-in Node and avoids editing
  claude_desktop_config.json, which the app rewrites while running. The MCP `instructions` field is reportedly
  ignored by the desktop app, so the "call at conversation start" guidance lives in the tool descriptions, plus an
  optional profile-preference line.
- **C1**: the torso-sibling injection holds through every bounce, jump and tilt. Head gear is suppressed on
  wizard/building (own hats). Splooted poses (sleeping/error) keep only head gear, shifted down 4.
- **D**: drag follows `screen.getCursorScreenPoint()` in main (renderer screen coords drift on mixed DPI).
- **Outfit rule**: he wears the most recently assigned outfit from any non-background session. A chat tool call takes
  focus for 20 s.
