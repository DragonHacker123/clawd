// Turns Claude Code hook events and chat MCP calls into what Clawd should be
// doing. Several Claude sessions can run at once; Clawd follows the one you
// most recently typed into, and only falls back to another busy session when
// that one goes quiet.
const path = require('path');
const { sanitizeOutfit } = require('./outfits');

const STALE_MS = 10 * 60 * 1000;
const MIN_TOPIC_PROMPT = 15;
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

class Brain {
  constructor({ send, outfits, settings, onBusyChange, onPosture = () => {} }) {
    this.onPosture = onPosture;
    this.sitting = false;
    setInterval(() => this.publish(), 5000).unref?.();
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
      this.sessions.set(id, { id, cwd, busy: false, background: false, activity: null, lastEvent: 0, lastPrompt: 0, outfit: null, outfitAsked: false });
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
    this.refocus();
    this.publish();
  }

  isFocus(s) {
    this.refocus();
    return this.focusId === s.id;
  }

  // Stay on the session you last typed into while it's busy; otherwise follow
  // the busiest recent session; otherwise keep the last one (for its outfit).
  refocus() {
    const focus = this.sessions.get(this.focusId);
    if (focus && focus.busy) return;
    const busy = [...this.sessions.values()].filter((s) => s.busy && !s.background).sort((a, b) => b.lastPrompt - a.lastPrompt);
    if (busy.length) this.focusId = busy[0].id;
  }

  maybeDress(s, text) {
    if (s.outfitAsked || !this.settings().outfits) return;
    const clean = text.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').trim();
    if (clean.length < MIN_TOPIC_PROMPT || clean.startsWith('/')) return;
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
    this.publish();
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
    const outfit = this.currentOutfit();
    const outfitId = outfit ? outfit.id : null;
    if (outfitId !== this.shown.outfitId) {
      if (outfit && this.shown.outfitId !== undefined) this.send('flash', { state: 'wizard', ms: 2200 });
      this.shown.outfitId = outfitId;
      this.send('outfit', outfit);
    }
    const sit = !!(focus && focus.busy && focus.busySince && Date.now() - focus.busySince > LONG_TASK_MS);
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

module.exports = { Brain, toolActivity, shellActivity };
