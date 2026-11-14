'use strict';
// Tiny JSON-file datastore with atomic writes. Good for launch-scale traffic on one server.
// To scale beyond one process, swap this module for Postgres/MySQL — the API surface is small.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const file = path.join(config.dataDir, 'db.json');
fs.mkdirSync(config.dataDir, { recursive: true });

let state = { bookings: [], queries: [], emails: [] };
if (fs.existsSync(file)) {
  try { state = Object.assign(state, JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { console.error('db.json unreadable, starting empty:', e.message); }
}

let writing = Promise.resolve();
function persist() {
  const snapshot = JSON.stringify(state, null, 2);
  writing = writing.then(() => new Promise((resolve) => {
    const tmp = file + '.tmp';
    fs.writeFile(tmp, snapshot, (err) => {
      if (err) { console.error('db write failed', err); return resolve(); }
      fs.rename(tmp, file, (err2) => { if (err2) console.error('db rename failed', err2); resolve(); });
    });
  }));
  return writing;
}

function newId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

module.exports = {
  state,
  persist,
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
