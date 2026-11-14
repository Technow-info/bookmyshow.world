'use strict';
// Loads .env (if present) without any dependency, then exposes typed config.
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3000),
  siteUrl: (env.SITE_URL || 'http://localhost:3000').replace(/\/$/, ''),
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),

  // Admin
  adminPassword: env.ADMIN_PASSWORD || '',

  // Stripe. Without a secret key the site runs in clearly-labelled TEST MODE.
  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
  },
  currency: 'AED',

  // Gmail SMTP (use a Google "App password", not the account password)
  mail: {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(env.SMTP_PORT || 465),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
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
