'use strict';
// Bookmyshow.world — web server, booking API, Stripe payments, contact mail and admin API.
// Zero npm dependencies: run with `node server.js` (Node 18+).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./lib/config');
const db = require('./lib/db');
const stripe = require('./lib/stripe');
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
const isEmail = (s) => /^[^\s@<>,;:"'()\[\]\\]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,}$/.test(String(s || ''));
const isPhone = (s) => /^[+\d][\d\s-]{6,18}$/.test(String(s || '').trim());
const str = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

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
const sameToken = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function readJson(req) {
  const raw = await readBody(req);
  try { return raw.length ? JSON.parse(raw.toString('utf8')) : {}; }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

// Simple fixed-window rate limiter per IP+bucket
const hits = new Map();
function limited(req, bucket, max, windowMs) {
  // Only trust X-Forwarded-For behind a proxy you control (TRUST_PROXY=1); otherwise anyone could fake it to dodge limits.
  const ip = (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0] : req.socket.remoteAddress || '').trim();
  const key = bucket + '|' + ip; const now = Date.now();
  const h = hits.get(key);
  if (!h || now - h.start > windowMs) { hits.set(key, { start: now, n: 1 }); return false; }
  h.n += 1; return h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (now - v.start > 3600e3) hits.delete(k); }, 600e3).unref();

// ---------- admin sessions ----------
const sessions = new Map(); // token -> expiry
const SESSION_MS = 12 * 3600e3;
function cookie(req, name) {
  const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : null;
}
function isAdmin(req) {
  let t = null; try { t = cookie(req, 'bmsw_admin'); } catch { return false; }
  const exp = t && sessions.get(t);
  if (!exp || exp < Date.now()) { if (t) sessions.delete(t); return false; }
  return true;
}
const secureCookie = () => (config.siteUrl.startsWith('https') ? '; Secure' : '');
setInterval(() => { const now = Date.now(); for (const [k, exp] of sessions) if (exp < now) sessions.delete(k); }, 3600e3).unref();

// ---------- tiers ----------
function publicTiers() {
  return config.tiers.map((t) => {
    const left = t.capacity == null ? Infinity : Math.max(0, t.capacity - db.seatsTaken(t.id));
    return { id: t.id, tag: t.tag, name: t.name, desc: t.desc, price: t.price, priceLabel: money(t.price), featured: !!t.featured, seats: t.seats || 1, pickDay: !!t.pickDay, soldOut: left <= 0, fewLeft: left > 0 && left < 100 };
  });
}

// ---------- emails ----------
// Every send is logged (admin → Email log) so you can see exactly what went out and what failed.
async function sendLogged(kind, ref, msg) {
  const entry = { id: db.newId('M'), at: new Date().toISOString(), kind, ref, to: msg.to, subject: msg.subject, status: 'sending' };
  db.logEmail(entry);
  try {
    const r = await mailer.send(msg);
    entry.status = r.sent ? 'sent' : 'skipped';
    if (r.skipped) entry.error = r.reason;
  } catch (e) {
    entry.status = 'failed'; entry.error = e.message;
    console.error(`${kind} mail to ${msg.to} failed:`, e.message);
  }
  entry.doneAt = new Date().toISOString();
  db.persist();
  return entry;
}

function alertHtml(b) {
  return `<h2>New booking ${esc(b.id)}</h2><p><b>${esc(b.tierName)}</b> × ${b.qty}${b.dayLabel ? ' · ' + esc(b.dayLabel) : ''}<br>Paid ${money(b.amount)} · ref ${esc(b.paymentId || '-')}</p>
  <p>${esc(b.name)} · ${esc(b.email)} · ${esc(b.phone)}</p><p>E-tickets: ${(b.tickets || []).map((t) => esc(t.code)).join(', ')}</p>`;
}

// Sends the buyer their e-tickets (QR codes inline). Called the moment a payment is confirmed, and by "Resend" in admin.
async function sendTickets(b) {
  if (!b.tickets) { b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code })); db.persist(); }
  b.ticketEmail = { status: 'sending', at: new Date().toISOString() };
  let mail;
  try { mail = tickets.email(b); }
  catch (e) {
    console.error('ticket build failed', e);
    b.ticketEmail = { status: 'failed', at: new Date().toISOString(), error: 'Could not build ticket: ' + e.message }; db.persist();
    return db.logEmail({ id: db.newId('M'), at: b.ticketEmail.at, doneAt: b.ticketEmail.at, kind: 'ticket', ref: b.id, to: b.email, subject: 'E-tickets', status: 'failed', error: b.ticketEmail.error });
  }
  const r = await sendLogged('ticket', b.id, { to: b.email, replyTo: config.mail.to, ...mail });
  b.ticketEmail = { status: r.status, at: r.doneAt, error: r.error };
  db.persist();
  return r;
}

async function notifyPaid(b) {
  await sendTickets(b);
  await sendLogged('booking-alert', b.id, { to: config.mail.to, replyTo: b.email, subject: `New booking ${b.id}: ${b.tierName} × ${b.qty} (${money(b.amount)})`, html: alertHtml(b) });
}

function markPaid(b, paymentId) {
  if (b.status === 'paid') return;
  b.status = 'paid'; b.paidAt = new Date().toISOString(); b.paymentId = paymentId; delete b.failReason;
  b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code }));
  db.persist();
  notifyPaid(b).catch((e) => console.error('notify failed', e));
}
function markFailed(b, reason) {
  if (b.status === 'paid') return;
  b.status = 'failed'; b.failReason = str(reason, 200) || 'Payment failed'; b.failedAt = new Date().toISOString();
  db.persist();
}

// ---------- stats ----------
function stats() {
  const all = db.bookings();
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
      newQueries: db.queries().filter((q) => q.status === 'new').length,
      queries: db.queries().length,
      emailsFailed: db.emails().filter((e) => e.status === 'failed').length,
      ticketsPending: paid.filter((b) => !b.ticketEmail || b.ticketEmail.status !== 'sent').length,
    },
    perDay, tiers,
    mode: { payments: stripe.enabled() ? 'live' : 'test', currency: config.currency, mail: mailer.enabled() ? 'on' : 'off', timeZone: config.reportTimeZone },
  };
}

// ---------- routes ----------
async function api(req, res, url) {
  const p = url.pathname; const m = req.method;

  if (p === '/api/health' && (m === 'GET' || m === 'HEAD')) return send(res, 200, { ok: true, uptime: Math.round(process.uptime()), bookings: db.bookings().length });
  if (p === '/api/tiers' && m === 'GET') return send(res, 200, { tiers: publicTiers(), currency: config.currency, testMode: !stripe.enabled(), maxQty: config.maxQtyPerOrder, days: config.event.days });

  // Create an order (pending booking)
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
    if (tier.capacity != null && tier.capacity - db.seatsTaken(tier.id) < qty) return send(res, 409, { error: 'Sorry, not enough passes left in this tier.' });

    const booking = {
      id: db.newId('BMW'), token: crypto.randomBytes(16).toString('hex'),
      tierId: tier.id, tierName: tier.name, seats: tier.seats || 1, qty, unitPrice: tier.price, amount: tier.price * qty, currency: config.currency,
      day: day ? day.id : null, dayLabel: day ? day.label : null,
      name, email, phone, status: 'pending', createdAt: new Date().toISOString(), gateway: stripe.enabled() ? 'stripe' : 'test',
    };
    let checkoutUrl = null;
    if (stripe.enabled()) {
      try {
        const back = `${config.siteUrl}/checkout?b=${encodeURIComponent(booking.id)}`;
        const session = await stripe.createCheckoutSession({
          booking, unitAmount: tier.price, productName: tier.name + (day ? ` (${day.label})` : ''),
          successUrl: back + '&return=success', cancelUrl: back + '&return=cancel',
        });
        booking.gatewayOrderId = session.id; checkoutUrl = session.url;
      } catch (e) {
        console.error('stripe session failed:', e.message);
        return send(res, 502, { error: 'Payment service is unavailable right now. Please try again shortly.' });
      }
    }
    db.addBooking(booking);
    return send(res, 201, {
      bookingId: booking.id, token: booking.token, amount: booking.amount, amountLabel: money(booking.amount), currency: booking.currency,
      testMode: !stripe.enabled(), checkoutUrl,
    });
  }

  // Verify payment
  let mm = /^\/api\/orders\/([A-Z0-9-]+)\/verify$/.exec(p);
  if (mm && m === 'POST') {
    const booking = db.findBooking(mm[1]); const b = await readJson(req);
    if (!booking || !sameToken(b.token, booking.token)) return send(res, 404, { error: 'Booking not found.' });
    if (booking.gateway === 'test') {
      if (b.failed) { markFailed(booking, b.reason); return send(res, 200, { status: booking.status }); }
      if (stripe.enabled()) return send(res, 400, { error: 'Test payments are disabled.' });
      if (b.testOutcome === 'success') markPaid(booking, 'TEST-' + crypto.randomBytes(4).toString('hex').toUpperCase());
      else markFailed(booking, 'Test payment declined');
      return send(res, 200, { status: booking.status, bookingId: booking.id, ticketUrl: booking.status === 'paid' ? `/ticket?b=${encodeURIComponent(booking.id)}&t=${booking.token}` : null });
    }
    // Stripe: never trust the browser — ask Stripe for the session's real state.
    if (booking.status !== 'paid') {
      if (!booking.gatewayOrderId) return send(res, 409, { error: 'This booking has no payment session. Please start a new booking.' });
      let session;
      try { session = await stripe.retrieveSession(booking.gatewayOrderId); }
      catch (e) { console.error('stripe retrieve failed:', e.message); return send(res, 502, { error: 'Could not reach the payment service. Refresh this page in a moment.' }); }
      if (session.payment_status === 'paid') markPaid(booking, String(session.payment_intent || session.id));
      else if (b.failed || session.status === 'expired') markFailed(booking, session.status === 'expired' ? 'Checkout expired' : (str(b.reason, 120) || 'Checkout cancelled'));
    }
    return send(res, 200, { status: booking.status, bookingId: booking.id, ticketUrl: booking.status === 'paid' ? `/ticket?b=${encodeURIComponent(booking.id)}&t=${booking.token}` : null });
  }

  // Booking status (needs the private token)
  mm = /^\/api\/orders\/([A-Z0-9-]+)$/.exec(p);
  if (mm && m === 'GET') {
    const booking = db.findBooking(mm[1]);
    if (!booking || !sameToken(url.searchParams.get('t'), booking.token)) return send(res, 404, { error: 'Booking not found.' });
    const { id, status, tierName, dayLabel, qty, amount, name, email, paymentId, createdAt, paidAt } = booking;
    return send(res, 200, { id, status, tierName, dayLabel, qty, amount, amountLabel: money(amount), name, email, paymentId, createdAt, paidAt });
  }

  // Stripe webhook — keeps bookings right even if the buyer closes the tab before returning
  if (p === '/api/webhooks/stripe' && m === 'POST') {
    const raw = await readBody(req, 512 * 1024);
    if (!stripe.verifyWebhook(raw.toString('utf8'), req.headers['stripe-signature'])) return send(res, 400, { error: 'bad signature' });
    let evt; try { evt = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: 'bad json' }); }
    const session = evt.data && evt.data.object;
    const booking = session && db.findBookingByGatewayOrder(session.id);
    if (booking) {
      if ((evt.type === 'checkout.session.completed' && session.payment_status === 'paid') || evt.type === 'checkout.session.async_payment_succeeded') markPaid(booking, String(session.payment_intent || session.id));
      else if (evt.type === 'checkout.session.expired' || evt.type === 'checkout.session.async_payment_failed') markFailed(booking, evt.type === 'checkout.session.expired' ? 'Checkout expired' : 'Payment failed');
    }
    return send(res, 200, { received: true });
  }

  // Contact form → Gmail
  if (p === '/api/contact' && m === 'POST') {
    if (limited(req, 'contact', 5, 15 * 60e3)) return send(res, 429, { error: 'Too many messages. Please try again later.' });
    const b = await readJson(req);
    if (b.website) return send(res, 200, { ok: true }); // honeypot: bots fill hidden field
    // Bots submit instantly. The browser measures time-on-form itself, so visitors' clock settings can't affect this.
    if (b.elapsed !== undefined && Number(b.elapsed) >= 0 && Number(b.elapsed) < 2500) return send(res, 200, { ok: true });
    const q = { id: db.newId('Q'), name: str(b.name, 80), email: str(b.email, 120), phone: str(b.phone, 20), subject: str(b.subject, 80) || 'General', message: str(b.message, 4000), createdAt: new Date().toISOString(), status: 'new', source: str(b.source, 20) || 'contact' };
    if (q.name.length < 2) return send(res, 400, { error: 'Please enter your name.' });
    if (!isEmail(q.email)) return send(res, 400, { error: 'Please enter a valid email.' });
    if (q.phone && !isPhone(q.phone)) return send(res, 400, { error: 'Please check your phone number.' });
    if (q.message.length < 5) return send(res, 400, { error: 'Please write a short message.' });
    db.addQuery(q);
    // Reply to the visitor straight away; the alert email goes out in the background (Gmail can take seconds).
    send(res, 200, { ok: true, ref: q.id });
    sendLogged('query', q.id, {
        to: config.mail.to, replyTo: q.email, subject: `[Bookmyshow.world query] ${q.subject} — ${q.name}`,
        html: `<h2>New query from the website</h2><p><b>Name:</b> ${esc(q.name)}<br><b>Email:</b> ${esc(q.email)}<br><b>Phone:</b> ${esc(q.phone || '-')}<br><b>Topic:</b> ${esc(q.subject)}</p><p style="white-space:pre-wrap">${esc(q.message)}</p><p style="color:#888">Ref ${q.id}. Reply directly to this email to answer.</p>`,
    }).then((r) => { q.mailed = r.status === 'sent'; if (r.error) q.mailError = r.error; db.persist(); })
      .catch((e) => console.error('query mail error', e));
    return;
  }

  // ----- Admin -----
  if (p === '/api/admin/login' && m === 'POST') {
    if (limited(req, 'login', 8, 15 * 60e3)) return send(res, 429, { error: 'Too many attempts. Wait 15 minutes.' });
    const b = await readJson(req);
    if (!config.adminPassword) return send(res, 503, { error: 'Set ADMIN_PASSWORD in .env to enable the dashboard.' });
    const a = crypto.createHash('sha256').update(String(b.password || '')).digest();
    const c = crypto.createHash('sha256').update(config.adminPassword).digest();
    if (!crypto.timingSafeEqual(a, c)) return send(res, 401, { error: 'Wrong password.' });
    const t = crypto.randomBytes(24).toString('hex'); sessions.set(t, Date.now() + SESSION_MS);
    return send(res, 200, { ok: true }, { 'Set-Cookie': `bmsw_admin=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secureCookie()}` });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    const t = cookie(req, 'bmsw_admin'); if (t) sessions.delete(t);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'bmsw_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return send(res, 401, { error: 'Please sign in.' });
    if (p === '/api/admin/stats' && m === 'GET') return send(res, 200, stats());
    if (p === '/api/admin/bookings' && m === 'GET') {
      const status = url.searchParams.get('status'); const q = (url.searchParams.get('q') || '').toLowerCase();
      let list = db.bookings().slice().reverse();
      if (status && status !== 'all') list = list.filter((b) => b.status === status);
      if (q) list = list.filter((b) => [b.id, b.name, b.email, b.phone, b.paymentId].join(' ').toLowerCase().includes(q));
      return send(res, 200, { bookings: list.slice(0, 500).map(({ token, ...rest }) => ({ ...rest, ticketUrl: rest.status === 'paid' ? `/ticket?b=${encodeURIComponent(rest.id)}&t=${token}` : null })), total: list.length });
    }
    if (p === '/api/admin/bookings.csv' && m === 'GET') {
      const cols = ['id', 'status', 'tierName', 'dayLabel', 'qty', 'amount', 'name', 'email', 'phone', 'paymentId', 'createdAt', 'paidAt'];
      const cell = (v) => { let s = String(v == null ? '' : v); if (/^[=@\t\r]/.test(s) || /^[+-](?!\d)/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
      const csv = [cols.join(',')].concat(db.bookings().map((b) => cols.map((c) => cell(c === 'amount' ? b.amount / 100 : b[c])).join(','))).join('\r\n');
      return send(res, 200, csv, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bookmyshow-world-bookings-${new Date().toISOString().slice(0, 10)}.csv"` });
    }
    if (p === '/api/admin/queries' && m === 'GET') return send(res, 200, { queries: db.queries().slice().reverse().slice(0, 300) });
    if (p === '/api/admin/emails' && m === 'GET') return send(res, 200, { emails: db.emails().slice().reverse().slice(0, 100) });
    mm = /^\/api\/admin\/bookings\/([A-Z0-9-]+)\/resend$/.exec(p);
    if (mm && m === 'POST') {
      const b = db.findBooking(mm[1]);
      if (!b) return send(res, 404, { error: 'Booking not found' });
      if (b.status !== 'paid') return send(res, 400, { error: 'Tickets are only sent for paid bookings.' });
      const r = await sendTickets(b);
      return send(res, r.status === 'failed' ? 502 : 200, { status: r.status, error: r.error });
    }
    if (p === '/api/admin/tickets/verify' && m === 'GET') {
      const t = tickets.parse(url.searchParams.get('code'));
      if (!t) return send(res, 400, { valid: false, reason: 'Not a Bookmyshow.world ticket code.' });
      const b = db.findBooking(t.bookingId);
      const exists = b && b.status === 'paid' && b.tickets && b.tickets.some((x) => x.n === t.n);
      const sigOk = t.sig ? tickets.validSig(t.bookingId, t.n, t.sig) : null;
      if (!exists) return send(res, 200, { valid: false, reason: b ? 'Booking is not paid, or no such pass number.' : 'No booking with this ID.' });
      if (sigOk === false) return send(res, 200, { valid: false, reason: 'QR signature does not match — possibly forged.' });
      return send(res, 200, { valid: true, signed: sigOk === true, code: `${t.bookingId}-${String(t.n).padStart(2, '0')}`, booking: { id: b.id, name: b.name, tierName: b.tierName, dayLabel: b.dayLabel, qty: b.qty, paidAt: b.paidAt } });
    }
    mm = /^\/api\/admin\/queries\/([A-Z0-9-]+)$/.exec(p);
    if (mm && m === 'PATCH') {
      const q = db.queries().find((x) => x.id === mm[1]); const b = await readJson(req);
      if (!q) return send(res, 404, { error: 'Not found' });
      if (['new', 'replied', 'closed'].includes(b.status)) { q.status = b.status; db.persist(); }
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
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, 'Bad request'); }
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/ticket' && req.method === 'GET') {
      const b = db.findBooking(url.searchParams.get('b') || '');
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
});
server.requestTimeout = 30000;   // slowloris protection
server.headersTimeout = 20000;
server.keepAliveTimeout = 65000; // longer than most load balancers' idle timeout

// Abandoned checkouts: mark pending bookings older than 40 minutes as failed (Stripe sessions expire after 32).
function sweepAbandoned() {
  const cutoff = Date.now() - 40 * 60e3;
  db.bookings().forEach((b) => { if (b.status === 'pending' && Date.parse(b.createdAt) < cutoff) markFailed(b, 'Checkout not completed'); });
}

function start() {
  const { errors, warnings } = config.validate();
  warnings.forEach((w) => console.warn('⚠  ' + w));
  if (errors.length) {
    errors.forEach((e) => console.error('✖  ' + e));
    console.error('\nFix the settings above in .env (see .env.example) and start again.');
    process.exit(1);
  }
  sweepAbandoned();
  setInterval(sweepAbandoned, 5 * 60e3).unref();
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to a free port.` : e);
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    console.log(`Bookmyshow.world running on port ${config.port} (${config.env}) · public URL ${config.siteUrl}`);
    console.log(`  payments: ${stripe.enabled() ? 'Stripe (' + (config.stripe.secretKey.includes('_live_') ? 'LIVE' : 'test') + ' key) in AED' : 'TEST MODE (no Stripe key)'}`);
    console.log(`  mail:     ${mailer.enabled() ? 'SMTP ' + config.mail.host + ':' + config.mail.port + ' as ' + config.mail.user + ' → ' + config.mail.to : 'OFF (queries saved to dashboard only)'}`);
    console.log(`  admin:    ${config.adminPassword ? config.siteUrl + '/admin/' : 'disabled until ADMIN_PASSWORD is set'}`);
  });

  // Graceful shutdown: stop taking requests, save data, exit. Hosts send SIGTERM on deploy/restart.
  let stopping = false;
  function shutdown(signal) {
    if (stopping) return; stopping = true;
    console.log(`${signal} received: saving data and shutting down…`);
    server.close();
    const force = setTimeout(() => { try { db.flushSync(); } catch (e) { console.error(e); } process.exit(0); }, 8000);
    force.unref();
    db.idle().then(() => { db.flushSync(); process.exit(0); }).catch(() => process.exit(1));
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => console.error('Unhandled promise rejection:', e));
  process.on('uncaughtException', (e) => {
    console.error('Uncaught exception, saving data and exiting:', e);
    try { db.flushSync(); } catch { /* ignore */ }
    process.exit(1); // let the host / PM2 / Docker restart a clean process
  });
}

if (require.main === module) start();
module.exports = server;
