#!/usr/bin/env node
// Adds (or removes, with --uninstall) Clawd's http hooks in ~/.claude/settings.json.
// Merges into existing hook arrays without touching other hooks, backs the file
// up first, and is safe to run repeatedly.
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 47321;
const URL = `http://127.0.0.1:${PORT}/event`;
const EVENTS = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopFailure', 'SessionEnd'];
const uninstall = process.argv.includes('--uninstall');

const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const tokenPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'clawd-desktop', 'token.txt');

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw);
fs.writeFileSync(`${settingsPath}.bak-clawd`, raw);

const isClawd = (h) => h && h.type === 'http' && typeof h.url === 'string' && h.url.startsWith(`http://127.0.0.1:${PORT}/`);

settings.hooks = settings.hooks || {};
// Strip any previous Clawd hooks (and groups left empty by that).
for (const [event, groups] of Object.entries(settings.hooks)) {
  settings.hooks[event] = groups
    .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isClawd(h)) }))
    .filter((g) => g.hooks.length);
  if (!settings.hooks[event].length) delete settings.hooks[event];
}

if (!uninstall) {
  if (!fs.existsSync(tokenPath)) {
    console.error('Start Clawd once first (it creates its token), then run this again.');
    process.exit(1);
  }
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  // timeout 2s: if Clawd ever hangs, Claude only waits 2s instead of the 600s default.
  const hook = { type: 'http', url: URL, timeout: 2, headers: { 'X-Clawd-Token': token } };
  for (const event of EVENTS) {
    settings.hooks[event] = settings.hooks[event] || [];
    settings.hooks[event].push({ matcher: '', hooks: [hook] });
  }
}
if (!Object.keys(settings.hooks).length) delete settings.hooks;

fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
console.log(uninstall ? 'Clawd hooks removed.' : `Clawd hooks installed for: ${EVENTS.join(', ')}`);
console.log(`Backup: ${settingsPath}.bak-clawd`);
