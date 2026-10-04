const { contextBridge } = require('electron');
const fs = require('fs');
const path = require('path');

const SVG_DIR = path.join(__dirname, '..', 'assets', 'svg');
const outfitFile = process.env.CLAWD_GALLERY_OUTFIT;

contextBridge.exposeInMainWorld('clawd', {
  readSvg: (name) => fs.readFileSync(path.join(SVG_DIR, `${name}.svg`), 'utf8'),
  outfit: () => (outfitFile ? JSON.parse(fs.readFileSync(outfitFile, 'utf8')) : null),
  outfits: () => (process.env.CLAWD_GALLERY_OUTFITS || '').split(';').filter(Boolean)
    .map((f) => ({ file: path.basename(f), ...JSON.parse(fs.readFileSync(f, 'utf8')) })),
  date: () => process.env.CLAWD_GALLERY_DATE || null,
  opts: () => JSON.parse(process.env.CLAWD_GALLERY_OPTS || '{}'),
});
