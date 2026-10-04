// Finds things on screen for Clawd to stand on, and lands him on them.
//
// Other apps (Claude's own window included) don't expose their layout, so this
// works visually: it captures the display, ignores the patch of screen Clawd
// himself covers (masked out, so he never has to vanish from recordings), then
// looks under his feet for long, solid horizontal edges — the top of a text
// box, a card, a button row, a window's title bar — plus the top of the taskbar
// from Windows' own work-area geometry. His feet go exactly on the line.
const { desktopCapturer, screen } = require('electron');

// Geometry of Clawd inside his 150px window (viewBox -15 -25 45 45).
const UNIT = 150 / 45;
const FEET_Y = (15 + 25) * UNIT; // bottom of his legs (viewBox y=15) ≈ 133.3px
const FEET_L = (3 + 15) * UNIT; // outer left leg (viewBox x=3) = 60px
const FEET_R = (12 + 15) * UNIT; // outer right leg ends (viewBox x=12) = 90px
const HEAD_Y = (0 + 25) * UNIT; // roughly the top of any hat ≈ 83px

const SNAP_RANGE = 48; // DIP: a drop this close to a line snaps onto it
const EDGE_STEP = 8; // luminance jump (0-255) between two rows that counts as an edge
const GAP = 2; // px of broken edge tolerated inside a line (anti-aliasing, dots)
const MIN_LINE = 46; // DIP: a line must be at least this long (text strokes aren't)
const MAX_NUDGE = 30; // DIP: slide sideways at most this far to get both feet on a short ledge

const lum = (b, g, r) => 0.114 * b + 0.587 * g + 0.299 * r;

function feetOf(bounds) {
  return { y: bounds.y + FEET_Y, l: bounds.x + FEET_L, r: bounds.x + FEET_R };
}

// A capture costs ~280 ms whatever its size, so several Clawds share one:
// anything asked for within 150 ms of the last grab of that display reuses it.
const recent = new Map(); // display id -> { at, promise }

function capture(win, display) {
  const hit = recent.get(display.id);
  if (hit && Date.now() - hit.at < 150) return hit.promise;
  const sf = display.scaleFactor;
  const thumbnailSize = { width: Math.round(display.size.width * sf), height: Math.round(display.size.height * sf) };
  const promise = desktopCapturer.getSources({ types: ['screen'], thumbnailSize }).then((sources) => {
    const src = sources.find((s) => s.display_id === String(display.id)) || sources[0];
    return src ? src.thumbnail : null;
  });
  recent.set(display.id, { at: Date.now(), promise });
  promise.then(() => recent.set(display.id, { at: Date.now(), promise }), () => recent.delete(display.id));
  return promise;
}

// Scan a DIP rectangle of the captured display for horizontal lines.
// Returns [{ y, x0, x1 }] in DIP screen coordinates, where y is the row his feet
// should rest on (the first row of the edge's lower side), topmost first.
// `mask` (DIP rect, optional) is where Clawd is drawn: those pixels say nothing
// about the screen, so they may bridge a line but never count as evidence.
function findLines(img, display, rect, mask) {
  const sf = display.scaleFactor;
  const px = (v) => Math.round(v * sf);
  const region = {
    x: Math.max(0, px(rect.x0 - display.bounds.x)),
    y: Math.max(0, px(rect.y0 - display.bounds.y)),
  };
  const size = img.getSize();
  region.width = Math.min(size.width, px(rect.x1 - display.bounds.x)) - region.x;
  region.height = Math.min(size.height, px(rect.y1 - display.bounds.y)) - region.y;
  if (region.width < 4 || region.height < 2) return [];

  const buf = img.crop(region).toBitmap(); // BGRA
  const w = region.width;
  const h = region.height;
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) L[i] = lum(buf[p], buf[p + 1], buf[p + 2]);

  const minRun = MIN_LINE * sf;
  const minReal = 20 * sf;
  // One mask per Clawd on screen.
  const masks = (Array.isArray(mask) ? mask : mask ? [mask] : []).map((mk) => ({
    x0: px(mk.x0 - display.bounds.x) - region.x, x1: px(mk.x1 - display.bounds.x) - region.x,
    y0: px(mk.y0 - display.bounds.y) - region.y, y1: px(mk.y1 - display.bounds.y) - region.y,
  }));
  const lines = [];
  for (let row = 1; row < h; row++) {
    const rowMasks = masks.filter((mk) => row >= mk.y0 && row - 1 <= mk.y1);
    const maskedRow = rowMasks.length > 0;
    // Track each run's hits and step statistics: a real UI edge is almost
    // unbroken and has the same brightness step all along (same two colours);
    // a word's baseline is gappy and its steps vary letter to letter.
    let start = -1;
    let lastHit = -1;
    let hits = 0;
    let sum = 0;
    let sumAbs = 0;
    let sumSq = 0;
    let masked = 0;
    let firstReal = -1;
    let lastReal = -1;
    const flush = () => {
      const len = lastHit - start + 1;
      if (start >= 0 && len >= minRun && hits >= minReal) {
        const mean = sumAbs / hits;
        const sd = Math.sqrt(Math.max(0, sumSq / hits - mean * mean));
        const dense = hits / Math.max(1, len - masked) >= 0.94;
        const oneWay = Math.abs(sum) / sumAbs >= 0.9;
        const even = sd / mean <= 0.35;
        if (dense && oneWay && even) {
          // Ends hidden behind Clawd are unknown: report where the visible
          // line stops, and flag that the real end may be further under him.
          lines.push({
            y: display.bounds.y + (region.y + row) / sf,
            x0: display.bounds.x + (region.x + firstReal) / sf,
            x1: display.bounds.x + (region.x + lastReal + 1) / sf,
            hiddenLeft: firstReal > start,
            hiddenRight: lastReal < lastHit,
            sig: sum / hits, // signed brightness step: which two colours meet here
          });
        }
      }
      start = -1;
      firstReal = lastReal = -1;
      hits = sum = sumAbs = sumSq = masked = 0;
    };
    for (let x = 0; x < w; x++) {
      if (maskedRow && rowMasks.some((mk) => x >= mk.x0 && x <= mk.x1)) {
        if (start < 0) start = x;
        lastHit = x;
        masked++;
        continue;
      }
      const step = L[row * w + x] - L[(row - 1) * w + x];
      if (Math.abs(step) >= EDGE_STEP) {
        if (start < 0) start = x;
        if (firstReal < 0) firstReal = x;
        lastReal = x;
        lastHit = x;
        hits++;
        sum += step;
        sumAbs += Math.abs(step);
        sumSq += step * step;
      } else if (start >= 0 && x - lastHit > GAP) {
        flush();
      }
    }
    flush();
  }

  // A 1px border makes two edges a pixel apart; he stands on the upper one.
  lines.sort((a, b) => a.y - b.y);
  const merged = [];
  for (const line of lines) {
    const prev = merged.find((m) => line.y - m.y <= 3 && line.x0 < m.x1 && line.x1 > m.x0);
    if (prev) {
      if (line.x0 < prev.x0) { prev.x0 = line.x0; prev.hiddenLeft = line.hiddenLeft; }
      if (line.x1 > prev.x1) { prev.x1 = line.x1; prev.hiddenRight = line.hiddenRight; }
    } else {
      merged.push({ ...line });
    }
  }
  return merged;
}

// Can both feet rest on this line, possibly after a small sideways nudge?
// Returns the horizontal nudge (DIP) or null.
function footing(line, feet) {
  const width = feet.r - feet.l;
  if (line.x1 - line.x0 < width + 4) return null;
  let dx = 0;
  if (line.x0 > feet.l - 2) dx = line.x0 - feet.l + 2;
  if (line.x1 < feet.r + 2) dx = line.x1 - feet.r - 2;
  return Math.abs(dx) <= MAX_NUDGE ? dx : null;
}

class Surfaces {
  constructor({ getWindow, getMask, log }) {
    this.log = log || (() => {});
    this.getWindow = getWindow;
    this.getMask = getMask || (() => null);
    this.log = log || (() => {});
    this.busy = false;
  }

  // Every surface near/below Clawd on his display.
  async survey(bounds) {
    const win = this.getWindow();
    const display = screen.getDisplayMatching(bounds);
    const feet = feetOf(bounds);
    const wa = display.workArea;
    const out = [];
    // The taskbar top (or the bottom of the screen when it auto-hides / sits elsewhere).
    out.push({ y: wa.y + wa.height, x0: wa.x, x1: wa.x + wa.width, kind: 'taskbar' });

    const img = await capture(win, display);
    if (img && !img.isEmpty()) {
      const rect = {
        x0: Math.max(display.bounds.x, feet.l - MAX_NUDGE - 40),
        x1: Math.min(display.bounds.x + display.bounds.width, feet.r + MAX_NUDGE + 40),
        y0: Math.max(wa.y + 1, feet.y - SNAP_RANGE),
        y1: wa.y + wa.height - 1,
      };
      for (const line of findLines(img, display, rect, this.getMask())) out.push({ ...line, kind: 'edge' });
    }
    return { display, feet, lines: out };
  }

  // Where should he end up? mode 'drop': snap to the nearest line within reach,
  // otherwise fall to the first line below. Returns { x, y, line } or null to stay.
  async landing(bounds, { gravity = true } = {}) {
    const { display, feet, lines } = await this.survey(bounds);
    const usable = lines
      .map((line) => ({ line, dx: footing(line, feet) }))
      .filter(({ line, dx }) => dx !== null && line.y - FEET_Y >= display.bounds.y - HEAD_Y + 20);
    if (!usable.length) return null;

    const near = usable
      .filter(({ line }) => Math.abs(line.y - feet.y) <= SNAP_RANGE)
      .sort((a, b) => Math.abs(a.line.y - feet.y) - Math.abs(b.line.y - feet.y))[0];
    const below = usable.filter(({ line }) => line.y > feet.y).sort((a, b) => a.line.y - b.line.y)[0];
    const pick = near || (gravity ? below : null);
    if (!pick) return null;
    return {
      x: Math.round(bounds.x + pick.dx),
      y: Math.round(pick.line.y - FEET_Y),
      line: pick.line,
    };
  }

  // Every line from just above his feet down to the floor, across the whole
  // display (full extents, for walking and for wherever a throw takes him).
  async scanWide(bounds, floor) {
    const win = this.getWindow();
    const display = screen.getDisplayMatching(bounds);
    const feet = feetOf(bounds);
    const wa = display.workArea;
    const bottom = floor ? floor.y : wa.y + wa.height;
    const lines = [floor || { y: bottom, x0: wa.x, x1: wa.x + wa.width, kind: 'taskbar' }];
    const img = await capture(win, display);
    if (img && !img.isEmpty()) {
      const x0 = floor ? floor.x0 : display.bounds.x;
      const x1 = floor ? floor.x1 : display.bounds.x + display.bounds.width;
      const rect = { x0, x1, y0: Math.max(display.bounds.y + 1, feet.y - 24), y1: bottom - 1 };
      for (const line of findLines(img, display, rect, this.getMask())) lines.push({ ...line, kind: 'edge' });
    }
    if (process.env.CLAWD_TRACE) this.log(`scanWide feet=${feet.y.toFixed(0)} mask=${JSON.stringify(this.getMask())} lines=${JSON.stringify(lines.filter((l) => l.y < feet.y + 200).map((l) => [Math.round(l.y), Math.round(l.x0), Math.round(l.x1), l.hiddenLeft ? 'hL' : '', l.hiddenRight ? 'hR' : '']))}`);
    return lines;
  }

  // Follow the ledge he's on as the screen changes: returns the line nearest his
  // feet (within `reach` px up or down) that's under his centre, or null if
  // there's nothing there any more. Nearest wins, so a ledge scrolling down past
  // a static one (like the message box) hands him over to the static one.
  async track(bounds, prev, reach = 160) {
    const win = this.getWindow();
    const display = screen.getDisplayMatching(bounds);
    const feet = feetOf(bounds);
    const c = (feet.l + feet.r) / 2;
    const img = await capture(win, display);
    if (!img || img.isEmpty()) return { line: null, ok: false };
    const wa = display.workArea;
    const rect = {
      x0: Math.max(display.bounds.x, feet.l - 110),
      x1: Math.min(display.bounds.x + display.bounds.width, feet.r + 110),
      y0: Math.max(display.bounds.y + 1, feet.y - reach),
      y1: Math.min(wa.y + wa.height - 1, feet.y + reach),
    };
    // Score: how far it moved, plus how unlike his ledge it is (ends that
    // were known before, and the colours meeting at the edge).
    const score = (l) => {
      let s = Math.abs(l.y - feet.y);
      if (prev) {
        if (!prev.openLeft && l.x0 > rect.x0 + 1) s += 0.6 * Math.abs(l.x0 - prev.x0);
        if (!prev.openRight && l.x1 < rect.x1 - 1) s += 0.6 * Math.abs(l.x1 - prev.x1);
        if (Number.isFinite(prev.sig)) {
          s += 1.5 * Math.abs(l.sig - prev.sig);
        }
      }
      return s;
    };
    const all = findLines(img, display, rect, this.getMask());
    // Same colour direction as his ledge only: an edge the other way round is
    // the far side of a box, not the thing he's standing on.
    const sameWay = (l) => !prev || !Number.isFinite(prev.sig) || Math.sign(l.sig) === Math.sign(prev.sig);
    const under = (l) => (l.x0 <= c || l.hiddenLeft) && (c <= l.x1 || l.hiddenRight);
    // His own ledge, still where it was: any line within 3 px counts, whatever
    // its colour direction (thin borders flicker between their two edges).
    const near = (l) => Math.abs(l.y - feet.y) <= 3;
    const here = all.filter((l) => under(l) && near(l)).sort((a, b) => Math.abs(a.y - feet.y) - Math.abs(b.y - feet.y))[0];
    const lines = all
      .filter((l) => under(l) && !near(l) && sameWay(l))
      .sort((a, b) => score(a) - score(b));
    if (process.env.CLAWD_TRACE) this.log(`track feet=${feet.y.toFixed(0)} c=${c.toFixed(0)} rect=${JSON.stringify(rect)} all=${JSON.stringify(all.map((l) => [Math.round(l.y), Math.round(l.x0), Math.round(l.x1), Math.round(l.sig)]))}`);
    // Ends that touch the scan strip's sides are unknown (the line runs on).
    const withEnds = (l) => l && { ...l, openLeft: l.x0 <= rect.x0 + 1, openRight: l.x1 >= rect.x1 - 1 };
    return { here: withEnds(here), other: withEnds(lines[0]), ok: true };
  }

  // Is there still something under his feet right now?
  async supported(bounds, floor) {
    const feet0 = feetOf(bounds);
    if (floor && Math.abs(floor.y - feet0.y) <= 2) return true;
    const { feet, lines } = await this.survey(bounds);
    return lines.some((line) => Math.abs(line.y - feet.y) <= 2 && line.x0 <= feet.l + 6 && line.x1 >= feet.r - 6);
  }
}

module.exports = { Surfaces, FEET_Y, FEET_L, FEET_R, HEAD_Y, findLines };
