'use strict';
// Test helpers: fake SMTP (465 TLS / 587 STARTTLS), fake Stripe API, and a server launcher.
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

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

// ---------- fake Stripe API ----------
function fakeStripe() {
  const sessions = new Map();
  const server = require('https').createServer({ key, cert }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!/^Bearer sk_test_/.test(req.headers.authorization || '')) return json(401, { error: { message: 'bad key' } });
      if (req.method === 'POST' && req.url === '/v1/checkout/sessions') {
        const params = new URLSearchParams(body);
        const id = 'cs_test_' + crypto.randomBytes(6).toString('hex');
        const s = { id, url: 'https://checkout.stripe.test/' + id, status: 'open', payment_status: 'unpaid', payment_intent: null, params: Object.fromEntries(params) };
        sessions.set(id, s);
        return json(200, s);
      }
      const m = /^\/v1\/checkout\/sessions\/([^/?]+)$/.exec(req.url);
      if (req.method === 'GET' && m && sessions.has(m[1])) return json(200, sessions.get(m[1]));
      return json(404, { error: { message: 'not found' } });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port, sessions,
    pay(id) { const s = sessions.get(id); s.status = 'complete'; s.payment_status = 'paid'; s.payment_intent = 'pi_test_' + crypto.randomBytes(4).toString('hex'); return s; },
    close: () => new Promise((r) => server.close(() => r())),
  })));
}

// ---------- launch the real server ----------
function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}

async function launch(env = {}, { expectExit = false } = {}) {
  const dataDir = env.DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'bmsw-test-'));
  const port = await freePort();
  const childEnv = {
    PATH: process.env.PATH, NODE_EXTRA_CA_CERTS: path.join(FIX, 'test-cert.pem'),
    PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, SITE_URL: `http://localhost:${port}`,
    ADMIN_PASSWORD: 'correct-horse-battery', NODE_ENV: 'test', ...env,
  };
  const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
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

module.exports = { fakeSmtp, fakeStripe, launch, waitFor, ROOT };
