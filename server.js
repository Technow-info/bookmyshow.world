'use strict';
// Bookmyshow.world — web server, booking API, Ziina payments, contact mail and admin API.
// Zero npm dependencies. Runs as a normal server (`node server.js`) or as a Vercel function (api/index.js).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');
const store = require('./lib/store');
const ziina = require('./lib/ziina');
const mailer = require('./lib/mailer');
const tickets = require('./lib/tickets');

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.xml': 'application/xml', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};

// ---------- helpers ----------
const money = (fils) => 'AED ' + (fils / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isEmail = (s) => /^[^\s@<>,;:"'()[\]\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(String(s || ''));
const isPhone = (s) => /^[+\d][\d\s-]{6,18}$/.test(String(s || '').trim());
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);
const newId = (prefix) => prefix + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const ticketPath = (b) => `/ticket?b=${encodeURIComponent(b.id)}&t=${b.token}`;

function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, Object.assign({ 'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(isObj ? JSON.stringify(body) : body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', (c) => {
      if (over) return; // keep draining so the 413 response can still be delivered
      size += c.length;
      if (size > limit) { over = true; chunks.length = 0; reject(Object.assign(new Error('Payload too large'), { status: 413 })); } else chunks.push(c);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}
async function readJson(req) {
  const raw = await readBody(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// Simple fixed-window rate limiter per IP+bucket (per server copy)
const hits = new Map();
function clientIp(req) {
  // Only trust X-Forwarded-For behind a proxy you control (TRUST_PROXY=1, automatic on Vercel).
  const fwd = config.trustProxy && req.headers['x-forwarded-for'];
  return (fwd ? String(fwd).split(',')[0] : (req.socket && req.socket.remoteAddress) || '').trim();
}
function limited(req, bucket, max, windowMs) {
  const key = bucket + '|' + clientIp(req); const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  h.n += 1; return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 3600e3) hits.delete(k); }, 600e3).unref();

// ---------- admin sessions ----------
// Stateless HMAC-signed cookies: work across server copies (Vercel) and restarts.
// Changing ADMIN_PASSWORD (or ADMIN_SESSION_SECRET) signs everyone out.
const SESSION_MS = 12 * 3600e3;
const sessionKey = () => {
  const base = process.env.ADMIN_SESSION_SECRET || config.adminPassword;
  return base ? crypto.createHash('sha256').update('bmsw-admin-session:' + base).digest() : null;
};
function createAdminToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + SESSION_MS, nonce: crypto.randomBytes(16).toString('hex') })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionKey()).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function cookie(req, name) {
  for (const item of String(req.headers.cookie || '').split(';')) {
    const i = item.indexOf('=');
    if (i < 0 || item.slice(0, i).trim() !== name) continue;
    try { return decodeURIComponent(item.slice(i + 1).trim()); } catch { return null; }
  }
  return null;
}
function isAdmin(req) {
  const key = sessionKey(); if (!key) return false;
  const token = cookie(req, 'bmsw_admin'); if (!token) return false;
  const parts = token.split('.'); if (parts.length !== 2) return false;
  const [payload, signature] = parts;
  const expected = crypto.createHmac('sha256', key).update(payload).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  try { const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); return Number.isFinite(data.exp) && data.exp > Date.now(); }
  catch { return false; }
}
const secureCookie = () => (config.siteUrl.startsWith('https://') ? '; Secure' : '');

// ---------- start-up (storage + ticket key), once per server copy ----------
let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => { await store.init(); await tickets.init(store); })()
      .catch((e) => { readyPromise = null; throw e; }); // retry on the next request
  }
  return readyPromise;
}

// ---------- tiers ----------
async function seatsTaken(tierId) {
  const cutoff = Date.now() - 30 * 60 * 1000;
  return (await store.listBookings())
    .filter((b) => b.tierId === tierId && (b.status === 'paid' || (b.status === 'pending' && Date.parse(b.createdAt) > cutoff)))
    .reduce((n, b) => n + b.qty, 0);
}
async function publicTiers() {
  const out = [];
  for (const t of config.tiers) {
    const left = t.capacity == null ? Infinity : Math.max(0, t.capacity - (await seatsTaken(t.id)));
    out.push({ id: t.id, tag: t.tag, name: t.name, desc: t.desc, price: t.price, priceLabel: money(t.price), featured: !!t.featured, seats: t.seats || 1, pickDay: !!t.pickDay, soldOut: left <= 0, fewLeft: left > 0 && left < 100 });
  }
  return out;
}

// ---------- emails ----------
// Every send is logged (admin → Email log) so you can see exactly what went out and what failed.
async function sendLogged(kind, ref, msg) {
  const entry = { id: newId('M'), at: new Date().toISOString(), kind, ref, to: msg.to, subject: msg.subject, status: 'sending' };
  await store.saveEmail(entry);
  try {
    const r = await mailer.send(msg);
    entry.status = r.sent ? 'sent' : 'skipped';
    if (r.skipped) entry.error = r.reason;
  } catch (e) {
    entry.status = 'failed'; entry.error = e.message;
    console.error(`${kind} mail to ${msg.to} failed:`, e.message);
  }
  entry.doneAt = new Date().toISOString();
  await store.saveEmail(entry);
  return entry;
}

function alertHtml(b) {
  return `<h2>New booking ${esc(b.id)}</h2><p><b>${esc(b.tierName)}</b> × ${b.qty}${b.dayLabel ? ' · ' + esc(b.dayLabel) : ''}<br>Paid ${money(b.amount)} · ref ${esc(b.paymentId || '-')}</p>
  <p>${esc(b.name)} · ${esc(b.email)} · ${esc(b.phone)}</p><p>E-tickets: ${(b.tickets || []).map((t) => esc(t.code)).join(', ')}</p>`;
}

// Sends the buyer their e-tickets (QR codes inline). Called the moment a payment is confirmed, and by "Resend" in admin.
async function sendTickets(b) {
  if (!b.tickets) b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code }));
  b.ticketEmail = { status: 'sending', at: new Date().toISOString() };
  await store.saveBooking(b);
  let mail;
  try { mail = tickets.email(b); }
  catch (e) {
    console.error('ticket build failed', e);
    b.ticketEmail = { status: 'failed', at: new Date().toISOString(), error: 'Could not build ticket: ' + e.message };
    await store.saveBooking(b);
    return store.saveEmail({ id: newId('M'), at: b.ticketEmail.at, doneAt: b.ticketEmail.at, kind: 'ticket', ref: b.id, to: b.email, subject: 'E-tickets', status: 'failed', error: b.ticketEmail.error });
  }
  const r = await sendLogged('ticket', b.id, { to: b.email, replyTo: config.mail.to, ...mail });
  b.ticketEmail = { status: r.status, at: r.doneAt, error: r.error };
  await store.saveBooking(b);
  return r;
}

async function notifyPaid(b) {
  await sendTickets(b);
  await sendLogged('booking-alert', b.id, { to: config.mail.to, replyTo: b.email, subject: `New booking ${b.id}: ${b.tierName} × ${b.qty} (${money(b.amount)})`, html: alertHtml(b) });
}

// On a normal server, emails go out in the background. On serverless (Vercel) the function may be frozen
// as soon as the response is sent, so we wait for them before answering.
async function background(job, label) {
  const p = Promise.resolve().then(job).catch((e) => console.error(label + ' failed:', e));
  if (config.serverless) await p;
}

async function markPaid(booking, paymentId) {
  const b = (await store.getBooking(booking.id)) || booking; // re-read: another copy may have confirmed it already
  if (b.status === 'paid') return b;
  b.status = 'paid'; b.paidAt = new Date().toISOString(); b.paymentId = paymentId; delete b.failReason;
  b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code }));
  await store.saveBooking(b);
  await background(() => notifyPaid(b), 'notify');
  return b;
}
async function markFailed(booking, reason) {
  const b = (await store.getBooking(booking.id)) || booking;
  if (b.status === 'paid') return b;
  b.status = 'failed'; b.failReason = str(reason, 200) || 'Payment failed'; b.failedAt = new Date().toISOString();
  await store.saveBooking(b);
  return b;
}

// Asks Ziina for the real state of a booking's payment and records it. Never trusts the browser or webhook body.
async function syncWithZiina(b, { cancelled = false } = {}) {
  if (b.status === 'paid') return b;
  if (!b.gatewayOrderId) return markFailed(b, 'No payment session');
  const intent = await ziina.getPaymentIntent(b.gatewayOrderId);
  const result = ziina.outcome(intent.status);
  if (result === 'paid') return markPaid(b, String(intent.id));
  if (result === 'failed') return markFailed(b, (intent.latest_error && intent.latest_error.message) || (intent.status === 'canceled' ? 'Payment cancelled' : 'Payment failed'));
  if (cancelled) return markFailed(b, 'Checkout cancelled');
  return b; // still pending (e.g. 3-D Secure in progress)
}

// Abandoned checkouts: mark pending bookings older than 40 minutes as failed (Ziina intents expire after 30).
async function sweepAbandoned() {
  const cutoff = Date.now() - 40 * 60e3;
  for (const b of await store.listBookings()) {
    if (b.status === 'pending' && Date.parse(b.createdAt) < cutoff) await markFailed(b, 'Checkout not completed');
  }
}

// ---------- stats ----------
async function stats() {
  const all = await store.listBookings();
  const queries = await store.listQueries();
  const emails = await store.listEmails();
  const paid = all.filter((b) => b.status === 'paid');
  const seatsOf = (b) => b.qty * (b.seats || 1);
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.reportTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayKey = (iso) => fmt.format(new Date(iso)); // YYYY-MM-DD in REPORT_TIMEZONE
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(fmt.format(new Date(Date.now() - i * 864e5)));
  const perDay = days.map((d) => {
    const list = paid.filter((b) => dayKey(b.paidAt || b.createdAt) === d);
    return { date: d, bookings: list.length, tickets: list.reduce((n, b) => n + seatsOf(b), 0), revenue: list.reduce((n, b) => n + b.amount, 0) };
  });
  const tiers = config.tiers.map((t) => {
    const list = paid.filter((b) => b.tierId === t.id);
    return { id: t.id, name: t.name, capacity: t.capacity == null ? null : t.capacity, sold: list.reduce((n, b) => n + b.qty, 0), revenue: list.reduce((n, b) => n + b.amount, 0) };
  });
  const finished = all.filter((b) => b.status === 'paid' || b.status === 'failed').length;
  const todayKey = fmt.format(new Date());
  const today = paid.filter((b) => dayKey(b.paidAt || b.createdAt) === todayKey);
  return {
    totals: {
      bookings: paid.length,
      tickets: paid.reduce((n, b) => n + seatsOf(b), 0),
      revenue: paid.reduce((n, b) => n + b.amount, 0),
      pending: all.filter((b) => b.status === 'pending').length,
      failed: all.filter((b) => b.status === 'failed').length,
      avgOrder: paid.length ? Math.round(paid.reduce((n, b) => n + b.amount, 0) / paid.length) : 0,
      successRate: finished ? paid.length / finished : null,
      todayBookings: today.length,
      todayRevenue: today.reduce((n, b) => n + b.amount, 0),
      newQueries: queries.filter((q) => q.status === 'new').length,
      queries: queries.length,
      emailsFailed: emails.filter((e) => e.status === 'failed').length,
      ticketsPending: paid.filter((b) => !b.ticketEmail || b.ticketEmail.status !== 'sent').length,
    },
    perDay, tiers,
    mode: {
      payments: ziina.enabled() ? (config.ziina.testMode ? 'ziina-test' : 'live') : 'test',
      gateway: 'Ziina', currency: config.currency, mail: mailer.enabled() ? 'on' : 'off', timeZone: config.reportTimeZone,
      storage: store.kind, storageWarning: config.serverless && store.kind !== 'redis',
    },
  };
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;

  if (p === '/api/health' && (m === 'GET' || m === 'HEAD')) {
    return send(res, 200, { ok: true, uptime: Math.round(process.uptime()), storage: store.kind, payments: ziina.enabled() ? 'ziina' : 'test' });
  }
  if (p === '/api/tiers' && m === 'GET') {
    return send(res, 200, { tiers: await publicTiers(), currency: config.currency, testMode: !ziina.enabled(), gateway: 'Ziina', maxQty: config.maxQtyPerOrder, days: config.event.days });
  }

  // Create an order (pending booking) and a Ziina payment page
  if (p === '/api/orders' && m === 'POST') {
    if (limited(req, 'order', 20, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
    const b = await readJson(req);
    const tier = config.tiers.find((t) => t.id === b.tierId);
    const qty = Math.floor(Number(b.qty));
    const name = str(b.name, 80), email = str(b.email, 120), phone = str(b.phone, 20);
    if (!tier) return send(res, 400, { error: 'Please choose a ticket type.' });
    if (!(qty >= 1 && qty <= config.maxQtyPerOrder)) return send(res, 400, { error: `Quantity must be 1–${config.maxQtyPerOrder}.` });
    if (name.length < 2) return send(res, 400, { error: 'Please enter your full name.' });
    if (!isEmail(email)) return send(res, 400, { error: 'Please enter a valid email.' });
    if (!isPhone(phone)) return send(res, 400, { error: 'Please enter a valid phone number.' });
    let day = null;
    if (tier.pickDay) {
      day = config.event.days.find((d) => d.id === b.day);
      if (!day) return send(res, 400, { error: 'Please choose your festival day.' });
    }
    if (tier.capacity != null && tier.capacity - (await seatsTaken(tier.id)) < qty) return send(res, 409, { error: 'Sorry, not enough passes left in this tier.' });

    const booking = {
      id: newId('BMW'), token: crypto.randomBytes(16).toString('hex'),
      tierId: tier.id, tierName: tier.name, seats: tier.seats || 1, qty, unitPrice: tier.price, amount: tier.price * qty, currency: config.currency,
      day: day ? day.id : null, dayLabel: day ? day.label : null,
      name, email, phone, status: 'pending', createdAt: new Date().toISOString(), gateway: ziina.enabled() ? 'ziina' : 'test',
    };
    let checkoutUrl = null;
    if (ziina.enabled()) {
      try {
        const back = `${config.siteUrl}/checkout?b=${encodeURIComponent(booking.id)}`;
        const intent = await ziina.createPaymentIntent({
          amount: booking.amount,
          message: `Bookmyshow.world · ${tier.name}${day ? ' (' + day.label + ')' : ''} × ${qty} · ${booking.id}`,
          successUrl: back + '&return=success', cancelUrl: back + '&return=cancel', failureUrl: back + '&return=failure',
        });
        if (!intent.id || !intent.redirect_url) throw new Error('Ziina returned no payment page');
        booking.gatewayOrderId = intent.id; checkoutUrl = intent.redirect_url;
        if (config.ziina.testMode) booking.gatewayTest = true;
      } catch (e) {
        console.error('ziina payment intent failed:', e.message);
        return send(res, 502, { error: 'Payment service is unavailable right now. Please try again shortly.' });
      }
    }
    await store.saveBooking(booking);
    return send(res, 201, {
      bookingId: booking.id, token: booking.token, amount: booking.amount, amountLabel: money(booking.amount), currency: booking.currency,
      testMode: !ziina.enabled(), checkoutUrl,
    });
  }

  // Verify payment (browser returns from Ziina, or the simulated test step)
  let mm = /^\/api\/orders\/([A-Z0-9-]+)\/verify$/.exec(p);
  if (mm && m === 'POST') {
    const b = await readJson(req);
    let booking = await store.getBooking(mm[1]);
    if (!booking || !sameToken(b.token, booking.token)) return send(res, 404, { error: 'Booking not found.' });
    if (booking.gateway === 'test') {
      if (b.failed) booking = await markFailed(booking, b.reason);
      else if (ziina.enabled()) return send(res, 400, { error: 'Test payments are disabled.' });
      else if (b.testOutcome === 'success') booking = await markPaid(booking, 'TEST-' + crypto.randomBytes(4).toString('hex').toUpperCase());
      else booking = await markFailed(booking, 'Test payment declined');
    } else {
      try { booking = await syncWithZiina(booking, { cancelled: !!b.failed }); }
      catch (e) { console.error('ziina status check failed:', e.message); return send(res, 502, { error: 'Could not reach the payment service. Refresh this page in a moment.' }); }
    }
    return send(res, 200, { status: booking.status, bookingId: booking.id, ticketUrl: booking.status === 'paid' ? ticketPath(booking) : null });
  }

  // Booking status (needs the private token)
  mm = /^\/api\/orders\/([A-Z0-9-]+)$/.exec(p);
  if (mm && m === 'GET') {
    const booking = await store.getBooking(mm[1]);
    if (!booking || !sameToken(url.searchParams.get('t'), booking.token)) return send(res, 404, { error: 'Booking not found.' });
    const { id, status, tierName, dayLabel, qty, amount, name, email, paymentId, createdAt, paidAt } = booking;
    return send(res, 200, { id, status, tierName, dayLabel, qty, amount, amountLabel: money(amount), name, email, paymentId, createdAt, paidAt });
  }

  // Ziina webhook — keeps bookings right even if the buyer closes the tab before returning.
  // The body is never trusted: we re-read the payment intent from Ziina's API before changing anything.
  if (p === '/api/webhooks/ziina' && m === 'POST') {
    const raw = await readBody(req, 256 * 1024);
    if (ziina.verifySignature(raw, req.headers['x-hmac-signature']) === false) return send(res, 401, { error: 'bad signature' });
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
    const id = evt && evt.data && evt.data.id;
    if (evt.event !== 'payment_intent.status.updated' || !id) return send(res, 200, { ignored: true });
    const booking = await store.getBookingByGateway(String(id));
    if (!booking) return send(res, 200, { ignored: true });
    try { await syncWithZiina(booking); }
    catch (e) { console.error('ziina webhook sync failed:', e.message); return send(res, 502, { error: 'retry' }); } // Ziina retries up to 3 times
    return send(res, 200, { received: true });
  }

  // Contact form → saved for the admin inbox, and emailed to the business inbox
  if (p === '/api/contact' && m === 'POST') {
    if (limited(req, 'contact', 5, 15 * 60e3)) return send(res, 429, { error: 'Too many messages. Please try again later.' });
    const b = await readJson(req);
    if (b.website) return send(res, 200, { ok: true }); // honeypot: bots fill hidden field
    // Bots submit instantly. The browser measures time-on-form itself, so visitors' clock settings can't affect this.
    if (b.elapsed !== undefined && Number(b.elapsed) >= 0 && Number(b.elapsed) < 2500) return send(res, 200, { ok: true });
    const q = { id: newId('Q'), name: str(b.name, 80), email: str(b.email, 120), phone: str(b.phone, 20), subject: str(b.subject, 80) || 'General', message: str(b.message, 4000), createdAt: new Date().toISOString(), status: 'new', source: str(b.source, 20) || 'contact' };
    if (q.name.length < 2) return send(res, 400, { error: 'Please enter your name.' });
    if (!isEmail(q.email)) return send(res, 400, { error: 'Please enter a valid email.' });
    if (q.phone && !isPhone(q.phone)) return send(res, 400, { error: 'Please check your phone number.' });
    if (q.message.length < 5) return send(res, 400, { error: 'Please write a short message.' });
    await store.saveQuery(q);
    const job = async () => {
      const r = await sendLogged('query', q.id, {
        to: config.mail.to, replyTo: q.email, subject: `[Bookmyshow.world query] ${q.subject} — ${q.name}`,
        html: `<h2>New query from the website</h2><p><b>Name:</b> ${esc(q.name)}<br><b>Email:</b> ${esc(q.email)}<br><b>Phone:</b> ${esc(q.phone || '-')}<br><b>Topic:</b> ${esc(q.subject)}</p><p style="white-space:pre-wrap">${esc(q.message)}</p><p style="color:#888">Ref ${q.id}. Reply directly to this email to answer.</p>`,
      });
      q.mailed = r.status === 'sent'; if (r.error) q.mailError = r.error;
      await store.saveQuery(q);
    };
    if (config.serverless) { await background(job, 'query mail'); return send(res, 200, { ok: true, ref: q.id }); }
    send(res, 200, { ok: true, ref: q.id }); // reply first; the alert email goes out in the background
    background(job, 'query mail');
    return undefined;
  }

  // ----- Admin -----
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited(req, 'login', 8, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const b = await readJson(req);
    if (!config.adminPassword) return send(res, 503, { error: 'Set ADMIN_PASSWORD to enable the dashboard.' });
    const a = crypto.createHash('sha256').update(String(b.password || '')).digest();
    const c = crypto.createHash('sha256').update(config.adminPassword).digest();
    if (!crypto.timingSafeEqual(a, c)) return send(res, 401, { error: 'Wrong password.' });
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bmsw_admin=${createAdminToken()}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie()}` });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bmsw_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie()}` });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Please sign in.' });
    if (p === '/api/admin/stats' && m === 'GET') {
      if (config.serverless) await sweepAbandoned(); // no background timers on serverless
      return send(res, 200, await stats());
    }
    if (p === '/api/admin/bookings' && m === 'GET') {
      const status = url.searchParams.get('status'); const q = (url.searchParams.get('q') || '').toLowerCase();
      let list = (await store.listBookings()).reverse();
      if (status && status !== 'all') list = list.filter((b) => b.status === status);
      if (q) list = list.filter((b) => [b.id, b.name, b.email, b.phone, b.paymentId].join(' ').toLowerCase().includes(q));
      return send(res, 200, { bookings: list.slice(0, 500).map(({ token, ...rest }) => ({ ...rest, ticketUrl: rest.status === 'paid' ? ticketPath({ id: rest.id, token }) : null })), total: list.length });
    }
    if (p === '/api/admin/bookings.csv' && m === 'GET') {
      const cols = ['id', 'status', 'tierName', 'dayLabel', 'qty', 'amount', 'name', 'email', 'phone', 'paymentId', 'createdAt', 'paidAt'];
      const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=@\t\r]/.test(s) || /^[+-](?!\d)/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = [cols.join(',')].concat((await store.listBookings()).map((b) => cols.map((c) => cell(c === 'amount' ? b.amount / 100 : b[c])).join(','))).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bookmyshow-world-bookings-${new Date().toISOString().slice(0, 10)}.csv"` });
    }
    if (p === '/api/admin/queries' && m === 'GET') return send(res, 200, { queries: (await store.listQueries()).reverse().slice(0, 300) });
    if (p === '/api/admin/emails' && m === 'GET') return send(res, 200, { emails: (await store.listEmails()).reverse().slice(0, 100) });
    mm = /^\/api\/admin\/bookings\/([A-Z0-9-]+)\/resend$/.exec(p);
    if (mm && m === 'POST') {
      const b = await store.getBooking(mm[1]);
      if (!b) return send(res, 404, { error: 'Booking not found' });
      if (b.status !== 'paid') return send(res, 400, { error: 'Tickets are only sent for paid bookings.' });
      const r = await sendTickets(b);
      return send(res, r.status === 'failed' ? 502 : 200, { status: r.status, error: r.error });
    }
    mm = /^\/api\/admin\/bookings\/([A-Z0-9-]+)\/sync$/.exec(p);
    if (mm && m === 'POST') { // re-check a pending booking with Ziina
      const b = await store.getBooking(mm[1]);
      if (!b) return send(res, 404, { error: 'Booking not found' });
      if (b.gateway !== 'ziina') return send(res, 400, { error: 'Only Ziina bookings can be re-checked.' });
      try { const nb = await syncWithZiina(b); return send(res, 200, { status: nb.status }); }
      catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (p === '/api/admin/tickets/verify' && m === 'GET') {
      const t = tickets.parse(url.searchParams.get('code'));
      if (!t) return send(res, 400, { valid: false, reason: 'Not a Bookmyshow.world ticket code.' });
      const b = await store.getBooking(t.bookingId);
      const exists = b && b.status === 'paid' && b.tickets && b.tickets.some((x) => x.n === t.n);
      const sigOk = t.sig ? tickets.validSig(t.bookingId, t.n, t.sig) : null;
      if (!exists) return send(res, 200, { valid: false, reason: b ? 'Booking is not paid, or no such pass number.' : 'No booking with this ID.' });
      if (sigOk === false) return send(res, 200, { valid: false, reason: 'QR signature does not match — possibly forged.' });
      return send(res, 200, { valid: true, signed: sigOk === true, code: `${t.bookingId}-${String(t.n).padStart(2, '0')}`, booking: { id: b.id, name: b.name, tierName: b.tierName, dayLabel: b.dayLabel, qty: b.qty, paidAt: b.paidAt } });
    }
    mm = /^\/api\/admin\/queries\/([A-Z0-9-]+)$/.exec(p);
    if (mm && m === 'PATCH') {
      const q = await store.getQuery(mm[1]); const b = await readJson(req);
      if (!q) return send(res, 404, { error: 'Not found' });
      if (['new', 'replied', 'closed'].includes(b.status)) { q.status = b.status; await store.saveQuery(q); }
      return send(res, 200, { ok: true, query: q });
    }
  }
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, 'Bad request'); }
  if (rel.includes('\0')) return send(res, 400, 'Bad request');
  if (rel.endsWith('/')) rel += 'index.html';
  let file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) return send(res, 403, 'Forbidden');
  if (path.basename(file).startsWith('.')) return send(res, 404, 'Not found');
  if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html'; // pretty URLs: /tickets
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { // /admin → /admin/
      res.writeHead(301, { Location: url.pathname.replace(/^\/+/, '/').replace(/\/?$/, '/') + url.search, 'Cache-Control': 'no-cache' });
      return res.end();
    }
    if (err || !st.isFile()) {
      const nf = path.join(PUBLIC, '404.html');
      res.writeHead(404, { 'Content-Type': MIME['.html'] });
      return fs.createReadStream(nf).on('error', () => res.end('Not found')).pipe(res);
    }
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html' || ext === '.xml' || ext === '.txt') {
      // Pages are authored with a placeholder origin; swap in SITE_URL so canonical/OG/sitemap URLs are right.
      return fs.readFile(file, 'utf8', (e, text) => {
        if (e) return send(res, 500, 'Error');
        res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-cache' });
        res.end(text.split('https://www.example.com').join(config.siteUrl));
      });
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    });
    fs.createReadStream(file)
      .on('error', (e) => { console.error('static read failed', file, e.message); res.destroy(); })
      .pipe(res);
  });
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join('; ');

const HTTPS = config.siteUrl.startsWith('https://');

// The request handler. Used by the http server below and by Vercel (api/index.js).
async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  try {
    const isApi = url.pathname.startsWith('/api/');
    const isTicket = url.pathname === '/ticket';
    if ((isApi && url.pathname !== '/api/health') || isTicket) await ready();
    if (isApi) return await api(req, res, url);
    if (isTicket && req.method === 'GET') {
      const b = await store.getBooking(url.searchParams.get('b') || '');
      if (!b || !sameToken(url.searchParams.get('t'), b.token) || b.status !== 'paid') return send(res, 404, 'Ticket not found. Use the link in your confirmation email.');
      if (!b.tickets) b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code }));
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
      return res.end(tickets.page(b));
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    return serveStatic(req, res, url);
  } catch (e) {
    if (!e.status) console.error(e);
    if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Something went wrong.' });
    else res.destroy();
  }
  return undefined;
}

const server = http.createServer(handler);
server.requestTimeout = 30000;   // slowloris protection
server.headersTimeout = 20000;
server.keepAliveTimeout = 65000; // longer than most load balancers' idle timeout

function start() {
  const { errors, warnings } = config.validate();
  warnings.forEach((w) => console.warn('⚠  ' + w));
  if (errors.length) {
    errors.forEach((e) => console.error('✖  ' + e));
    console.error('\nFix the settings above in .env (see .env.example) and start again.');
    process.exit(1);
  }
  ready().then(() => {
    sweepAbandoned().catch((e) => console.error('sweep failed', e));
    setInterval(() => sweepAbandoned().catch((e) => console.error('sweep failed', e)), 5 * 60e3).unref();
    server.listen(config.port, config.host, () => {
      console.log(`Bookmyshow.world running on port ${config.port} (${config.env}) · public URL ${config.siteUrl}`);
      console.log(`  payments: ${ziina.enabled() ? 'Ziina' + (config.ziina.testMode ? ' (TEST payments)' : ' (live)') + ' in AED' : 'TEST MODE (no Ziina key, payments simulated)'}`);
      console.log(`  storage:  ${store.describe()}`);
      console.log(`  mail:     ${mailer.enabled() ? 'SMTP ' + config.mail.host + ':' + config.mail.port + ' as ' + config.mail.user + ' → ' + config.mail.to : 'OFF (queries saved to dashboard only)'}`);
      console.log(`  admin:    ${config.adminPassword ? config.siteUrl + '/admin/' : 'disabled until ADMIN_PASSWORD is set'}`);
    });
  }).catch((e) => { console.error('✖  ' + e.message); process.exit(1); });

  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to a free port.` : e);
    process.exit(1);
  });

  // Graceful shutdown: stop taking requests, save data, exit. Hosts send SIGTERM on deploy/restart.
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return; stopping = true;
    console.log(`${signal} received: saving data and shutting down…`);
    server.close();
    const force = setTimeout(() => { try { store.flushSync(); } catch (e) { console.error(e); } process.exit(0); }, 8000);
    force.unref();
    store.idle().then(() => { store.flushSync(); process.exit(0); }).catch(() => process.exit(1));
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection:', e));
  process.on('uncaughtException', (e) => {
    console.error('Uncaught exception, saving data and exiting:', e);
    try { store.flushSync(); } catch { /* ignore */ }
    process.exit(1); // let the host / PM2 / Docker restart a clean process
  });
}

if (require.main === module) start();
module.exports = server;
module.exports.handler = handler;
