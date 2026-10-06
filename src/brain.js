// Turns Claude Code hook events and chat MCP calls into what Clawd should be
// doing. Several Claude sessions can run at once; Clawd follows the one you
// most recently typed into, and only falls back to another busy session when
// that one goes quiet.
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { sanitizeOutfit } = require('./outfits');

const STALE_MS = 10 * 60 * 1000;
const MIN_TOPIC_PROMPT = 15;
// A session counts as open (and gets its own Clawd) this long after its last sign of life.
const OPEN_MS = 45 * 60 * 1000;
const OUTFIT_MEMORY_DAYS = 14;
const CHAT_BUSY_MS = 2 * 60 * 1000; // after a topic/mood call
const CHAT_WORK_MS = 10 * 60 * 1000; // after "working", unless "done" comes first
const LONG_TASK_MS = 90 * 1000; // busy this long on one prompt: he sits down
const MOODS = ['happy', 'celebrate', 'excited', 'thinking', 'confused', 'surprised', 'sleepy'];

// A shell command can be anything, so look at what it does. Checked in order:
// the first match wins, so e.g. "npm test | grep fail" counts as testing.
const SHELL_KINDS = [
  ['searching', /\b(test|tests|pytest|jest|vitest|mocha|lint|eslint|cargo test|go test)\b/],
  ['sweeping', /(^|[;&|]\s*)(rm|rmdir|del|remove-item|git clean|git stash)\b|\b(clean|prune|cleanup)\b/],
  ['fetching', /\b(curl|wget|invoke-webrequest|invoke-restmethod|iwr|irm|ssh|scp|rsync|git (push|pull|fetch|clone)|gh (api|pr|repo|issue|run)|npm (install|i|ci)|pip install|yarn add|pnpm (add|install))\b/],
  ['typing', /<<\s*'?\w+|\bsed -i\b|\btee\b|>\s*[\w./~"$-]|\b(set-content|add-content|out-file|new-item|copy-item|move-item|patch|mkdir|cp|mv)\b|\bgit (commit|add|apply|mv)\b/],
  ['searching', /(^|[;&|(]\s*)(grep|rg|find|fd|ls|dir|tree|where|which|get-childitem|select-string|du|wc|git (status|log|diff|show|grep|blame|branch))\b/],
  ['reading', /(^|[;&|(]\s*)(cat|head|tail|less|more|type|get-content|sed -n|awk|jq|bat)\b/],
  ['thinking', /(^|[;&|(]\s*)(sleep|start-sleep|wait|timeout)\b/],
];

function shellActivity(command = '') {
  const cmd = String(command).toLowerCase();
  for (const [kind, re] of SHELL_KINDS) if (re.test(cmd)) return kind;
  return 'building'; // compiling, running scripts, anything else
}

function toolActivity(name = '', input = {}) {
  const n = name.toLowerCase();
  if (['edit', 'write', 'multiedit', 'notebookedit'].includes(n)) return 'typing';
  if (n === 'read') return 'reading';
  if (['grep', 'glob', 'ls', 'toolsearch'].includes(n)) return 'searching';
  if (n === 'bash' || n === 'powershell') return shellActivity(input.command);
  if (['websearch', 'webfetch'].includes(n)) return 'fetching';
  if (['agent', 'task', 'sendmessage'].includes(n)) return 'conducting';
  if (['todowrite', 'taskcreate', 'taskupdate'].includes(n)) return 'sweeping';
  if (n === 'skill') return 'wizard';
  if (['askuserquestion', 'exitplanmode'].includes(n)) return 'attention';
  if (n.startsWith('mcp__')) {
    if (/browser|navigate|chrome|fetch|web/.test(n)) return 'fetching';
    if (/computer|click|type|screenshot/.test(n)) return 'typing';
    return 'juggling';
  }
  return 'thinking';
}

// ---------- ultracode ----------
// Hook events don't say which effort a session runs at, but its transcript
// (whose path every hook event carries) does: each of Claude's replies is
// stamped with that turn's effort, and the desktop app's "Ultracode" is effort
// xhigh. Switching the ultracode setting in the CLI also leaves an
// ultra_effort_enter / ultra_effort_exit marker. Whichever comes last wins.
// (Quotes inside messages are escaped in the transcript, so talking about
// these strings never matches.)
const ULTRA_SIGNS = /"attachment":\{"type":"ultra_effort_(enter|exit)"/g;
const CHUNK = 1024 * 1024;
const MAX_BACK = 64 * CHUNK; // give up looking further back than this

// true (on), false (off) or null (nothing about it in this text).
function ultraFromText(text) {
  let last = null;
  for (const m of text.matchAll(ULTRA_SIGNS)) last = m;
  if (!last) return null;
  return last[1] === 'enter';
}

async function readSlice(fh, start, end) {
  const buf = Buffer.alloc(end - start);
  const { bytesRead } = await fh.read(buf, 0, buf.length, start);
  return buf.toString('utf8', 0, bytesRead);
}

// The newest marker in bytes [from, size) of the transcript; reading
// backwards from the end when from is null (first look at a session).
async function ultraMarker(file, from, size) {
  const fh = await fsp.open(file, 'r');
  try {
    if (from !== null) {
      for (let end = size; end > from; end -= CHUNK) {
        const found = ultraFromText(await readSlice(fh, Math.max(from - 100, end - CHUNK - 100, 0), end));
        if (found !== null) return found;
      }
      return null;
    }
    for (let end = size; end > 0 && size - end < MAX_BACK; end -= CHUNK) {
      const found = ultraFromText(await readSlice(fh, Math.max(0, end - CHUNK - 100), end));
      if (found !== null) return found;
    }
    return null;
  } finally {
    await fh.close();
  }
}

// Who a transcript belongs to: cwd, entrypoint, and whether it's a scheduled
// task (their first prompt starts with <scheduled-task ...>).
async function transcriptInfo(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const head = await readSlice(fh, 0, Math.min(size, 256 * 1024));
    const tail = await readSlice(fh, Math.max(0, size - 64 * 1024), size);
    const cwd = (tail.match(/"cwd":"((?:[^"\\]|\\.)*)"/g) || []).pop();
    const entry = (tail.match(/"entrypoint":"([^"]*)"/) || [])[1] || '';
    return {
      cwd: cwd ? JSON.parse(cwd.slice(6)) : '',
      entrypoint: entry,
      background: /"content":"\s*<scheduled-task\b/.test(head) || /"content":\[\{"type":"text","text":"\s*<scheduled-task\b/.test(head),
    };
  } finally {
    await fh.close();
  }
}

// The newest thing you typed in a transcript (not tool results or reminders).
async function lastUserPrompt(file) {
  try {
    const fh = await fsp.open(file, 'r');
    try {
      const { size } = await fh.stat();
      for (let back = 512 * 1024; ; back *= 4) {
        const text = await readSlice(fh, Math.max(0, size - back), size);
        const lines = text.split('\n').reverse();
        for (const line of lines) {
          if (!line.includes('"type":"user"') || line.includes('"tool_result"') || line.includes('"isMeta":true')) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          const c = msg && msg.message && msg.message.content;
          const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((p) => p.type === 'text').map((p) => p.text).join(' ') : '';
          const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').trim();
          if (clean.length >= MIN_TOPIC_PROMPT && !clean.startsWith('/')) return clean.slice(0, 2000);
        }
        if (back >= size || back > 32 * 1024 * 1024) return null;
      }
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

class Brain {
  constructor({ send, outfits, settings, onBusyChange, onPosture = () => {}, memoryFile = null, visible = () => null, appUltra = () => undefined }) {
    // The app's own Ultracode switch for a session (true/false/undefined).
    this.appUltra = appUltra;
    // Sessions on screen in the app (a Set of ids), or null when unknown.
    this.visible = visible;
    this.memoryFile = memoryFile; // outfits per session, so a restart doesn't undress everyone
    this.memory = this.loadMemory();
    this.onPosture = onPosture;
    this.sitting = false;
    setInterval(() => {
      // A turn can run a long time without tool calls: keep checking its effort.
      for (const s of this.sessions.values()) if (s.busy && !s.background) this.checkUltra(s);
      this.publish();
    }, 5000).unref?.();
    this.send = send;
    this.outfits = outfits;
    this.settings = settings;
    this.onBusyChange = onBusyChange;
    this.sessions = new Map();
    this.focusId = null;
    this.outfitSeq = 0;
    this.shown = { activity: undefined, outfitId: undefined };
    this.wasBusy = false;
    setInterval(() => this.sweep(), 30 * 1000).unref?.();
  }

  ignored(ev, meta) {
    const s = this.settings();
    const cwd = String(ev.cwd || '').toLowerCase();
    if ((s.ignoreCwds || []).some((p) => p && cwd.includes(String(p).toLowerCase()))) return true;
    // Headless runs (claude -p, SDK, scheduled tasks) aren't you typing.
    const entry = String(meta.entrypoint || '').toLowerCase();
    return entry === 'sdk-cli' || entry === 'sdk-ts' || entry === 'sdk-py';
  }

  session(id, cwd) {
    if (!this.sessions.has(id)) {
      const s = { id, cwd, busy: false, background: false, activity: null, lastEvent: 0, lastPrompt: 0, outfit: null, outfitAsked: false, fresh: true };
      const saved = this.memory[id];
      if (saved && saved.outfit) {
        s.outfit = { ...saved.outfit, assignedAt: ++this.outfitSeq };
        s.outfitAsked = true;
      }
      this.sessions.set(id, s);
    }
    return this.sessions.get(id);
  }

  hookEvent(ev, meta = {}) {
    if (!ev || !ev.session_id || this.ignored(ev, meta)) return;
    const s = this.session(ev.session_id, ev.cwd);
    // Scheduled tasks (e.g. the Tetris/HK supervisor) look exactly like you on
    // every field except their prompt, which starts with <scheduled-task ...>.
    // Once spotted, that session is background for good and Clawd ignores it.
    if (ev.hook_event_name === 'UserPromptSubmit' && /^\s*<scheduled-task\b/.test(String(ev.prompt || ''))) {
      s.background = true;
    }
    if (s.background) {
      if (ev.hook_event_name === 'SessionEnd') this.sessions.delete(s.id);
      return;
    }
    const t = Date.now();
    s.lastEvent = t;

    switch (ev.hook_event_name) {
      case 'UserPromptSubmit': {
        const prompt = String(ev.prompt || '');
        if (!s.busy) s.busySince = t;
        s.busy = true;
        s.lastPrompt = t;
        s.activity = /ultrathink|think (really )?hard/i.test(prompt) ? 'ultrathink' : 'thinking';
        this.focusId = s.id;
        this.maybeDress(s, prompt);
        break;
      }
      case 'PreToolUse':
        s.busy = true;
        s.activity = toolActivity(ev.tool_name, ev.tool_input || {});
        break;
      case 'PostToolUse':
        s.activity = 'thinking';
        break;
      case 'PostToolUseFailure':
        s.activity = 'thinking';
        if (this.isFocus(s)) this.send('flash', { state: 'error', ms: 2500 });
        break;
      case 'Notification':
        if (ev.notification_type === 'idle_prompt') break;
        if (/permission|waiting|needs your/i.test(String(ev.message || '')) || ev.notification_type === 'permission_prompt') {
          s.activity = 'attention';
        }
        break;
      case 'Stop':
        s.busy = false;
        s.activity = null;
        if (this.isFocus(s)) this.send('flash', { state: 'happy', ms: 2600 });
        break;
      case 'StopFailure':
        s.busy = false;
        s.activity = null;
        if (this.isFocus(s)) this.send('flash', { state: 'error', ms: 3000 });
        break;
      case 'SessionEnd':
        this.sessions.delete(s.id);
        if (this.focusId === s.id) this.focusId = null;
        break;
      default:
        break;
    }
    if (ev.transcript_path) s.transcriptPath = String(ev.transcript_path);
    if (s.fresh) {
      s.fresh = false;
      if (ev.hook_event_name !== 'UserPromptSubmit') this.dressFromTranscript(s);
    }
    s.ultra = this.ultraOf(s);
    this.checkUltra(s, ev.hook_event_name === 'UserPromptSubmit');
    this.refocus();
    this.publish();
  }

  // Has ultracode been switched on or off in this session? Reads only what
  // was added to the transcript since the last look (at most every 3 s).
  async checkUltra(s, force = false) {
    const file = s.transcriptPath;
    if (!file || s.ultraBusy) return;
    const t = Date.now();
    if (!force && t - (s.ultraChecked || 0) < 3000) return;
    s.ultraBusy = true;
    s.ultraChecked = t;
    try {
      const { size } = await fsp.stat(file);
      if (s.ultraFile !== file || size < (s.ultraOffset || 0)) {
        s.ultraFile = file;
        s.ultraOffset = null;
      }
      const found = await ultraMarker(file, s.ultraOffset, size);
      s.ultraOffset = size;
      if (found !== null) s.ultraSession = found;
    } catch {
      // transcript unreadable: keep what we knew
    } finally {
      s.ultraBusy = false;
    }
    const ultra = this.ultraOf(s);
    if (ultra !== s.ultra) {
      s.ultra = ultra;
      this.publish();
    }
  }

  // Ultracode: the app's switch when it knows the session, otherwise the
  // CLI's transcript markers.
  ultraOf(s) {
    const app = this.appUltra(s.id);
    // (Not the word "ultracode" in a prompt: talking about it would set him off.)
    return !!(app === undefined ? s.ultraSession : app);
  }

  // The app's switch changed (no hook event for that): re-check everyone.
  refreshUltra() {
    for (const s of this.sessions.values()) s.ultra = this.ultraOf(s);
    this.publish();
  }

  isFocus(s) {
    this.refocus();
    return this.focusId === s.id;
  }

  // Stay on the session you last typed into while it's busy; otherwise follow
  // the busiest recent session; otherwise keep the last one (for its outfit).
  refocus() {
    const shown = this.visible();
    const onScreen = (s) => !shown || shown.has(s.id) || s.id === 'chat';
    let focus = this.sessions.get(this.focusId);
    if (focus && !onScreen(focus)) {
      this.focusId = null;
      focus = null;
    }
    if (focus && focus.busy) return;
    const busy = [...this.sessions.values()].filter((s) => s.busy && !s.background && onScreen(s)).sort((a, b) => b.lastPrompt - a.lastPrompt);
    if (busy.length) this.focusId = busy[0].id;
    // Nothing busy and no (live) focus, e.g. just after a restart: the main
    // Clawd takes the most recently active open session.
    else if (!focus) {
      const open = [...this.sessions.values()].filter((x) => !x.background && onScreen(x)).sort((a, b) => b.lastEvent - a.lastEvent);
      if (open.length) this.focusId = open[0].id;
    }
  }

  maybeDress(s, text) {
    if (!this.settings().outfits) return;
    const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').trim();
    if (clean.length < MIN_TOPIC_PROMPT || clean.startsWith('/')) return;
    // Already dressed: re-dress only when this message is about something new.
    if (s.outfitAsked) {
      if (!s.outfit || s.topicCheck || !this.outfits.topicChanged) return;
      s.topicCheck = true;
      this.outfits
        .topicChanged(s.outfit.topic || s.outfit.label || s.outfit.name, clean)
        .then((changed) => {
          s.topicCheck = false;
          if (!changed || !this.sessions.has(s.id)) return;
          s.outfitAsked = false;
          this.maybeDress(s, clean);
        })
        .catch((err) => {
          s.topicCheck = false;
          console.error('topic check failed', err);
        });
      return;
    }
    s.outfitAsked = true;
    this.outfits
      .make(clean, { avoidSlots: this.seasonalSlots(), where: path.basename(String(s.cwd || '')) })
      .then((outfit) => {
        if (!outfit || !this.sessions.has(s.id)) return;
        this.dress(s, outfit);
      })
      .catch((err) => console.error('outfit failed', err));
  }

  seasonalSlots() {
    const d = new Date();
    return d.getMonth() === 11 || (d.getMonth() === 5 && d.getDate() === 4) ? ['head'] : [];
  }

  chatEvent(body = {}) {
    // A chat tool call means Claude chat is working on something for you, so
    // chat takes focus and counts as busy ("chatting": he does his normal idle
    // animations in costume and doesn't fall asleep) until it says it's done,
    // or for a while after a topic/mood call.
    const chat = this.session('chat', '');
    const t = Date.now();
    chat.lastEvent = t;
    chat.lastPrompt = t;
    if (!chat.busy) chat.busySince = t;
    chat.busy = true;
    chat.activity = 'chatting';
    this.focusId = 'chat';
    const done = body.action === 'status' && body.state === 'done';
    this.chatBusyFor(done ? 0 : body.action === 'status' ? CHAT_WORK_MS : CHAT_BUSY_MS);
    if (done) {
      this.send('flash', { state: 'happy', ms: 2600 });
      return { ok: true, message: 'Clawd knows you are done.' };
    }
    if (body.action === 'status') {
      this.publish();
      return { ok: true, message: 'Clawd will stay awake while you work.' };
    }
    this.publish();

    if (body.action === 'mood') {
      if (!MOODS.includes(body.mood)) return { ok: false, message: `mood must be one of ${MOODS.join(', ')}` };
      this.send('flash', { state: body.mood, ms: 3200 });
      return { ok: true, message: 'Clawd reacted.' };
    }
    if (body.action === 'topic') {
      if (!this.settings().outfits) return { ok: true, message: 'Topic outfits are switched off.' };
      const drawn = body.accessory && sanitizeOutfit({ ...body.accessory, topic: body.topic, label: body.label });
      if (drawn) {
        this.dress(chat, drawn);
        return { ok: true, message: `Clawd is now wearing: ${drawn.name || drawn.topic}.` };
      }
      this.outfits
        .make(String(body.topic || ''), { avoidSlots: this.seasonalSlots(), isTopic: true })
        .then((outfit) => {
          if (!outfit) return;
          this.dress(chat, outfit);
        })
        .catch((err) => console.error('outfit failed', err));
      return { ok: true, message: 'Clawd is picking an outfit for that topic.' };
    }
    return { ok: false, message: 'Unknown action.' };
  }

  dress(s, outfit) {
    s.outfit = { ...outfit, assignedAt: ++this.outfitSeq };
    this.memory[s.id] = { outfit, at: Date.now() };
    this.saveMemory();
    this.publish();
  }

  loadMemory() {
    if (!this.memoryFile) return {};
    try {
      const all = JSON.parse(fs.readFileSync(this.memoryFile, 'utf8'));
      const cutoff = Date.now() - OUTFIT_MEMORY_DAYS * 24 * 60 * 60 * 1000;
      return Object.fromEntries(Object.entries(all).filter(([, v]) => v && v.at > cutoff));
    } catch {
      return {};
    }
  }

  saveMemory() {
    if (!this.memoryFile) return;
    try {
      fs.mkdirSync(path.dirname(this.memoryFile), { recursive: true });
      fs.writeFileSync(this.memoryFile, JSON.stringify(this.memory));
    } catch {}
  }

  // A session seen for the first time mid-conversation (e.g. after Clawd
  // restarted) has no prompt to dress for: use its latest one from the transcript.
  async dressFromTranscript(s) {
    if (s.outfitAsked || !s.transcriptPath || !this.settings().outfits) return;
    const prompt = await lastUserPrompt(s.transcriptPath);
    if (prompt && !s.outfitAsked) this.maybeDress(s, prompt);
  }

  // At startup: sessions whose transcript changed recently are probably open
  // in the app (maybe side by side), so they get their Clawds straight away
  // instead of when they next do something. Idle until they send an event.
  async discover(projectsDir, withinMs = OPEN_MS) {
    let dirs;
    try {
      dirs = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const now = Date.now();
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      let files;
      try {
        files = await fsp.readdir(path.join(projectsDir, d.name));
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const file = path.join(projectsDir, d.name, f);
        const id = f.slice(0, -6);
        if (this.sessions.has(id)) continue;
        try {
          const st = await fsp.stat(file);
          if (now - st.mtimeMs > withinMs) continue;
          const info = await transcriptInfo(file);
          if (!info || info.background) continue;
          if (this.ignored({ cwd: info.cwd }, { entrypoint: info.entrypoint })) continue;
          const s = this.session(id, info.cwd);
          s.transcriptPath = file;
          s.lastEvent = st.mtimeMs;
          s.fresh = false;
          this.checkUltra(s, true);
          this.dressFromTranscript(s);
        } catch {}
      }
    }
    this.refocus();
    this.publish();
  }

  // The app's layout changed: sessions now on screen that we haven't heard
  // from get created from their transcripts (idle until they do something).
  async adoptVisible(projectsDir, info = new Map()) {
    const shown = this.visible();
    if (!shown) return;
    for (const id of shown) {
      if (this.sessions.has(id)) continue;
      let file = null;
      try {
        for (const d of await fsp.readdir(projectsDir)) {
          const f = path.join(projectsDir, d, id + '.jsonl');
          if (fs.existsSync(f)) {
            file = f;
            break;
          }
        }
      } catch {}
      const s = this.session(id, (info.get(id) || {}).cwd || '');
      s.fresh = false;
      if (file) {
        s.transcriptPath = file;
        this.checkUltra(s, true);
        this.dressFromTranscript(s);
      }
    }
    this.refocus();
    this.publish();
  }

  // Sessions open right now: each gets a Clawd (busy or not).
  openSessions() {
    const t = Date.now();
    const shown = this.visible();
    return [...this.sessions.values()]
      .filter((s) => !s.background && (shown ? shown.has(s.id) || (s.id === 'chat' && s.busy) : s.busy || t - s.lastEvent < OPEN_MS))
      .sort((a, b) => b.lastPrompt - a.lastPrompt || b.lastEvent - a.lastEvent);
  }

  // He wears the outfit of whichever conversation most recently got one.
  currentOutfit() {
    let best = null;
    for (const s of this.sessions.values()) {
      if (!s.background && s.outfit && (!best || s.outfit.assignedAt > best.assignedAt)) best = s.outfit;
    }
    return best;
  }

  chatBusyFor(ms) {
    const chat = this.sessions.get('chat');
    clearTimeout(this.chatTimer);
    const end = () => {
      if (!chat) return;
      chat.busy = false;
      chat.activity = null;
      this.refocus();
      this.publish();
    };
    if (ms <= 0) end();
    else this.chatTimer = setTimeout(end, ms);
  }

  // Everything happening right now (busy, not a background task), most recent first.
  activeSessions() {
    return [...this.sessions.values()]
      .filter((s) => s.busy && !s.background)
      .sort((a, b) => b.lastPrompt - a.lastPrompt);
  }

  clearOutfit() {
    for (const s of this.sessions.values()) s.outfit = null;
    this.publish();
  }

  debugState() {
    return { focusId: this.focusId, shown: this.shown, sessions: [...this.sessions.values()].map(({ outfit, ...s }) => ({ ...s, outfit: outfit && outfit.label })) };
  }

  isBusy() {
    return [...this.sessions.values()].some((s) => s.busy && !s.background);
  }

  sweep() {
    const t = Date.now();
    for (const s of this.sessions.values()) {
      if (s.busy && t - s.lastEvent > STALE_MS) {
        s.busy = false;
        s.activity = null;
      }
      if (!s.busy && s.id !== this.focusId && t - s.lastEvent > 6 * 60 * 60 * 1000) this.sessions.delete(s.id);
    }
    this.refocus();
    this.publish();
  }

  publish() {
    const focus = this.sessions.get(this.focusId);
    let activity = focus && focus.busy ? focus.activity : null;
    const busyCount = [...this.sessions.values()].filter((s) => s.busy && !s.background).length;
    if (activity !== this.shown.activity) {
      this.shown.activity = activity;
      this.send('activity', activity);
    }
    const outfit = (focus && focus.outfit) || null;
    const outfitId = outfit ? outfit.id : null;
    if (outfitId !== this.shown.outfitId) {
      if (outfit && this.shown.outfitId !== undefined) this.send('flash', { state: 'wizard', ms: 2200 });
      this.shown.outfitId = outfitId;
      this.send('outfit', outfit);
    }
    // Ultracode: he's hyper (runs, hops, climbs walls) and never sits down.
    const hyper = !!(focus && focus.ultra);
    if (hyper !== this.shown.hyper) {
      this.shown.hyper = hyper;
      this.send('hyper', hyper);
    }
    const sit = !hyper && !!(focus && focus.busy && focus.busySince && Date.now() - focus.busySince > LONG_TASK_MS);
    if (sit !== this.sitting) {
      this.sitting = sit;
      this.onPosture(sit);
    }
    const busy = busyCount > 0;
    if (busy !== this.wasBusy) {
      this.wasBusy = busy;
      this.onBusyChange(busy);
    }
  }
}

module.exports = { Brain, toolActivity, shellActivity, ultraFromText, ultraMarker };
