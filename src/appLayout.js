// Which Claude Code sessions are on screen in the Claude desktop app right now:
// the main pane plus any split-view panes. The app saves its pane layout in
// claude_desktop_config.json (preferences.epitaxyPrefs["desktop-frame.paneStore.v1"])
// using its own session ids (local_...); each of those has a file under
// claude-code-sessions/ that names the Claude Code session id (cliSessionId),
// which is what hook events carry. Pop-out windows aren't in the saved layout.
//
// The app is an MSIX package, so its data lives in the package's LocalCache
// (or in %APPDATA%\Claude for a non-store install).
const fs = require('fs');
const path = require('path');
const os = require('os');

function appDataDirs() {
  const dirs = [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  try {
    for (const n of fs.readdirSync(path.join(local, 'Packages'))) {
      if (/^Claude_/i.test(n)) dirs.push(path.join(local, 'Packages', n, 'LocalCache', 'Roaming', 'Claude'));
    }
  } catch {}
  dirs.push(path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude'));
  return dirs.filter((d) => fs.existsSync(path.join(d, 'claude_desktop_config.json')));
}

class AppLayout {
  constructor({ log, onChange } = {}) {
    this.log = log || (() => {});
    this.onChange = onChange || (() => {});
    this.visible = null; // Set of Claude Code session ids, or null when unknown
    this.info = new Map(); // cli id -> { cwd, title }
    this.cliOf = new Map(); // local id -> cli id
    this.files = new Map(); // cli id -> { file, mtime } (the app's session file)
    this.ultra = new Map(); // cli id -> the app's Ultracode switch for that session
    this.mtime = 0;
    this.timer = setInterval(() => this.poll(), 1500);
    this.poll();
  }

  poll() {
    const dir = appDataDirs()
      .map((d) => ({ d, t: fs.statSync(path.join(d, 'claude_desktop_config.json')).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!dir) return;
    this.pollSettings();
    if (dir.t === this.mtime && this.visible) return;
    this.mtime = dir.t;
    let store;
    try {
      const config = JSON.parse(fs.readFileSync(path.join(dir.d, 'claude_desktop_config.json'), 'utf8'));
      store = config.preferences.epitaxyPrefs['desktop-frame.paneStore.v1'].state;
    } catch {
      return; // mid-write or a different app version: keep what we had
    }
    const locals = [];
    if (store.lastPrimaryCodeSession && store.lastPrimaryCodeSession.id) locals.push(store.lastPrimaryCodeSession.id);
    for (const pane of (store.extraPanesByMode && store.extraPanesByMode.code) || []) {
      if (pane && pane.ref && pane.ref.id) locals.push(pane.ref.id);
    }
    const next = new Set();
    for (const id of locals) {
      const cli = this.resolve(dir.d, id);
      if (cli) next.add(cli);
    }
    const before = this.visible ? [...this.visible].sort().join() : null;
    this.visible = next;
    if ([...next].sort().join() !== before) {
      this.log(`app layout: on screen ${[...next].map((id) => `${id.slice(0, 8)} (${(this.info.get(id) || {}).title || '?'})`).join(', ') || 'no sessions'}`);
      this.onChange(next);
    }
  }

  // local_... -> Claude Code session id, from the app's session file.
  resolve(dir, localId) {
    if (this.cliOf.has(localId)) return this.cliOf.get(localId);
    const root = path.join(dir, 'claude-code-sessions');
    try {
      for (const a of fs.readdirSync(root)) {
        for (const b of fs.readdirSync(path.join(root, a))) {
          const file = path.join(root, a, b, `${localId}.json`);
          if (!fs.existsSync(file)) continue;
          const s = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!s.cliSessionId) return null;
          this.cliOf.set(localId, s.cliSessionId);
          this.info.set(s.cliSessionId, { cwd: s.cwd, title: s.title });
          this.files.set(s.cliSessionId, { file, mtime: 0 });
          this.readSettings(s.cliSessionId);
          return s.cliSessionId;
        }
      }
    } catch {}
    return null;
  }

  // Ultracode is a per-session switch the app saves in that session's file
  // (sessionSettings.ultracode). It's separate from effort: "Extra" is effort
  // xhigh without it. Re-read a session's file whenever it changes.
  pollSettings() {
    let changed = false;
    for (const id of this.files.keys()) changed = this.readSettings(id) || changed;
    if (changed) this.onChange(this.visible);
  }

  readSettings(id) {
    const entry = this.files.get(id);
    try {
      const t = fs.statSync(entry.file).mtimeMs;
      if (t === entry.mtime) return false;
      entry.mtime = t;
      const s = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
      const on = !!(s.sessionSettings && s.sessionSettings.ultracode);
      if (this.ultra.get(id) === on) return false;
      this.ultra.set(id, on);
      this.log(`app: ${(s.title || id).slice(0, 40)} ultracode ${on ? 'on' : 'off'}`);
      return true;
    } catch {
      return false; // mid-write: try again next time
    }
  }

  // true/false from the app, or undefined when we don't know this session.
  ultracode(id) {
    return this.ultra.get(id);
  }

  dispose() {
    clearInterval(this.timer);
  }
}

module.exports = { AppLayout };
