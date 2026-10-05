// Clawd's body in the world: gravity, throwing, landing, teetering on edges,
// slipping off, and wandering along whatever he's standing on.
//
// Positions are the pet window's top-left in screen DIPs; his feet are FEET_Y
// below that and span FEET_L..FEET_R. "Lines" are surfaces from surfaces.js:
// { y, x0, x1 } — his feet rest on y.
const { FEET_Y, FEET_L, FEET_R } = require('./surfaces');
const geometry = require('./geometry');

const S = geometry.scale;
const SIZE = Math.round(150 * S);

const G = 2600; // px/s²
const MAX_FALL = 2600; // px/s terminal velocity
const MAX_THROW = 2200; // px/s
const AIR_DRAG = 0.55; // fraction of horizontal speed kept per second in the air
const WALK_SPEED = 26 * S; // px/s
const SCRAMBLE_SPEED = 55 * S; // px/s, backing away from an edge
const HARD_LANDING = 1000; // px/s impact: lands angry (≈ a 190 px fall)
const LEDGE_GRAB = 20; // px: a line this far above his feet at release catches him
const TEETER_ZONE = 8 * S; // px: centre this close to an edge = wobbling
const TICK_MS = 16;
const CENTER = (FEET_L + FEET_R) / 2;
const HEAD_TOP = 75 * S; // px from the window top to the top of his head
const HALF_FEET = (FEET_R - FEET_L) / 2;

// Hyper mode (Claude Code on ultracode): he runs, hops and climbs walls.
const RUN_SPEED = 150 * S; // px/s
const CLIMB_SPEED = 120 * S; // px/s up a wall
const HYPER_TICK_MS = 600; // how often he picks his next stunt
// Climbing, he's turned 90° with his feet on the wall: how far the window's
// left edge sits from the wall (left wall), or from the wall minus the window
// (right wall), so his feet touch it.
const CLIMB_INSET = SIZE - FEET_Y;
const CLIMB_BODY = 25 * S; // half his width incl. arms: his side rests this far above the floor as he starts up

class Physics {
  constructor({ getWindow, surfaces, send, settings, world, onRest, log, heads, isShown }) {
    this.isShown = isShown || (() => true);
    this.heads = heads || (() => []); // other Clawds' heads: ledges he can land on
    this.getWindow = getWindow;
    this.surfaces = surfaces;
    this.send = send;
    this.settings = settings;
    this.world = world; // () => { x0, x1, floor: line } where he's allowed to be
    this.onRest = onRest;
    this.log = log || (() => {});
    this.mode = 'ground'; // ground | air | held | teeter
    this.x = 0;
    this.y = 0;
    this.vx = 0;
    this.vy = 0;
    this.ground = null; // the line he stands on
    this.lines = null; // collision lines while airborne (null until scanned)
    this.walk = null; // { dir, targetX, speed }
    this.teeterUntil = 0;
    this.teeterDir = 0;
    this.cause = null; // 'slip' | 'drop' | 'gone'
    this.samples = []; // drag positions for throw velocity
    this.activity = null;
    this.sitting = false;
    this.lastStimulus = Date.now();
    this.timer = null;
    this.last = 0;
    this.wanderTimer = setInterval(() => this.maybeWander(), 2500);
    this.hyper = false;
    this.facing = 1; // 1 right, -1 left: the way he last walked
    this.flipUntil = 0;
    this.climb = null; // { side: -1 left wall | 1 right wall, topY }
    this.hyperTimer = setInterval(() => this.hyperTick(), HYPER_TICK_MS);
  }

  dispose() {
    clearInterval(this.wanderTimer);
    clearInterval(this.hyperTimer);
    this.loop(false);
  }

  // ---------- helpers ----------

  sync() {
    const win = this.getWindow();
    if (!win) return false;
    const [x, y] = win.getPosition();
    this.x = x;
    this.y = y;
    return true;
  }

  place() {
    const win = this.getWindow();
    if (!win) return;
    if (!Number.isFinite(this.x) || !Number.isFinite(this.y)) {
      // Never hand Electron a NaN (it throws); recover from the real window position.
      this.log(`bad position ${this.x},${this.y} mode=${this.mode} walk=${JSON.stringify(this.walk)} ground=${JSON.stringify(this.ground)}`);
      this.walk = null;
      this.sync();
      return;
    }
    win.setPosition(Math.round(this.x), Math.round(this.y));
  }

  center() {
    return this.x + CENTER;
  }

  feetY() {
    return this.y + FEET_Y;
  }

  bounds() {
    return { x: Math.round(this.x), y: Math.round(this.y), width: SIZE, height: SIZE };
  }

  motion(mode, extra = {}) {
    if (mode === 'walk' && extra.dir) this.facing = extra.dir;
    this.send('motion', { mode, ...extra });
  }

  stimulus() {
    this.lastStimulus = Date.now();
  }

  loop(on) {
    if (on && !this.timer) {
      this.last = Date.now();
      this.timer = setInterval(() => this.step(), TICK_MS);
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------- being dragged and thrown ----------

  grab() {
    if (this.mode === 'climb') this.motion('held'); // turn him upright again
    this.mode = 'held';
    this.climb = null;
    this.walk = null;
    this.loop(false);
    this.samples = [];
    this.stimulus();
  }

  heldAt(x, y) {
    const t = Date.now();
    this.samples.push({ t, x, y });
    this.samples = this.samples.filter((s) => t - s.t < 120);
  }

  release() {
    if (!this.sync()) return;
    const s = this.samples;
    let vx = 0;
    let vy = 0;
    if (s.length >= 2) {
      const a = s[0];
      const b = s[s.length - 1];
      const dt = Math.max(0.016, (b.t - a.t) / 1000);
      vx = (b.x - a.x) / dt;
      vy = (b.y - a.y) / dt;
    }
    const clamp = (v) => Math.max(-MAX_THROW, Math.min(MAX_THROW, v));
    this.launch(clamp(vx), clamp(vy), 'drop', { ledgeGrab: true });
  }

  // ---------- airborne ----------

  // Start flying from where he is now. Collision lines arrive asynchronously
  // (a screen capture); until then he flies and crossings are checked once
  // they're in, from the height where the flight started.
  launch(vx, vy, cause, { ledgeGrab = false, ignoreY = null, flipMs = 0 } = {}) {
    this.ignoreY = ignoreY;
    this.mode = 'air';
    this.climb = null;
    this.walk = null;
    this.vx = vx;
    this.vy = vy;
    this.cause = cause;
    this.lines = null;
    this.checkedFeetY = this.feetY();
    this.startFeetY = this.feetY();
    // A flip turns him the way he's travelling (backwards, for a backflip).
    const flip = flipMs ? { deg: vx < 0 ? -360 : 360, ms: Math.round(flipMs) } : null;
    this.flipUntil = flip ? Date.now() + flip.ms : 0;
    this.motion('air', { hop: cause === 'hop', flip, face: this.facing });
    this.loop(true);
    const w = this.world();
    // Jumping up: look for ledges as high as he'll get, so he can land on them.
    const rise = vy < 0 ? (vy * vy) / (2 * G) + 10 : 0;
    this.surfaces.scanWide(this.bounds(), w.floor, rise).then((lines) => {
      if (this.mode !== 'air') return;
      this.lines = lines;
      if (ledgeGrab) {
        // Dropped just below a ledge: he grabs it and pulls himself up.
        const c = this.center();
        const ledge = lines
          .filter((l) => l.y < this.startFeetY && this.startFeetY - l.y <= LEDGE_GRAB && c >= l.x0 && c <= l.x1)
          .sort((a, b) => b.y - a.y)[0];
        if (ledge) return this.land(ledge, 0);
      }
    }, (err) => {
      this.log(`scan failed: ${err.message}`);
      this.lines = [this.world().floor];
    });
  }

  step() {
    try {
      this.stepInner();
    } catch (err) {
      this.log(`physics step failed: ${err.stack || err}`);
      this.walk = null;
      this.mode = this.mode === 'held' ? 'held' : 'ground';
      this.loop(false);
      this.sync();
    }
  }

  stepInner() {
    const now = Date.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.mode === 'air') this.airStep(dt);
    else if (this.mode === 'climb') this.climbStep(dt);
    else if (this.mode === 'teeter') this.teeterStep();
    else if (this.mode === 'ground' && this.walk) this.walkStep(dt);
    else this.loop(false);
  }

  airStep(dt) {
    const w = this.world();
    this.vy = Math.min(MAX_FALL, this.vy + G * dt);
    this.vx *= Math.pow(AIR_DRAG, dt);
    const prevFeet = this.feetY();
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // Walls: the sides of his world (screen or Claude's window). Bounce softly.
    const minX = w.x0 - FEET_L + 2;
    const maxX = w.x1 - FEET_R - 2;
    if (this.x < minX || this.x > maxX) {
      this.x = Math.max(minX, Math.min(maxX, this.x));
      this.vx = -this.vx * 0.35;
    }
    // Ceiling: let the empty top of the window poke out, not his head.
    if (this.y < w.top - 60 * S) {
      this.y = w.top - 60 * S;
      this.vy = Math.max(0, this.vy);
    }

    const feet = this.feetY();
    if (this.vy > 0) {
      // Never fall through the floor, even before the scan arrives.
      const floor = w.floor;
      // Screen ledges (scanned at launch) plus other Clawds' heads (live).
      const candidates = [...(this.lines ? this.lines : [floor]), ...this.heads()];
      const from = Math.min(this.checkedFeetY, prevFeet);
      const c = this.center();
      // Skip the ledge he was just knocked off (it's moving up past him).
      const hit = candidates
        .filter((l) => this.ignoreY === null || Math.abs(l.y - this.ignoreY) > 12 || l.y > this.ignoreY + 12)
        .filter((l) => l.y >= from - 0.5 && l.y <= feet && (c >= l.x0 || l.hiddenLeft) && (c <= l.x1 || l.hiddenRight))
        .sort((a, b) => a.y - b.y)[0];
      if (this.lines) this.checkedFeetY = feet;
      if (hit) return this.land(hit, this.vy);
      if (feet > floor.y) return this.land(floor, this.vy);
    } else if (this.lines) {
      this.checkedFeetY = feet;
    }
    this.place();
  }

  land(line, impact) {
    this.y = line.y - FEET_Y;
    this.vx = 0;
    this.vy = 0;
    this.ground = line;
    this.mode = 'ground';
    this.loop(false);
    this.place();
    // Stunts never hurt: he meant to do that.
    const angry = this.cause !== 'hop' && (impact >= HARD_LANDING || (this.cause === 'slip' && impact > 300));
    this.motion('ground', { impact: Math.round(impact), angry });
    this.cause = null;
    this.stimulus();
    this.checkFooting();
    this.onRest();
  }

  // ---------- edges ----------

  // On landing (and after walking), see how much of him is over the edge.
  checkFooting() {
    const line = this.ground;
    if (!line || line.kind === 'taskbar' || line.kind === 'floor') return;
    const c = this.center();
    const offLeft = c < line.x0;
    const offRight = c > line.x1;
    // Where the edge is hidden behind him he can't be sure either: wobble.
    const unsure = (offLeft && line.hiddenLeft) || (offRight && line.hiddenRight);
    if ((offLeft || offRight) && !unsure) {
      // Centre of mass over thin air: he slips off.
      return this.slip(offLeft ? -1 : 1);
    }
    const room = Math.min(c - line.x0, line.x1 - c);
    if (unsure || room < TEETER_ZONE) {
      this.mode = 'teeter';
      this.teeterDir = offLeft || (!offRight && c - line.x0 < line.x1 - c) ? -1 : 1;
      this.teeterUntil = Date.now() + 1500;
      this.motion('teeter', { dir: this.teeterDir });
      this.loop(true);
    }
  }

  teeterStep() {
    if (Date.now() < this.teeterUntil) return;
    if (Math.random() < 0.5) {
      this.slip(this.teeterDir);
    } else {
      // Phew: scramble back to safety.
      this.mode = 'ground';
      this.motion('ground');
      const target = this.x - this.teeterDir * (HALF_FEET + 10);
      this.walk = { dir: -this.teeterDir, targetX: target, speed: SCRAMBLE_SPEED };
      this.motion('walk', { dir: -this.teeterDir });
    }
  }

  slip(dir) {
    const line = this.ground;
    // Tip his centre just past the edge so he can't land straight back on it.
    const c = this.center();
    if (line) {
      const edge = dir < 0 ? Math.min(c, line.x0) - 3 : Math.max(c, line.x1) + 3;
      this.x = edge - CENTER;
      this.place();
    }
    this.ground = null;
    this.launch(dir * 60, 0, 'slip', { ignoreY: line ? line.y : null });
  }

  // ---------- walking ----------

  canWander() {
    const s = this.settings();
    return !this.hyper && this.mode === 'ground' && !this.walk && s.gravity && !this.sitting
      && !(this.ground && this.ground.kind === 'pet') // standing on a friend's head: stay put
      && (this.activity === null || this.activity === 'chatting' || this.activity === 'fetching' || this.activity === 'sweeping')
      && Date.now() - this.lastStimulus < 18 * 1000; // not while he's dozing/asleep
  }

  async maybeWander() {
    if (!this.canWander() || !this.ground || !this.sync()) return;
    const chance = this.activity ? 0.6 : 0.3;
    if (Math.random() > chance) return;
    const line = this.ground;
    // How far he may go: keep both feet on the line (and inside his world).
    const w = this.world();
    const lo = Math.max(line.x0, w.x0) + HALF_FEET + 4 - CENTER;
    const hi = Math.min(line.x1, w.x1) - HALF_FEET - 4 - CENTER;
    if (hi - lo < 24) return;
    let dir = Math.random() < 0.5 ? -1 : 1;
    if (this.x - lo < 30) dir = 1;
    if (hi - this.x < 30) dir = -1;
    const dist = 20 + Math.random() * 110;
    const targetX = Math.max(lo, Math.min(hi, this.x + dir * dist));
    if (Math.abs(targetX - this.x) < 8) return;
    this.walk = { dir, targetX, speed: WALK_SPEED };
    this.motion('walk', { dir });
    this.loop(true);
  }

  walkStep(dt) {
    const wk = this.walk;
    this.x += wk.dir * wk.speed * dt;
    if ((wk.dir > 0 && this.x >= wk.targetX) || (wk.dir < 0 && this.x <= wk.targetX)) {
      this.x = wk.targetX;
      this.walk = null;
      this.place();
      if (wk.climb) return this.startClimb(wk.climb);
      this.motion('ground');
      this.onRest();
      return;
    }
    this.place();
  }

  // Walk toward a window x (for joining friends), staying on his ledge.
  walkTo(targetX, speed = WALK_SPEED) {
    if (this.mode !== 'ground' || this.walk || !this.ground || this.sitting || !this.sync()) return false;
    if (this.ground.kind === 'pet') return false;
    const line = this.ground;
    const w = this.world();
    const lo = Math.max(line.x0, w.x0) + HALF_FEET + 4 - CENTER;
    const hi = Math.min(line.x1, w.x1) - HALF_FEET - 4 - CENTER;
    const x = Math.max(lo, Math.min(hi, targetX));
    if (!Number.isFinite(x) || Math.abs(x - this.x) < 6) return false;
    const dir = x > this.x ? 1 : -1;
    this.walk = { dir, targetX: x, speed };
    this.motion('walk', { dir });
    this.loop(true);
    return true;
  }

  stopWalking() {
    if (!this.walk) return;
    this.walk = null;
    this.motion('ground');
    this.onRest();
  }

  // ---------- hyper mode (ultracode) ----------

  // Ultracode: he never sits still. Runs back and forth, hops (onto higher
  // ledges if there are any), and dashes at the side walls to run up them.
  setHyper(on) {
    on = !!on;
    if (on === this.hyper) return;
    this.hyper = on;
    if (on) {
      this.stimulus();
      return;
    }
    if (this.mode === 'climb') this.leap();
    else if (this.walk && this.walk.speed === RUN_SPEED) this.stopWalking();
  }

  hyperTick() {
    if (!this.hyper || !this.settings().gravity || this.mode !== 'ground' || this.walk || !this.ground) return;
    if (!this.isShown()) return; // nobody to show off to (and each hop costs a screen capture)
    // Asleep (nothing going on and you've been away): let him sleep.
    if (this.activity === null && Date.now() - this.lastStimulus > 18 * 1000) return;
    if (!this.sync()) return;
    if (this.ground.kind === 'pet') return this.hop(); // off his friend's head
    const line = this.ground;
    const w = this.world();
    const lo = Math.max(line.x0, w.x0) + HALF_FEET + 4 - CENTER;
    const hi = Math.min(line.x1, w.x1) - HALF_FEET - 4 - CENTER;
    const wallL = line.x0 <= w.x0 + 2;
    const wallR = line.x1 >= w.x1 - 2;
    const roll = Math.random();
    if (roll < 0.12) return; // a split-second breather
    if (roll < 0.3) return this.backflip();
    if (roll < 0.45 && (wallL || wallR)) {
      const side = wallL && wallR ? (this.center() < (w.x0 + w.x1) / 2 ? -1 : 1) : wallL ? -1 : 1;
      return this.runTo(side < 0 ? lo : hi, side);
    }
    if (roll < 0.65 || hi - lo < 40 * S) return this.hop();
    let target = lo + Math.random() * (hi - lo);
    if (Math.abs(target - this.x) < 80 * S) target = this.x + (target >= this.x ? 1 : -1) * 160 * S;
    this.runTo(Math.max(lo, Math.min(hi, target)), 0);
  }

  // Sprint along his ledge; with climbSide set, run up that wall on arrival.
  runTo(targetX, climbSide = 0) {
    if (!Number.isFinite(targetX)) return;
    if (Math.abs(targetX - this.x) < 4) {
      if (climbSide) this.startClimb(climbSide);
      return;
    }
    const dir = targetX > this.x ? 1 : -1;
    this.walk = { dir, targetX, speed: RUN_SPEED, climb: climbSide };
    this.motion('walk', { dir, run: true });
    this.loop(true);
  }

  hop() {
    const dir = Math.random() < 0.5 ? -1 : 1;
    const vx = dir * (100 + Math.random() * 280) * S;
    const vy = -(650 + Math.random() * 500) * Math.sqrt(S); // 80-230 px high at full size
    this.ground = null;
    this.walk = null;
    this.launch(vx, vy, 'hop');
  }

  // Straight up, a full turn backwards, and down about where he started.
  backflip() {
    const f = this.facing || 1;
    const vy = -(1000 + Math.random() * 200) * Math.sqrt(S); // 190-280 px high at full size
    const vx = -f * (40 + Math.random() * 60) * S; // drifting back a little
    this.ground = null;
    this.walk = null;
    this.launch(vx, vy, 'hop', { flipMs: ((2 * -vy) / G) * 1000 * 0.85 });
  }

  // Turned 90°, feet on the wall, running up it.
  startClimb(side) {
    const w = this.world();
    const floorY = this.ground ? this.ground.y : w.floor.y;
    this.walk = null;
    this.ground = null;
    this.mode = 'climb';
    this.x = side < 0 ? w.x0 - CLIMB_INSET : w.x1 - FEET_Y;
    this.y = floorY - SIZE / 2 - CLIMB_BODY;
    const height = (180 + Math.random() * 420) * S;
    this.climb = { side, topY: Math.max(w.top + 20 * S, this.y - height) };
    this.motion('climb', { side });
    this.loop(true);
    this.place();
  }

  climbStep(dt) {
    if (!this.climb) return this.leap();
    this.y -= CLIMB_SPEED * dt;
    if (this.y <= this.climb.topY) return this.leap();
    this.place();
  }

  // Kick off the wall and fly back into the room.
  leap() {
    const side = this.climb ? this.climb.side : (this.center() < (this.world().x0 + this.world().x1) / 2 ? -1 : 1);
    this.climb = null;
    const w = this.world();
    this.x = side < 0 ? w.x0 - FEET_L + 2 : w.x1 - FEET_R - 2;
    this.place();
    const vx = -side * (300 + Math.random() * 350) * S;
    const vy = -(250 + Math.random() * 350) * Math.sqrt(S);
    // Half the time it's a wall-flip: facing the wall, over backwards and away.
    // Spin for about as long as the fall to the floor takes.
    let flipMs = 0;
    if (Math.random() < 0.5) {
      this.facing = side;
      const h = Math.max(0, w.floor.y - this.feetY());
      flipMs = Math.min(1200, Math.max(450, ((-vy + Math.sqrt(vy * vy + 2 * G * h)) / G) * 1000 * 0.85));
    }
    this.launch(vx, vy, 'hop', { flipMs });
  }

  // ---------- outside events ----------

  setActivity(activity) {
    this.activity = activity;
    this.stimulus();
    if (this.walk && !this.hyper && !(activity === null || activity === 'chatting' || activity === 'fetching' || activity === 'sweeping')) this.stopWalking();
  }

  setSitting(sitting) {
    this.sitting = sitting && !this.hyper;
    if (sitting) this.stopWalking();
  }

  // Look for something under him; land on it or start falling.
  async settle() {
    if (this.mode !== 'ground' || !this.sync()) return;
    const w = this.world();
    const lines = await this.surfaces.scanWide(this.bounds(), w.floor);
    if (this.mode !== 'ground') return;
    const feet = this.feetY();
    const c = this.center();
    const under = lines.find((l) => Math.abs(l.y - feet) <= 2 && c >= l.x0 && c <= l.x1);
    if (under) {
      this.ground = under;
      if (Math.abs(under.y - feet) > 0.5) {
        this.y = under.y - FEET_Y;
        this.place();
      }
      return this.checkFooting();
    }
    this.launch(0, 0, 'gone');
  }

  // The thing under him vanished (window closed, content scrolled).
  fallFromRest() {
    if (this.mode !== 'ground' || !this.sync()) return;
    this.launch(0, 0, 'gone');
  }

  // The ledge he's on moved (scrolling, a growing text box): stay on it.
  // Unknown ends (beyond what was scanned) keep their previous extent.
  rideTo(line) {
    if (this.mode !== 'ground') return;
    if (!this.walk && !this.sync()) return;
    const old = this.ground || line;
    // Ends beyond the scanned strip or hidden behind him: keep what we knew.
    const keepLeft = line.openLeft || line.hiddenLeft;
    const keepRight = line.openRight || line.hiddenRight;
    this.ground = {
      y: line.y,
      x0: keepLeft ? Math.min(old.x0, line.x0) : line.x0,
      x1: keepRight ? Math.max(old.x1, line.x1) : line.x1,
      hiddenLeft: keepLeft && old.hiddenLeft !== false && line.hiddenLeft,
      hiddenRight: keepRight && old.hiddenRight !== false && line.hiddenRight,
      openLeft: line.openLeft,
      openRight: line.openRight,
      sig: line.sig,
      kind: 'edge',
    };
    const y = line.y - FEET_Y;
    // Carried up into the top of his world (the ledge is scrolling off the
    // top): he gets knocked off and falls to whatever is below.
    if (y + HEAD_TOP < this.world().top) {
      this.ground = null;
      this.launch((Math.random() < 0.5 ? -1 : 1) * 70, 120, 'slip', { ignoreY: line.y });
      return;
    }
    if (Math.abs(y - this.y) >= 0.5) {
      this.y = y;
      this.place();
      if (!this.walk) this.onRest();
      return true;
    }
    return false;
  }

  // His world moved (e.g. Claude's window was dragged): ride along.
  shift(dx, dy) {
    if (!this.sync()) return;
    this.x += dx;
    this.y += dy;
    if (this.ground) this.ground = { ...this.ground, y: this.ground.y + dy, x0: this.ground.x0 + dx, x1: this.ground.x1 + dx };
    this.place();
  }
}

module.exports = { Physics };
