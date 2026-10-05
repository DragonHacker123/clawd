// Clawd's behaviour: picks which animation to show from (in priority order)
// the user poking him, short "flash" reactions, what Claude is doing, and his
// own idle/sleep routine. Also handles click-through, dragging and clicks.
(function () {
  const api = window.clawd;
  const stage = document.getElementById('stage');
  const bubble = document.getElementById('bubble');
  // When Clawd is shrunk to fit a small screen, keep the bubble text readable (~10 px on screen).
  if (api.scale < 1) bubble.style.fontSize = `${Math.min(16, 10 / api.scale).toFixed(1)}px`;

  // Activity names sent by the main process -> SVG animation.
  const ACTIVITY = {
    thinking: 'clawd-working-thinking',
    ultrathink: 'clawd-working-ultrathink',
    typing: 'clawd-working-typing',
    reading: 'clawd-idle-reading',
    searching: 'clawd-working-debugger',
    building: 'clawd-working-building',
    fetching: 'clawd-working-carrying',
    conducting: 'clawd-working-conducting',
    juggling: 'clawd-working-juggling',
    sweeping: 'clawd-working-sweeping',
    wizard: 'clawd-working-wizard',
    attention: 'clawd-notification',
  };

  const FLASH = {
    happy: 'clawd-happy',
    error: 'clawd-error',
    attention: 'clawd-notification',
    alert: 'clawd-mini-alert',
    wizard: 'clawd-working-wizard',
    wake: 'clawd-wake',
    // moods the chat model can send via the MCP server
    celebrate: 'clawd-react-double-jump',
    excited: 'clawd-mini-happy',
    confused: 'clawd-react-double',
    surprised: 'clawd-mini-alert',
    sleepy: 'clawd-idle-yawn',
    // turning to a friend (other Clawds)
    lookLeft: 'clawd-react-left',
    lookRight: 'clawd-react-right',
  };

  // [animation, weight, how long to hold it (ms)]
  const IDLE = [
    ['clawd-idle-living', 6, 16000],
    ['clawd-idle-look', 2, 9000],
    ['clawd-idle-follow', 1, 7000],
    ['clawd-idle-reading', 2, 14000],
    ['clawd-idle-yawn', 1, 7600],
  ];

  // No typing, prompts, link clicks or pokes for this long (and Claude idle):
  // he nods off, then sleeps until you do something.
  const DOZE_AFTER = 20 * 1000;
  const SLEEP_AFTER = 30 * 1000;
  const COLLAPSE_MS = 6000;

  let activity = null;
  let flash = null; // { anim, until }
  let reaction = null; // { anim, until }
  let outfit = null; // generated topic accessory
  let lastStimulus = Date.now();
  let idle = { anim: 'clawd-idle-living', until: 0 };
  let shownKey = '';
  let motion = { mode: 'ground', dir: 1 };
  let sitting = false;
  let hyper = false; // ultracode: running, hopping, climbing walls

  function now() {
    return Date.now();
  }

  // Anything that should wake him up / reset the sleep timer.
  function stimulus() {
    if (now() - lastStimulus > DOZE_AFTER) {
      flash = { anim: FLASH.wake, until: now() + 1500 };
    }
    lastStimulus = now();
  }

  function pickIdle(t) {
    if (t < idle.until) return idle.anim;
    const pool = IDLE.filter(([anim]) => anim !== idle.anim);
    let roll = Math.random() * pool.reduce((sum, [, w]) => sum + w, 0);
    for (const [anim, weight, hold] of pool) {
      roll -= weight;
      if (roll <= 0) {
        idle = { anim, until: t + hold };
        break;
      }
    }
    return idle.anim;
  }

  function pickAnimation(t) {
    if (reaction && t < reaction.until) return reaction.anim;
    reaction = null;
    if (motion.mode === 'climb') return 'clawd-walk';
    if (motion.mode === 'air') return motion.hop ? 'clawd-happy' : 'clawd-react-drag';
    if (motion.mode === 'teeter') return 'clawd-teeter';
    if (flash && t < flash.until) return flash.anim;
    flash = null;
    if (motion.mode === 'walk') {
      if (motion.run) return 'clawd-walk';
      if (activity === 'fetching') return ACTIVITY.fetching;
      if (activity === 'sweeping') return ACTIVITY.sweeping;
      return 'clawd-walk';
    }
    // Chat is working on something: awake, doing his normal idle routine in costume.
    if (activity === 'chatting') {
      lastStimulus = t;
      return pickIdle(t);
    }
    if (activity) return ACTIVITY[activity] || ACTIVITY.thinking;
    const quiet = t - lastStimulus;
    if (quiet >= SLEEP_AFTER) {
      return quiet - SLEEP_AFTER < COLLAPSE_MS ? 'clawd-collapse-sleep' : 'clawd-sleeping';
    }
    if (quiet >= DOZE_AFTER) return 'clawd-idle-doze';
    return pickIdle(t);
  }

  function accessories() {
    const seasonal = window.ClawdSeasonal.forDate(new Date());
    const taken = new Set(seasonal.map(a => a.slot));
    const list = [...seasonal];
    if (outfit && !(outfit.slot === 'head' && taken.has('head'))) list.push(outfit);
    return list;
  }

  const WORKING = new Set(Object.values(ACTIVITY));

  function tick() {
    const anim = pickAnimation(now());
    const acc = accessories();
    // Up a wall he faces up it: turned 90° with his feet on the wall.
    const climb = motion.mode === 'climb' ? motion.side : 0;
    const flip = climb ? climb < 0 : motion.mode === 'walk' && motion.dir < 0;
    const fast = climb ? 2 : motion.mode === 'walk' && motion.run ? 2.6 : 1;
    // Long tasks: he sits down to work.
    const sit = sitting && motion.mode === 'ground' && WORKING.has(anim);
    const key = `${anim}|${acc.map(a => a.id).join(',')}|${flip}|${sit}|${climb}|${fast}`;
    if (key !== shownKey) {
      shownKey = key;
      window.ClawdSprites.render(stage, anim, acc, { flip, sit });
      stage.classList.toggle('climb-left', climb < 0);
      stage.classList.toggle('climb-right', climb > 0);
      // Running: legs and bob at double speed.
      for (const a of document.getAnimations()) a.playbackRate = fast;
    }
  }

  let bubbleTimer = null;
  function say(text, ms = 4000) {
    bubble.textContent = text;
    bubble.classList.remove('hidden');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => bubble.classList.add('hidden'), ms);
  }

  // ---------- messages from the main process ----------

  api.onActivity((state) => {
    activity = state || null;
    stimulus();
  });

  api.onFlash(({ state, ms }) => {
    stimulus();
    const anim = FLASH[state] || ACTIVITY[state];
    if (anim) flash = { anim, until: now() + (ms || 2500) };
  });

  api.onOutfit((acc) => {
    outfit = acc || null;
    if (acc && acc.label) say(acc.label, 5000);
  });

  api.onBubble(({ text, ms }) => say(text, ms));

  // Dangling while he falls to the next thing to stand on.
  // Physics from the main process: air (falling/thrown), teeter (on an edge),
  // walk (dir -1/1), ground. A bad landing makes him cross.
  api.onMotion((m) => {
    const wasAirborne = motion.mode === 'air';
    motion = m;
    if (m.mode === 'ground' && wasAirborne) {
      if (m.angry) {
        flash = { anim: 'clawd-angry', until: now() + 2800 };
        say('ow!! 💢', 2200);
      }
    }
  });

  // You typed, sent something or clicked a link in Claude.
  api.onWake(() => stimulus());

  api.onPosture((p) => {
    sitting = p === 'sit';
  });

  api.onHyper((on) => {
    hyper = !!on;
    if (hyper) stimulus();
  });

  // ---------- mouse: click-through, drag, clicks ----------

  // The window ignores the mouse except over Clawd himself, so the rest of
  // the square stays click-through. The main process does that hit test
  // against the real cursor; we report where his body is in the window
  // (body and accessories, as they are right now in the animation).
  let lastHitbox = '';
  function reportHitbox() {
    const svg = stage.querySelector('.pet-svg');
    if (!svg) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of svg.querySelectorAll('rect')) {
      let fill = '';
      for (let n = r; n && n !== svg; n = n.parentNode) {
        fill = n.getAttribute('fill');
        if (fill) break;
      }
      if (!/^#de886d$/i.test(fill || '') && !r.closest('.accessory')) continue;
      const b = r.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      x0 = Math.min(x0, b.left); y0 = Math.min(y0, b.top);
      x1 = Math.max(x1, b.right); y1 = Math.max(y1, b.bottom);
    }
    if (!Number.isFinite(x0)) return;
    const box = { x0: Math.floor(x0) - 3, y0: Math.floor(y0) - 3, x1: Math.ceil(x1) + 3, y1: Math.ceil(y1) + 3 };
    const key = JSON.stringify(box);
    if (key !== lastHitbox) {
      lastHitbox = key;
      api.hitbox(box);
    }
  }
  setInterval(reportHitbox, 300);

  let press = null; // { x, y, dragging, pointerId }

  stage.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    press = { x: e.screenX, y: e.screenY, dragging: false };
    stage.setPointerCapture(e.pointerId);
    api.dragStart();
  });

  stage.addEventListener('pointermove', (e) => {
    if (!press) return;
    const dx = e.screenX - press.x;
    const dy = e.screenY - press.y;
    if (!press.dragging && Math.hypot(dx, dy) > 4) {
      press.dragging = true;
      document.body.classList.add('dragging');
      reaction = { anim: 'clawd-react-drag', until: Infinity };
      stimulus();
    }
    if (press.dragging) api.dragMove(dx, dy);
  });

  function endPress(e) {
    if (!press) return;
    const wasDrag = press.dragging;
    press = null;
    document.body.classList.remove('dragging');
    api.dragEnd();
    if (wasDrag) {
      reaction = null; // physics takes over (he falls or lands)
    } else {
      onClick(e.clientX);
    }
  }
  stage.addEventListener('pointerup', endPress);
  stage.addEventListener('pointercancel', endPress);
  // If the pointer is lost mid-press (window hidden, capture broken), end it
  // rather than leaving him stuck "held".
  stage.addEventListener('lostpointercapture', (e) => {
    if (press) endPress(e);
  });
  // Diagnostics: what mouse input actually reaches the page each second.
  const seen = { move: 0, down: 0 };
  window.addEventListener('pointermove', () => seen.move++, true);
  window.addEventListener('pointerdown', () => seen.down++, true);
  setInterval(() => {
    api.pressState(!!press, { ...seen, anim: shownKey.split('|')[0] });
    seen.move = 0;
    seen.down = 0;
  }, 1000);

  stage.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    api.showMenu();
  });

  let pokes = [];
  let pendingSingle = null;

  function react(anim, ms) {
    reaction = { anim, until: now() + ms };
  }

  function onClick(clientX) {
    const t = now();
    const wasAsleep = t - lastStimulus > DOZE_AFTER;
    stimulus();
    if (wasAsleep) return; // first poke just wakes him

    pokes = [...pokes.filter(p => t - p < 4000), t];
    if (pokes.length >= 5) {
      pokes = [];
      clearTimeout(pendingSingle);
      pendingSingle = null;
      react('clawd-react-annoyed', 6000);
      say('hey!! 😤', 2500);
      return;
    }
    if (pendingSingle) {
      clearTimeout(pendingSingle);
      pendingSingle = null;
      react('clawd-react-double-jump', 3500);
      return;
    }
    const left = clientX < window.innerWidth / 2;
    pendingSingle = setTimeout(() => {
      pendingSingle = null;
      react(left ? 'clawd-react-left' : 'clawd-react-right', 2500);
    }, 280);
  }

  setInterval(tick, 200);
  tick();
  api.ready();
})();
