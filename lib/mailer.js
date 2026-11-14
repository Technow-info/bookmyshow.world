'use strict';
// Minimal dependency-free SMTP client for Gmail (port 465 implicit TLS, or 587 STARTTLS; AUTH LOGIN).
// Set SMTP_USER to the Gmail address and SMTP_PASS to a Google App Password
// (Google Account → Security → 2-Step Verification → App passwords).
const tls = require('tls');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');

const enabled = () => Boolean(config.mail.user && config.mail.pass);

const clean = (s) => String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = (s) => `=?UTF-8?B?${Buffer.from(clean(s)).toString('base64')}?=`;
const wrap76 = (b64) => b64.replace(/(.{76})/g, '$1\r\n');

function send({ to, subject, html, text, replyTo, attachments = [] }) {
  if (!enabled()) return Promise.resolve({ skipped: true, reason: 'SMTP not configured' });
  const { host, port, user, pass, fromName, secure } = config.mail;
  const recipients = (Array.isArray(to) ? to : [to]).map(clean).filter(Boolean);
  const boundary = 'b_' + crypto.randomBytes(8).toString('hex');
  const outer = 'r_' + crypto.randomBytes(8).toString('hex');
  const headers = [
    `From: ${encodeHeader(fromName)} <${user}>`,
    `To: ${recipients.join(', ')}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${String(user).split('@')[1] || 'bookmyshow.world'}>`,
    'MIME-Version: 1.0',
    attachments.length ? `Content-Type: multipart/related; boundary="${outer}"; type="multipart/alternative"` : `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);
  const alternative = [
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrap76(Buffer.from(text || html.replace(/<[^>]+>/g, '')).toString('base64')),
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '',
    wrap76(Buffer.from(html).toString('base64')),
    `--${boundary}--`, '',
  ].join('\r\n');
  let body = alternative;
  if (attachments.length) {
    body = [`--${outer}`, `Content-Type: multipart/alternative; boundary="${boundary}"`, '', alternative]
      .concat(attachments.flatMap((a) => [
        `--${outer}`,
        `Content-Type: ${a.contentType || 'application/octet-stream'}; name="${clean(a.filename)}"`,
        'Content-Transfer-Encoding: base64',
        a.cid ? `Content-ID: <${clean(a.cid)}>` : null,
        `Content-Disposition: ${a.cid ? 'inline' : 'attachment'}; filename="${clean(a.filename)}"`,
        '',
        wrap76(Buffer.from(a.content).toString('base64')),
      ].filter((l) => l !== null)))
      .concat([`--${outer}--`, '']).join('\r\n');
  }
  // SMTP dot-stuffing: a line starting with "." must be sent as ".."
  const message = (headers.join('\r\n') + '\r\n\r\n' + body).replace(/\r\n\./g, '\r\n..');

  return deliver({ host, port, secure, user, pass, recipients, message });
}

// ---------- SMTP transport ----------
// Port 465: implicit TLS (Gmail default). Port 587: plain connect, then STARTTLS upgrade.
// Resolves as soon as the server accepts the message (250 after DATA); QUIT is best-effort.
function deliver({ host, port, secure, user, pass, recipients, message }) {
  return new Promise((resolve, reject) => {
    let socket, buffer = '', waiter = null, settled = false, lines = [];
    const timer = setTimeout(() => finish(new Error('SMTP timeout after 30s')), 30000);
    function finish(err, value) {
      if (settled) return; settled = true; clearTimeout(timer);
      if (err) { if (socket) socket.destroy(); reject(err); } else resolve(value);
    }
    function onData(chunk) {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
        const m = /^(\d{3})([ -])(.*)$/.exec(line);
        if (!m) continue;
        lines.push(m[3]);
        if (m[2] === ' ' && waiter) { const w = waiter; waiter = null; const text = lines.join(' | '); lines = []; w(Number(m[1]), text); }
      }
    }
    function attach(sock) {
      socket = sock;
      sock.on('data', onData);
      sock.on('error', (e) => finish(e));
      sock.on('close', () => finish(new Error('SMTP connection closed unexpectedly')));
    }
    const reply = () => new Promise((res) => { waiter = (code, text) => res({ code, text }); });
    async function cmd(line, want) {
      if (line !== null) socket.write(line + '\r\n');
      const r = await reply();
      if (!want.includes(r.code)) throw new Error(`SMTP ${line ? line.split(' ')[0] : 'greeting'}: expected ${want.join('/')}, got ${r.code} ${r.text}`.replace(pass, '***'));
      return r;
    }
    const hello = `EHLO ${(os.hostname() || 'localhost').replace(/[^A-Za-z0-9.-]/g, '') || 'localhost'}`;
    (async () => {
      const implicit = secure === undefined ? Number(port) === 465 : !!secure;
      const greeting = reply();
      const sni = require('net').isIP(host) ? undefined : host;
      if (implicit) attach(tls.connect({ host, port, servername: sni }));
      else attach(require('net').connect({ host, port }));
      const g = await greeting; if (g.code !== 220) throw new Error(`SMTP greeting: ${g.code} ${g.text}`);
      const ehlo = await cmd(hello, [250]);
      if (!implicit) {
        if (!/STARTTLS/i.test(ehlo.text)) throw new Error('SMTP server does not offer STARTTLS on port ' + port);
        await cmd('STARTTLS', [220]);
        const plain = socket; plain.removeAllListeners('data'); plain.removeAllListeners('close'); plain.removeAllListeners('error');
        const upgraded = tls.connect({ socket: plain, servername: sni });
        await new Promise((res, rej) => { upgraded.once('secureConnect', res); upgraded.once('error', rej); });
        attach(upgraded);
        await cmd(hello, [250]);
      }
      await cmd('AUTH LOGIN', [334]);
      await cmd(Buffer.from(user).toString('base64'), [334]);
      await cmd(Buffer.from(pass).toString('base64'), [235]);
      await cmd(`MAIL FROM:<${user}>`, [250]);
      for (const r of recipients) await cmd(`RCPT TO:<${r}>`, [250, 251]);
      await cmd('DATA', [354]);
      await cmd(message + '\r\n.', [250]);
      finish(null, { sent: true });
      try { socket.write('QUIT\r\n'); socket.end(); } catch { /* already closed */ }
    })().catch((e) => finish(e));
  });
}

module.exports = { enabled, send };
