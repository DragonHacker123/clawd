// Dev tool: a temporary grey "platform" window, for testing Clawd landing,
// riding moving ledges and falling when they vanish.
// usage: electron tools/test-platform.js x y width seconds [path]
//   path (optional): comma-separated y positions, one per second, the platform
//   glides between (e.g. "400,400,300,200,200,700" rises then drops away).
const { app, BrowserWindow } = require('electron');
const [x, y, width, seconds] = process.argv.slice(2, 6).map(Number);
const path = (process.argv[6] || '').split(',').filter(Boolean).map(Number);
app.whenReady().then(() => {
  const win = new BrowserWindow({ x, y, width, height: 120, frame: false, show: false, focusable: false, backgroundColor: '#5a6b7c', skipTaskbar: true });
  win.showInactive();
  win.loadURL('data:text/html,<body style="margin:0;background:%235a6b7c"></body>');
  if (path.length) {
    const start = Date.now();
    setInterval(() => {
      const t = (Date.now() - start) / 1000;
      const i = Math.min(path.length - 1, Math.floor(t));
      const j = Math.min(path.length - 1, i + 1);
      const f = Math.min(1, t - i);
      win.setPosition(x, Math.round(path[i] + (path[j] - path[i]) * f));
    }, 30);
  }
  setTimeout(() => app.quit(), seconds * 1000);
});
