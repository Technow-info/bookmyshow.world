'use strict';
// E-tickets: one signed, scannable code per pass in a paid booking.
// QR payload: BMSW1|<bookingId>|<nn>|<sig>   sig = first 12 hex of HMAC-SHA256(secret, "<bookingId>|<nn>")
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const qr = require('./qr');

// Secret: TICKET_SECRET from .env, otherwise generated once and kept in data/.ticket-secret
let SECRET = process.env.TICKET_SECRET || '';
if (!SECRET) {
  const f = path.join(config.dataDir, '.ticket-secret');
  try { SECRET = fs.readFileSync(f, 'utf8').trim(); } catch { /* first run */ }
  if (!SECRET) { SECRET = crypto.randomBytes(32).toString('hex'); fs.mkdirSync(config.dataDir, { recursive: true }); fs.writeFileSync(f, SECRET, { mode: 0o600 }); }
}

const pad = (n) => String(n).padStart(2, '0');
const sign = (bookingId, n) => crypto.createHmac('sha256', SECRET).update(`${bookingId}|${pad(n)}`).digest('hex').slice(0, 12).toUpperCase();

function issue(booking) {
  const count = booking.qty * (booking.seats || 1);
  const list = [];
  for (let n = 1; n <= count; n++) {
    const sig = sign(booking.id, n);
    list.push({ n, code: `${booking.id}-${pad(n)}`, payload: `BMSW1|${booking.id}|${pad(n)}|${sig}`, sig });
  }
  return list;
}

// Accepts the QR payload or "BMW-XXXX-01" (+ optional "-SIG") typed by hand
function parse(input) {
  const s = String(input || '').trim().toUpperCase();
  let m = /^BMSW1\|([A-Z0-9-]+)\|(\d{2})\|([0-9A-F]{12})$/.exec(s);
  if (m) return { bookingId: m[1], n: Number(m[2]), sig: m[3] };
  m = /^([A-Z]+-[A-Z0-9]+)-(\d{2})(?:-([0-9A-F]{12}))?$/.exec(s);
  if (m) return { bookingId: m[1], n: Number(m[2]), sig: m[3] || null };
  return null;
}
const validSig = (bookingId, n, sig) => { const e = sign(bookingId, n); return sig && sig.length === e.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(e)); };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (fils) => 'AED ' + (fils / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ticketUrl = (b) => `${config.siteUrl}/ticket?b=${encodeURIComponent(b.id)}&t=${encodeURIComponent(b.token)}`;
const whenText = (b) => b.dayLabel || 'Friday 11 – Sunday 13 December 2026';

// ---------- the email (inline QR images via cid:) ----------
function email(booking) {
  const list = issue(booking); // deterministic: same codes and signatures every time
  const attachments = list.map((t) => ({ filename: `ticket-${t.code}.png`, contentType: 'image/png', cid: `qr-${t.n}@bmsw`, content: qr.png(t.payload, 6) }));
  const stubs = list.map((t) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;background:#3a0a08;border:1px solid #6b2a1a;border-radius:14px">
    <tr>
      <td style="padding:20px 22px;vertical-align:top;font-family:Arial,Helvetica,sans-serif;color:#fffaf4">
        <div style="font-size:11px;letter-spacing:2px;color:#ec8830;font-weight:bold">E-TICKET ${t.n} OF ${list.length}</div>
        <div style="font-size:20px;font-weight:bold;margin:8px 0 4px">${esc(booking.tierName)}</div>
        <div style="font-size:14px;color:#d9b3a3;line-height:1.6">${esc(whenText(booking))}<br>Wisdom Valley, Pattaya, Thailand</div>
        <div style="font-size:13px;color:#d9b3a3;margin-top:12px">Holder</div>
        <div style="font-size:15px;font-weight:bold">${esc(booking.name)}</div>
        <div style="font-size:13px;color:#d9b3a3;margin-top:10px">Ticket no.</div>
        <div style="font-size:15px;font-weight:bold;font-family:'Courier New',monospace;letter-spacing:1px">${esc(t.code)}</div>
      </td>
      <td width="170" style="padding:16px;vertical-align:middle;text-align:center;border-left:2px dashed #6b2a1a">
        <img src="cid:qr-${t.n}@bmsw" width="150" height="150" alt="QR code for ticket ${esc(t.code)}" style="display:block;margin:0 auto;border-radius:8px;background:#fff">
      </td>
    </tr>
  </table>`).join('');

  const html = `<!doctype html><html><body style="margin:0;background:#1b0706">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#1b0706"><tr><td align="center" style="padding:28px 12px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">
  <tr><td style="font-family:Arial,Helvetica,sans-serif;color:#fffaf4;padding:0 4px 18px">
    <div style="font-size:18px;font-weight:bold;letter-spacing:1px">BOOKMYSHOW<span style="color:#ec8830">.WORLD</span></div>
  </td></tr>
  <tr><td style="font-family:Arial,Helvetica,sans-serif;color:#fffaf4;background:#540e0e;border-radius:16px;padding:26px 24px">
    <div style="font-size:12px;letter-spacing:2px;color:#ec8830;font-weight:bold">PAYMENT RECEIVED</div>
    <div style="font-size:26px;font-weight:bold;margin:8px 0 6px">Your tickets are here, ${esc(booking.name.split(' ')[0])}.</div>
    <div style="font-size:14px;color:#d9b3a3;line-height:1.6">Booking <b style="color:#fffaf4">${esc(booking.id)}</b> · ${esc(booking.tierName)} × ${booking.qty} · Paid ${money(booking.amount)}</div>
    <div style="margin-top:18px"><a href="${ticketUrl(booking)}" style="display:inline-block;background:#fffaf4;color:#a3441a;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 22px;border-radius:999px">VIEW TICKETS ONLINE</a></div>
  </td></tr>
  <tr><td style="padding:18px 0 0">${stubs}</td></tr>
  <tr><td style="font-family:Arial,Helvetica,sans-serif;color:#d9b3a3;font-size:13px;line-height:1.7;padding:6px 4px">
    <b style="color:#fffaf4">Before you go</b><br>
    · Keep these e-tickets with your passport or photo ID. Each QR code is unique to one pass.<br>
    · Strictly 20+. Last check-in 10 PM Fri/Sat, 9 PM Sun. No same-day re-entry.<br>
    · Our team will contact you about festival bracelet delivery.<br><br>
    Questions? Just reply to this email.<br>
    <span style="font-size:11px;color:#a07b6d">Bookmyshow.world · Independent ticket information and enquiry concept.</span>
  </td></tr>
</table></td></tr></table></body></html>`;

  const text = [`Payment received. Your Bookmyshow.world tickets — booking ${booking.id}`, `${booking.tierName} × ${booking.qty} · ${whenText(booking)} · Wisdom Valley, Pattaya`, `Holder: ${booking.name}`, '',
    ...list.map((t) => `Ticket ${t.n}/${list.length}: ${t.code}`), '', `View tickets online: ${ticketUrl(booking)}`, '', 'Keep these e-tickets with your passport or photo ID. Strictly 20+.'].join('\n');

  return { subject: `Your tickets · ${booking.tierName} · ${booking.id}`, html, text, attachments };
}

// ---------- the online ticket page ----------
function page(booking) {
  const list = issue(booking);
  const cards = list.map((t) => `
    <article class="tk">
      <div class="info">
        <p class="k">E-ticket ${t.n} of ${list.length}</p>
        <h2>${esc(booking.tierName)}</h2>
        <p>${esc(whenText(booking))}<br>Wisdom Valley, Pattaya, Thailand</p>
        <dl><dt>Holder</dt><dd>${esc(booking.name)}</dd><dt>Ticket no.</dt><dd class="mono">${esc(t.code)}</dd></dl>
      </div>
      <div class="qr">${qr.svg(t.payload, { size: 180 })}</div>
    </article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your tickets · ${esc(booking.id)} | Bookmyshow.world</title><meta name="robots" content="noindex">
<link rel="icon" href="/img/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/css/site.css">
<style>
.tp{width:min(760px,100% - 32px);margin:32px auto 64px}
.tp header{display:flex;justify-content:space-between;align-items:center;margin-bottom:28px}
.tp h1{font-size:clamp(34px,6vw,56px);letter-spacing:-.03em;line-height:1;margin:8px 0 10px}
.tk{display:grid;grid-template-columns:1fr auto;border-radius:var(--radius-md);background:linear-gradient(160deg,var(--maroon-800),var(--maroon-900));border:1px solid var(--line);margin-bottom:16px;overflow:hidden}
.tk .info{padding:24px}.tk .k{font-size:11px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--amber-400);margin:0}
.tk h2{font-size:24px;margin:8px 0 6px}.tk p{color:var(--text-muted);margin:0}
.tk dl{display:grid;grid-template-columns:auto 1fr;gap:4px 16px;margin:16px 0 0}.tk dt{color:var(--text-muted);font-size:13px}.tk dd{margin:0;font-weight:600}
.mono{font-family:"Courier New",monospace;letter-spacing:.06em}
.tk .qr{display:grid;place-items:center;padding:20px;border-left:2px dashed var(--line-strong);background:rgba(255,250,244,.03)}
.tk .qr svg{border-radius:10px}
@media (max-width:560px){.tk{grid-template-columns:1fr}.tk .qr{border-left:0;border-top:2px dashed var(--line-strong)}}
@media print{body{background:#fff;color:#000}.tk{background:#fff;border:1px solid #999;break-inside:avoid}.tk p,.tk dt{color:#333}.noprint{display:none}}
</style></head><body>
<main class="tp">
  <header><a class="logo" href="/">BOOKMYSHOW<em>.WORLD</em></a><button class="btn btn-outline noprint" data-print type="button">Print / save PDF</button></header>
  <p class="eyebrow">Booking ${esc(booking.id)} · ${esc(booking.tierName)} × ${booking.qty} · ${money(booking.amount)}</p>
  <h1>Your tickets</h1>
  <p class="muted" style="margin:0 0 28px">Show these with your passport or photo ID. Each QR code belongs to one pass.</p>
  ${cards}
  <p class="fine">Strictly 20+. Last check-in 10 PM Fri/Sat, 9 PM Sun. No same-day re-entry. Questions: <a href="/contact">contact support</a>.</p>
</main><script src="/js/ticket-page.js" defer></script></body></html>`;
}

module.exports = { issue, parse, validSig, email, page, ticketUrl };
