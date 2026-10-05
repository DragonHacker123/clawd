// Headless checks for Clawd's logic (no Electron needed): node tools/test.js
const assert = require('assert');
const { Brain, toolActivity, shellActivity, ultraFromText } = require('../src/brain');
const { sanitizeOutfit } = require('../src/outfits');

global.window = {};
require('../renderer/seasonal.js');
const { forDate, easterSunday } = window.ClawdSeasonal;

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    console.error(`FAIL ${name}\n  ${err.message}`);
    process.exitCode = 1;
  }
}

function makeBrain() {
  const sent = [];
  const fakeOutfits = { made: [], make(text) { this.made.push(text); return new Promise(() => {}); } };
  const brain = new Brain({
    send: (channel, payload) => sent.push([channel, payload]),
    outfits: fakeOutfits,
    settings: () => ({ outfits: true, ignoreCwds: [] }),
    onBusyChange: () => {},
  });
  const last = (channel) => [...sent].reverse().find(([c]) => c === channel)?.[1];
  const ev = (session_id, hook_event_name, extra = {}) => brain.hookEvent({ session_id, cwd: 'C:\\proj', hook_event_name, ...extra });
  return { brain, sent, last, ev, fakeOutfits };
}

test('tool -> activity mapping', () => {
  assert.equal(toolActivity('Edit'), 'typing');
  assert.equal(toolActivity('Read'), 'reading');
  assert.equal(toolActivity('Grep'), 'searching');
  assert.equal(toolActivity('Bash', { command: 'npm run build' }), 'building');
  assert.equal(toolActivity('Bash', { command: 'npx jest' }), 'searching');
  assert.equal(toolActivity('WebSearch'), 'fetching');
  assert.equal(toolActivity('Agent'), 'conducting');
  assert.equal(toolActivity('mcp__Claude_Browser__navigate'), 'fetching');
  assert.equal(toolActivity('mcp__something__else'), 'juggling');
  assert.equal(toolActivity('SomethingNew'), 'thinking');
});

test('shell command -> activity', () => {
  const cases = {
    'cat src/brain.js | head -40': 'reading',
    'sed -n 10,40p main.js': 'reading',
    'grep -n foo src/*.js': 'searching',
    'git status --short': 'searching',
    'npm test 2>&1 | tail -1': 'searching',
    "python - <<'EOF'\nprint(1)\nEOF": 'typing',
    'git add -A && git commit -m x': 'typing',
    'curl -s http://127.0.0.1:47321/debug/pets': 'fetching',
    'git push origin main': 'fetching',
    'rm -f snap.png': 'sweeping',
    'npm run build': 'building',
    'powershell -NoProfile -File tools/restart.ps1': 'building',
    'sleep 5': 'thinking',
  };
  for (const [cmd, want] of Object.entries(cases)) assert.equal(shellActivity(cmd), want, cmd);
});

test('ultracode markers in a transcript', () => {
  const on = '{"attachment":{"type":"ultra_effort_enter","reminderType":"full"},"type":"attachment"}';
  const off = '{"attachment":{"type":"ultra_effort_exit"},"type":"attachment"}';
  assert.equal(ultraFromText('{"type":"user"}'), null);
  assert.equal(ultraFromText(on), true);
  assert.equal(ultraFromText(on + '\n' + off), false);
  assert.equal(ultraFromText(off + '\n' + on), true);
  // Talking about the marker (escaped inside a message) doesn't count.
  assert.equal(ultraFromText(JSON.stringify({ text: on })), null);
});

test('ultracode keyword -> hyper for that turn', () => {
  const { ev, last } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'ultracode: rebuild the parser' });
  assert.equal(last('hyper'), true);
  ev('a', 'Stop');
  assert.equal(last('hyper'), false);
});

test('prompt -> thinking, tool -> typing, stop -> happy + idle', () => {
  const { ev, last, sent } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'fix the bug please, the parser crashes' });
  assert.equal(last('activity'), 'thinking');
  ev('a', 'PreToolUse', { tool_name: 'Edit', tool_input: {} });
  assert.equal(last('activity'), 'typing');
  ev('a', 'PostToolUse', { tool_name: 'Edit' });
  assert.equal(last('activity'), 'thinking');
  ev('a', 'Stop');
  assert.equal(last('activity'), null);
  assert.deepEqual(sent.filter(([c]) => c === 'flash').pop()[1].state, 'happy');
});

test('ultrathink prompt', () => {
  const { ev, last } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'ultrathink about this architecture' });
  assert.equal(last('activity'), 'ultrathink');
});

test('tool failure flashes error', () => {
  const { ev, sent } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'run the tests and fix them all' });
  ev('a', 'PostToolUseFailure', { tool_name: 'Bash' });
  assert.equal(sent.filter(([c]) => c === 'flash').pop()[1].state, 'error');
});

test('scheduled tasks never take over or get outfits', () => {
  const { brain, ev, last, fakeOutfits } = makeBrain();
  ev('me', 'UserPromptSubmit', { prompt: 'help me plan my DofE expedition' });
  ev('me', 'Stop');
  ev('cron', 'UserPromptSubmit', { prompt: '<scheduled-task name="tetris-hk-supervisor">keep training alive</scheduled-task>' });
  ev('cron', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(last('activity'), null);
  assert.equal(brain.focusId, 'me');
  assert.equal(fakeOutfits.made.length, 1);
  assert.equal(brain.isBusy(), false);
});

test('focus stays on the session you typed into', () => {
  const { brain, ev, last } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'first session doing some long work' });
  ev('b', 'UserPromptSubmit', { prompt: 'second session about something else' });
  ev('a', 'PreToolUse', { tool_name: 'Edit' });
  assert.equal(brain.focusId, 'b');
  assert.equal(last('activity'), 'thinking'); // b thinking; a gets its own Clawd
  ev('b', 'Stop');
  assert.equal(brain.focusId, 'a');
  assert.equal(last('activity'), 'typing');
});

test('short prompts and slash commands do not trigger outfits', () => {
  const { ev, fakeOutfits } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'hi' });
  ev('a', 'UserPromptSubmit', { prompt: '/compact please now' });
  assert.equal(fakeOutfits.made.length, 0);
  ev('a', 'UserPromptSubmit', { prompt: 'let us talk about sourdough baking' });
  ev('a', 'UserPromptSubmit', { prompt: 'and another long message after that' });
  assert.equal(fakeOutfits.made.length, 1);
});

test('latest outfit wins; chat takes focus', () => {
  const { brain, ev, last } = makeBrain();
  ev('a', 'UserPromptSubmit', { prompt: 'a long running code task here' });
  brain.dress(brain.sessions.get('a'), { id: 'o1', slot: 'head', rects: [] });
  assert.equal(last('outfit').id, 'o1');
  const res = brain.chatEvent({
    action: 'topic', topic: 'wizards', label: 'wizards',
    accessory: { slot: 'hand', rects: [{ x: 15, y: 4, w: 1, h: 6, fill: '#5D4037' }, { x: 14, y: 2, w: 3, h: 3, fill: '#FFD54F' }, { x: 13, y: 3, w: 5, h: 1, fill: '#FFD54F' }] },
  });
  assert.ok(res.ok);
  assert.equal(brain.focusId, 'chat');
  assert.match(last('outfit').id, /^topic-wizards/);
  clearTimeout(brain.chatTimer);
});

test('chat moods validated', () => {
  const { brain } = makeBrain();
  assert.equal(brain.chatEvent({ action: 'mood', mood: 'celebrate' }).ok, true);
  assert.equal(brain.chatEvent({ action: 'mood', mood: '<script>' }).ok, false);
  clearTimeout(brain.chatTimer);
});

test('sanitizeOutfit rejects junk and clips', () => {
  assert.equal(sanitizeOutfit(null), null);
  assert.equal(sanitizeOutfit({ slot: 'hat', rects: [] }), null);
  const o = sanitizeOutfit({
    topic: 'x', slot: 'head',
    rects: [
      { x: 0, y: 0, w: 2, h: 2, fill: '#FF0000' },
      { x: 1, y: 1, w: 1, h: 1, fill: 'red' }, // bad colour
      { x: 1, y: 1, w: 1, h: 1, fill: '#00FF00" onload="x' }, // injection
      { x: 'a', y: 1, w: 1, h: 1, fill: '#00FF00' },
      { x: 100, y: 0, w: 5, h: 5, fill: '#0000FF' }, // fully off canvas
      { x: 25, y: 0, w: 10, h: 2, fill: '#0000FF' }, // clipped
      { x: 3, y: 3, w: 1, h: 1, fill: '#123456' },
    ],
  });
  assert.equal(o.rects.length, 3);
  assert.equal(o.rects[1].w, 2); // 25..27
});

test('easter dates', () => {
  assert.deepEqual(easterSunday(2024), [3, 31]);
  assert.deepEqual(easterSunday(2025), [4, 20]);
  assert.deepEqual(easterSunday(2026), [4, 5]);
  assert.deepEqual(easterSunday(2027), [3, 28]);
  assert.deepEqual(easterSunday(2038), [4, 25]);
});

test('seasonal outfits by date', () => {
  const ids = (d) => forDate(new Date(d + 'T12:00:00')).map((a) => a.id);
  assert.deepEqual(ids('2026-12-01'), ['santa-hat']);
  assert.deepEqual(ids('2026-12-31'), ['santa-hat']);
  assert.deepEqual(ids('2026-11-30'), []);
  assert.deepEqual(ids('2027-06-04'), ['party-hat', 'confetti']);
  assert.deepEqual(ids('2027-06-05'), []);
  assert.deepEqual(ids('2027-03-28'), ['easter-bunny', 'easter-egg']);
  assert.deepEqual(ids('2027-03-29'), []);
});

console.log(`${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
process.exit(process.exitCode || 0);
