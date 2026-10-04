// Dev tool: step through every SVG animation (100 ms steps over its longest cycle)
// and report frames where exactly one eye is off the torso or hidden.
// usage: electron tools/eye-check.js
const { app, BrowserWindow } = require('electron');
const path = require('path');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 600, height: 600, webPreferences: { preload: path.join(__dirname, 'gallery-preload.js'), sandbox: false } });
  await win.loadURL('data:text/html,<body></body>');
  const result = await win.webContents.executeJavaScript(`(async () => {
    const fs = null;
    const names = ${JSON.stringify(require('fs').readdirSync(path.join(__dirname, '..', 'assets', 'svg')).filter((f) => f.endsWith('.svg')).map((f) => f.replace('.svg', '')))};
    const out = {};
    for (const name of names) {
      if (name === 'clawd-about-hero' || name === 'clawd-static-base') continue;
      const host = document.createElement('div');
      document.body.replaceChildren(host);
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = window.clawd.readSvg(name).replace(/width="\d+" height="\d+"/, 'width="450" height="450"');
      const svg = root.querySelector('svg');
      const isBlack = (el) => { let n = el; while (n && n !== svg) { const f = n.getAttribute && n.getAttribute('fill'); if (f) return /^#0{3}(0{3})?$/i.test(f); n = n.parentNode; } return false; };
      const rects = [...svg.querySelectorAll('rect')];
      const num = (r, a) => parseFloat(r.getAttribute(a));
      const eyes = rects.filter((r) => isBlack(r) && num(r, 'width') <= 2.2 && num(r, 'y') >= 7 && num(r, 'y') <= 13.5 && !(r.closest('[class*="mouth"]')) && !/mouth|yawn/.test(r.getAttribute('class') || ''));
      const torso = rects.find((r) => (num(r,'width') === 11 && num(r,'height') === 7) || (num(r,'width') === 13 && num(r,'height') === 5));
      if (!torso || eyes.length < 2) { out[name] = 'skipped (eyes ' + eyes.length + ')'; continue; }
      const anims = svg.getAnimations ? svg.getAnimations({ subtree: true }) : document.getAnimations();
      const all = root.getAnimations ? root.getAnimations() : [];
      const list = [...new Set([...anims, ...all])];
      list.forEach((a) => a.pause());
      const maxDur = Math.max(1000, ...list.map((a) => { const t = a.effect.getComputedTiming(); return Number.isFinite(t.endTime) ? t.endTime : t.duration; }).filter(Number.isFinite));
      const bad = [];
      for (let t = 0; t <= Math.min(maxDur, 20000); t += 100) {
        list.forEach((a) => (a.currentTime = t));
        const tb = torso.getBoundingClientRect();
        let visible = 0, hidden = 0;
        for (const e of eyes) {
          const b = e.getBoundingClientRect();
          const cs = getComputedStyle(e);
          let op = 1; for (let n = e; n && n !== svg; n = n.parentNode) { if (n.nodeType === 1) op *= parseFloat(getComputedStyle(n).opacity); }
          const inside = b.left >= tb.left - 2 && b.right <= tb.right + 2 && b.width > 1 && b.height > 1 && op > 0.3;
          if (inside) visible++; else hidden++;
        }
        if (visible > 0 && hidden > 0 && eyes.length === 2) bad.push(t);
        if (eyes.length > 2 && visible > 0 && visible < eyes.length && visible % 2 === 1) bad.push(t);
      }
      out[name] = bad.length ? ('ONE EYE at ' + bad.length + ' frames, e.g. ' + bad.slice(0, 6).join(',') + 'ms (eyes=' + eyes.length + ')') : 'ok (eyes=' + eyes.length + ', ' + Math.round(maxDur) + 'ms)';
    }
    return out;
  })()`);
  for (const [k, v] of Object.entries(result)) console.log(k.padEnd(30), v);
  app.quit();
});
