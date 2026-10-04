// Tiny localhost-only HTTP server that Claude Code hooks and the chat MCP
// server post events to. Requests must carry the token from token.txt in the
// app's data folder, and browser requests (anything with an Origin) are refused,
// so web pages can't drive the pet or burn generation usage.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const PORT = 47321;
// PostToolUse payloads carry whole tool results (file contents), so allow big bodies.
const MAX_BODY = 32 * 1024 * 1024;

function loadToken() {
  const file = path.join(app.getPath('userData'), 'token.txt');
  try {
    const token = fs.readFileSync(file, 'utf8').trim();
    if (token.length >= 32) return token;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, token);
  return token;
}

function startServer(brain, debug = {}) {
  const token = loadToken();
  const server = http.createServer((req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.origin || req.headers['x-clawd-token'] !== token) return reply(403, { error: 'forbidden' });
    if (req.method === 'GET' && req.url === '/health') return reply(200, { ok: true });
    if (req.method === 'GET' && req.url === '/debug/state') return reply(200, brain.debugState());
    if (req.method === 'GET' && req.url === '/debug/physics' && debug.physicsState) return reply(200, debug.physicsState());
    if (req.method === 'GET' && req.url === '/debug/clicks' && debug.clicks) return reply(200, debug.clicks());
    if (req.method === 'GET' && req.url === '/debug/surfaces' && debug.surfacesDebug) {
      debug.surfacesDebug().then((r) => reply(200, r), (err) => reply(500, { error: String(err.stack || err) }));
      return;
    }
    if (req.method === 'POST' && req.url === '/debug/settle' && debug.settleNow) {
      debug.settleNow();
      return reply(200, { ok: true });
    }
    if (req.method === 'GET' && req.url === '/debug/snap' && debug.snap) {
      debug.snap().then((png) => {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(png);
      }, (err) => reply(500, { error: String(err) }));
      return;
    }
    if (req.method !== 'POST') return reply(405, { error: 'method' });

    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) req.destroy();
      else chunks.push(c);
    });
    req.on('end', () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return reply(400, { error: 'json' });
      }
      try {
        if (req.url === '/event') {
          brain.hookEvent(body, { entrypoint: req.headers['x-clawd-entrypoint'] || '' });
          // Claude Code http hooks treat any response body as hook output; stay silent.
          res.writeHead(204);
          return res.end();
        }
        if (req.url === '/chat') return reply(200, brain.chatEvent(body));
        if (req.url === '/debug/drop' && debug.dropAt) {
          debug.dropAt(body);
          return reply(200, { ok: true });
        }
        if (req.url === '/debug/force-interactive' && debug.forceInteractive) {
          debug.forceInteractive(body.ms);
          return reply(200, { ok: true });
        }
        if (req.url === '/debug/input' && debug.input) {
          debug.input(body.events || []);
          return reply(200, { ok: true });
        }
        return reply(404, { error: 'route' });
      } catch (err) {
        console.error('event failed', err);
        return reply(500, { error: String(err.message || err) });
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer, PORT };
