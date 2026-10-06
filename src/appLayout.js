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
    this.mtime = 0;
    this.timer = setInterval(() => this.poll(), 1500);
    this.poll();
  }

  poll() {
    const dir = appDataDirs()
      .map((d) => ({ d, t: fs.statSync(path.join(d, 'claude_desktop_config.json')).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0];
    if (!dir) return;
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
          return s.cliSessionId;
        }
      }
    } catch {}
    return null;
  }

  dispose() {
    clearInterval(this.timer);
  }
}

module.exports = { AppLayout };
