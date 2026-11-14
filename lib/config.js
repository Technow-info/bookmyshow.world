'use strict';
// Loads .env (if present) without any dependency, then exposes typed config.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // allow: KEY=value  # comment
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;

const cfg = module.exports = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  // Set TRUST_PROXY=1 when running behind Nginx / Render / Railway / Cloudflare so the real visitor IP is used for rate limits.
  trustProxy: /^(1|true|yes)$/i.test(env.TRUST_PROXY || ''),
  // Time zone used to group bookings by day on the dashboard.
  reportTimeZone: env.REPORT_TIMEZONE || 'Asia/Kolkata',
  siteUrl: (env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Admin
  adminPassword: env.ADMIN_PASSWORD || '',

  // Stripe. Without a secret key the site runs in clearly-labelled TEST MODE.
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // Only for automated tests (points the client at a local fake Stripe). Leave unset in production.
    apiHost: env.STRIPE_API_HOST || 'api.stripe.com',
    apiPort: Number(env.STRIPE_API_PORT || 443),
  },
  currency: 'AED',

  // Gmail SMTP (use a Google "App password", not the account password)
  mail: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),
    // true = TLS from the first byte (port 465). false = plain connect then STARTTLS (port 587). Default: decided by port.
    secure: env.SMTP_SECURE ? /^(1|true|yes)$/i.test(env.SMTP_SECURE) : Number(env.SMTP_PORT || 465) === 465,
    user: env.SMTP_USER || '',
    pass: (env.SMTP_PASS || '').replace(/\s+/g, ''),
    to: env.MAIL_TO || 'connect.technow@gmail.com',
    fromName: env.MAIL_FROM_NAME || 'Bookmyshow.world',
  },

  // Event details (from the site owner's sample; * = to be reconfirmed before publication)
  event: {
    name: 'Bookmyshow.world',
    days: [
      { id: '2026-12-11', label: 'Friday 11 December 2026' },
      { id: '2026-12-12', label: 'Saturday 12 December 2026' },
      { id: '2026-12-13', label: 'Sunday 13 December 2026' },
    ],
  },

  // Ticket tiers. Prices are in fils (AED 1 = 100 fils) and are the ONLY source of truth for pricing.
  // capacity: null = no limit set. Put the real allocation from the ticket issuer here.
  tiers: [
    { id: 'full', tag: '3-day festival pass', name: 'Full Madness Pass', desc: '3-day festival pass with entry on all three festival days at Wisdom Valley, Pattaya. Inclusions and validity are confirmed with the authorized ticket issuer.', price: 135931, capacity: null },
    { id: 'full-vip', tag: '3-day VIP pass', name: 'Full Madness Comfort (VIP) Pass', desc: '3-day VIP festival pass with the Comfort experience. VIP benefits and VIP access areas follow the official ticket terms.', price: 219664, capacity: null, featured: true },
    { id: 'day', tag: 'Single-day pass', name: 'Day Pass', desc: 'Single-day festival ticket for the day you choose. Your festival date and entry conditions must be confirmed.', price: 55460, capacity: null, pickDay: true },
    { id: 'day-vip', tag: 'Single-day VIP pass', name: 'Day Comfort (VIP) Pass', desc: 'Single-day VIP festival ticket with the Comfort experience. VIP benefits and VIP access areas follow the official ticket terms.', price: 89170, capacity: null, pickDay: true },
  ],
  maxQtyPerOrder: 10,
};

// ---------- startup checks: returns { errors, warnings } ----------
cfg.validate = function validate() {
  const errors = [], warnings = [];
  const prod = cfg.env === 'production';
  let site;
  try { site = new URL(cfg.siteUrl); } catch { errors.push(`SITE_URL "${cfg.siteUrl}" is not a valid URL (example: https://bookmyshow.world)`); }
  if (site && prod && site.protocol !== 'https:') errors.push('SITE_URL must start with https:// in production (Stripe return links and secure cookies need it).');
  if (site && prod && /localhost|127\.0\.0\.1/.test(site.hostname)) errors.push('SITE_URL still points to localhost. Set it to your real domain.');
  if (!(cfg.port > 0 && cfg.port < 65536)) errors.push(`PORT "${env.PORT}" is not a valid port number.`);
  if (!cfg.adminPassword) warnings.push('ADMIN_PASSWORD is not set: the /admin dashboard is disabled.');
  else if (cfg.adminPassword.length < 12) (prod ? errors : warnings).push('ADMIN_PASSWORD should be at least 12 characters.');
  const sk = cfg.stripe.secretKey;
  if (sk && !/^(sk|rk)_(test|live)_/.test(sk)) errors.push('STRIPE_SECRET_KEY does not look like a Stripe secret key (sk_test_… or sk_live_…). Never use the publishable pk_ key here.');
  if (sk && !cfg.stripe.webhookSecret) warnings.push('STRIPE_WEBHOOK_SECRET is not set: payments still work, but a buyer who closes the tab before returning will only be confirmed when they reload.');
  if (cfg.stripe.webhookSecret && !/^whsec_/.test(cfg.stripe.webhookSecret)) errors.push('STRIPE_WEBHOOK_SECRET should start with whsec_.');
  if (prod && !sk) warnings.push('No STRIPE_SECRET_KEY: checkout runs in TEST MODE (simulated payments).');
  if (prod && sk && sk.startsWith('sk_test_')) warnings.push('Using a Stripe TEST key in production: no real money is collected.');
  const m = cfg.mail;
  if (!!m.user !== !!m.pass) errors.push('Set both SMTP_USER and SMTP_PASS (or neither).');
  if (m.user && !(m.port > 0 && m.port < 65536)) errors.push(`SMTP_PORT "${env.SMTP_PORT}" is not a valid port. Gmail uses 465 (or 587).`);
  if (m.pass && m.host === 'smtp.gmail.com' && m.pass.length !== 16) warnings.push('SMTP_PASS for Gmail should be a 16-letter App Password, not your normal Gmail password.');
  if (!m.user) warnings.push('SMTP_USER/SMTP_PASS not set: e-tickets and query alerts will NOT be emailed (they are still saved in the dashboard).');
  try { new Intl.DateTimeFormat('en-CA', { timeZone: cfg.reportTimeZone }); } catch { errors.push(`REPORT_TIMEZONE "${cfg.reportTimeZone}" is not a valid time zone (example: Asia/Dubai).`); }
  if (prod && !env.TICKET_SECRET) warnings.push('TICKET_SECRET not set: a signing key is kept in DATA_DIR/.ticket-secret (created on first start). Back it up with your data, or set TICKET_SECRET.');
  return { errors, warnings };
};
