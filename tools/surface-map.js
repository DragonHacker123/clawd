// Dev tool: capture the primary display, find every line Clawd could stand on,
// and save the screenshot with those lines drawn in red.
// usage: electron tools/surface-map.js out.png
const { app, desktopCapturer, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { findLines } = require('../src/surfaces');

app.whenReady().then(async () => {
  const display = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: display.size });
  const img = sources[0].thumbnail;
  const lines = findLines(img, display, { x0: 0, x1: display.size.width, y0: 1, y1: display.size.height });
  const { width, height } = img.getSize();
  const bmp = Buffer.from(img.toBitmap());
  for (const l of lines) {
    const y = Math.round(l.y);
    for (let x = Math.round(l.x0); x < Math.round(l.x1); x++) {
      for (const yy of [y, y + 1]) {
        if (yy >= height) continue;
        const i = (yy * width + x) * 4;
        bmp[i] = 0; bmp[i + 1] = 0; bmp[i + 2] = 255;
      }
    }
  }
  fs.writeFileSync(path.resolve(process.argv[2] || 'surfaces.png'), nativeImage.createFromBitmap(bmp, { width, height }).toPNG());
  console.log(`${lines.length} lines`);
  app.quit();
});
