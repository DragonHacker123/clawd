// Date-based outfits: Santa hat all December, party hat on 4 June, and an
// Easter bunny companion on Easter Sunday. Coordinates are in Clawd's body grid.
(function () {
  // Anonymous Gregorian algorithm (Meeus/Jones/Butcher). Returns [month (1-12), day].
  function easterSunday(year) {
    const a = year % 19;
    const b = Math.floor(year / 100);
    const c = year % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31);
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return [month, day];
  }

  const SANTA_HAT = {
    id: 'santa-hat', name: 'Santa hat', slot: 'head',
    rects: [
      { x: 2.5, y: 3.3, w: 10, h: 1.6, fill: '#D32F2F' },
      { x: 4, y: 2, w: 7.5, h: 1.4, fill: '#D32F2F' },
      { x: 7, y: 1, w: 5, h: 1.1, fill: '#C62828' },
      { x: 11, y: 1.6, w: 2.2, h: 1.2, fill: '#C62828' },
      { x: 4.5, y: 2.2, w: 1.5, h: 0.5, fill: '#EF5350' },
      { x: 1.5, y: 4.8, w: 12, h: 1.4, fill: '#F5F5F5' },
      { x: 1.5, y: 5.8, w: 12, h: 0.4, fill: '#E0E0E0' },
      { x: 12.6, y: 2.1, w: 1.9, h: 1.9, fill: '#FFFFFF' },
      { x: 12.6, y: 3.5, w: 1.9, h: 0.5, fill: '#E0E0E0' },
    ],
  };

  const PARTY_HAT = {
    id: 'party-hat', name: 'Party hat', slot: 'head',
    rects: [
      { x: 5, y: 4.6, w: 6, h: 1.4, fill: '#7E57C2' },
      { x: 5.6, y: 3.4, w: 4.8, h: 1.2, fill: '#FFCA28' },
      { x: 6.2, y: 2.3, w: 3.6, h: 1.1, fill: '#7E57C2' },
      { x: 6.8, y: 1.3, w: 2.4, h: 1.0, fill: '#FFCA28' },
      { x: 7.4, y: 0.4, w: 1.2, h: 0.9, fill: '#7E57C2' },
      { x: 6, y: 5, w: 0.8, h: 0.6, fill: '#4FC3F7' },
      { x: 9.2, y: 4.9, w: 0.8, h: 0.6, fill: '#66BB6A' },
      { x: 7.6, y: 3.7, w: 0.8, h: 0.6, fill: '#EC407A' },
      { x: 7.1, y: -0.9, w: 1.8, h: 1.4, fill: '#EC407A' },
    ],
  };

  const CONFETTI = {
    id: 'confetti', name: 'Confetti', slot: 'companion',
    rects: [
      { x: -4, y: -6, w: 0.8, h: 0.8, fill: '#EC407A', cls: 'confetti c1' },
      { x: 1, y: -9, w: 0.8, h: 0.8, fill: '#FFCA28', cls: 'confetti c2' },
      { x: 6, y: -7, w: 0.8, h: 0.8, fill: '#4FC3F7', cls: 'confetti c3' },
      { x: 12, y: -10, w: 0.8, h: 0.8, fill: '#66BB6A', cls: 'confetti c4' },
      { x: 17, y: -6, w: 0.8, h: 0.8, fill: '#7E57C2', cls: 'confetti c5' },
      { x: 20, y: -9, w: 0.8, h: 0.8, fill: '#EC407A', cls: 'confetti c6' },
    ],
  };

  const EASTER_BUNNY = {
    id: 'easter-bunny', name: 'Easter bunny', slot: 'companion', cls: 'bunny-hop',
    rects: [
      { x: 15.8, y: 12, w: 1.3, h: 1.3, fill: '#FFFFFF' },
      { x: 16.5, y: 11.5, w: 5, h: 3.5, fill: '#F5F5F5' },
      { x: 16.5, y: 14.2, w: 5, h: 0.8, fill: '#E0E0E0' },
      { x: 19.5, y: 9, w: 3.5, h: 3, fill: '#FAFAFA' },
      { x: 19.8, y: 5.5, w: 1, h: 3.6, fill: '#FAFAFA' },
      { x: 21.6, y: 5.8, w: 1, h: 3.3, fill: '#FAFAFA' },
      { x: 20.1, y: 6.2, w: 0.4, h: 2.4, fill: '#F8BBD0' },
      { x: 21.9, y: 6.5, w: 0.4, h: 2.2, fill: '#F8BBD0' },
      { x: 21.8, y: 10, w: 0.7, h: 0.8, fill: '#000000' },
      { x: 22.6, y: 11, w: 0.5, h: 0.4, fill: '#EC407A' },
      { x: 20.5, y: 14.2, w: 1.6, h: 0.8, fill: '#EEEEEE' },
      { x: 16.8, y: 14.3, w: 2.2, h: 0.7, fill: '#EEEEEE' },
    ],
  };

  const EASTER_EGG = {
    id: 'easter-egg', name: 'Easter egg', slot: 'companion',
    rects: [
      { x: 16.5, y: 15, w: 6, h: 0.8, fill: '#000000', opacity: 0.3 },
      { x: 23.7, y: 12.8, w: 1.4, h: 0.4, fill: '#81D4FA' },
      { x: 23.4, y: 13.2, w: 2, h: 1.8, fill: '#81D4FA' },
      { x: 23.4, y: 13.7, w: 2, h: 0.45, fill: '#FFEB3B' },
      { x: 23.4, y: 14.4, w: 2, h: 0.3, fill: '#F48FB1' },
    ],
  };

  // Which slots the date occupies, so generated topic outfits can avoid them.
  function forDate(date = new Date()) {
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const out = [];
    if (month === 12) out.push(SANTA_HAT);
    if (month === 6 && day === 4) out.push(PARTY_HAT, CONFETTI);
    const [em, ed] = easterSunday(date.getFullYear());
    if (month === em && day === ed) out.push(EASTER_BUNNY, EASTER_EGG);
    return out;
  }

  window.ClawdSeasonal = { forDate, easterSunday };
})();
