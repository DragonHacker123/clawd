# Clawd v2: a desktop pet that watches Claude work

Cameron's fork of [KebeliSamet0/clawd](https://github.com/KebeliSamet0/clawd) (MIT). The original showed
a random GIF every minute or two. This version renders the SVG animations live and reacts to what Claude is
actually doing.

## What he does

| | |
|---|---|
| **Follows Claude Code** | Thinks when you send a prompt. Types while Claude edits, reads while it reads, uses the magnifier for searches/tests, hammers away on Bash, carries stuff for web fetches, conducts subagents, sweeps on todo updates, juggles when several sessions are busy, waves for attention when Claude needs you, celebrates when Claude finishes, flops over on errors. |
| **Ignores scheduled tasks** | Sessions whose prompt starts with `<scheduled-task …>` (e.g. the Tetris/HK supervisor) are marked background and never drive him. |
| **Topic outfits, generated live** | On the first real prompt of a session, he asks Claude (Sonnet, thinking off, about 10 s, on your own login) to draw a pixel accessory for the topic: DofE gets a backpack, football gets a linesman's flag. Outfits are rects only, validated hard, and cached in `%APPDATA%\clawd-desktop\outfits`. He wears the most recently assigned outfit. |
| **Works in chat** | The `dist/clawd.mcpb` desktop extension gives Claude chat `clawd_set_topic` and `clawd_react` tools. Chat can draw the outfit itself; topic-only calls fall back to the generator. |
| **Seasonal** | Santa hat all December, party hat and confetti on 4 June, Easter bunny and egg on Easter Sunday (computed). |
| **Physics** | Gravity and throwing: let go mid-drag and he flies with the drag's speed. He lands on surfaces he finds on screen (text boxes, cards, bubbles, title bars, the taskbar). Land near an edge and he teeters, then scrambles back or slips off. A slip or hard landing gives an angry stomp and "ow!! 💢". |
| **Moving ledges** | He re-finds his ledge up to ~3×/s (backing off to ~1.5 s when nothing moves) and rides it: the message box growing pushes him up, scrolling carries him. If it scrolls away he falls to the next surface (e.g. the message box). If it carries him into the top he's knocked off and falls. |
| **Walking** | When idle (or fetching/sweeping) he wanders along whatever he's standing on, turning at the ends. On long tasks (90 s+) he sits down to work instead. |
| **Lives in Claude** | Shown while the Claude app is open, and hidden only when another window actually covers him. Riding along when you move Claude's window, he treats its bottom edge (or the taskbar) as the floor. |
| **Sleep** | 30 s with no typing, prompts, link clicks or pokes (and Claude idle): he dozes, then sleeps with zzz's. Scrolling and other clicks don't wake him. |
| **Drag & clicks** | Drag him anywhere (he dangles) and he stays there across restarts. Click: he looks over. Double-click: jump. Five pokes: annoyed. Right-click: menu. The rest of his square is click-through. |
| **Idle life** | Cycles through idle animations, dozes after 5 min with nothing happening, then falls asleep. Activity or a poke wakes him. |

## Running

```bash
npm install
npm start
```

He registers himself to start with Windows. Toggle that, "only show while Claude is working", topic
outfits and so on from the tray icon or by right-clicking him.

### Hooking up Claude Code (done on this PC)

```bash
npm run install-hooks
```

This merges `type: "http"` hooks into `~/.claude/settings.json` without touching existing hooks, and backs the file
up to `settings.json.bak-clawd`. The hooks post to `http://127.0.0.1:47321/event` with a per-install token (from
`%APPDATA%\clawd-desktop\token.txt`) and a 2 s timeout. If Clawd isn't running, Claude Code just skips them.
`npm run uninstall-hooks` removes them.

### Hooking up chat

1. `npm run build-extension` builds `dist/clawd.mcpb`.
2. In the Claude desktop app: **Settings → Extensions → Advanced settings → Install Extension…**, and pick
   `dist/clawd.mcpb`. You can also drag the file onto the Extensions page.
3. Optional, for reliability: add this to your claude.ai profile preferences: *"At the start of each conversation, call
   clawd_set_topic once with the topic and a drawn accessory."* Choose "Always allow" the first time it asks.

## How it fits together

```
Claude Code ──http hooks──▶ src/server.js ─▶ src/brain.js ──IPC──▶ renderer/pet.js ─▶ renderer/sprites.js
Claude chat ──mcp/clawd-mcp.js (in .mcpb)──▶ /chat ─┘     │                          (inline SVG + accessories)
                                         src/outfits.js ◀─┘ (claude -p → rects)       renderer/seasonal.js
```

- `main.js`: window (transparent, click-through except his pixels), tray, saved position, login item.
- `src/server.js`: localhost-only server. Token required, browser `Origin` requests refused. Debug routes:
  `GET /debug/state`, `GET /debug/snap` (PNG of the pet), `POST /debug/input` (synthetic mouse events).
- `src/surfaces.js`: finds standable lines by looking at the screen, because apps don't expose their layout. It captures the
  display, masks out the patch Clawd himself covers (so he never vanishes from recordings), then keeps horizontal edges that are long
  (≥46 px), unbroken (≥94% of the run), one-directional and even-stepped. That rejects text baselines and keeps real UI
  edges. The taskbar top comes from the work area.
- `src/physics.js`: gravity, throws, landings, teetering, walking, riding moving ledges.
- `src/foreground.js` + `native/fgwatch.cs`: a tiny helper (compiled on first run with Windows' built-in
  `csc.exe`) that reports Claude's window, the windows stacked above it, and "you typed / clicked a link /
  scrolled" while Claude is in front (only that it happened, never which key).
- `src/brain.js`: sessions, focus (the session you last typed into wins), tool → activity mapping, outfits.
- `renderer/sprites.js`: injects accessories next to the torso rect so they inherit every body animation.
  Slots: head, face, neck, back, hand, body, companion.
- Errors go to `%APPDATA%\clawd-desktop\clawd.log`. Hook payloads are never logged.

## Dev tools

| Command | What it does |
|---|---|
| `npm test` | Headless logic tests (brain, outfits sanitiser, seasonal dates) |
| `electron tools/gallery.js out.png [outfit.json or "a.json;b.json"] [YYYY-MM-DD]` | Renders animations wearing outfits/seasonal gear to a PNG |
| `node tools/try-outfit.js "conversation opener"` | Generates one outfit and prints it |
| `tools/fake-event.sh UserPromptSubmit "" "some prompt"` | Sends a fake hook event |
| `electron tools/surface-map.js out.png` | Screenshot with every line he could stand on drawn in red |
| `tools/drop-at.sh FX FY` | Drops him with his feet at (FX, FY) and reports where he landed |
| `electron tools/test-platform.js x y w secs [y1,y2,...]` | Temporary platform window (optionally moving), for testing landing, riding and falling |
| `electron tools/eye-check.js` | Steps through every animation frame and flags one-eyed moments |
| `CLAWD_TRACE=1 npm start` | Logs every ledge-tracking scan to clawd.log |
| `CLAWD_SCALE=0.65 npm start` | Pretend the screen is smaller (Clawd's size; normally from your screen) |
| `tools/snap.sh out.png` | Snapshot of the live pet and brain state |
| `powershell -File tools/restart.ps1` | Restarts the running pet |

Design notes and the review that shaped this are in `BRAINSTORM.md`.

## Size and the taskbar

Clawd sizes himself from your screen: 150 px tall on a 1080p desktop at 100% scaling, smaller on a
laptop or at 125-150% display scaling (between 0.5x and 1.6x). **Size** in the tray menu makes him
smaller or larger than that. If the screen changes a lot (docking, a new monitor, a different scaling
setting) he restarts to resize himself.

The floor is the top of the taskbar. It's read from the taskbar window itself, so it still counts when
the taskbar auto-hides. Every 0.7 s a guard checks that no Clawd is below the floor or off the side of
his world. If one is, it puts him back and logs a `guard:` line in clawd.log.
