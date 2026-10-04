// Dev tool: render assets/svg/clawd-static-base.svg to extension/icon.png (256px).
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(async () => {
  const svg = fs.readFileSync(path.join(__dirname, '..', 'assets', 'svg', 'clawd-static-base.svg'), 'utf8')
    .replace(/width="\d+" height="\d+"/, 'width="200" height="213" shape-rendering="crispEdges"');
  const html = `<body style="margin:0;background:transparent;display:flex;align-items:center;justify-content:center;width:256px;height:256px">${svg}</body>`;
  const win = new BrowserWindow({ width: 256, height: 256, show: false, transparent: true, frame: false });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await new Promise((r) => setTimeout(r, 300));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(__dirname, '..', 'extension', 'icon.png'), img.toPNG());
  app.quit();
});
