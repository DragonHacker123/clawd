// Loads Clawd's SVG animations into the DOM and dresses them with accessories.
//
// Accessories are lists of rects in Clawd's body grid (torso is x 2..13, y 6..13,
// head top at y=6). They are injected next to the torso so they inherit every
// body animation (bounce, squash, jump) of whichever SVG is playing.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const parser = new DOMParser();
  const textCache = new Map();

  function svgText(name) {
    if (!textCache.has(name)) textCache.set(name, window.clawd.readSvg(name));
    return textCache.get(name);
  }

  function num(el, attr) {
    return parseFloat(el.getAttribute(attr));
  }

  // Standing torso (11x7 at 2,6) or the splooted torso (13x5 at 1,10) used by
  // the sleeping/error poses, where the head sits 4 units lower.
  function findTorso(svg) {
    const rects = [...svg.querySelectorAll('rect')];
    const standing = rects.find(r => num(r, 'x') === 2 && num(r, 'y') === 6 && num(r, 'width') === 11 && num(r, 'height') === 7);
    if (standing) return { el: standing, dy: 0, sploot: false };
    const sploot = rects.find(r => num(r, 'x') === 1 && num(r, 'y') === 10 && num(r, 'width') === 13 && num(r, 'height') === 5);
    if (sploot) return { el: sploot, dy: 4, sploot: true };
    return null;
  }

  // Front accessories go at the end of the lowest group that holds both the
  // torso and the eyes, so face items draw over the eyes and move with the head.
  function frontParent(torso) {
    let node = torso.parentNode;
    while (node && node.tagName !== 'svg') {
      const eyes = node.querySelector('[class*="eye"], [id*="eye"]');
      if (eyes && eyes !== torso) return node;
      node = node.parentNode;
    }
    return torso.parentNode;
  }

  const COLOR = /^#[0-9a-fA-F]{3,8}$/;

  function buildGroup(acc, dy) {
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', `accessory slot-${acc.slot}${acc.cls ? ' ' + acc.cls : ''}`);
    if (dy) g.setAttribute('transform', `translate(0 ${dy})`);
    for (const r of acc.rects || []) {
      if (!COLOR.test(r.fill || '')) continue;
      if (!['x', 'y', 'w', 'h'].every(k => Number.isFinite(r[k]))) continue;
      const el = document.createElementNS(SVG_NS, 'rect');
      el.setAttribute('x', r.x);
      el.setAttribute('y', r.y);
      el.setAttribute('width', r.w);
      el.setAttribute('height', r.h);
      el.setAttribute('fill', r.fill);
      if (Number.isFinite(r.opacity)) el.setAttribute('opacity', r.opacity);
      if (r.cls) el.setAttribute('class', r.cls);
      g.appendChild(el);
    }
    return g;
  }

  // Animations where Clawd already wears his own hat (wizard hat, hard hat).
  const OWN_HAT = new Set(['clawd-working-wizard', 'clawd-working-building']);

  function dress(svg, name, accessories) {
    const torso = findTorso(svg);
    for (const acc of accessories) {
      if (acc.slot === 'head' && OWN_HAT.has(name)) continue;
      if (acc.slot === 'companion') {
        svg.appendChild(buildGroup(acc, 0));
        continue;
      }
      if (!torso) continue;
      // Only hats survive the flat splooted poses; face/back/body items are
      // drawn for the standing body and look broken when he's lying down.
      if (torso.sploot && acc.slot !== 'head') continue;
      const g = buildGroup(acc, torso.dy);
      if (acc.slot === 'back') {
        torso.el.parentNode.insertBefore(g, torso.el);
      } else {
        frontParent(torso.el).appendChild(g);
      }
    }
  }

  const BODY_FILL = /^#de886d$/i;

  function fillOf(el, stop) {
    for (let n = el; n && n !== stop; n = n.parentNode) {
      const f = n.getAttribute && n.getAttribute('fill');
      if (f) return f;
    }
    return '';
  }

  // Does this element hold part of Clawd's own body (torso, limbs, eyes)?
  function holdsBody(el, svg) {
    if (el.matches('rect') ? BODY_FILL.test(fillOf(el, svg)) : false) return true;
    return [...el.querySelectorAll('rect')].some((r) => BODY_FILL.test(fillOf(r, svg)))
      || !!el.querySelector('[class*="eye"], [id*="eye"]');
  }

  const isShadow = (el) => el.matches('rect') && num(el, 'y') >= 15 && /^#0{3}(0{3})?$/i.test(el.getAttribute('fill') || '');

  // Sitting (long tasks): legs tucked away, body lowered 2 units onto the
  // ground, little feet poking out sideways. Props on the ground stay put.
  function sitDown(svg) {
    for (const r of svg.querySelectorAll('rect')) {
      // Legs: 1-wide body-coloured rects that reach the ground (y + h = 15).
      const w = num(r, 'width');
      const bottom = num(r, 'y') + num(r, 'height');
      if (w <= 1.2 && Math.abs(bottom - 15) < 0.01 && BODY_FILL.test(fillOf(r, svg))) {
        r.setAttribute('visibility', 'hidden');
      }
    }
    for (const el of [...svg.children]) {
      if (el.tagName === 'defs' || el.tagName === 'style' || isShadow(el)) continue;
      if (!holdsBody(el, svg) && !el.classList.contains('accessory')) continue;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', 'translate(0 2)');
      svg.insertBefore(g, el);
      g.appendChild(el);
    }
    const feet = document.createElementNS(SVG_NS, 'g');
    feet.setAttribute('fill', '#DE886D');
    feet.innerHTML = '<rect x="0.5" y="14" width="1.5" height="1"/><rect x="13" y="14" width="1.5" height="1"/>';
    svg.appendChild(feet);
  }

  // ---------- keeping parts from overlapping ----------

  // Bounding boxes (in SVG units) of each element, unioned over the animation
  // cycle, so moving parts are judged by everywhere they go.
  function sweptBoxes(svg, elements) {
    const anims = svg.getAnimations ? svg.getAnimations({ subtree: true }) : [];
    const inv = svg.getScreenCTM();
    if (!inv) return elements.map(() => null);
    const toSvg = inv.inverse();
    const pt = svg.createSVGPoint();
    const map = (x, y) => {
      pt.x = x;
      pt.y = y;
      const p = pt.matrixTransform(toSvg);
      return [p.x, p.y];
    };
    const boxes = elements.map(() => null);
    anims.forEach((a) => a.pause());
    for (const t of [0, 250, 600, 1000, 1500, 2100, 2900, 3800]) {
      anims.forEach((a) => {
        a.currentTime = t;
      });
      elements.forEach((el, i) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return;
        const [x0, y0] = map(r.left, r.top);
        const [x1, y1] = map(r.right, r.bottom);
        const b = boxes[i];
        boxes[i] = b
          ? { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x1), y1: Math.max(b.y1, y1) }
          : { x0, y0, x1, y1 };
      });
    }
    anims.forEach((a) => {
      a.currentTime = 0;
      a.play();
    });
    return boxes;
  }

  const GAP = 0.4;
  const hits = (a, b) => a && b && a.x0 < b.x1 + GAP && b.x0 < a.x1 + GAP && a.y0 < b.y1 + GAP && b.y0 < a.y1 + GAP;

  // Nudge the animation's own props (thought bubbles, screens, sparkles,
  // alarm marks...) up or sideways until they clear every accessory.
  function separate(svg) {
    const accessories = [...svg.querySelectorAll('.accessory')];
    if (!accessories.length) return;
    const props = [...svg.children].filter((el) => el.tagName !== 'defs' && el.tagName !== 'style'
      && !isShadow(el) && !el.classList.contains('accessory') && !holdsBody(el, svg));
    if (!props.length) return;
    const all = sweptBoxes(svg, [...accessories, ...props]);
    const accBoxes = all.slice(0, accessories.length).filter(Boolean);
    props.forEach((prop, i) => {
      let box = all[accessories.length + i];
      if (!box) return;
      let dx = 0;
      let dy = 0;
      for (let round = 0; round < 4; round++) {
        const hit = accBoxes.find((a) => hits(box, a));
        if (!hit) break;
        const cy = (box.y0 + box.y1) / 2;
        const cx = (box.x0 + box.x1) / 2;
        const up = hit.y0 - box.y1 - GAP;
        const left = hit.x0 - box.x1 - GAP;
        const right = hit.x1 - box.x0 + GAP;
        const options = [];
        if (cy <= (hit.y0 + hit.y1) / 2 + 2 && box.y0 + up >= -24) options.push([0, up]);
        if (cx < (hit.x0 + hit.x1) / 2 && box.x0 + left >= -14.5) options.push([left, 0]);
        if (cx >= (hit.x0 + hit.x1) / 2 && box.x1 + right <= 29.5) options.push([right, 0]);
        if (!options.length) options.push([0, up]);
        const [mx, my] = options.sort((a, b) => Math.hypot(...a) - Math.hypot(...b))[0];
        dx += mx;
        dy += my;
        box = { x0: box.x0 + mx, x1: box.x1 + mx, y0: box.y0 + my, y1: box.y1 + my };
      }
      if (dx || dy) {
        const g = document.createElementNS(SVG_NS, 'g');
        g.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
        svg.insertBefore(g, prop);
        g.appendChild(prop);
      }
    });
  }

  // Static bounds of an accessory's rects.
  function accBounds(acc) {
    const rs = acc.rects || [];
    if (!rs.length) return null;
    return {
      x0: Math.min(...rs.map((r) => r.x)), x1: Math.max(...rs.map((r) => r.x + r.w)),
      y0: Math.min(...rs.map((r) => r.y)), y1: Math.max(...rs.map((r) => r.y + r.h)),
    };
  }

  const mirror = (acc) => ({ ...acc, id: acc.id + '-m', rects: acc.rects.map((r) => ({ ...r, x: 15 - r.x - r.w })) });

  // Accessories must not overlap each other either: a later one (the topic
  // outfit) that collides with an earlier one (seasonal gear) moves to his
  // other side, or is left off if that collides too.
  function untangle(accessories) {
    const placed = [];
    for (const acc of accessories) {
      const clashes = (a) => placed.some((p) => p.slot !== a.slot || p.slot === 'companion' ? hits(accBounds(p), accBounds(a)) : false);
      if (!clashes(acc)) placed.push(acc);
      else if (!clashes(mirror(acc))) placed.push(mirror(acc));
    }
    return placed;
  }

  // Replace the container's contents with `name` wearing `accessories`.
  // opts.sit: sitting pose; opts.flip: face left.
  function render(container, name, accessories, opts = {}) {
    const doc = parser.parseFromString(svgText(name), 'image/svg+xml');
    const svg = document.importNode(doc.documentElement, true);
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('class', 'pet-svg' + (opts.flip ? ' flip' : ''));
    dress(svg, name, untangle(accessories));
    if (opts.sit) sitDown(svg);
    container.replaceChildren(svg);
    try {
      separate(svg);
    } catch (err) {
      console.warn('separate failed', err);
    }
    return svg;
  }

  window.ClawdSprites = { render };
})();
