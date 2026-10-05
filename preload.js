const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG_DIR = path.join(__dirname, 'assets', 'svg');

function on(channel, fn) {
  ipcRenderer.on(channel, (_event, payload) => fn(payload));
}

// How much the window is zoomed (Clawd's size on this screen), from main.
const scaleArg = process.argv.find((a) => a.startsWith('--clawd-scale='));
const scale = scaleArg ? Number(scaleArg.split('=')[1]) || 1 : 1;

contextBridge.exposeInMainWorld('clawd', {
  scale,
  readSvg: (name) => {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`bad sprite name: ${name}`);
    return fs.readFileSync(path.join(SVG_DIR, `${name}.svg`), 'utf8');
  },
  hitbox: (box) => ipcRenderer.send('hitbox', box),
  pressState: (pressing, seen) => ipcRenderer.send('press-state', pressing, seen),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', { dx, dy }),
  dragEnd: () => ipcRenderer.send('drag-end'),
  showMenu: () => ipcRenderer.send('show-menu'),
  ready: () => ipcRenderer.send('renderer-ready'),
  onActivity: (fn) => on('activity', fn),
  onFlash: (fn) => on('flash', fn),
  onOutfit: (fn) => on('outfit', fn),
  onBubble: (fn) => on('bubble', fn),
  onMotion: (fn) => on('motion', fn),
  onPosture: (fn) => on('posture', fn),
  onWake: (fn) => on('wake', fn),
});
