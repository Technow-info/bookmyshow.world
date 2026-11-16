'use strict';
// Test helpers: fake SMTP (465 TLS / 587 STARTTLS), fake Stripe API, and a server launcher.
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const http = require('http');

const FIX = path.join(__dirname, 'fixtures');
const key = fs.readFileSync(path.join(FIX, 'test-key.pem'));
const cert = fs.readFileSync(path.join(FIX, 'test-cert.pem'));
const ROOT = path.join(__dirname, '..');

// ---------- fake SMTP ----------
function fakeSmtp({ starttls = false } = {}) {
  const mails = [];
  const sockets = new Set();
  const handle = (sock, secure, upgraded = false) => {
    sockets.add(sock); sock.on('close', () => sockets.delete(sock));
    let buf = '', data = false, lines = [], from = '', rcpt = [], authStep = 0;
    if (!upgraded) sock.write('220 fake.smtp ready\r\n'); // no second greeting after STARTTLS (RFC 3207)
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) {
          if (line === '.') { data = false; mails.push({ from, to: rcpt.slice(), raw: lines.join('\r\n') }); lines = []; rcpt = []; sock.write('250 2.0.0 queued\r\n'); }
          else lines.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        if (authStep === 1) { authStep = 2; sock.write('334 UGFzc3dvcmQ6\r\n'); continue; }
        if (authStep === 2) { authStep = 0; sock.write('235 2.7.0 accepted\r\n'); continue; }
        const cmd = line.toUpperCase();
        if (cmd.startsWith('EHLO')) sock.write('250-fake.smtp\r\n' + (starttls && !secure ? '250-STARTTLS\r\n' : '') + '250 AUTH LOGIN\r\n');
        else if (cmd === 'STARTTLS') {
          sock.write('220 go ahead\r\n');
          sock.removeAllListeners('data');
          const up = new tls.TLSSocket(sock, { isServer: true, key, cert });
          handle(up, true, true);
          return;
        } else if (cmd === 'AUTH LOGIN') { authStep = 1; sock.write('334 VXNlcm5hbWU6\r\n'); }
        else if (cmd.startsWith('MAIL FROM')) { from = line.slice(10); sock.write('250 ok\r\n'); }
        else if (cmd.startsWith('RCPT TO')) { rcpt.push(line.replace(/^RCPT TO:<|>$/gi, '')); sock.write('250 ok\r\n'); }
        else if (cmd === 'DATA') { data = true; sock.write('354 end with .\r\n'); }
        else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('500 unknown\r\n');
      }
    });
    sock.on('error', () => {});
  };
  const server = starttls ? net.createServer((s) => handle(s, false)) : tls.createServer({ key, cert }, (s) => handle(s, true));
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, mails,
    close: () => new Promise((r) => { sockets.forEach((s) => s.destroy()); server.close(() => r()); }),
  })));
}

// ---------- fake Ziina API (http, same paths as https://api-v2.ziina.com/api) ----------
function fakeZiina() {
  const intents = new Map();
  const calls = [];
  let down = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (down) return json(503, { message: 'maintenance' });
      if (!/^Bearer zt_/.test(req.headers.authorization || '')) return json(401, { message: 'Unauthorized' });
      calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.method === 'POST' && req.url === '/api/payment_intent') {
        const p = JSON.parse(body);
        if (!Number.isInteger(p.amount) || p.amount < 200) return json(400, { message: 'amount must be at least 2 AED' });
        const id = crypto.randomUUID();
        const it = { id, account_id: 'acc_1', amount: p.amount, tip_amount: 0, vat_amount: 0, currency_code: p.currency_code, status: 'requires_payment_instrument',
          message: p.message, success_url: p.success_url, cancel_url: p.cancel_url, failure_url: p.failure_url, test: p.test, expiry: p.expiry,
          redirect_url: `https://pay.ziina.test/payment_intent/${id}`, created_at: String(Date.now()), operation_id: crypto.randomUUID() };
        intents.set(id, it);
        return json(201, it);
      }
      const m = /^\/api\/payment_intent\/([^/?]+)$/.exec(req.url);
      if (req.method === 'GET' && m) return intents.has(m[1]) ? json(200, intents.get(m[1])) : json(404, { message: 'not found' });
      if (req.method === 'POST' && req.url === '/api/webhook') return json(201, { success: true });
      return json(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    base: `http://127.0.0.1:${server.address().port}/api`, intents, calls,
    set(id, status, extra = {}) { Object.assign(intents.get(id), { status }, extra); return intents.get(id); },
    last() { return [...intents.values()].at(-1); },
    setDown(v) { down = v; },
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  })));
}

// ---------- fake Upstash Redis REST API ----------
function fakeRedis() {
  const data = new Map(); // key -> string | Map (hash)
  const run = (c) => {
    const [cmd, ...a] = c; const C = String(cmd).toUpperCase();
    const hash = (k) => { if (!data.has(k)) data.set(k, new Map()); return data.get(k); };
    if (C === 'PING') return 'PONG';
    if (C === 'HSET') { const h = hash(a[0]); let n = 0; for (let i = 1; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
    if (C === 'HGET') { const h = data.get(a[0]); return h && h.has(a[1]) ? h.get(a[1]) : null; }
    if (C === 'HGETALL') { const h = data.get(a[0]); const out = []; if (h) for (const [k, v] of h) out.push(k, v); return out; }
    if (C === 'HDEL') { const h = data.get(a[0]); let n = 0; if (h) for (const f of a.slice(1)) if (h.delete(f)) n++; return n; }
    if (C === 'SET') { if (a.includes('NX') && data.has(a[0])) return null; data.set(a[0], a[1]); return 'OK'; }
    if (C === 'GET') { const v = data.get(a[0]); return typeof v === 'string' ? v : null; }
    throw new Error('ERR unknown command ' + C);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer redis-test-token') return json(401, { error: 'Unauthorized' });
      try {
        const parsed = JSON.parse(body);
        if (req.url === '/pipeline') return json(200, parsed.map((c) => { try { return { result: run(c) }; } catch (e) { return { error: e.message }; } }));
        return json(200, { result: run(parsed) });
      } catch (e) { return json(400, { error: e.message }); }
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: `http://127.0.0.1:${server.address().port}`, token: 'redis-test-token', data,
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
  })));
}

// ---------- launch the real server ----------
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function launch(env = {}, { expectExit = false, vercel = false } = {}) {
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bmsw-test-'));
  const port = await freePort();
  const childEnv = {
    PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: path.join(FIX, 'test-cert.pem'),
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SITE_URL: `http://localhost:${port}`,
    ADMIN_PASSWORD: 'correct-horse-battery', NODE_ENV: 'test', ...env,
  };
  // vercel: serve through api/index.js exactly as Vercel does (handler only, no start-up code, VERCEL=1)
  const args = vercel
    ? ['-e', `require('http').createServer(require('./api/index.js')).listen(${port}, '127.0.0.1', () => console.log('running on port ${port}'))`]
    : ['server.js'];
  if (vercel) childEnv.VERCEL = '1';
  const child = spawn(process.execPath, args, { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  if (expectExit) { const code = await exited; return { code, out, dataDir }; }
  const started = Date.now();
  while (!/running on port/.test(out)) {
    if (child.exitCode !== null) throw new Error('server exited early:\n' + out);
    if (Date.now() - started > 8000) { child.kill(); throw new Error('server did not start:\n' + out); }
    await new Promise((r) => setTimeout(r, 50));
  }
  const base = `http://127.0.0.1:${port}`;
  let cookie = '';
  async function req(method, p, body, headers = {}) {
    const r = await fetch(base + p, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, headers: r.headers, text, json };
  }
  return {
    base, port, dataDir, child, req, out: () => out, exited,
    async stop(signal = 'SIGTERM') { if (child.exitCode === null) { child.kill(signal); } return exited; },
  };
}

const waitFor = async (fn, ms = 4000) => {
  const t = Date.now();
  while (Date.now() - t < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 40)); }
  throw new Error('timed out waiting');
};

module.exports = { fakeSmtp, fakeZiina, fakeRedis, launch, waitFor, ROOT };
