const { app, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./src/server');
const { Brain } = require('./src/brain');
const { OutfitMaker } = require('./src/outfits');
const { Surfaces, FEET_Y } = require('./src/surfaces');
const { Foreground } = require('./src/foreground');
const { Pet, SIZE } = require('./src/pet');
const { Flock } = require('./src/flock');

let tray;
let brain;
let surfaces;
let flock;
let foreground;
let fgState = { fg: 'claude', claude: null, above: [], available: false };
let hiddenByUser = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.commandLine.appendSwitch('disable-background-timer-throttling');

// ---------- persisted settings ----------

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const defaults = { x: null, y: null, outfits: true, onlyWhileWorking: false, openAtLogin: true, gravity: true, onlyInClaude: true, ignoreCwds: [] };
let state = { ...defaults };

function loadState() {
  try {
    state = { ...defaults, ...JSON.parse(fs.readFileSync(statePath(), 'utf8')) };
  } catch {
    state = { ...defaults };
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(statePath()), { recursive: true });
    fs.writeFileSync(statePath(), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('could not save state', err);
  }
}

// Errors go to clawd.log in the app's data folder (handy when he misbehaves).
function log(message) {
  try {
    const file = path.join(app.getPath('userData'), 'clawd.log');
    if (fs.existsSync(file) && fs.statSync(file).size > 512 * 1024) fs.renameSync(file, file + '.old');
    fs.appendFileSync(file, `${new Date().toISOString()} ${message}\n`);
  } catch {}
}
console.error = (...args) => log(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
// A bug must never pop up an error dialog over your work; log it and carry on.
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack || err}`));
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err && err.stack ? err.stack : err}`));

// ---------- the world they live in ----------

// Standing on the taskbar, bottom-left.
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + 20, y: Math.round(workArea.y + workArea.height - FEET_Y) };
}

function clampToScreen(x, y) {
  const { workArea, bounds } = screen.getDisplayMatching({ x, y, width: SIZE, height: SIZE });
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - SIZE),
    y: Math.min(Math.max(y, bounds.y - 60), Math.round(workArea.y + workArea.height - FEET_Y)),
  };
}

// Where Clawd may be: inside the Claude app's window when "only in Claude" is
// on and the app is open (its bottom edge is the floor), otherwise the work
// area of the primary Clawd's display (the taskbar top is the floor).
function world() {
  const c = fgState.claude;
  if (state.onlyInClaude && c && !c.min) {
    const wa = screen.getDisplayMatching(c).workArea;
    const floorY = Math.min(c.y + c.height, wa.y + wa.height);
    return { x0: c.x, x1: c.x + c.width, top: c.y, floor: { y: floorY, x0: c.x, x1: c.x + c.width, kind: 'floor' } };
  }
  const lead = flock && flock.primary;
  const b = lead && lead.win ? lead.win.getBounds() : { x: 0, y: 0, width: SIZE, height: SIZE };
  const wa = screen.getDisplayMatching(b).workArea;
  return { x0: wa.x, x1: wa.x + wa.width, top: wa.y, floor: { y: wa.y + wa.height, x0: wa.x, x1: wa.x + wa.width, kind: 'taskbar' } };
}

function refreshVisibility() {
  if (flock) for (const p of flock.pets) if (!p.closing) p.refreshVisibility();
}

function onForeground(next) {
  const prev = fgState.claude;
  fgState = next;
  const c = next.claude;
  if (state.onlyInClaude && flock && c && !c.min) {
    for (const p of flock.pets) {
      if (!prev || prev.min || prev.width !== c.width || prev.height !== c.height) p.rehome();
      else if (prev.x !== c.x || prev.y !== c.y) p.physics.shift(c.x - prev.x, c.y - prev.y); // ride along with the window
    }
  }
  refreshVisibility();
}

// ---------- tray / context menu ----------

function applyLoginItem() {
  // When run from source (`npm start`), point the login item at this app folder,
  // otherwise Windows launches bare electron.exe at login. Quoted because the
  // Run key entry isn't quoted for us and the path may contain spaces.
  const base = { openAtLogin: state.openAtLogin, name: 'ClaudePet' };
  app.setLoginItemSettings(app.isPackaged
    ? base
    : { ...base, path: `"${process.execPath}"`, args: [`"${app.getAppPath()}"`] });
}

function buildMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show Clawd', click: () => { hiddenByUser = false; refreshVisibility(); } },
    { label: 'Hide Clawd', click: () => { hiddenByUser = true; refreshVisibility(); } },
    {
      label: 'Reset position',
      click: () => {
        const lead = flock.primary;
        const p = defaultPosition();
        if (lead && lead.win) lead.win.setPosition(p.x, p.y);
        if (lead) lead.rehome();
      },
    },
    { type: 'separator' },
    {
      label: 'Only show while Claude is working',
      type: 'checkbox',
      checked: state.onlyWhileWorking,
      click: (item) => {
        state.onlyWhileWorking = item.checked;
        saveState();
        refreshVisibility();
      },
    },
    {
      label: 'Only show over the Claude app',
      type: 'checkbox',
      checked: state.onlyInClaude,
      click: (item) => {
        state.onlyInClaude = item.checked;
        saveState();
        refreshVisibility();
        for (const p of flock.pets) p.rehome();
      },
    },
    {
      label: 'Physics (stand, walk, fall)',
      type: 'checkbox',
      checked: state.gravity,
      click: (item) => {
        state.gravity = item.checked;
        saveState();
        for (const p of flock.pets) {
          if (state.gravity) p.physics.settle();
          else p.physics.stopWalking();
        }
      },
    },
    {
      label: 'Topic outfits (generated live)',
      type: 'checkbox',
      checked: state.outfits,
      click: (item) => {
        state.outfits = item.checked;
        saveState();
        if (!state.outfits) flock.broadcast('outfit', null);
      },
    },
    { label: 'Take off current outfit', click: () => brain.clearOutfit() },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: state.openAtLogin,
      click: (item) => {
        state.openAtLogin = item.checked;
        saveState();
        applyLoginItem();
      },
    },
    { type: 'separator' },
    { label: 'Open outfits folder', click: () => shell.openPath(path.join(app.getPath('userData'), 'outfits')) },
    { label: 'Show chat extension file', click: () => shell.showItemInFolder(path.join(__dirname, 'dist', 'clawd.mcpb')) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.ico'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Clawd');
  tray.on('click', () => {
    hiddenByUser = !hiddenByUser;
    refreshVisibility();
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// ---------- IPC from each Clawd's page (routed to that Clawd) ----------

function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => {
    const pet = flock && flock.byWebContents(e.sender.id);
    if (pet) fn(pet, ...args);
  });
}

on('renderer-ready', (pet) => pet.onReady());
on('hitbox', (pet, box) => pet.setHitbox(box));
on('press-state', (pet, pressing, seen) => pet.pressState(pressing, seen));
on('drag-start', (pet) => pet.dragStart());
on('drag-move', (pet, { dx, dy }) => pet.dragMove(dx, dy));
on('drag-end', (pet) => pet.dragEnd());
on('show-menu', (pet) => pet.win && buildMenu().popup({ window: pet.win }));

// ---------- the Claude app's CPU: a backup "chat is working" signal ----------

// Sustained activity in the Claude app (e.g. chat streaming a long answer or
// building an artifact) keeps the Clawds awake even if chat never told us it
// was working. Logged every minute so the threshold can be tuned.
const APP_BUSY_CPU = 25; // % of one core
let appCpuHigh = 0;
let appCpuLog = [];
function onAppCpu(pct) {
  appCpuLog.push(Math.round(pct));
  if (appCpuLog.length >= 30) {
    log(`claude app cpu (2 s samples): ${appCpuLog.join(' ')}`);
    appCpuLog = [];
  }
  appCpuHigh = pct >= APP_BUSY_CPU ? appCpuHigh + 1 : 0;
  if (appCpuHigh >= 3 && flock) {
    for (const p of flock.pets) p.physics.stimulus();
    flock.broadcast('wake', 'app-busy');
  }
}

// ---------- startup ----------

app.on('second-instance', () => {
  hiddenByUser = false;
  refreshVisibility();
});

app.whenReady().then(() => {
  log('starting');
  loadState();
  createTray();
  applyLoginItem();

  surfaces = new Surfaces({ getWindow: () => flock && flock.primary && flock.primary.win, getMask: () => flock.masks(), log });

  const ctx = {
    state,
    log,
    surfaces,
    world,
    fg: () => fgState,
    brain: () => brain,
    busy: () => !!(brain && brain.isBusy()),
    hiddenByUser: () => hiddenByUser,
    onPositionSaved: (pet) => {
      const [x, y] = pet.position();
      state.x = x;
      state.y = y;
      saveState();
    },
  };
  flock = new Flock(ctx);
  ctx.flock = flock;
  const start = state.x === null ? defaultPosition() : clampToScreen(state.x, state.y);
  flock.add(new Pet(ctx, { x: start.x, y: start.y, primary: true }));

  const outfits = new OutfitMaker(path.join(app.getPath('userData'), 'outfits'));
  brain = new Brain({
    send: (channel, payload) => flock.primary && flock.primary.send(channel, payload),
    outfits,
    settings: () => state,
    onBusyChange: () => refreshVisibility(),
    onPosture: (sit) => flock.primary && flock.primary.send('posture', sit ? 'sit' : 'stand'),
  });

  // ---------- debug routes (localhost + token only), acting on the primary Clawd ----------
  const lead = () => flock.primary;
  const snap = async () => (lead() && lead().win ? (await lead().win.webContents.capturePage()).toPNG() : Buffer.alloc(0));
  // Inject synthetic mouse events into the page (dev testing without moving the real cursor).
  const input = (events) => {
    const p = lead();
    if (!p || !p.win) return;
    const [wx, wy] = p.position();
    for (const e of events) p.win.webContents.sendInputEvent({ button: 'left', clickCount: 1, ...e, globalX: wx + e.x, globalY: wy + e.y });
  };
  const surfacesDebug = async () => {
    const result = await surfaces.survey(lead().win.getBounds());
    return { feet: result.feet, lines: result.lines.map((l) => ({ ...l, y: Math.round(l.y), x0: Math.round(l.x0), x1: Math.round(l.x1) })) };
  };
  const settleNow = () => lead().physics.settle();
  // Same as letting go of a drag at window position (x, y), optionally thrown.
  const dropAt = ({ x, y, vx = 0, vy = 0 }) => {
    const p = lead();
    if (!p || !p.win) return;
    p.win.setPosition(Math.round(x), Math.round(y));
    p.physics.grab();
    p.physics.heldAt(Math.round(x - vx * 0.05), Math.round(y - vy * 0.05));
    setTimeout(() => {
      p.physics.heldAt(Math.round(x), Math.round(y));
      p.letGo();
    }, 50);
  };
  const physicsState = () => {
    const p = lead();
    const ph = p.physics;
    return {
      mode: ph.mode, x: ph.x, y: ph.y, vx: ph.vx, vy: ph.vy, walk: ph.walk,
      ground: ph.ground && { ...ph.ground, pet: ph.ground.pet ? ph.ground.pet.id : undefined },
      sitting: ph.sitting, activity: ph.activity, visible: p.shown, fg: fgState, world: world(),
      hitbox: p.hitbox, interactive: p.interactive, cursor: screen.getCursorScreenPoint(),
    };
  };
  const forceInteractive = (ms) => { lead().forceInteractiveUntil = Date.now() + Math.min(Number(ms) || 3000, 15000); };
  const clicks = () => {
    const p = lead();
    return { anim: p.lastAnim, interactive: p.interactive, hitbox: p.hitbox, mode: p.physics.mode, cursor: screen.getCursorScreenPoint(), win: p.position(), log: p.clickLog };
  };
  const pets = () => flock.pets.map((p) => ({
    id: p.id, primary: p.primary, session: p.sessionId, closing: p.closing, shown: p.shown,
    pos: p.position(), mode: p.physics.mode, activity: p.physics.activity, anim: p.lastAnim,
    ground: p.physics.ground && { y: Math.round(p.physics.ground.y), kind: p.physics.ground.kind, on: p.physics.ground.pet ? p.physics.ground.pet.id : undefined },
  }));
  startServer(brain, { snap, input, surfacesDebug, settleNow, dropAt, physicsState, clicks, forceInteractive, pets })
    .catch((err) => console.error('event server failed', err));

  foreground = new Foreground({
    onChange: onForeground,
    // You typed or clicked a link in Claude: wake them up.
    onInput: (kind) => {
      for (const p of flock.pets) p.trackDelay = 60; // typing grows the text box, scrolling moves ledges
      if (kind === 'scroll') return; // they sleep through scrolling
      for (const p of flock.pets) p.physics.stimulus();
      flock.broadcast('wake', kind);
    },
    onAppCpu,
    log,
  });
  setInterval(refreshVisibility, 500);
  setInterval(() => { for (const p of flock.pets) p.hitTest(); }, 30);

  screen.on('display-removed', () => {
    for (const p of flock.pets) {
      const [x, y] = p.position();
      const c = clampToScreen(x, y);
      if (p.win) p.win.setPosition(c.x, c.y);
    }
  });
});

app.on('before-quit', () => {
  if (foreground) foreground.stop();
  if (flock) flock.dispose();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
