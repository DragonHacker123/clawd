// One Clawd on screen: his transparent window, his body (physics), his ledge
// tracking, and his click-through hit testing. The primary Clawd follows the
// session you're focused on; extra Clawds appear for other things happening
// at the same time (see flock.js).
const { BrowserWindow, screen } = require('electron');
const path = require('path');
const { FEET_Y, FEET_L, FEET_R } = require('./surfaces');
const { Physics } = require('./physics');
const geometry = require('./geometry');

const S = geometry.scale; // 1 on the 1080p desk this was drawn for; smaller on small screens
const SIZE = Math.round(150 * S);
// His head top (viewBox y=6) in window px: another Clawd can stand on it.
const HEAD_Y = (6 + 25) * ((150 * S) / 45);
const HEAD_L = (2 + 15) * ((150 * S) / 45);
const HEAD_R = (13 + 15) * ((150 * S) / 45);

let nextId = 1;

class Pet {
  // ctx: shared { state, log, surfaces, world, fg, flock, onPositionSaved, primary }
  constructor(ctx, { x, y, primary = false, sessionId = null }) {
    this.ctx = ctx;
    this.id = nextId++;
    this.primary = primary;
    this.sessionId = sessionId;
    this.ready = false;
    this.pending = [];
    this.shown = true;
    this.hitbox = { x0: 50 * S, y0: 70 * S, x1: 100 * S, y1: 140 * S };
    this.interactive = false;
    this.lastAssert = 0;
    this.forceInteractiveUntil = 0;
    this.notPressingFor = 0;
    this.dragOrigin = null;
    this.unsupportedChecks = 0;
    this.trackDelay = 60;
    this.lastAnim = '';
    this.clickLog = [];
    this.closing = false;
    this.lastState = {}; // activity/outfit/posture last sent, replayed into a new window
    this.expectPress = null;
    this.coveredBySystem = false; // a system surface (e.g. a notification toast) is on top of him

    this.win = this.createWindow(x, y);
    this.physics = new Physics({
      getWindow: () => this.win,
      surfaces: ctx.surfaces,
      send: (ch, p) => this.send(ch, p),
      settings: () => ctx.state,
      world: ctx.world,
      heads: () => ctx.flock.headsExcept(this),
      onRest: () => this.onRest(),
      log: ctx.log,
    });
    this.trackLoop();
  }

  createWindow(x, y) {
    const win = new BrowserWindow({
      width: SIZE, height: SIZE, x: Math.round(x), y: Math.round(y),
      transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true, resizable: false,
      hasShadow: false, focusable: false, show: true,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
        additionalArguments: [`--clawd-scale=${S}`],
        zoomFactor: S, // the page is laid out on 150 CSS px, so zooming scales sprite and bubble together
      },
    });
    // Electron's setPosition throws on -0 (Math.round(-0.3) is -0) and NaN, which
    // crashed him at the screen's left/top edges. Sanitise every call.
    const rawSetPosition = win.setPosition.bind(win);
    win.setPosition = (px, py, ...rest) => {
      if (!Number.isFinite(px) || !Number.isFinite(py)) return;
      rawSetPosition(Math.round(px) + 0, Math.round(py) + 0, ...rest);
    };
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true);
    // Chromium remembers zoom per page across runs, so a size used before can
    // stick; set this run's size on every load.
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(S));
    win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
    win.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) this.ctx.log(`renderer ${this.id}: ${message} (${path.basename(source || '')}:${line})`);
    });
    win.webContents.on('render-process-gone', (_e, d) => this.ctx.log(`renderer ${this.id} gone: ${d.reason} exit ${d.exitCode}`));
    win.on('closed', () => {
      this.win = null;
    });
    return win;
  }

  // ---------- messages to his page ----------

  send(channel, payload) {
    if (['activity', 'outfit', 'posture'].includes(channel)) this.lastState[channel] = payload;
    if (channel === 'activity') this.physics && this.physics.setActivity(payload);
    if (channel === 'posture') this.physics && this.physics.setSitting(payload === 'sit');
    if (this.win && this.ready) this.win.webContents.send(channel, payload);
    else this.pending.push([channel, payload]);
  }

  onReady() {
    const first = !this.everReady;
    this.ready = true;
    this.everReady = true;
    for (const [channel, payload] of this.pending.splice(0)) this.win.webContents.send(channel, payload);
    if (first) setTimeout(() => this.ctx.state.gravity && this.physics.settle(), 800);
  }

  onRest() {
    if (this.primary) this.ctx.onPositionSaved(this);
  }

  // ---------- geometry ----------

  position() {
    return this.win ? this.win.getPosition() : [0, 0];
  }

  // The patch of screen he covers, which the surface finder must ignore.
  mask() {
    if (!this.win) return null;
    const [wx, wy] = this.position();
    return { x0: wx + Math.min(40 * S, this.hitbox.x0), x1: wx + Math.max(110 * S, this.hitbox.x1), y0: wy, y1: wy + 141 * S };
  }

  // The top of his head, as a ledge another Clawd can land on.
  head() {
    if (!this.win || !this.shown || this.physics.mode === 'held') return null;
    const [wx, wy] = this.position();
    return { y: wy + HEAD_Y, x0: wx + HEAD_L, x1: wx + HEAD_R, kind: 'pet', pet: this };
  }

  center() {
    const [wx] = this.position();
    return wx + (FEET_L + FEET_R) / 2;
  }

  feetY() {
    const [, wy] = this.position();
    return wy + FEET_Y;
  }

  // ---------- visibility ----------

  // "Hidden" means fully transparent and click-through, never win.hide(): a
  // transparent, non-focusable Electron window that's hidden and re-shown keeps
  // getting clicks routed to it by Windows but stops passing them to the page.
  setVisible(visible) {
    if (!this.win || visible === this.shown) return;
    this.shown = visible;
    this.win.setOpacity(visible ? 1 : 0);
    this.interactive = null;
    if (visible && this.ctx.state.gravity) this.physics.settle();
  }

  // Shown while the Claude app is open and nothing covers HIM.
  wantVisible() {
    const { state, fg } = this.ctx;
    const f = fg();
    if (this.physics.mode === 'held') return true; // never vanish from under your mouse mid-drag
    if (this.ctx.hiddenByUser()) return false;
    if (this.coveredBySystem) return false;
    if (this.primary && state.onlyWhileWorking && !this.ctx.busy()) return false;
    if (!state.onlyInClaude || !f.available) return true;
    const c = f.claude;
    if (!c || c.min || !this.win) return false;
    const [wx, wy] = this.position();
    const b = { x0: wx + this.hitbox.x0, y0: wy + this.hitbox.y0, x1: wx + this.hitbox.x1, y1: wy + this.hitbox.y1 };
    return !(f.above || []).some((r) => b.x0 < r.x + r.width && r.x < b.x1 && b.y0 < r.y + r.height && r.y < b.y1);
  }

  refreshVisibility() {
    this.setVisible(this.wantVisible());
  }

  // Ask Windows what is really on top at his body's centre. Notification toasts,
  // the Start menu and other shell surfaces sit above even always-on-top windows
  // (and don't appear in normal window lists), so clicks meant for him would land
  // on them. If one is there, he steps aside (fades out) until it's gone.
  probeCover(foreground) {
    if (!this.win || this.closing || this.physics.mode === 'held') return;
    const [wx, wy] = this.position();
    const hb = this.hitbox;
    const point = { x: wx + (hb.x0 + hb.x1) / 2, y: wy + (hb.y0 + hb.y1) / 2 };
    foreground.probe(point, (owner, cls) => {
      const covered = owner === 'other';
      if (covered !== this.coveredBySystem) {
        this.coveredBySystem = covered;
        this.noteClick(covered ? `covered by ${cls}: stepping aside` : 'no longer covered');
        this.refreshVisibility();
      }
      // Walk out from under it (toasts live in the bottom-right corner, so
      // head left unless he's already at the left edge), then reappear.
      if (covered && this.physics.mode === 'ground' && !this.physics.walk) {
        const w = this.ctx.world();
        const dir = this.center() - 320 > w.x0 + 40 * S ? -1 : 1;
        this.physics.walkTo(wx + dir * 320, 90);
      }
    });
  }

  // ---------- clicks ----------

  noteClick(what) {
    this.clickLog.push(`${new Date().toISOString().slice(11, 23)} ${what}`);
    if (this.clickLog.length > 60) this.clickLog.shift();
  }

  // Click-through everywhere except over him: poll the real cursor against the
  // hitbox his page reports. Re-asserted every second in case anything reset it.
  hitTest() {
    const win = this.win;
    if (!win) return;
    if (!this.shown) {
      if (this.interactive !== false) {
        this.interactive = false;
        win.setIgnoreMouseEvents(true);
      }
      return;
    }
    let on = this.physics.mode === 'held' || Date.now() < this.forceInteractiveUntil;
    if (!on) {
      const c = screen.getCursorScreenPoint();
      const [wx, wy] = this.position();
      const hb = this.hitbox;
      on = c.x >= wx + hb.x0 && c.x <= wx + hb.x1 && c.y >= wy + hb.y0 && c.y <= wy + hb.y1;
    }
    const now = Date.now();
    if (on !== this.interactive || now - this.lastAssert > 1000) {
      if (on !== this.interactive) this.noteClick(on ? 'cursor over him: taking clicks' : 'cursor left: click-through');
      this.interactive = on;
      this.lastAssert = now;
      win.setIgnoreMouseEvents(!on);
    }
  }

  setHitbox(box) {
    // The page reports CSS px on its 150 px canvas; the window is S times that.
    if (box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) {
      const c = (v) => Math.max(0, Math.min(SIZE, v * S));
      this.hitbox = { x0: c(box.x0), y0: c(box.y0), x1: c(box.x1), y1: c(box.y1) };
    }
  }

  // The page says every second whether a press is really down; if we think
  // he's held without one (a release got lost), let him go.
  pressState(pressing, seen) {
    if (seen && seen.anim) this.lastAnim = seen.anim;
    if (seen && (seen.move || seen.down)) this.noteClick(`page saw ${seen.move} moves, ${seen.down} presses (taking clicks: ${this.interactive})`);
    if (this.physics.mode === 'held' && !pressing) {
      this.notPressingFor += 1;
      if (this.notPressingFor >= 2) {
        this.noteClick('stuck held with no press: letting go');
        this.notPressingFor = 0;
        this.dragOrigin = null;
        this.letGo();
      }
    } else {
      this.notPressingFor = 0;
    }
  }

  // ---------- dragging ----------

  // Windows reported a left-button press at p. If it's on him while he's
  // taking clicks, his page should report it within half a second. If it
  // doesn't, his window has got into a state where presses are lost (seen after
  // long idle periods; nothing short of a new window fixes it), so swap one in.
  osPress(p) {
    if (!this.win || !this.shown || this.closing || this.interactive !== true) return;
    const [wx, wy] = this.position();
    const hb = this.hitbox;
    if (p.x < wx + hb.x0 || p.x > wx + hb.x1 || p.y < wy + hb.y0 || p.y > wy + hb.y1) return;
    clearTimeout(this.expectPress);
    this.expectPress = setTimeout(() => {
      this.expectPress = null;
      this.noteClick('press on him never reached the page: new window');
      this.ctx.log(`Clawd ${this.id}: lost a press; recreating his window`);
      this.recreate();
    }, 600);
  }

  // A fresh window in the same place, with his current outfit/activity/pose.
  recreate() {
    if (!this.win || this.closing) return;
    const old = this.win;
    const [x, y] = this.position();
    this.ready = false;
    this.pending = [];
    this.interactive = null;
    this.win = this.createWindow(x, y);
    if (!this.shown) this.win.setOpacity(0);
    for (const ch of ['outfit', 'posture', 'activity']) {
      if (ch in this.lastState) this.pending.push([ch, this.lastState[ch]]);
    }
    old.removeAllListeners('closed');
    old.destroy();
  }

  dragStart() {
    clearTimeout(this.expectPress);
    this.expectPress = null;
    this.noteClick(`press (physics was ${this.physics.mode})`);
    if (!this.win) return;
    this.dragOrigin = { win: this.position(), cursor: screen.getCursorScreenPoint() };
    this.physics.grab();
    this.ctx.flock.grabbed(this);
  }

  dragMove(dx, dy) {
    if (!this.win || !this.dragOrigin) return;
    const c = screen.getCursorScreenPoint();
    // Synthetic test input doesn't move the OS cursor; fall back to the page's delta.
    const moved = c.x !== this.dragOrigin.cursor.x || c.y !== this.dragOrigin.cursor.y;
    const x = Math.round(this.dragOrigin.win[0] + (moved ? c.x - this.dragOrigin.cursor.x : dx * S));
    const y = Math.round(this.dragOrigin.win[1] + (moved ? c.y - this.dragOrigin.cursor.y : dy * S));
    this.win.setPosition(x, y);
    this.physics.heldAt(x, y);
  }

  dragEnd() {
    this.noteClick('release');
    this.dragOrigin = null;
    this.letGo();
  }

  clampToWorld(x, y) {
    const w = this.ctx.world();
    return {
      x: Math.round(Math.min(Math.max(x, w.x0 - FEET_L + 2), w.x1 - FEET_R - 2)),
      y: Math.round(Math.min(Math.max(y, w.top - 60), w.floor.y - FEET_Y)),
    };
  }

  // Let go: with physics on he's thrown with the drag's speed and falls;
  // with it off he stays where he was dropped.
  letGo() {
    if (!this.win) return;
    const [x, y] = this.position();
    const p = this.clampToWorld(x, y);
    this.win.setPosition(p.x, p.y);
    this.unsupportedChecks = 0;
    if (this.ctx.state.gravity) {
      this.physics.release();
    } else {
      this.physics.mode = 'ground';
      this.physics.ground = null;
      this.onRest();
    }
  }

  // Keep him inside Claude's window after it opens, restores or resizes.
  rehome() {
    if (!this.win || this.physics.mode === 'held') return;
    const [x, y] = this.position();
    const p = this.clampToWorld(x, y);
    if (p.x !== x || p.y !== y) {
      this.win.setPosition(p.x, p.y);
      this.physics.ground = null;
    }
    if (this.ctx.state.gravity) this.physics.settle();
  }

  // Safety net: he must never be below the floor (the taskbar top / Claude's
  // bottom edge) or off the side of his world, whatever went wrong (rounding at
  // odd display scaling, a changed taskbar, a lost scan). Pull him back and let
  // him land again.
  guardFloor() {
    if (!this.win || this.win.isDestroyed() || this.closing || !this.ctx.state.gravity) return;
    const ph = this.physics;
    if (ph.mode === 'held') return;
    const w = this.ctx.world();
    const [x, y] = this.position();
    const feet = y + FEET_Y;
    const slack = ph.mode === 'air' ? 60 * S : 3;
    const c = x + (FEET_L + FEET_R) / 2;
    const outside = feet > w.floor.y + slack || c < w.x0 - 20 || c > w.x1 + 20 || y > w.floor.y;
    if (!outside) return;
    const now = Date.now();
    if (now - (this.lastGuardLog || 0) > 5000) {
      this.lastGuardLog = now;
      this.ctx.log(`guard: Clawd ${this.id} was out of bounds (pos ${x},${y} feet ${feet.toFixed(0)} floor ${w.floor.y} world ${w.x0}-${w.x1} mode ${ph.mode}); pulling him back`);
    }
    const p = this.clampToWorld(x, y);
    this.win.setPosition(p.x, Math.min(p.y, Math.round(w.floor.y - FEET_Y)));
    ph.walk = null;
    ph.ground = null;
    ph.mode = 'ground';
    ph.vx = ph.vy = 0;
    ph.loop(false);
    ph.sync();
    ph.settle();
  }

  // ---------- following the ledge he stands on ----------

  // About three times a second while he stands on a ledge (backing off to
  // ~1.5 s when nothing moves): find it again and ride it. Standing on another
  // Clawd is handled by the flock instead.
  async trackTick() {
    const { surfaces, state } = this.ctx;
    const ph = this.physics;
    if (!this.win || !state.gravity || !this.shown || ph.mode !== 'ground' || surfaces.busy) return;
    const g = ph.ground;
    if (!g || g.kind === 'floor' || g.kind === 'taskbar' || g.kind === 'pet') return;
    surfaces.busy = true;
    try {
      const { here, other, ok } = await surfaces.track(this.win.getBounds(), ph.ground);
      if (!ok || ph.mode !== 'ground') return;
      if (here) {
        this.unsupportedChecks = 0;
        return ph.rideTo(here);
      }
      // One glitchy frame mustn't make him jump: act only when his ledge is
      // missing on two looks running; then follow it, or fall.
      this.unsupportedChecks += 1;
      this.trackDelay = 60;
      if (this.unsupportedChecks < 2) return;
      if (other) {
        this.unsupportedChecks = 0;
        return ph.rideTo(other);
      }
      if (this.unsupportedChecks >= 3) {
        this.unsupportedChecks = 0;
        ph.fallFromRest();
      }
    } finally {
      surfaces.busy = false;
    }
  }

  trackLoop() {
    const loop = async () => {
      if (this.closing) return;
      try {
        const moved = await this.trackTick();
        this.trackDelay = moved ? 60 : Math.min(1200, this.trackDelay * 1.6);
      } catch (err) {
        this.ctx.log(`track loop ${this.id}: ${err.stack || err}`);
      } finally {
        if (!this.closing) setTimeout(loop, this.trackDelay);
      }
    };
    loop();
  }

  // ---------- going away ----------

  close() {
    this.closing = true;
    this.physics.dispose();
    if (this.win) this.win.close();
  }
}

module.exports = { Pet, SIZE, HEAD_Y };
