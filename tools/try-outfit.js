// Dev helper: generate one outfit outside Electron and print it.
// usage: node tools/try-outfit.js "conversation opener text"
const os = require('os');
const path = require('path');
const { OutfitMaker } = require('../src/outfits');

const maker = new OutfitMaker(path.join(os.tmpdir(), 'clawd-outfits-test'));
const t0 = Date.now();
maker.make(process.argv[2] || 'help me plan my DofE silver expedition kit list')
  .then((o) => console.log(JSON.stringify(o), `\n${((Date.now() - t0) / 1000).toFixed(1)}s`))
  .catch((e) => console.error('FAILED', e.message));
