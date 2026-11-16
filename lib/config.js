'use strict';

// Loads .env (if present) without any dependency,
// then exposes typed config.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');

if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);

    if (!m || line.trim().startsWith('#')) continue;

    let v = m[2];

    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, ''); // allow: KEY=value  # comment
    }

    if (process.env[m[1]] === undefined) {
      process.env[m[1]] = v;
    }
  }
}

const env = process.env;
const yes = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());

// Running as a serverless function (Vercel, AWS Lambda): no persistent disk,
// and work after the response is sent may never run.
const serverless = Boolean(env.VERCEL || env.AWS_LAMBDA_FUNCTION_NAME);
const redisConfigured = Boolean(
  (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) ||
  (env.KV_REST_API_URL && env.KV_REST_API_TOKEN)
);

const cfg = module.exports = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  serverless,

  // Proxy configuration: set TRUST_PROXY=1 behind Nginx / Vercel / Render / Cloudflare
  // so the real visitor IP is used for rate limits. Automatically on for Vercel.
  trustProxy: yes(env.TRUST_PROXY) || Boolean(env.VERCEL),

  // Booking dashboard timezone
  reportTimeZone: env.REPORT_TIMEZONE || 'Asia/Kolkata',

  // Website URL. On Vercel, falls back to the production domain Vercel provides.
  siteUrl: (
    env.SITE_URL ||
    (env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${env.VERCEL_PROJECT_PRODUCTION_URL}` : '') ||
    'http://localhost:3000'
  ).replace(/\/+$/, ''),

  // Storage. With Upstash Redis configured, data lives in Redis (required on Vercel).
  // Otherwise one JSON file in DATA_DIR (fine on a normal server with a persistent disk).
  redisConfigured,
  storePrefix: env.STORE_PREFIX || 'bmsw:',
  dataDir: env.DATA_DIR || (serverless ? '/tmp/bookmyshow-data' : path.join(__dirname, '..', 'data')),

  // Admin
  adminPassword: env.ADMIN_PASSWORD || '',

  // Ziina (UAE payments). Without an API key the site runs in TEST MODE (simulated payments).
  ziina: {
    apiKey: env.ZIINA_API_KEY || '',
    // true = Ziina test payments (any card works, nothing is charged). Turn off for real money.
    testMode: yes(env.ZIINA_TEST_MODE),
    webhookSecret: env.ZIINA_WEBHOOK_SECRET || '',
    // Only for automated tests (points at a local fake Ziina). Leave unset in production.
    apiBase: env.ZIINA_API_BASE || 'https://api-v2.ziina.com/api',
  },

  currency: 'AED',

  // Gmail SMTP
  // Use a Google App Password, not your normal Gmail password.
  mail: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),

    // true = TLS from the first byte (port 465). false = STARTTLS (port 587). Default: decided by port.
    secure: env.SMTP_SECURE
      ? yes(env.SMTP_SECURE)
      : Number(env.SMTP_PORT || 465) === 465,

    user: env.SMTP_USER || '',
    pass: (env.SMTP_PASS || '').replace(/\s+/g, ''),
    to: env.MAIL_TO || 'connect.technow@gmail.com',
    fromName: env.MAIL_FROM_NAME || 'Bookmyshow.world',
  },

  // Event details
  event: {
    name: 'Bookmyshow.world',

    days: [
      { id: '2026-12-11', label: 'Friday 11 December 2026' },
      { id: '2026-12-12', label: 'Saturday 12 December 2026' },
      { id: '2026-12-13', label: 'Sunday 13 December 2026' },
    ],
  },

  // Ticket tiers
  // Prices are in fils (AED 1 = 100 fils) and are the ONLY source of truth for pricing.
  // capacity: null = no limit set.
  tiers: [
    {
      id: 'full',
      tag: '3-day festival pass',
      name: 'Full Madness Pass',
      desc: '3-day festival pass with entry on all three festival days at Wisdom Valley, Pattaya. Inclusions and validity are confirmed with the authorized ticket issuer.',
      price: 135931,
      capacity: null,
    },
    {
      id: 'full-vip',
      tag: '3-day VIP pass',
      name: 'Full Madness Comfort (VIP) Pass',
      desc: '3-day VIP festival pass with the Comfort experience. VIP benefits and VIP access areas follow the official ticket terms.',
      price: 219664,
      capacity: null,
      featured: true,
    },
    {
      id: 'day',
      tag: 'Single-day pass',
      name: 'Day Pass',
      desc: 'Single-day festival ticket for the day you choose. Your festival date and entry conditions must be confirmed.',
      price: 55460,
      capacity: null,
      pickDay: true,
    },
    {
      id: 'day-vip',
      tag: 'Single-day VIP pass',
      name: 'Day Comfort (VIP) Pass',
      desc: 'Single-day VIP festival ticket with the Comfort experience. VIP benefits and VIP access areas follow the official ticket terms.',
      price: 89170,
      capacity: null,
      pickDay: true,
    },
  ],

  maxQtyPerOrder: 10,
};

// ---------- Startup checks ----------
// Returns { errors, warnings }

cfg.validate = function validate() {
  const errors = [];
  const warnings = [];

  const prod = cfg.env === 'production';

  let site;

  try {
    site = new URL(cfg.siteUrl);
  } catch {
    errors.push(`SITE_URL "${cfg.siteUrl}" is not a valid URL (example: https://bookmyshow.world)`);
  }

  if (site && prod && site.protocol !== 'https:') {
    errors.push('SITE_URL must start with https:// in production (payment return links and secure cookies need it).');
  }

  if (site && prod && /(localhost|127\.0\.0\.1)/.test(site.hostname)) {
    errors.push('SITE_URL still points to localhost. Set it to your real domain.');
  }

  if (!(cfg.port > 0 && cfg.port < 65536)) {
    errors.push(`PORT "${env.PORT}" is not a valid port number.`);
  }

  if (!cfg.adminPassword) {
    warnings.push('ADMIN_PASSWORD is not set: the /admin dashboard is disabled.');
  } else if (cfg.adminPassword.length < 12) {
    (prod ? errors : warnings).push('ADMIN_PASSWORD should be at least 12 characters.');
  }

  // Storage
  if (cfg.serverless && !cfg.redisConfigured) {
    warnings.push(
      'Running on Vercel/serverless WITHOUT Upstash Redis: bookings and queries are kept in /tmp and WILL be lost. ' +
      'Add Upstash Redis (Vercel → Storage) so UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are set.'
    );
  }

  // Ziina
  const k = cfg.ziina.apiKey;

  if (k && k.length < 20) {
    errors.push('ZIINA_API_KEY looks too short. Copy the full API key from ziina.com/business/connect.');
  }

  if (prod && !k) {
    warnings.push('No ZIINA_API_KEY: checkout runs in TEST MODE (simulated payments, nothing is charged).');
  }

  if (k && cfg.ziina.testMode) {
    (prod ? warnings : []).push('ZIINA_TEST_MODE is on: Ziina takes test payments only, no real money is collected.');
  }

  if (k && !cfg.ziina.webhookSecret) {
    warnings.push('ZIINA_WEBHOOK_SECRET is not set: payments still work, but register a webhook with a secret (npm run ziina:webhook) so bookings are confirmed even if the buyer closes the tab.');
  }

  // Gmail validation
  const m = cfg.mail;

  if (!!m.user !== !!m.pass) {
    errors.push('Set both SMTP_USER and SMTP_PASS (or neither).');
  }

  if (m.user && !(m.port > 0 && m.port < 65536)) {
    errors.push(`SMTP_PORT "${env.SMTP_PORT}" is not a valid port. Gmail uses 465 (or 587).`);
  }

  if (m.pass && m.host === 'smtp.gmail.com' && m.pass.length !== 16) {
    warnings.push('SMTP_PASS for Gmail should be a 16-letter App Password, not your normal Gmail password.');
  }

  if (!m.user) {
    warnings.push('SMTP_USER/SMTP_PASS not set: e-tickets and query alerts will NOT be emailed (they are still saved in the dashboard).');
  }

  // Timezone validation
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: cfg.reportTimeZone });
  } catch {
    errors.push(`REPORT_TIMEZONE "${cfg.reportTimeZone}" is not a valid time zone (example: Asia/Dubai).`);
  }

  // Ticket signing secret
  if (prod && !env.TICKET_SECRET) {
    warnings.push('TICKET_SECRET not set: a signing key is generated and kept in storage. Setting TICKET_SECRET yourself is safer.');
  }

  return { errors, warnings };
};
