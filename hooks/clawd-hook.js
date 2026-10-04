#!/usr/bin/env node
// Claude Code hook -> Clawd. Reads the hook's JSON from stdin and forwards it
// to the pet's localhost server. Must never block or break Claude: it prints
// nothing, gives up after a short timeout, and always exits 0.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Runs started by Clawd's own outfit generator must not feed back into him.
if (process.env.CLAWD_GEN) process.exit(0);

const PORT = 47321;
const TIMEOUT_MS = 700;
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

setTimeout(() => process.exit(0), 1500).unref();

let token;
try {
  token = fs.readFileSync(path.join(appData, 'clawd-desktop', 'token.txt'), 'utf8').trim();
} catch {
  process.exit(0); // pet not installed / never started
}

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', () => {
  const body = Buffer.concat(chunks);
  const req = http.request({
    host: '127.0.0.1',
    port: PORT,
    path: '/event',
    method: 'POST',
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
      'X-Clawd-Token': token,
      'X-Clawd-Entrypoint': process.env.CLAUDE_CODE_ENTRYPOINT || '',
    },
  });
  const done = () => process.exit(0);
  req.on('response', (res) => {
    res.resume();
    res.on('end', done);
  });
  req.on('timeout', () => req.destroy());
  req.on('error', done);
  req.end(body);
});
