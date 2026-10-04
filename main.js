const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { startServer } = require('./src/server');
const { Brain } = require('./src/brain');
const { OutfitMaker } = require('./src/outfits');
const { Surfaces, FEET_Y, FEET_L, FEET_R } = require('./src/surfaces');
const { Physics } = require('./src/physics');
const { Foreground } = require('./src/foreground');

const SIZE = 150;

let win;
let tray;
let brain;
let rendererReady = false;
const pending = [];

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

// ---------- window ----------

// Standing on the taskbar, bottom-left.
function defaultPosition() {
  const { workArea } = screen.getPrimaryDisplay();
  return { x: workArea.x + 20, y: Math.round(workArea.y + workArea.height - FEET_Y) };
}

// Keep Clawd on whichever display he mostly sits on. His feet can go as low as
// the taskbar top (the empty bottom of his window overlaps it) and the empty top
// of his window may poke above the screen.
function clampToScreen(x, y) {
  const { workArea, bounds } = screen.getDisplayMatching({ x, y, width: SIZE, height: SIZE });
  return {
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - SIZE),
    y: Math.min(Math.max(y, bounds.y - 60), Math.round(workArea.y + workArea.height - FEET_Y)),
  };
}

// ---------- the world he lives in ----------

let surfaces;
let physics;
let foreground;
let fgState = { fg: 'claude', claude: null, available: false };
let unsupportedChecks = 0;
let hiddenByUser = false;

function savePosition() {
  if (!win) return;
  const [x, y] = win.getPosition();
  state.x = x;
  state.y = y;
  saveState();
}

// Where Clawd may be: inside the Claude app's window when "only in Claude" is
// on and the app is open (its bottom edge is his floor), otherwise the work
// area of his display (the taskbar top is his floor).
function world() {
  const c = fgState.claude;
  if (state.onlyInClaude && c && !c.min) {
    const wa = screen.getDisplayMatching(c).workArea;
    const floorY = Math.min(c.y + c.height, wa.y + wa.height);
    return { x0: c.x, x1: c.x + c.width, top: c.y, floor: { y: floorY, x0: c.x, x1: c.x + c.width, kind: 'floor' } };
  }
  const b = win ? win.getBounds() : { x: 0, y: 0, width: SIZE, height: SIZE };
  const wa = screen.getDisplayMatching(b).workArea;
  return { x0: wa.x, x1: wa.x + wa.width, top: wa.y, floor: { y: wa.y + wa.height, x0: wa.x, x1: wa.x + wa.width, kind: 'taskbar' } };
}

function clampToWorld(x, y) {
  const w = world();
  return {
    x: Math.round(Math.min(Math.max(x, w.x0 - FEET_L + 2), w.x1 - FEET_R - 2)),
    y: Math.round(Math.min(Math.max(y, w.top - 60), w.floor.y - FEET_Y)),
  };
}

// He lives in the Claude app: shown while its window is open (not minimised)
// and no other window covers HIM. A smaller window elsewhere on screen (say
// Spotify in the middle while he's on the taskbar) doesn't hide him.
function wantVisible() {
  if (hiddenByUser) return false;
  if (state.onlyWhileWorking && brain && !brain.isBusy()) return false;
  if (!state.onlyInClaude || !fgState.available) return true;
  const c = fgState.claude;
  if (!c || c.min || !win) return false;
  const [wx, wy] = win.getPosition();
  const body = { x0: wx + hitbox.x0, y0: wy + hitbox.y0, x1: wx + hitbox.x1, y1: wy + hitbox.y1 };
  return !(fgState.above || []).some((r) => body.x0 < r.x + r.width && r.x < body.x1 && body.y0 < r.y + r.height && r.y < body.y1);
}

function refreshVisibility() {
  const before = win && win.isVisible();
  setVisible(wantVisible());
  if (!before && win && win.isVisible() && physics && state.gravity) physics.settle();
}

// Keep him inside Claude's window after it opens, restores or resizes.
function rehome() {
  if (!win || !physics || physics.mode === 'held') return;
  const [x, y] = win.getPosition();
  const p = clampToWorld(x, y);
  if (p.x !== x || p.y !== y) {
    win.setPosition(p.x, p.y);
    physics.ground = null;
  }
  if (state.gravity) physics.settle();
}

function onForeground(next) {
  const prev = fgState.claude;
  fgState = next;
  const c = next.claude;
  if (state.onlyInClaude && physics && c && !c.min) {
    if (!prev || prev.min) {
      rehome();
    } else if (prev.width !== c.width || prev.height !== c.height) {
      rehome();
    } else if (prev.x !== c.x || prev.y !== c.y) {
      physics.shift(c.x - prev.x, c.y - prev.y); // ride along with the window
    }
  }
  refreshVisibility();
}

// About three times a second while he stands on a ledge: find it again and ride it
// (the message box growing pushes him up, scrolling carries him along). If it
// has gone (scrolled off, window closed) for three looks running (~1 s), he falls.
let trackDelay = 60;

async function trackTick() {
  if (!win || !state.gravity || !win.isVisible() || !physics || physics.mode !== 'ground' || surfaces.busy) return;
  const g = physics.ground;
  if (!g || g.kind === 'floor' || g.kind === 'taskbar') return;
  surfaces.busy = true;
  try {
    const { line, ok } = await surfaces.track(win.getBounds(), physics.ground);
    if (!ok || physics.mode !== 'ground') return;
    if (!line) {
      unsupportedChecks += 1;
      trackDelay = 60; // look again quickly before deciding it's gone
      if (unsupportedChecks >= 3) {
        unsupportedChecks = 0;
        physics.fallFromRest();
      }
      return;
    }
    unsupportedChecks = 0;
    return physics.rideTo(line);
  } catch (err) {
    console.error('ledge tracking failed', err);
  } finally {
    surfaces.busy = false;
  }
}

// The patch of screen Clawd himself covers (body, shadow, props at his feet),
// which the surface finder must ignore.
function clawdMask() {
  if (!win) return null;
  const [wx, wy] = win.getPosition();
  return { x0: wx + Math.min(40, hitbox.x0), x1: wx + Math.max(110, hitbox.x1), y0: wy, y1: wy + 141 };
}

function send(channel, payload) {
  if (channel === 'activity' && physics) physics.setActivity(payload);
  if (win && rendererReady) win.webContents.send(channel, payload);
  else pending.push([channel, payload]);
}

function createWindow() {
  const start = state.x === null ? defaultPosition() : clampToScreen(state.x, state.y);
  win = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    x: start.x,
    y: start.y,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    focusable: false,
    show: !state.onlyWhileWorking,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  // Electron's setPosition throws on -0 (Math.round(-0.3) is -0) and NaN, which
  // crashed him at the screen's left/top edges. Sanitise every call.
  const rawSetPosition = win.setPosition.bind(win);
  win.setPosition = (x, y, ...rest) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    rawSetPosition(Math.round(x) + 0, Math.round(y) + 0, ...rest);
  };
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) log(`renderer: ${message} (${path.basename(source || '')}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => log(`renderer gone: ${details.reason} exit ${details.exitCode}`));
  win.on('closed', () => {
    win = null;
  });
}

function setVisible(visible) {
  if (!win) return;
  if (visible && !win.isVisible()) win.showInactive();
  if (!visible && win.isVisible()) win.hide();
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
        const p = defaultPosition();
        if (win) win.setPosition(p.x, p.y);
        rehome();
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
        rehome();
      },
    },
    {
      label: 'Physics (stand, walk, fall)',
      type: 'checkbox',
      checked: state.gravity,
      click: (item) => {
        state.gravity = item.checked;
        saveState();
        if (state.gravity) physics.settle();
        else physics.stopWalking();
      },
    },
    {
      label: 'Topic outfits (generated live)',
      type: 'checkbox',
      checked: state.outfits,
      click: (item) => {
        state.outfits = item.checked;
        saveState();
        if (!state.outfits) send('outfit', null);
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
    hiddenByUser = !!(win && win.isVisible());
    refreshVisibility();
  });
  tray.on('right-click', () => tray.popUpContextMenu(buildMenu()));
}

// ---------- IPC from the renderer ----------

let dragOrigin = null;

ipcMain.on('renderer-ready', () => {
  rendererReady = true;
  for (const [channel, payload] of pending.splice(0)) win.webContents.send(channel, payload);
});

// Click-through everywhere except over Clawd: poll the real cursor against the
// hitbox the renderer reports. (Robust to him walking under a still cursor and
// to the window being hidden/shown, which broke the old forwarded-mousemove way.)
let hitbox = { x0: 50, y0: 70, x1: 100, y1: 140 };
let interactive = false;

ipcMain.on('hitbox', (_e, box) => {
  if (box && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)) hitbox = box;
});

function hitTest() {
  if (!win || !win.isVisible()) {
    interactive = null; // re-apply after he's shown again
    return;
  }
  let on = physics && physics.mode === 'held';
  if (!on) {
    const c = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    on = c.x >= wx + hitbox.x0 && c.x <= wx + hitbox.x1 && c.y >= wy + hitbox.y0 && c.y <= wy + hitbox.y1;
  }
  if (on !== interactive) {
    interactive = on;
    win.setIgnoreMouseEvents(!on);
  }
}

// Drags follow the real cursor position from the OS, which stays correct on
// mixed-DPI multi-monitor setups where renderer screen coords drift.
ipcMain.on('drag-start', () => {
  if (!win) return;
  dragOrigin = { win: win.getPosition(), cursor: screen.getCursorScreenPoint() };
  physics.grab();
});

ipcMain.on('drag-move', (_e, { dx, dy }) => {
  if (!win || !dragOrigin) return;
  const c = screen.getCursorScreenPoint();
  // Synthetic test input doesn't move the OS cursor; fall back to the renderer's delta.
  const moved = c.x !== dragOrigin.cursor.x || c.y !== dragOrigin.cursor.y;
  const ox = moved ? c.x - dragOrigin.cursor.x : dx;
  const oy = moved ? c.y - dragOrigin.cursor.y : dy;
  const x = Math.round(dragOrigin.win[0] + ox);
  const y = Math.round(dragOrigin.win[1] + oy);
  win.setPosition(x, y);
  physics.heldAt(x, y);
});

// Let go: with physics on he's thrown with the drag's speed and falls;
// with it off he stays where he was dropped.
function letGo() {
  if (!win) return;
  const [x, y] = win.getPosition();
  const p = clampToWorld(x, y);
  win.setPosition(p.x, p.y);
  unsupportedChecks = 0;
  if (state.gravity) {
    physics.release();
  } else {
    physics.mode = 'ground';
    physics.ground = null;
    savePosition();
  }
}

ipcMain.on('drag-end', () => {
  dragOrigin = null;
  letGo();
});

ipcMain.on('show-menu', () => {
  if (win) buildMenu().popup({ window: win });
});

// ---------- startup ----------

app.on('second-instance', () => setVisible(true));

app.whenReady().then(() => {
  log('starting');
  loadState();
  createWindow();
  createTray();
  applyLoginItem();

  const outfits = new OutfitMaker(path.join(app.getPath('userData'), 'outfits'));
  brain = new Brain({
    send,
    outfits,
    settings: () => state,
    onBusyChange: () => refreshVisibility(),
    onPosture: (sit) => {
      if (physics) physics.setSitting(sit);
      send('posture', sit ? 'sit' : 'stand');
    },
  });

  const snap = async () => (win ? (await win.webContents.capturePage()).toPNG() : Buffer.alloc(0));
  // Inject synthetic mouse events into the page (dev testing without moving the real cursor).
  const input = (events) => {
    if (!win) return;
    const [wx, wy] = win.getPosition();
    for (const e of events) {
      win.webContents.sendInputEvent({ button: 'left', clickCount: 1, ...e, globalX: wx + e.x, globalY: wy + e.y });
    }
  };
  // Show what he can stand on: JSON of lines plus an annotated capture saved next to the log.
  const surfacesDebug = async () => {
    const bounds = win.getBounds();
    const result = await surfaces.survey(bounds);
    const display = result.display;
    const { desktopCapturer } = require('electron');
    win.setContentProtection(true);
    await new Promise((r) => setTimeout(r, 60));
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
    win.setContentProtection(false);
    const img = sources[0].thumbnail;
    const crop = { x: Math.max(0, bounds.x - 150), y: Math.max(0, bounds.y - 100), width: 450, height: 0 };
    crop.width = Math.min(crop.width, display.size.width - crop.x);
    crop.height = display.size.height - crop.y;
    const bmp = Buffer.from(img.crop(crop).toBitmap());
    const mark = (x, y, b, g, r) => {
      if (x < 0 || y < 0 || x >= crop.width || y >= crop.height) return;
      const i = (y * crop.width + x) * 4;
      bmp[i] = b; bmp[i + 1] = g; bmp[i + 2] = r; bmp[i + 3] = 255;
    };
    for (const line of result.lines) {
      const y = Math.round(line.y) - crop.y;
      for (let x = Math.round(line.x0) - crop.x; x < Math.round(line.x1) - crop.x; x++) mark(x, y, 0, line.kind === 'taskbar' ? 255 : 0, 255);
    }
    const fy = Math.round(result.feet.y) - crop.y;
    for (let x = Math.round(result.feet.l) - crop.x; x < Math.round(result.feet.r) - crop.x; x++) { mark(x, fy, 255, 255, 0); mark(x, fy - 1, 255, 255, 0); }
    const file = path.join(app.getPath('userData'), 'surfaces-debug.png');
    fs.writeFileSync(file, require('electron').nativeImage.createFromBitmap(bmp, { width: crop.width, height: crop.height }).toPNG());
    return { file, feet: result.feet, lines: result.lines.map((l) => ({ ...l, y: Math.round(l.y), x0: Math.round(l.x0), x1: Math.round(l.x1) })) };
  };
  const settleNow = () => physics.settle();
  // Same as letting go of a drag at window position (x, y), optionally thrown.
  const dropAt = ({ x, y, vx = 0, vy = 0 }) => {
    if (!win) return;
    win.setPosition(Math.round(x), Math.round(y));
    physics.grab();
    physics.heldAt(Math.round(x - vx * 0.05), Math.round(y - vy * 0.05));
    setTimeout(() => {
      physics.heldAt(Math.round(x), Math.round(y));
      letGo();
    }, 50);
  };
  const physicsState = () => ({
    mode: physics.mode, x: physics.x, y: physics.y, vx: physics.vx, vy: physics.vy,
    walk: physics.walk, ground: physics.ground, sitting: physics.sitting, activity: physics.activity,
    visible: !!(win && win.isVisible()), fg: fgState, world: world(), hitbox, interactive,
    cursor: screen.getCursorScreenPoint(),
  });
  startServer(brain, { snap, input, surfacesDebug, settleNow, dropAt, physicsState }).catch((err) => console.error('event server failed', err));

  surfaces = new Surfaces({ getWindow: () => win, getMask: clawdMask, log });
  physics = new Physics({
    getWindow: () => win,
    surfaces,
    send,
    settings: () => state,
    world,
    onRest: savePosition,
    log,
  });
  foreground = new Foreground({
    onChange: onForeground,
    // You typed or clicked a link in Claude: wake him.
    onInput: (kind) => {
      trackDelay = 60; // typing grows the text box, scrolling moves ledges: watch closely
      if (kind === 'scroll') return; // he sleeps through scrolling
      physics.stimulus();
      send('wake', kind);
    },
    log,
  });
  // He moves (walking, riding a ledge) without the windows changing: re-check cover.
  setInterval(refreshVisibility, 500);
  // Back-to-back (a screen capture takes ~280 ms, so this is ~3 looks a second).
  // Adaptive: right after the ledge moves (or you type/click) look again almost
  // at once; while nothing changes, back off to ~1.5 s between looks. Each
  // capture costs ~280 ms of work, so this keeps him cheap when idle.
  const trackLoop = async () => {
    const moved = await trackTick();
    trackDelay = moved ? 60 : Math.min(1200, trackDelay * 1.6);
    setTimeout(trackLoop, trackDelay);
  };
  trackLoop();
  setInterval(hitTest, 40);
  win.webContents.once('did-finish-load', () => setTimeout(() => state.gravity && physics.settle(), 800));

  screen.on('display-removed', () => {
    if (!win) return;
    const [x, y] = win.getPosition();
    const p = clampToScreen(x, y);
    win.setPosition(p.x, p.y);
  });
});

app.on('before-quit', () => foreground && foreground.stop());

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
