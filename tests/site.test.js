'use strict';
// End-to-end tests against the real server process. Run: npm test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fakeSmtp, fakeStripe, launch, waitFor } = require('./helpers');

const buyer = { name: 'Omar Haddad', email: 'omar@example.com', phone: '+971 50 111 2233' };
const decodeB64Part = (raw, type) => {
  const m = new RegExp(`Content-Type: ${type}[\\s\\S]*?\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+)`).exec(raw);
  return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : '';
};

describe('Bookmyshow.world server (test-mode payments, Gmail via fake SMTP)', () => {
  let smtp, app;
  before(async () => {
    smtp = await fakeSmtp();
    app = await launch({ SMTP_HOST: 'localhost', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'true', SMTP_USER: 'connect.technow@gmail.com', SMTP_PASS: 'abcdefghijklmnop', MAIL_TO: 'connect.technow@gmail.com', STRIPE_WEBHOOK_SECRET: 'whsec_testsecret' });
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

  it('checks Stripe webhook signatures', async () => {
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_unknown', payment_status: 'paid' } } });
    assert.equal((await app.req('POST', '/api/webhooks/stripe', body, { 'Stripe-Signature': 't=1,v1=bad' })).status, 400);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_testsecret').update(`${t}.${body}`).digest('hex');
    assert.equal((await app.req('POST', '/api/webhooks/stripe', body, { 'Stripe-Signature': `t=${t},v1=${sig}` })).status, 200);
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
    assert.ok(fs.existsSync(path.join(app.dataDir, '.ticket-secret')));
  });
});

describe('Stripe checkout (fake Stripe API)', () => {
  let stripe, app;
  before(async () => {
    stripe = await fakeStripe();
    app = await launch({ STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_stripetest', STRIPE_API_HOST: 'localhost', STRIPE_API_PORT: String(stripe.port) });
  });
  after(async () => { if (app) await app.stop(); });

  it('creates an AED Checkout Session with server-side prices', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full-vip', qty: 2 });
    assert.equal(o.status, 201); assert.equal(o.json.testMode, false);
    assert.match(o.json.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
    const s = [...stripe.sessions.values()].at(-1);
    assert.equal(s.params['line_items[0][price_data][currency]'], 'aed');
    assert.equal(s.params['line_items[0][price_data][unit_amount]'], '219664');
    assert.equal(s.params['line_items[0][quantity]'], '2');
    assert.match(s.params.success_url, /\/checkout\?b=BMW-.+&return=success$/);

    // Unpaid: stays pending. Test payments are refused when Stripe is on.
    assert.equal((await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token })).json.status, 'pending');
    assert.equal((await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token, testOutcome: 'success' })).json.status, 'pending');
    // Paid on Stripe → verified by asking Stripe, never trusting the browser
    stripe.pay(s.id);
    const v = await app.req('POST', `/api/orders/${o.json.bookingId}/verify`, { token: o.json.token });
    assert.equal(v.json.status, 'paid');
  });

  it('confirms a payment from the webhook alone (buyer closed the tab)', async () => {
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'day', day: '2026-12-11', qty: 1 });
    const s = [...stripe.sessions.values()].at(-1);
    const paidSession = stripe.pay(s.id);
    const body = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: paidSession.id, payment_status: 'paid', payment_intent: paidSession.payment_intent } } });
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', 'whsec_stripetest').update(`${t}.${body}`).digest('hex');
    assert.equal((await app.req('POST', '/api/webhooks/stripe', body, { 'Stripe-Signature': `t=${t},v1=${sig}` })).status, 200);
    const st = await app.req('GET', `/api/orders/${o.json.bookingId}?t=${o.json.token}`);
    assert.equal(st.json.status, 'paid');
  });

  it('reports a clear error when Stripe is unreachable', async () => {
    await stripe.close();
    const o = await app.req('POST', '/api/orders', { ...buyer, tierId: 'full', qty: 1 });
    assert.equal(o.status, 502); assert.match(o.json.error, /Payment service/);
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
  it('refuses a publishable Stripe key', async () => {
    const r = await launch({ STRIPE_SECRET_KEY: 'pk_live_abc' }, { expectExit: true });
    assert.equal(r.code, 1); assert.match(r.out, /does not look like a Stripe secret key/);
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
