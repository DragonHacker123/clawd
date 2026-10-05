// How big Clawd is on this computer. His artwork is drawn on a 150 px canvas
// that looks right on a 1080p desktop (1032 px of work area above the
// taskbar); on a smaller or lower-resolution screen he scales down with the
// screen, on a bigger one he scales up. All the sizes in physics, surfaces and
// the pet window are multiplied by `scale`, which is fixed for the run (a big
// change in the display restarts Clawd, see main.js).
const { screen } = require('electron');

const REF_WORK_HEIGHT = 1032;
const MIN = 0.5;
const MAX = 1.6;

let scale = 1;
let userScale = 1;

function computeScale(userMultiplier = 1) {
  const forced = Number(process.env.CLAWD_SCALE); // dev/testing: pretend the screen is a different size
  if (forced > 0) return Math.max(MIN, Math.min(MAX, forced));
  const { workArea } = screen.getPrimaryDisplay();
  const raw = (workArea.height / REF_WORK_HEIGHT) * userMultiplier;
  return Math.round(Math.max(MIN, Math.min(MAX, raw)) * 100) / 100;
}

function init(userMultiplier = 1) {
  userScale = userMultiplier;
  scale = computeScale(userMultiplier);
  return scale;
}

module.exports = {
  init,
  computeScale,
  get scale() { return scale; },
  get userScale() { return userScale; },
  BASE: 150,
};
