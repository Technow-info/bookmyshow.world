'use strict';
// Ziina payments (UAE) via the Payment Intent API — no SDK needed.
// Docs: https://docs.ziina.com/api-reference/payment-intent  ·  Webhooks: https://docs.ziina.com/api-reference/webhook
//   POST /payment_intent      → { id, redirect_url, status }
//   GET  /payment_intent/{id} → { status: requires_payment_instrument | requires_user_action | pending | completed | failed | canceled }
// Amounts are in fils (AED 1 = 100 fils). Minimum payment: AED 2.
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');

const enabled = () => Boolean(config.ziina.apiKey);

function request(method, pathname, body) {
  const base = new URL(config.ziina.apiBase);
  const lib = base.protocol === 'http:' ? http : https;
  const data = body ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = lib.request({
      method, hostname: base.hostname, port: base.port || undefined,
      path: base.pathname.replace(/\/$/, '') + pathname,
      headers: { Authorization: `Bearer ${config.ziina.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000,
    }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => {
        let json = null; try { json = out ? JSON.parse(out) : {}; } catch { /* non-JSON */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && json) return resolve(json);
        const msg = (json && (json.message || (json.error && (json.error.message || json.error)) || json.latest_error)) || `HTTP ${res.statusCode}`;
        reject(new Error(`Ziina: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('Ziina timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// Creates a hosted payment page. Ziina swaps {PAYMENT_INTENT_ID} in the return URLs for the real id.
function createPaymentIntent({ amount, message, successUrl, cancelUrl, failureUrl }) {
  return request('POST', '/payment_intent', {
    amount,
    currency_code: config.currency,
    message: String(message).slice(0, 200),
    success_url: successUrl,
    cancel_url: cancelUrl,
    failure_url: failureUrl,
    test: config.ziina.testMode,
    expiry: String(Date.now() + 30 * 60e3), // 30 minutes, matches the seat hold
    allow_tips: false,
  });
}

const getPaymentIntent = (id) => request('GET', `/payment_intent/${encodeURIComponent(id)}`);

// Map Ziina's status to ours: paid | failed | pending
function outcome(status) {
  if (status === 'completed') return 'paid';
  if (status === 'failed' || status === 'canceled') return 'failed';
  return 'pending';
}

// X-Hmac-Signature = hex(HMAC-SHA256(secret, raw body)). Only sent when a secret was set when registering the webhook.
function verifySignature(rawBody, header) {
  if (!config.ziina.webhookSecret) return null; // no secret configured: caller must re-check with the API (it always does)
  if (!header) return false;
  const expected = crypto.createHmac('sha256', config.ziina.webhookSecret).update(rawBody).digest('hex');
  const got = String(header).trim().toLowerCase();
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

// Webhooks come only from these Ziina addresses (per their docs).
const WEBHOOK_IPS = ['3.29.184.186', '3.29.190.95', '20.233.47.127', '13.202.161.181'];

// One-off: tell Ziina where to send webhooks (see scripts/ziina-webhook.js)
const registerWebhook = (url, secret) => request('POST', '/webhook', secret ? { url, secret } : { url });

module.exports = { enabled, createPaymentIntent, getPaymentIntent, outcome, verifySignature, registerWebhook, WEBHOOK_IPS };
