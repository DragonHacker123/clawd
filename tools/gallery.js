// Dev tool: render every animation wearing the current seasonal outfit plus an
// optional outfit JSON, and save a PNG.
// usage: electron tools/gallery.js <out.png> [outfit.json] [YYYY-MM-DD] [delayMs]
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const [out, outfit, date, delay] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (outfit && outfit.includes(';')) process.env.CLAWD_GALLERY_OUTFITS = outfit.split(';').map((f) => path.resolve(f)).join(';');
else if (outfit && outfit !== '-') process.env.CLAWD_GALLERY_OUTFIT = path.resolve(outfit);
if (date && date !== '-') process.env.CLAWD_GALLERY_DATE = date;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1240, height: 880, show: false,
    webPreferences: { preload: path.join(__dirname, 'gallery-preload.js'), contextIsolation: true, sandbox: false, offscreen: false },
  });
  win.webContents.on('console-message', (_e, _l, msg) => console.log('[page]', msg));
  await win.loadFile(path.join(__dirname, 'gallery.html'));
  await new Promise((r) => setTimeout(r, Number(delay) || 1200));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.resolve(out || 'gallery.png'), img.toPNG());
  console.log('saved', path.resolve(out || 'gallery.png'));
  app.quit();
});
