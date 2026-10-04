// Knows whether the Claude desktop app is in the foreground and where its main
// window is, via native/bin/fgwatch.exe (compiled on first run with the
// .NET Framework's built-in csc.exe, so there are no native npm modules).
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { screen } = require('electron');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'native', 'fgwatch.cs');
const EXE = path.join(ROOT, 'native', 'bin', 'fgwatch.exe');
const CSC = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function build() {
  const fresh = fs.existsSync(EXE) && fs.statSync(EXE).mtimeMs >= fs.statSync(SRC).mtimeMs;
  if (fresh) return true;
  if (!fs.existsSync(CSC)) return false;
  fs.mkdirSync(path.dirname(EXE), { recursive: true });
  execFileSync(CSC, ['-nologo', '-optimize', '-target:exe', `-out:${EXE}`, SRC], { windowsHide: true });
  return fs.existsSync(EXE);
}

class Foreground {
  // onChange({ fg, claude, above }) where fg is 'claude' | 'self' | 'tray' | 'other' | 'none',
  // claude is { x, y, width, height, min } in DIPs (null when it's not running) and
  // above is the rects of ordinary windows stacked over Claude's window.
  // onInput('key' | 'link') when you type / click a link while Claude is in front.
  constructor({ onChange, onInput, onAppCpu, log }) {
    this.onChange = onChange;
    this.onAppCpu = onAppCpu || (() => {});
    this.onInput = onInput || (() => {});
    this.log = log || (() => {});
    this.state = { fg: 'claude', claude: null, above: [], available: false };
    this.start();
  }

  start() {
    try {
      if (!build()) throw new Error('csc.exe not found');
    } catch (err) {
      this.log(`foreground watcher unavailable: ${err.message}`);
      return; // without it Clawd simply behaves as if Claude is always in front
    }
    this.child = spawn(EXE, [ROOT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    this.child.on('exit', (code) => {
      this.log(`foreground watcher exited (${code})`);
      this.state.available = false;
      if (!this.stopped) setTimeout(() => this.start(), 3000);
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (msg.error) return this.log(`foreground: ${msg.error}`);
      if (msg.input) return this.onInput(msg.input);
      if (Number.isFinite(msg.appCpu)) return this.onAppCpu(msg.appCpu);
      const toDip = (r) => (process.platform === 'win32' ? screen.screenToDipRect(null, r) : r);
      let claude = null;
      if (msg.claude) {
        claude = { ...toDip({ x: msg.claude.x, y: msg.claude.y, width: msg.claude.w, height: msg.claude.h }), min: msg.claude.min };
      }
      const above = (msg.above || []).map(([x, y, width, height]) => toDip({ x, y, width, height }));
      this.state = { fg: msg.fg, claude, above, available: true };
      this.onChange(this.state);
    });
  }

  stop() {
    this.stopped = true;
    if (this.child) this.child.kill();
  }
}

module.exports = { Foreground };
