// Several Clawds at once: the primary one follows the session you're focused
// on; when other things are happening at the same time (another Claude Code
// session, a chat working on something), each gets its own Clawd. They drop
// in next to the others, hang out together on the same ledge, wave, chat and
// high-five, can stand on each other's heads, and wave goodbye a little while
// after their task finishes. Each can be dragged independently.
const path = require('path');
const { Pet } = require('./pet');
const { FEET_Y } = require('./surfaces');
const S = require('./geometry').scale;

const MAX_EXTRA = 3;
const LINGER_MS = 40 * 1000; // an extra Clawd hangs around this long after his task ends
const LONG_TASK_MS = 90 * 1000; // busy this long: he sits down to work
const SOCIAL_COOLDOWN_MS = 20 * 1000;
const FREE = new Set([null, 'chatting', 'fetching', 'sweeping']); // activities he can wander during

const CHATTER = [
  ['hey!', 'hi 👋'], ['😄', '😆'], ['🤔', '💡!'], ['nice!', '✨'], ['☕?', 'yes pls'],
  ['busy?', 'always'], ['🎵', '🎶'], ['look!', '👀'], ['✋', '✋'],
];

function labelFor(session) {
  if (session.id === 'chat') return '💬 chat';
  const name = path.basename(String(session.cwd || '')) || 'code';
  return `📁 ${name}`;
}

class Flock {
  constructor(ctx) {
    this.ctx = ctx;
    this.pets = [];
    this.social = new Map(); // "idA-idB" -> last social time
    this.timers = [
      setInterval(() => this.tick(), 400),
      setInterval(() => this.sync(), 1000),
      setInterval(() => this.hangOut(), 2000),
    ];
  }

  get primary() {
    return this.pets.find((p) => p.primary);
  }

  extras() {
    return this.pets.filter((p) => !p.primary);
  }

  add(pet) {
    this.pets.push(pet);
    return pet;
  }

  byWebContents(id) {
    return this.pets.find((p) => p.win && !p.win.isDestroyed() && p.win.webContents.id === id);
  }

  headsExcept(pet) {
    return this.pets.filter((p) => p !== pet && !p.closing).map((p) => p.head()).filter(Boolean);
  }

  masks() {
    return this.pets.filter((p) => p.shown && !p.closing).map((p) => p.mask()).filter(Boolean);
  }

  broadcast(channel, payload) {
    for (const p of this.pets) p.send(channel, payload);
  }

  // Someone grabbed a Clawd: anyone standing on his head loses their footing.
  grabbed(pet) {
    for (const p of this.pets) {
      if (p.physics.ground && p.physics.ground.pet === pet) p.physics.fallFromRest();
    }
  }

  // ---------- who should be on screen ----------

  sync() {
    const brain = this.ctx.brain();
    if (!brain) return;
    const now = Date.now();
    const focusId = brain.focusId;
    const active = brain.activeSessions().filter((s) => s.id !== focusId).slice(0, MAX_EXTRA);
    const activeIds = new Set(active.map((s) => s.id));

    // If you switched to a session that has its own Clawd, the primary now
    // shows it; hand that extra Clawd the session the primary just left.
    for (const pet of this.extras()) {
      if (pet.sessionId === focusId) {
        const spare = active.find((s) => !this.extras().some((e) => e.sessionId === s.id));
        if (spare) this.assign(pet, spare);
        else pet.sessionId = null;
      }
    }

    for (const s of active) {
      let pet = this.extras().find((p) => p.sessionId === s.id && !p.closing);
      if (!pet) {
        if (this.extras().filter((p) => !p.closing).length >= MAX_EXTRA) continue;
        pet = this.spawn(s);
      }
      pet.idleSince = null;
      this.show(pet, s, now);
    }

    for (const pet of this.extras()) {
      if (pet.closing || activeIds.has(pet.sessionId)) continue;
      const s = brain.sessions.get(pet.sessionId);
      if (!pet.idleSince) {
        pet.idleSince = now;
        pet.send('activity', null);
        pet.send('posture', 'stand');
        pet.send('flash', { state: 'happy', ms: 2400 });
        if (s && s.outfit) pet.send('outfit', s.outfit);
      } else if (now - pet.idleSince > LINGER_MS) {
        this.leave(pet);
      }
    }
  }

  assign(pet, session) {
    pet.sessionId = session.id;
    pet.shownActivity = undefined;
    pet.shownOutfit = undefined;
    pet.send('bubble', { text: labelFor(session), ms: 3500 });
  }

  // Push one session's state to its Clawd (only what changed).
  show(pet, s, now) {
    const activity = s.activity || null;
    if (activity !== pet.shownActivity) {
      pet.shownActivity = activity;
      pet.send('activity', activity);
    }
    const outfit = s.outfit || null;
    const outfitId = outfit ? outfit.id : null;
    if (outfitId !== pet.shownOutfit) {
      pet.shownOutfit = outfitId;
      pet.send('outfit', outfit);
    }
    const sit = !!(s.busySince && now - s.busySince > LONG_TASK_MS);
    if (sit !== pet.shownSit) {
      pet.shownSit = sit;
      pet.send('posture', sit ? 'sit' : 'stand');
    }
  }

  // A new Clawd drops in beside the group.
  spawn(session) {
    const lead = this.primary;
    const [px, py] = lead ? lead.position() : [200, 200];
    const w = this.ctx.world();
    const taken = this.pets.map((p) => p.center());
    let x = px;
    for (const offset of [90 * S, -90 * S, 170 * S, -170 * S, 250 * S, -250 * S]) {
      const cx = px + 75 * S + offset;
      if (cx > w.x0 + 40 * S && cx < w.x1 - 40 * S && taken.every((t) => Math.abs(t - cx) > 60 * S)) {
        x = px + offset;
        break;
      }
    }
    const y = Math.max(w.top - 60 * S, py - 40 * S); // a short hop down onto the same ledge as the others
    const pet = this.add(new Pet(this.ctx, { x, y, sessionId: session.id }));
    pet.send('bubble', { text: labelFor(session), ms: 3500 });
    if (lead) lead.send('flash', { state: 'alert', ms: 1200 }); // "oh, a friend!"
    this.ctx.log(`flock: spawned Clawd ${pet.id} for ${session.id}`);
    return pet;
  }

  // Wave goodbye, fade out, close.
  leave(pet) {
    pet.closing = true;
    pet.send('bubble', { text: 'bye! 👋', ms: 2000 });
    pet.send('flash', { state: 'happy', ms: 2000 });
    this.grabbed(pet); // anyone on his head drops off
    let opacity = 1;
    setTimeout(() => {
      const fade = setInterval(() => {
        opacity -= 0.1;
        if (pet.win) pet.win.setOpacity(Math.max(0, opacity));
        if (opacity <= 0) {
          clearInterval(fade);
          pet.close();
          this.pets = this.pets.filter((p) => p !== pet);
          this.ctx.log(`flock: Clawd ${pet.id} left`);
        }
      }, 60);
    }, 1800);
  }

  // ---------- every 400 ms: riders and housekeeping ----------

  tick() {
    for (const p of this.pets) {
      if (p.closing) continue;
      const g = p.physics.ground;
      if (p.physics.mode !== 'ground' || !g || g.kind !== 'pet') continue;
      const base = g.pet;
      const gone = !this.pets.includes(base) || base.closing || !base.shown;
      if (gone || ['air', 'held', 'teeter'].includes(base.physics.mode)) {
        p.physics.fallFromRest();
        continue;
      }
      // Ride along on his friend's head.
      const h = base.head();
      if (!h) continue;
      const dx = h.x0 - g.x0;
      const dy = h.y - g.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) p.physics.shift(dx, dy);
    }
  }

  // ---------- every 2 s: grouping and socialising ----------

  sameLedge(a, b) {
    const ga = a.physics.ground;
    const gb = b.physics.ground;
    return ga && gb && ga.kind !== 'pet' && gb.kind !== 'pet' && Math.abs(ga.y - gb.y) <= 3
      && a.physics.mode === 'ground' && b.physics.mode === 'ground';
  }

  hangOut() {
    const pets = this.pets.filter((p) => !p.closing && p.shown && p.physics.mode === 'ground');
    if (pets.length < 2) return;
    const now = Date.now();

    // Grouping: drift toward the nearest friend on the same ledge; don't crowd.
    for (const p of pets) {
      const ph = p.physics;
      if (ph.walk || ph.sitting || !FREE.has(ph.activity)) continue;
      const friends = pets.filter((o) => o !== p && this.sameLedge(p, o));
      if (!friends.length) continue;
      const c = p.center();
      const nearest = friends.sort((a, b) => Math.abs(a.center() - c) - Math.abs(b.center() - c))[0];
      const d = nearest.center() - c;
      if (Math.abs(d) > 110 * S && Math.random() < 0.5) {
        const [x] = p.position();
        ph.walkTo(x + d - Math.sign(d) * 60 * S);
      } else if (Math.abs(d) < 34 * S) {
        const [x] = p.position();
        ph.walkTo(x - Math.sign(d || 1) * 30 * S, 40 * S);
      }
    }

    // Socialising: a pair standing near each other does something together.
    for (let i = 0; i < pets.length; i++) {
      for (let j = i + 1; j < pets.length; j++) {
        const a = pets[i];
        const b = pets[j];
        if (!this.sameLedge(a, b) || a.physics.walk || b.physics.walk) continue;
        const d = Math.abs(a.center() - b.center());
        if (d < 36 * S || d > 120 * S) continue;
        const key = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
        if (now - (this.social.get(key) || 0) < SOCIAL_COOLDOWN_MS || Math.random() > 0.35) continue;
        this.social.set(key, now);
        this.interact(a, b);
      }
    }
  }

  interact(a, b) {
    const [left, right] = a.center() < b.center() ? [a, b] : [b, a];
    const busy = (p) => !FREE.has(p.physics.activity);
    const roll = Math.random();
    if (roll < 0.35) {
      // Turn to look at each other.
      if (!busy(left)) left.send('flash', { state: 'lookRight', ms: 2500 });
      if (!busy(right)) right.send('flash', { state: 'lookLeft', ms: 2500 });
      left.send('bubble', { text: '👀', ms: 1500 });
    } else if (roll < 0.6 && !busy(left) && !busy(right)) {
      // High five: both jump at once.
      left.send('flash', { state: 'celebrate', ms: 2200 });
      right.send('flash', { state: 'celebrate', ms: 2200 });
      right.send('bubble', { text: '✋ high five!', ms: 1800 });
    } else {
      // A little chat.
      const [line, reply] = CHATTER[Math.floor(Math.random() * CHATTER.length)];
      left.send('bubble', { text: line, ms: 1800 });
      setTimeout(() => right.send('bubble', { text: reply, ms: 1800 }), 1300);
    }
  }

  dispose() {
    this.timers.forEach(clearInterval);
    for (const p of this.pets) p.close();
  }
}

module.exports = { Flock, FEET_Y };
