'use strict';
// Storage for bookings, queries, the email log and small settings.
//
// Two backends with the same async API:
//   • redis: Upstash Redis over its REST API. Use this on Vercel or any serverless host,
//            where the disk is temporary and several copies of the site run at once.
//            Enabled by UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//            (or Vercel's KV_REST_API_URL + KV_REST_API_TOKEN).
//   • file:  one JSON file in DATA_DIR. Use this on a normal server with a persistent disk.
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('./config');

const MAX_EMAILS = 1000;

// ======================= file backend =======================
function fileBackend() {
  const file = path.join(config.dataDir, 'db.json');
  let state = null;
  let writing = Promise.resolve();

  function load() {
    if (state) return;
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.accessSync(config.dataDir, fs.constants.W_OK); // fail fast on a read-only disk
    state = { bookings: [], queries: [], emails: [], meta: {} };
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    try {
      Object.assign(state, raw.trim() ? JSON.parse(raw) : {});
      ['bookings', 'queries', 'emails'].forEach((k) => { if (!Array.isArray(state[k])) state[k] = []; });
      if (!state.meta || typeof state.meta !== 'object') state.meta = {};
    } catch (e) {
      // Never overwrite a damaged file: keep it aside so no booking is lost, and refuse to start.
      const keep = file + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, keep);
      state = null;
      throw new Error(`${file} is not valid JSON (${e.message}). A copy was saved to ${keep}. Fix or restore it from backup, then restart.`);
    }
  }
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
  const upsert = (list, item) => { const i = list.findIndex((x) => x.id === item.id); if (i >= 0) list[i] = item; else list.push(item); };

  return {
    kind: 'file',
    async init() { load(); },
    async listBookings() { return state.bookings.slice(); },
    async getBooking(id) { return state.bookings.find((b) => b.id === id) || null; },
    async getBookingByGateway(gid) { return state.bookings.find((b) => b.gatewayOrderId === gid) || null; },
    async saveBooking(b) { upsert(state.bookings, b); await persist(); return b; },
    async listQueries() { return state.queries.slice(); },
    async getQuery(id) { return state.queries.find((q) => q.id === id) || null; },
    async saveQuery(q) { upsert(state.queries, q); await persist(); return q; },
    async listEmails() { return state.emails.slice(); },
    async saveEmail(e) { upsert(state.emails, e); if (state.emails.length > MAX_EMAILS) state.emails.splice(0, state.emails.length - MAX_EMAILS); await persist(); return e; },
    async getOrCreateMeta(key, make) { if (!state.meta[key]) { state.meta[key] = make(); await persist(); } return state.meta[key]; },
    idle: () => writing,
    flushSync() { if (!state) return; const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, file); },
    describe: () => `file ${file}`,
  };
}

// ======================= Upstash Redis backend =======================
function redisBackend(baseUrl, token) {
  const base = new URL(baseUrl.replace(/\/$/, ''));
  const lib = base.protocol === 'http:' ? http : https;
  const P = config.storePrefix;
  const K = { bookings: P + 'bookings', gw: P + 'gw', queries: P + 'queries', emails: P + 'emails', meta: P + 'meta:' };

  function call(pathname, body) {
    const data = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const req = lib.request({
        method: 'POST', hostname: base.hostname, port: base.port || undefined, path: (base.pathname === '/' ? '' : base.pathname) + pathname,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
        timeout: 10000,
      }, (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => {
          let json; try { json = JSON.parse(out); } catch { return reject(new Error(`Redis: bad response (${res.statusCode})`)); }
          if (res.statusCode >= 400 || (json && json.error)) return reject(new Error('Redis: ' + ((json && json.error) || res.statusCode)));
          resolve(json);
        });
      });
      req.on('timeout', () => req.destroy(new Error('Redis: request timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }
  const cmd = async (...args) => (await call('/', args.map(String))).result;
  const pipeline = async (cmds) => {
    const res = await call('/pipeline', cmds.map((c) => c.map(String)));
    const bad = res.find((r) => r && r.error); if (bad) throw new Error('Redis: ' + bad.error);
    return res.map((r) => r.result);
  };
  const parse = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  const values = (flat) => { const out = []; for (let i = 1; i < (flat || []).length; i += 2) { const v = parse(flat[i]); if (v) out.push(v); } return out; };
  const byCreated = (a, b) => String(a.createdAt || a.at || '').localeCompare(String(b.createdAt || b.at || ''));

  return {
    kind: 'redis',
    async init() { const pong = await cmd('PING'); if (pong !== 'PONG') throw new Error('Redis did not answer PING'); },
    async listBookings() { return values(await cmd('HGETALL', K.bookings)).sort(byCreated); },
    async getBooking(id) { return parse(await cmd('HGET', K.bookings, id)); },
    async getBookingByGateway(gid) { const id = await cmd('HGET', K.gw, gid); return id ? parse(await cmd('HGET', K.bookings, id)) : null; },
    async saveBooking(b) {
      const cmds = [['HSET', K.bookings, b.id, JSON.stringify(b)]];
      if (b.gatewayOrderId) cmds.push(['HSET', K.gw, b.gatewayOrderId, b.id]);
      await pipeline(cmds); return b;
    },
    async listQueries() { return values(await cmd('HGETALL', K.queries)).sort(byCreated); },
    async getQuery(id) { return parse(await cmd('HGET', K.queries, id)); },
    async saveQuery(q) { await cmd('HSET', K.queries, q.id, JSON.stringify(q)); return q; },
    async listEmails() { return values(await cmd('HGETALL', K.emails)).sort(byCreated); },
    async saveEmail(e) {
      await cmd('HSET', K.emails, e.id, JSON.stringify(e));
      if (Math.random() < 0.05) { // occasional trim to the newest MAX_EMAILS
        const all = values(await cmd('HGETALL', K.emails)).sort(byCreated);
        const old = all.slice(0, Math.max(0, all.length - MAX_EMAILS)).map((x) => x.id);
        if (old.length) await cmd('HDEL', K.emails, ...old);
      }
      return e;
    },
    async getOrCreateMeta(key, make) {
      const k = K.meta + key;
      await cmd('SET', k, make(), 'NX'); // first writer wins, so every instance shares one value
      return cmd('GET', k);
    },
    idle: () => Promise.resolve(),
    flushSync() {},
    describe: () => `Upstash Redis ${base.hostname}`,
  };
}

const redisUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
module.exports = redisUrl && redisToken ? redisBackend(redisUrl, redisToken) : fileBackend();
