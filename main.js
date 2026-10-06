const { app, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./src/server');
const { Brain } = require('./src/brain');
const { OutfitMaker } = require('./src/outfits');
const { Foreground } = require('./src/foreground');
const geometry = require('./src/geometry');
const { AppLayout } = require('./src/appLayout');
// Everything that depends on Clawd's size is loaded once the screen is known (see app.whenReady).
let Surfaces, FEET_Y, Pet, SIZE, Flock;

let tray;
let brain;
let surfaces;
let flock;
let foreground;
let fgState = { fg: 'claude', claude: null, above: [], tray: null, available: false };
let hiddenByUser = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.commandLine.appendSwitch('disable-background-timer-throttling');

// ---------- persisted settings ----------

const statePath = () => path.join(app.getPath('userData'), 'state.json');
const defaults = { x: null, y: null, outfits: true, onlyWhileWorking: false, openAtLogin: true, gravity: true, onlyInClaude: true, sizeScale: 1, ignoreCwds: [] };
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
  const display = screen.getPrimaryDisplay();
  return { x: display.workArea.x + 20, y: Math.round(floorY(display) - FEET_Y) };
}

function clampToScreen(x, y) {
  const display = screen.getDisplayMatching({ x, y, width: SIZE, height: SIZE });
  const { workArea, bounds } = display;
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - SIZE),
    y: Math.min(Math.max(y, bounds.y - 60), Math.round(floorY(display) - FEET_Y)),
  };
}

// Top of the taskbar on this display, from Windows' own taskbar window. Unlike
// the work area it still counts when the taskbar auto-hides (it slides back up
// over whatever is at the bottom of the screen), so he never stands where it
// will pop up.
function floorY(display) {
  const wa = display.workArea;
  let y = wa.y + wa.height;
  const t = fgState.tray;
  if (t && t.width >= display.bounds.width * 0.6 && t.height < display.bounds.height / 3
      && t.y >= display.bounds.y + display.bounds.height / 2 - 4 && t.x < display.bounds.x + display.bounds.width
      && t.x + t.width > display.bounds.x) {
    y = Math.min(y, display.bounds.y + display.bounds.height - t.height);
  }
  return Math.round(y);
}

// Where Clawd may be: inside the Claude app's window when "only in Claude" is
// on and the app is open (its bottom edge is the floor), otherwise the work
// area of the primary Clawd's display (the taskbar top is the floor).
function world() {
  const c = fgState.claude;
  if (state.onlyInClaude && c && !c.min) {
    const bottom = Math.min(c.y + c.height, floorY(screen.getDisplayMatching(c)));
    return { x0: c.x, x1: c.x + c.width, top: c.y, floor: { y: bottom, x0: c.x, x1: c.x + c.width, kind: 'floor' } };
  }
  const lead = flock && flock.primary;
  const b = lead && lead.win ? lead.win.getBounds() : { x: 0, y: 0, width: SIZE, height: SIZE };
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  return { x0: wa.x, x1: wa.x + wa.width, top: wa.y, floor: { y: floorY(display), x0: wa.x, x1: wa.x + wa.width, kind: 'taskbar' } };
}

function logDisplays(why) {
  const list = screen.getAllDisplays().map((d) => `#${d.id} bounds=${JSON.stringify(d.bounds)} work=${JSON.stringify(d.workArea)} dpi=${d.scaleFactor}${d.id === screen.getPrimaryDisplay().id ? ' primary' : ''}`);
  log(`displays (${why}): ${list.join(' | ')} tray=${JSON.stringify(fgState.tray)}`);
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

function relaunch(why) {
  log(`restarting: ${why}`);
  app.relaunch();
  app.exit(0);
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
    {
      label: 'Size',
      submenu: [['Smaller', 0.8], ['Normal (fits your screen)', 1], ['Larger', 1.25]].map(([label, v]) => ({
        label,
        type: 'radio',
        checked: (state.sizeScale || 1) === v,
        click: () => {
          state.sizeScale = v;
          saveState();
          relaunch('size changed');
        },
      })),
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
  const scale = geometry.init(state.sizeScale || 1);
  ({ Surfaces, FEET_Y } = require('./src/surfaces'));
  ({ Pet, SIZE } = require('./src/pet'));
  ({ Flock } = require('./src/flock'));
  logDisplays(`size scale ${scale} (user x${state.sizeScale || 1})`);
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

  // Which sessions are on screen in the app: only those get Clawds.
  const appLayout = new AppLayout({ log });
  const outfits = new OutfitMaker(path.join(app.getPath('userData'), 'outfits'));
  brain = new Brain({
    send: (channel, payload) => flock.primary && flock.primary.send(channel, payload),
    outfits,
    settings: () => state,
    onBusyChange: () => refreshVisibility(),
    onPosture: (sit) => flock.primary && flock.primary.send('posture', sit ? 'sit' : 'stand'),
    memoryFile: path.join(app.getPath('userData'), 'session-outfits.json'),
    visible: () => appLayout.visible,
    appUltra: (id) => appLayout.ultracode(id),
    onSessionFlash: (id, mood) => {
      const pet = flock.extras().find((p) => p.sessionId === id);
      if (pet) pet.send('flash', { state: mood, ms: 3200 });
    },
  });
  // Sessions already open in the app get their Clawds now, not on their next event.
  const projectsDir = path.join(require('os').homedir(), '.claude', 'projects');
  brain.discover(projectsDir).then(() => brain.adoptVisible(projectsDir, appLayout.info));
  appLayout.onChange = () => {
    brain.adoptVisible(projectsDir, appLayout.info);
    brain.refreshUltra();
  };

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
    const boxes = await surfaces.scanBoxes(world());
    return { feet: result.feet, boxes, lines: result.lines.map((l) => ({ ...l, y: Math.round(l.y), x0: Math.round(l.x0), x1: Math.round(l.x1) })) };
  };
  const settleNow = () => lead().physics.settle();
  // Same as letting go of a drag at window position (x, y), optionally thrown.
  // Put him somewhere without any checks (to test that the floor guard rescues him).
  const teleport = ({ x, y }) => {
    const p = lead();
    if (p && p.win) p.win.setPosition(Math.round(x), Math.round(y));
  };
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
      hyper: ph.hyper, flipping: Date.now() < ph.flipUntil,
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
  // Investigating "clicks stop reaching the page after a long idle": what the
  // page thinks, and candidate repairs to try on a live broken window.
  const pageState = async () => {
    const p = lead();
    const page = await p.win.webContents.executeJavaScript(
      '({ visibility: document.visibilityState, focus: document.hasFocus(), pointerLocked: !!document.pointerLockElement })',
    );
    return { page, focused: p.win.isFocused(), visible: p.win.isVisible(), opacity: p.win.getOpacity(), alwaysOnTop: p.win.isAlwaysOnTop() };
  };
  const heal = async (method) => {
    const w = lead().win;
    if (method === 'reassert') { w.setIgnoreMouseEvents(true); w.setIgnoreMouseEvents(false); }
    else if (method === 'focusable') { w.setFocusable(true); w.setFocusable(false); }
    else if (method === 'showInactive') w.showInactive();
    else if (method === 'ontop') { w.setAlwaysOnTop(false); w.setAlwaysOnTop(true, 'screen-saver'); }
    else if (method === 'invalidate') w.webContents.invalidate();
    else if (method === 'reload') w.webContents.reload();
    else if (method === 'recreate') lead().recreate();
    else return { ok: false };
    lead().interactive = null;
    return { ok: true };
  };
  startServer(brain, { teleport, snap, input, surfacesDebug, settleNow, dropAt, physicsState, clicks, forceInteractive, pets, pageState, heal })
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
    onMouseDown: (p) => { for (const pet of flock.pets) pet.osPress(p); },
    log,
  });
  setInterval(refreshVisibility, 500);
  setInterval(() => { for (const p of flock.pets) p.hitTest(); }, 30);
  setInterval(() => { for (const p of flock.pets) p.probeCover(foreground); }, 800);
  setInterval(() => { for (const p of flock.pets) p.guardFloor(); }, 700);

  // A new monitor, docking, or a change of display scaling: keep everyone on
  // screen, and if the screen is now a very different size, restart so Clawd
  // is resized to fit it.
  let metricsTimer = null;
  const onMetrics = () => {
    clearTimeout(metricsTimer);
    metricsTimer = setTimeout(() => {
      logDisplays('changed');
      const want = geometry.computeScale(state.sizeScale || 1);
      if (Math.abs(want - geometry.scale) >= 0.1) return relaunch(`screen resized, scale ${geometry.scale} -> ${want}`);
      for (const p of flock.pets) p.rehome();
    }, 1500);
  };
  screen.on('display-metrics-changed', onMetrics);
  screen.on('display-added', onMetrics);
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
