'use strict';
// Adds SAMPLE bookings and queries so you can preview the admin dashboard (file storage or Redis).
// For local review only. Sample records are marked "sample": true.
// Remove them before going live:  node scripts/seed-demo.js --clear
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../lib/config');
const tickets = require('../lib/tickets');
const store = require('../lib/store');

async function clear() {
  if (store.kind === 'file') {
    const file = path.join(config.dataDir, 'db.json');
    if (fs.existsSync(file)) {
      const db = JSON.parse(fs.readFileSync(file, 'utf8'));
      ['bookings', 'queries'].forEach((k) => { db[k] = (db[k] || []).filter((x) => !x.sample); });
      fs.writeFileSync(file, JSON.stringify(db, null, 2));
    }
    return console.log('Removed sample records from', file);
  }
  console.log('Redis: remove sample records from the admin view by filtering "sample": true, or flush the bmsw:* keys in the Upstash console.');
}

const names = ['Aarav Menon', 'Diya Nair', 'Rohan Pillai', 'Ananya Iyer', 'Kabir Thomas', 'Meera Joseph', 'Arjun Varma', 'Sara George', 'Nikhil Das', 'Fatima Rahman', 'Vivek Kurian', 'Isha Reddy'];
const rand = (n) => Math.floor(Math.random() * n);
const weights = { full: 6, 'full-vip': 2, day: 4, 'day-vip': 2 };
const pickTier = () => { const pool = []; config.tiers.forEach((t) => { for (let i = 0; i < weights[t.id]; i++) pool.push(t); }); return pool[rand(pool.length)]; };
const bookings = [];
for (let i = 0; i < 140; i++) {
  const t = pickTier(); const day = t.pickDay ? config.event.days[rand(config.event.days.length)] : null; const qty = 1 + (Math.random() < 0.35 ? rand(3) + 1 : 0);
  const dayAgo = Math.floor(Math.pow(Math.random(), 0.7) * 14);
  const created = new Date(Date.now() - dayAgo * 864e5 - rand(20) * 3600e3);
  if (created > Date.now()) created.setTime(Date.now() - 600e3);
  const nm = names[rand(names.length)];
  const r = Math.random(); const status = r < 0.86 ? 'paid' : r < 0.95 ? 'failed' : 'pending';
  bookings.push({
    id: 'BMW-' + created.getTime().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase(),
    token: crypto.randomBytes(16).toString('hex'), tierId: t.id, tierName: t.name, seats: t.seats || 1, qty, unitPrice: t.price, amount: t.price * qty, currency: 'AED', day: day ? day.id : null, dayLabel: day ? day.label : null,
    name: nm, email: nm.toLowerCase().replace(/\s+/g, '.') + '@example.com', phone: '+971 5' + String(10000000 + rand(89999999)),
    status, createdAt: created.toISOString(), gateway: 'test', sample: true,
    ...(status === 'paid' ? { paidAt: new Date(created.getTime() + 90e3).toISOString(), paymentId: 'TEST-' + crypto.randomBytes(4).toString('hex').toUpperCase() } : {}),
    ...(status === 'failed' ? { failReason: 'Test payment declined' } : {}),
  });
}
async function main() {
  if (process.argv.includes('--clear')) return clear();
  await store.init(); await tickets.init(store);
  bookings.forEach((b) => { b.sample = true; if (b.status === 'paid') { b.tickets = tickets.issue(b).map(({ n, code }) => ({ n, code })); b.ticketEmail = { status: 'sent', at: b.paidAt }; } });
bookings.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const queries = [
  { subject: 'Full Madness Comfort (VIP) Pass', message: 'We are a group of 6. Can we book all VIP passes in one payment?' },
  { subject: 'Day Pass', message: 'Which day is best for a first-time visitor?' },
  { subject: 'Payment', message: 'My card was charged but I did not receive the confirmation email.' },
].map((q, i) => ({ id: 'Q-SAMPLE' + i, name: names[i + 3], email: names[i + 3].toLowerCase().replace(/\s+/g, '.') + '@example.com', phone: '', createdAt: new Date(Date.now() - i * 5 * 3600e3).toISOString(), status: i === 2 ? 'replied' : 'new', source: 'contact', sample: true, ...q }));
  for (const b of bookings) await store.saveBooking(b);
  for (const q of queries) await store.saveQuery(q);
  console.log(`Added ${bookings.length} sample bookings and ${queries.length} sample queries to ${store.describe()}`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
