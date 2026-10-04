#!/usr/bin/env node
// MCP server (stdio) that lets Claude chat dress up and animate Clawd.
// Registered in the Claude desktop app's claude_desktop_config.json. No
// dependencies: speaks newline-delimited JSON-RPC directly.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const PORT = 47321;
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const tokenFile = path.join(appData, 'clawd-desktop', 'token.txt');

const GRID = 'Grid: x to the right, y DOWN, 1 unit = 1 big pixel. Clawd\'s body is a solid orange (#DE886D) block x 2..13, y 6..13 '
  + '(top of head is y=6), black eyes at x 4..5 and 10..11, y 8..10, arm stubs at x 0..2 and 13..15, y 9..11, legs y 13..15, ground y=15. '
  + 'Slots: "head" = rests on top of the head (bottom edge y=6, up to y=0, x 1..14); "face" = over the eyes (y 7..11); '
  + '"back" = drawn behind the body, so only parts outside x 2..13 or above y 6 show; make it stick out 3-5 units to a side or above the head; '
  + '"body" = on the front of the torso, keep the eyes clear; "companion" = a separate small object or creature on the ground beside him at x 16..26, y 4..15. '
  + 'Use 8-40 rects, steps of 0.5, hex colours "#RRGGBB", bold silhouette with strong contrast to orange.';

const INSTRUCTIONS = 'Clawd is a small pixel-art mascot on the user\'s desktop who dresses up to match the conversation. '
  + 'Near the start of each new conversation, once you know what it is about, call clawd_set_topic once (and again only if the subject clearly changes). '
  + 'Prefer drawing the accessory yourself in the call. Do not mention Clawd or these calls to the user unless they ask about him.';

const TOOLS = [
  {
    name: 'clawd_set_topic',
    description: 'Dress Clawd, the user\'s desktop mascot, in an accessory that matches what this conversation is about '
      + '(e.g. talking about a Duke of Edinburgh expedition -> a hiking backpack). Call once near the start of a conversation, '
      + 'and again only if the topic clearly changes. Draw the accessory as pixel rects. ' + GRID,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: '2-4 word topic, e.g. "DofE expedition"' },
        emoji: { type: 'string', description: 'One emoji for the topic' },
        accessory: {
          type: 'object',
          description: 'The accessory to draw. If omitted, Clawd will design one himself (slower).',
          properties: {
            name: { type: 'string', description: 'e.g. "hiking backpack"' },
            slot: { type: 'string', enum: ['head', 'face', 'back', 'body', 'companion'] },
            rects: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' },
                  fill: { type: 'string', description: '#RRGGBB' },
                },
                required: ['x', 'y', 'w', 'h', 'fill'],
              },
            },
          },
          required: ['slot', 'rects'],
        },
      },
      required: ['topic'],
    },
  },
  {
    name: 'clawd_react',
    description: 'Make Clawd, the user\'s desktop mascot, do a short reaction to a moment in the conversation '
      + '(e.g. celebrate when something works, look confused at a puzzle). Use sparingly.',
    inputSchema: {
      type: 'object',
      properties: {
        mood: { type: 'string', enum: ['happy', 'celebrate', 'excited', 'thinking', 'confused', 'surprised', 'sleepy'] },
      },
      required: ['mood'],
    },
  },
];

function post(body) {
  return new Promise((resolve) => {
    let token;
    try {
      token = fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return resolve({ ok: false, message: 'Clawd is not running on this computer.' });
    }
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/chat', method: 'POST', timeout: 3000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, 'X-Clawd-Token': token },
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(out));
        } catch {
          resolve({ ok: false, message: 'Clawd gave a confusing answer.' });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ ok: false, message: 'Clawd is not running right now.' }));
    req.end(data);
  });
}

async function callTool(name, args = {}) {
  if (name === 'clawd_set_topic') {
    const label = `${args.emoji || ''} ${args.topic || ''}`.trim();
    const accessory = args.accessory ? { ...args.accessory, emoji: args.emoji } : null;
    return post({ action: 'topic', topic: args.topic, label, accessory });
  }
  if (name === 'clawd_react') return post({ action: 'mood', mood: args.mood });
  return { ok: false, message: `Unknown tool ${name}` };
}

function write(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notification
  try {
    if (method === 'initialize') {
      return write({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: (params && params.protocolVersion) || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'clawd', version: '2.0.0' },
          instructions: INSTRUCTIONS,
        },
      });
    }
    if (method === 'ping') return write({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return write({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      const res = await callTool(params.name, params.arguments || {});
      return write({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: res.message || (res.ok ? 'Done.' : 'Failed.') }], isError: !res.ok },
      });
    }
    write({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (err) {
    write({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  handle(msg);
});
