'use strict';
// Minimal dependency-free SMTP client for Gmail (implicit TLS on port 465, AUTH LOGIN).
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
  const { host, port, user, pass, fromName } = config.mail;
  const recipients = (Array.isArray(to) ? to : [to]).map(clean).filter(Boolean);
  const boundary = 'b_' + crypto.randomBytes(8).toString('hex');
  const outer = 'r_' + crypto.randomBytes(8).toString('hex');
  const headers = [
    `From: ${encodeHeader(fromName)} <${user}>`,
    `To: ${recipients.join(', ')}`,
    replyTo ? `Reply-To: ${clean(replyTo)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${os.hostname() || 'ember'}>`,
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

  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 20000 });
    let buffer = '';
    const queue = [];
    const steps = [
      [null, 220],
      [`EHLO ${os.hostname() || 'localhost'}`, 250],
      ['AUTH LOGIN', 334],
      [Buffer.from(user).toString('base64'), 334],
      [Buffer.from(pass).toString('base64'), 235],
      [`MAIL FROM:<${user}>`, 250],
      ...recipients.map((r) => [`RCPT TO:<${r}>`, 250]),
      ['DATA', 354],
      [message + '\r\n.', 250],
      ['QUIT', 221],
    ];
    let i = 0;
    const fail = (err) => { socket.destroy(); reject(err); };
    const next = () => {
      i += 1;
      if (i >= steps.length) { socket.end(); return resolve({ sent: true }); }
      socket.write(steps[i][0] + '\r\n');
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      // A complete reply ends with a line "NNN <text>" (space after code, not dash)
      let m;
      while ((m = /^(\d{3})([ -])(.*)\r?\n/m.exec(buffer))) {
        buffer = buffer.slice(m.index + m[0].length);
        if (m[2] === '-') continue; // multi-line continuation
        queue.push(Number(m[1]));
        const code = queue.shift();
        const want = steps[i][1];
        if (code !== want) return fail(new Error(`SMTP expected ${want}, got ${code} ${m[3]}`));
        next();
      }
    });
    socket.on('timeout', () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);
  });
}

module.exports = { enabled, send };
