// Ultracode sparkles: bluey-purple pixel particles that rise around Clawd,
// stream out behind him when he runs and burst when he lands a stunt. Drawn on
// their own canvas outside the stage, so they stay upright while he climbs
// walls or flips. The loop only runs while there's something to draw.
(function () {
  const canvas = document.getElementById('fx');
  const ctx = canvas.getContext('2d');
  const W = 150; // CSS px, same canvas as the sprite (viewBox -15 -25 45 45)
  const UNIT = W / 45; // one big pixel of the sprite
  const BODY = { x: (7.5 + 15) * UNIT, y: (10 + 25) * UNIT }; // centre of his body
  const COLOURS = ['#6E7BFF', '#8B6CFF', '#A884FF', '#5AA2FF', '#C7B6FF', '#7F5BFF'];

  let on = false;
  let parts = [];
  let raf = 0;
  let last = 0;
  let owed = 0; // fractional particles carried between frames
  let motion = { mode: 'ground' };

  function size() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(W * dpr);
    ctx.setTransform(canvas.width / W, 0, 0, canvas.height / W, 0, 0);
    ctx.imageSmoothingEnabled = false;
  }

  function spawn(burst = false) {
    const a = Math.random() * Math.PI * 2;
    const r = burst ? 8 + Math.random() * 10 : 22 + Math.random() * 20;
    const p = {
      x: BODY.x + Math.cos(a) * r,
      y: BODY.y + Math.sin(a) * r * 0.8,
      vx: (Math.random() - 0.5) * 14,
      vy: -(12 + Math.random() * 30),
      life: 0,
      ttl: 0.7 + Math.random() * 0.9,
      size: Math.random() < 0.6 ? UNIT * 0.8 : UNIT * 1.3,
      star: Math.random() < 0.25, // a little plus-shaped twinkle
      colour: COLOURS[Math.floor(Math.random() * COLOURS.length)],
      phase: Math.random() * Math.PI * 2,
    };
    if (burst) {
      p.vx = Math.cos(a) * (50 + Math.random() * 60);
      p.vy = Math.sin(a) * (50 + Math.random() * 60) - 20;
      p.ttl = 0.5 + Math.random() * 0.5;
    } else if (motion.mode === 'walk' && motion.run) {
      // Running: a comet tail behind him.
      p.x = BODY.x - motion.dir * (10 + Math.random() * 18);
      p.y = BODY.y + (Math.random() - 0.3) * 30;
      p.vx = -motion.dir * (40 + Math.random() * 50);
      p.vy = -(5 + Math.random() * 15);
    } else if (motion.mode === 'climb') {
      // Up a wall: they fall away below him.
      p.vy = 20 + Math.random() * 30;
    }
    parts.push(p);
  }

  function frame(t) {
    const dt = Math.min(0.05, (t - (last || t)) / 1000);
    last = t;
    if (on) {
      const rate = motion.mode === 'walk' && motion.run ? 45 : motion.mode === 'air' ? 35 : 22; // per second
      owed += rate * dt;
      while (owed >= 1) {
        spawn();
        owed -= 1;
      }
    }
    ctx.clearRect(0, 0, W, W);
    parts = parts.filter((p) => (p.life += dt) < p.ttl);
    for (const p of parts) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 0.97;
      const fade = 1 - p.life / p.ttl;
      const twinkle = 0.65 + 0.35 * Math.sin(p.phase + p.life * 18);
      ctx.globalAlpha = Math.max(0, fade * twinkle);
      ctx.fillStyle = p.colour;
      const s = p.size;
      const x = Math.round(p.x / 0.5) * 0.5;
      const y = Math.round(p.y / 0.5) * 0.5;
      if (p.star) {
        ctx.fillRect(x - s, y - s / 3, s * 2, (s * 2) / 3);
        ctx.fillRect(x - s / 3, y - s, (s * 2) / 3, s * 2);
      } else {
        ctx.fillRect(x - s / 2, y - s / 2, s, s);
      }
    }
    ctx.globalAlpha = 1;
    if (on || parts.length) {
      raf = requestAnimationFrame(frame);
    } else {
      raf = 0;
      last = 0;
    }
  }

  function wake() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  size();
  window.addEventListener('resize', size);

  window.ClawdParticles = {
    setOn(value) {
      on = !!value;
      document.body.classList.toggle('hyper', on);
      if (on) wake();
    },
    setMotion(m) {
      motion = m || { mode: 'ground' };
    },
    burst(n = 18) {
      if (!on) return;
      for (let i = 0; i < n; i++) spawn(true);
      wake();
    },
  };
})();
