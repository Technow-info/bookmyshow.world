'use strict';
// Tiny JSON-file datastore with atomic writes. Good for launch-scale traffic on one server.
// To scale beyond one process, swap this module for Postgres/MySQL — the API surface is small.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const file = path.join(config.dataDir, 'db.json');
fs.mkdirSync(config.dataDir, { recursive: true });
// Fail fast if the data folder isn't writable (e.g. read-only container filesystem without a volume).
fs.accessSync(config.dataDir, fs.constants.W_OK);

let state = { bookings: [], queries: [], emails: [] };
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8');
  try {
    const parsed = raw.trim() ? JSON.parse(raw) : {};
    state = Object.assign(state, parsed);
    ['bookings', 'queries', 'emails'].forEach((k) => { if (!Array.isArray(state[k])) state[k] = []; });
  } catch (e) {
    // Never overwrite a damaged file: keep it aside so no booking is lost, and refuse to start.
    const keep = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, keep);
    throw new Error(`data/db.json is not valid JSON (${e.message}). A copy was saved to ${keep}. Fix or restore it from backup, then restart.`);
  }
}

let writing = Promise.resolve();
let pending = 0;
function persist() {
  pending += 1;
  const snapshot = JSON.stringify(state, null, 2);
  writing = writing.then(() => new Promise((resolve) => {
    const tmp = file + '.tmp';
    const done = () => { pending -= 1; resolve(); };
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('db write failed', err); return done(); }
      fs.rename(tmp, file, (err2) => { if (err2) console.error('db rename failed', err2); done(); });
    });
  }));
  return writing;
}
// Synchronous final save, used on shutdown so nothing in memory is lost.
function flushSync() {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  state,
  persist,
  flushSync,
  idle: () => writing,
  newId,
  bookings: () => state.bookings,
  queries: () => state.queries,
  findBooking: (id) => state.bookings.find((b) => b.id === id),
  findBookingByGatewayOrder: (oid) => state.bookings.find((b) => b.gatewayOrderId === oid),
  addBooking(b) { state.bookings.push(b); persist(); return b; },
  addQuery(q) { state.queries.push(q); persist(); return q; },
  emails: () => state.emails || (state.emails = []),
  logEmail(e) { const list = state.emails || (state.emails = []); list.push(e); if (list.length > 1000) list.splice(0, list.length - 1000); persist(); return e; },
  // Seats held = paid + still-pending (pending holds expire after 30 minutes)
  seatsTaken(tierId) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    return state.bookings
      .filter((b) => b.tierId === tierId && (b.status === 'paid' || (b.status === 'pending' && Date.parse(b.createdAt) > cutoff)))
      .reduce((n, b) => n + b.qty, 0);
  },
};
