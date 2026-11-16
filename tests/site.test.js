'use strict';
// End-to-end tests against the real server process. Run: npm test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fakeSmtp, fakeZiina, fakeRedis, launch, waitFor } = require('./helpers');

const buyer = { name: 'Omar Haddad', email: 'omar@example.com', phone: '+971 50 111 2233' };
const decodeB64Part = (raw, type) => {
  const m = new RegExp(`Content-Type: ${type}[\\s\\S]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(raw);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
};

describe('Bookmyshow.world server (test-mode payments, Gmail via fake SMTP)', () => {
  let smtp, app;
  before(async () => {
    smtp = await fakeSmtp();
    app = await launch({ SMTP_HOST: 'localhost', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'true', SMTP_USER: 'connect.technow@gmail.com', SMTP_PASS: 'abcdefghijklmnop', MAIL_TO: 'connect.technow@gmail.com' });
  });
  after(async () => { if (app) await app.stop(); if (smtp) await smtp.close(); });

  it('serves every public page, pretty URLs and SEO files', async () => {
    for (const p of ['/', '/tickets', '/info', '/contact', '/checkout', '/admin/', '/preview.html']) {
      const r = await app.req('GET', p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    }
    const home = await app.req('GET', '/');
    assert.match(home.text, /<title>[^<]+<\/title>/);
    assert.equal((home.text.match(/<h1/g) || []).length, 1, 'exactly one h1');
    assert.ok(home.text.includes(`<link rel="canonical" href="http://localhost:${app.port}/">`), 'canonical uses SITE_URL');
    assert.ok(!home.text.includes('example.com'), 'no placeholder domain leaks');
    assert.ok(!home.text.includes('Sample website preview'), 'sample notice removed');
    assert.match((await app.req('GET', '/robots.txt')).text, new RegExp(`Sitemap: http://localhost:${app.port}/sitemap.xml`));
    assert.match((await app.req('GET', '/sitemap.xml')).text, /<urlset/);
    for (const a of ['/css/site.css', '/js/site.js', '/js/checkout.js', '/js/admin.js', '/img/icons.svg', '/img/crowd-portrait.jpg', '/img/favicon.svg']) assert.equal((await app.req('GET', a)).status, 200, a);
  });

  it('redirects /admin, rejects bad paths, hides dotfiles, 404s unknown pages', async () => {
    const r = await app.req('GET', '/admin');
    assert.equal(r.status, 301); assert.equal(r.headers.get('location'), '/admin/');
    assert.equal((await app.req('GET', '/%E0%A4%A')).status, 400);
    assert.equal((await app.req('GET', '/nope')).status, 404);
    assert.equal((await app.req('GET', '/.env')).status, 404);
    const trav = await app.req('GET', '/..%2fserver.js');
    assert.ok([403, 404].includes(trav.status));
    assert.ok(!trav.text.includes('require('));
    assert.equal((await app.req('POST', '/')).status, 405);
    const h = await app.req('GET', '/api/health');
    assert.equal(h.status, 200); assert.equal(h.json.ok, true);
  });

  it('lists the four passes with exact AED prices', async () => {
    const r = await app.req('GET', '/api/tiers');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.tiers.map((t) => [t.name, t.priceLabel]), [
      ['Full Madness Pass', 'AED 1,359.31'], ['Full Madness Comfort (VIP) Pass', 'AED 2,196.64'],
      ['Day Pass', 'AED 554.60'], ['Day Comfort (VIP) Pass', 'AED 891.70'],
    ]);
    assert.equal(r.json.currency, 'AED');
    assert.equal(r.json.days.length, 3);
  });

  it('validates orders', async () => {
    const bad = async (body, re) => { const r = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1, ...body }); assert.equal(r.status, 400, JSON.stringify(body)); assert.match(r.json.error, re); };
    await bad({ tierId: 'nope' }, /ticket type/);
    await bad({ qty: 0 }, /Quantity/);
    await bad({ qty: 11 }, /Quantity/);
    await bad({ email: 'not-an-email' }, /email/);
    await bad({ email: 'a,b@x.com' }, /email/);
    await bad({ phone: 'abc' }, /phone/);
    await bad({ name: 'A' }, /name/);
    await bad({ tierId: 'day' }, /festival day/);
    await bad({ tierId: 'day', day: '2026-12-25' }, /festival day/);
    assert.equal((await app.req('POST', '/api/orders', '{bad json')).status, 400);
    assert.equal((await app.req('POST', '/api/orders', 'x'.repeat(70 * 1024))).status, 413);
  });

  let paid;
  it('takes a test payment and emails the e-tickets to the buyer immediately', async () => {
    const before = smtp.mails.length;
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'day-vip', day: '2026-12-12', qty: 2, price: 1 });
    assert.equal(o.status, 201);
    assert.equal(o.json.amount, 178340, 'server-side price, ignores client price');
    assert.equal(o.json.testMode, true);
    assert.equal((await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: 'wrong', testOutcome: 'success' })).status, 404);
    const v = await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token, testOutcome: 'success' });
    assert.equal(v.json.status, 'paid');
    assert.match(v.json.ticketUrl, /^\/ticket\?b=/);
    paid = { ...o.json, ticketUrl: v.json.ticketUrl };

    const ticketMail = await waitFor(() => smtp.mails.slice(before).find((m) => m.to.includes(buyer.email)));
    assert.match(ticketMail.raw, /Content-Type: multipart\/related/);
    assert.equal((ticketMail.raw.match(/Content-ID: <qr-\d@bmsw>/g) || []).length, 2, 'one QR per pass');
    const png = /Content-ID: <qr-1@bmsw>[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(ticketMail.raw)[1];
    assert.equal(Buffer.from(png.replace(/\r\n/g, ''), 'base64').subarray(1, 4).toString(), 'PNG');
    const html = decodeB64Part(ticketMail.raw, 'text/html');
    assert.match(html, /Day Comfort \(VIP\) Pass/); assert.match(html, /Saturday 12 December 2026/); assert.match(html, /cid:qr-2@bmsw/);
    const alert = await waitFor(() => smtp.mails.slice(before).find((m) => m.to.includes('connect.technow@gmail.com')));
    assert.match(decodeB64Part(alert.raw, 'text/html'), /New booking/);

    const page = await app.req('GET', paid.ticketUrl);
    assert.equal(page.status, 200); assert.match(page.text, /E-ticket 2 of 2/); assert.match(page.text, /<svg[^>]+aria-label="QR code"/);
    assert.equal((await app.req('GET', `/ticket?b=${paid.bookingId}&t=nope`)).status, 404);
  });

  it('records failed test payments', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    const v = await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token, testOutcome: 'fail' });
    assert.equal(v.json.status, 'failed');
  });

  it('saves contact queries (ignoring bots) and emails them to the inbox', async () => {
    const before = smtp.mails.length;
    assert.equal((await app.req('POST', '/api/contact', { name: 'Bot', email: 'b@x.com', message: 'spam spam', website: 'http://x' })).status, 200);
    assert.equal((await app.req('POST', '/api/contact', { name: 'Fast Bot', email: 'f@x.com', message: 'spam spam', elapsed: 300 })).status, 200);
    assert.equal((await app.req('POST', '/api/contact', { name: 'Aisha', email: 'bad', message: 'hello there' })).status, 400);
    const ok = await app.req('POST', '/api/contact', { name: 'Aisha Khan', email: 'aisha@example.com', subject: 'Day Pass', message: 'Is the Day Pass valid on Sunday?', elapsed: 9000 });
    assert.equal(ok.status, 200); assert.match(ok.json.ref, /^Q-/);
    const m = await waitFor(() => smtp.mails.slice(before).find((x) => decodeB64Part(x.raw, 'text/html').includes('Aisha Khan')));
    assert.ok(m.to.includes('connect.technow@gmail.com'));
    assert.ok(/Reply-To: aisha@example.com/.test(m.raw));
    globalThis.queryRef = ok.json.ref;
  });

  it('protects the admin API and shows bookings, queries, emails and ticket checks', async () => {
    assert.equal((await app.req('GET', '/api/admin/stats')).status, 401);
    assert.equal((await app.req('POST', '/api/admin/login', { password: 'wrong' })).status, 401);
    const login = await app.req('POST', '/api/admin/login', { password: 'correct-horse-battery' });
    assert.equal(login.status, 200);
    assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);

    const s = await app.req('GET', '/api/admin/stats');
    assert.equal(s.json.totals.bookings, 1); assert.equal(s.json.totals.tickets, 2); assert.equal(s.json.totals.failed, 1);
    assert.equal(s.json.perDay.length, 14); assert.equal(s.json.perDay.at(-1).bookings, 1, 'today counted in report time zone');

    const q = await app.req('GET', '/api/admin/queries');
    assert.equal(q.json.queries.length, 1, 'bot messages were not saved');
    assert.equal(q.json.queries[0].name, 'Aisha Khan');
    assert.equal((await app.req('PATCH', `/api/admin/queries/${globalThis.queryRef}`, { status: 'replied' })).json.query.status, 'replied');

    const b = await app.req('GET', `/api/admin/bookings?q=${paid.bookingId}`);
    const row = b.json.bookings[0];
    assert.equal(row.ticketEmail.status, 'sent'); assert.equal(row.tickets.length, 2); assert.ok(!('token' in row));

    const e = await app.req('GET', '/api/admin/emails');
    assert.ok(e.json.emails.some((x) => x.kind === 'ticket' && x.status === 'sent'));
    assert.ok(e.json.emails.some((x) => x.kind === 'query' && x.status === 'sent'));

    const code = row.tickets[0].code;
    assert.equal((await app.req('GET', `/api/admin/tickets/verify?code=${encodeURIComponent(code)}`)).json.valid, true);
    assert.equal((await app.req('GET', `/api/admin/tickets/verify?code=${encodeURIComponent(`BMSW1|${paid.bookingId}|01|000000000000`)}`)).json.valid, false);
    assert.equal((await app.req('GET', '/api/admin/tickets/verify?code=hello')).status, 400);

    const r = await app.req('POST', `/api/admin/bookings/${paid.bookingId}/resend`);
    assert.equal(r.status, 200); assert.equal(r.json.status, 'sent');

    const csv = await app.req('GET', '/api/admin/bookings.csv');
    assert.match(csv.headers.get('content-type'), /text\/csv/); assert.match(csv.text, /Day Comfort \(VIP\) Pass/);

    assert.equal((await app.req('POST', '/api/admin/logout')).status, 200);
    assert.equal((await app.req('GET', '/api/admin/stats')).status, 401);
  });

  it('rate-limits the contact form', async () => {
    let last;
    for (let i = 0; i < 6; i++) last = await app.req('POST', '/api/contact', { name: 'Rate Test', email: 'r@example.com', message: 'testing limits', elapsed: 9000 });
    assert.equal(last.status, 429);
  });

  it('saves data and exits cleanly on SIGTERM', async () => {
    const code = await app.stop('SIGTERM');
    assert.equal(code, 0);
    const saved = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'db.json'), 'utf8'));
    assert.ok(saved.bookings.some((b) => b.id === paid.bookingId && b.status === 'paid'));
    assert.match(saved.meta['ticket-secret'], /^[0-9a-f]{64}$/, 'ticket signing key kept in storage');
  });
});

const ZKEY = 'zt_' + 'x'.repeat(40);
const ziinaSign = (body, secret) => crypto.createHmac('sha256', secret).update(body).digest('hex');

describe('Ziina checkout (fake Ziina API)', () => {
  let z, smtp, app;
  before(async () => {
    z = await fakeZiina(); smtp = await fakeSmtp();
    app = await launch({ ZIINA_API_KEY: ZKEY, ZIINA_TEST_MODE: 'true', ZIINA_WEBHOOK_SECRET: 'zsecret', ZIINA_API_BASE: z.base,
      SMTP_HOST: 'localhost', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'true', SMTP_USER: 'connect.technow@gmail.com', SMTP_PASS: 'abcdefghijklmnop' });
  });
  after(async () => { if (app) await app.stop(); if (z) await z.close(); if (smtp) await smtp.close(); });

  it('creates an AED payment intent with server-side prices and return links', async () => {
    const t = await app.req('GET', '/api/tiers');
    assert.equal(t.json.testMode, false); assert.equal(t.json.gateway, 'Ziina');
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full-vip', qty: 2, price: 1 });
    assert.equal(o.status, 201); assert.equal(o.json.testMode, false);
    const it = z.last();
    assert.equal(o.json.checkoutUrl, it.redirect_url);
    assert.equal(it.amount, 439328, 'AED 2,196.64 × 2 in fils'); assert.equal(it.currency_code, 'AED'); assert.equal(it.test, true);
    assert.match(it.success_url, new RegExp(`/checkout\\?b=${o.json.bookingId}&return=success$`));
    assert.match(it.cancel_url, /&return=cancel$/); assert.match(it.failure_url, /&return=failure$/);
    assert.ok(Number(it.expiry) > Date.now(), 'expiry in the future');
    assert.match(it.message, /Full Madness Comfort \(VIP\) Pass × 2/);
    globalThis.zo = o.json;
  });

  it('only marks paid after Ziina itself says completed, then emails the e-tickets', async () => {
    const o = globalThis.zo; const it = z.last();
    assert.equal((await app.req('POST', `/api/orders/${o.bookingId}/verify`, { token: o.token })).json.status, 'pending');
    assert.equal((await app.req('POST', `/api/orders/${o.bookingId}/verify`, { token: o.token, testOutcome: 'success' })).json.status, 'pending', 'simulated payments refused');
    z.set(it.id, 'requires_user_action');
    assert.equal((await app.req('POST', `/api/orders/${o.bookingId}/verify`, { token: o.token })).json.status, 'pending', '3-D Secure still running');
    z.set(it.id, 'completed');
    const v = await app.req('POST', `/api/orders/${o.bookingId}/verify`, { token: o.token });
    assert.equal(v.json.status, 'paid'); assert.match(v.json.ticketUrl, /^\/ticket\?b=/);
    const mail = await waitFor(() => smtp.mails.find((x) => x.to.includes(buyer.email)));
    assert.equal((mail.raw.match(/Content-ID: <qr-\d@bmsw>/g) || []).length, 2);
  });

  it('records cancelled and failed Ziina payments', async () => {
    const a = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    assert.equal((await app.req('POST', `/api/orders/${a.json.bookingId}/verify`, { token: a.json.token, failed: true, reason: 'Checkout cancelled' })).json.status, 'failed');
    const b = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    z.set(z.last().id, 'failed', { latest_error: { message: 'Card declined', code: 'card_declined' } });
    assert.equal((await app.req('POST', `/api/orders/${b.json.bookingId}/verify`, { token: b.json.token })).json.status, 'failed');
    const c = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    z.set(z.last().id, 'completed');
    assert.equal((await app.req('POST', `/api/orders/${c.json.bookingId}/verify`, { token: c.json.token, failed: true })).json.status, 'paid', 'a cancel link never overrides a real payment');
  });

  it('confirms a payment from the webhook alone (buyer closed the tab)', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'day', day: '2026-12-11', qty: 1 });
    const it = z.set(z.last().id, 'completed');
    const body = JSON.stringify({ event: 'payment_intent.status.updated', data: { ...it } });
    assert.equal((await app.req('POST', '/api/webhooks/ziina', body, { 'X-Hmac-Signature': 'bad' })).status, 401);
    assert.equal((await app.req('POST', '/api/webhooks/ziina', body, { 'X-Hmac-Signature': ziinaSign(body, 'zsecret') })).status, 200);
    assert.equal((await app.req('GET', `/api/orders/${o.json.bookingId}?t=${o.json.token}`)).json.status, 'paid');
  });

  it('never trusts a webhook body: a forged "completed" for an unpaid intent changes nothing', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'day', day: '2026-12-12', qty: 1 });
    const it = z.last(); // still requires_payment_instrument at Ziina
    const body = JSON.stringify({ event: 'payment_intent.status.updated', data: { ...it, status: 'completed' } });
    assert.equal((await app.req('POST', '/api/webhooks/ziina', body, { 'X-Hmac-Signature': ziinaSign(body, 'zsecret') })).status, 200);
    assert.equal((await app.req('GET', `/api/orders/${o.json.bookingId}?t=${o.json.token}`)).json.status, 'pending');
    const other = JSON.stringify({ event: 'refund.status.updated', data: { id: 'r1' } });
    assert.equal((await app.req('POST', '/api/webhooks/ziina', other, { 'X-Hmac-Signature': ziinaSign(other, 'zsecret') })).json.ignored, true);
  });

  it('lets admin re-check a pending Ziina payment', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    z.set(z.last().id, 'completed');
    await app.req('POST', '/api/admin/login', { password: 'correct-horse-battery' });
    const r = await app.req('POST', `/api/admin/bookings/${o.json.bookingId}/sync`);
    assert.equal(r.json.status, 'paid');
    const s = await app.req('GET', '/api/admin/stats');
    assert.equal(s.json.mode.payments, 'ziina-test'); assert.equal(s.json.mode.gateway, 'Ziina');
  });

  it('reports a clear error when Ziina is down, and asks Ziina to retry webhooks', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    const it = z.last();
    z.setDown(true);
    const bad = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    assert.equal(bad.status, 502); assert.match(bad.json.error, /Payment service/);
    assert.equal((await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token })).status, 502);
    const body = JSON.stringify({ event: 'payment_intent.status.updated', data: { id: it.id } });
    assert.equal((await app.req('POST', '/api/webhooks/ziina', body, { 'X-Hmac-Signature': ziinaSign(body, 'zsecret') })).status, 502);
    z.setDown(false);
  });
});

describe('Vercel mode with Upstash Redis', () => {
  let redis, smtp, z, a, b;
  before(async () => {
    redis = await fakeRedis(); smtp = await fakeSmtp(); z = await fakeZiina();
    const env = { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: redis.token, ZIINA_API_KEY: ZKEY, ZIINA_API_BASE: z.base,
      SMTP_HOST: 'localhost', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'true', SMTP_USER: 'connect.technow@gmail.com', SMTP_PASS: 'abcdefghijklmnop' };
    a = await launch(env, { vercel: true }); // two copies of the site sharing one Redis, like Vercel
    b = await launch(env, { vercel: true });
  });
  after(async () => { for (const x of [a, b]) if (x) await x.stop(); for (const x of [redis, smtp, z]) if (x) await x.close(); });

  it('serves pages through api/index.js', async () => {
    assert.equal((await a.req('GET', '/')).status, 200);
    assert.equal((await a.req('GET', '/tickets')).status, 200);
    assert.equal((await a.req('GET', '/api/health')).json.storage, 'redis');
  });

  it('shares bookings, queries and the ticket key between server copies', async () => {
    const o = await a.req('POST', '/api/orders', { ...buyer, tierId: 'day-vip', day: '2026-12-13', qty: 1 });
    z.set(z.last().id, 'completed');
    const v = await b.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token }); // other copy confirms
    assert.equal(v.json.status, 'paid');
    // On serverless the e-ticket email has already been sent when the response arrives
    assert.ok(smtp.mails.some((m) => m.to.includes(buyer.email)), 'ticket emailed before the response');
    const page = await a.req('GET', v.json.ticketUrl);
    assert.equal(page.status, 200);
    assert.ok(redis.data.get('bmsw:bookings').has(o.json.bookingId), 'stored in Redis');
    assert.ok(redis.data.get('bmsw:meta:ticket-secret'), 'one shared ticket key');

    const q = await b.req('POST', '/api/contact', { name: 'Vercel Visitor', email: 'v@example.com', message: 'Hello from Vercel', elapsed: 9000 });
    assert.equal(q.status, 200);
    assert.ok(smtp.mails.some((m) => decodeB64Part(m.raw, 'text/html').includes('Vercel Visitor')), 'query emailed before the response');

    // Admin: sign in on copy A, use the cookie on copy B (stateless sessions)
    await a.req('POST', '/api/admin/login', { password: 'correct-horse-battery' });
    const cookieHeader = { Cookie: 'bmsw_admin=' + (await (async () => { const r = await fetch(a.base + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'correct-horse-battery' }) }); return r.headers.get('set-cookie').split(';')[0].split('=')[1]; })()) };
    const qs = await b.req('GET', '/api/admin/queries', undefined, cookieHeader);
    assert.equal(qs.status, 200); assert.equal(qs.json.queries[0].name, 'Vercel Visitor');
    const st = await b.req('GET', '/api/admin/stats', undefined, cookieHeader);
    assert.equal(st.json.mode.storage, 'redis'); assert.equal(st.json.mode.storageWarning, false);
    const code = (await b.req('GET', `/api/admin/bookings?q=${o.json.bookingId}`, undefined, cookieHeader)).json.bookings[0].tickets[0].code;
    assert.equal((await a.req('GET', `/api/admin/tickets/verify?code=${encodeURIComponent(code)}`, undefined, cookieHeader)).json.valid, true);
  });

  it('warns in admin when Vercel runs without Redis', async () => {
    const c = await launch({}, { vercel: true });
    try {
      await c.req('POST', '/api/admin/login', { password: 'correct-horse-battery' });
      const st = await c.req('GET', '/api/admin/stats');
      assert.equal(st.json.mode.storage, 'file'); assert.equal(st.json.mode.storageWarning, true);
    } finally { await c.stop(); }
  });
});

describe('Mailer', () => {
  it('delivers over port 587 with STARTTLS', async () => {
    const smtp = await fakeSmtp({ starttls: true });
    process.env.NODE_EXTRA_CA_CERTS = path.join(__dirname, 'fixtures', 'test-cert.pem');
    const config = require('../lib/config');
    const tls = require('tls');
    const orig = tls.connect;
    const ca = fs.readFileSync(path.join(__dirname, 'fixtures', 'test-cert.pem'));
    tls.connect = (opts, ...rest) => orig({ ...opts, ca }, ...rest); // trust the test cert in-process
    Object.assign(config.mail, { host: 'localhost', port: smtp.port, secure: false, user: 'sender@example.com', pass: 'abcdefghijklmnop' });
    try {
      const mailer = require('../lib/mailer');
      // force the STARTTLS path regardless of the random port number
      const r = await mailer.send({ to: 'x@example.com', subject: 'Hello ✦', html: '<p>Hi</p>' });
      assert.equal(r.sent, true);
      assert.equal(smtp.mails.length, 1);
    } finally { tls.connect = orig; await smtp.close(); }
  });

  it('fails fast (no hang) when the mail server is down', async () => {
    const config = require('../lib/config');
    Object.assign(config.mail, { host: '127.0.0.1', port: 465, secure: true, user: 'a@example.com', pass: 'abcdefghijklmnop' });
    const mailer = require('../lib/mailer');
    const t = Date.now();
    await assert.rejects(mailer.send({ to: 'x@example.com', subject: 's', html: 'h' }));
    assert.ok(Date.now() - t < 5000);
  });
});

describe('Startup safety checks', () => {
  it('refuses to start in production with an http SITE_URL', async () => {
    const r = await launch({ NODE_ENV: 'production', SITE_URL: 'http://bookmyshow.world' }, { expectExit: true });
    assert.equal(r.code, 1); assert.match(r.out, /SITE_URL must start with https/);
  });
  it('refuses an incomplete Ziina API key', async () => {
    const r = await launch({ ZIINA_API_KEY: 'abc123' }, { expectExit: true });
    assert.equal(r.code, 1); assert.match(r.out, /ZIINA_API_KEY looks too short/);
  });
  it('never overwrites a damaged database', async () => {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bmsw-bad-'));
    fs.writeFileSync(path.join(dir, 'db.json'), '{"bookings": [ {"id": "BMW-1"');
    const r = await launch({ DATA_DIR: dir }, { expectExit: true });
    assert.notEqual(r.code, 0); assert.match(r.out, /not valid JSON/);
    assert.equal(fs.readFileSync(path.join(dir, 'db.json'), 'utf8'), '{"bookings": [ {"id": "BMW-1"', 'original untouched');
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('db.json.corrupt-')));
  });
});
