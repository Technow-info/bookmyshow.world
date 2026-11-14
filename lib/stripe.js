'use strict';
// Stripe Checkout (hosted payment page) via the REST API — no SDK needed.
// Docs: https://docs.stripe.com/api/checkout/sessions  ·  Webhooks: https://docs.stripe.com/webhooks
const https = require('https');
const crypto = require('crypto');
const config = require('./config');

const enabled = () => Boolean(config.stripe.secretKey);

// Stripe expects application/x-www-form-urlencoded with bracketed keys for nested objects.
function encode(obj, prefix, out = []) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') encode(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  }
  return out.join('&');
}

function request(method, path, params) {
  const body = params ? encode(params) : '';
  return new Promise((resolve, reject) => {
    const req = https.request({
      method, host: config.stripe.apiHost, port: config.stripe.apiPort, path,
      headers: {
        Authorization: `Bearer ${config.stripe.secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Stripe-Version': '2024-06-20',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error((json.error && json.error.message) || `Stripe error ${res.statusCode}`));
        } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Stripe timed out')));
    req.on('error', reject);
    req.end(body);
  });
}

// amount is in fils (AED × 100)
function createCheckoutSession({ booking, productName, unitAmount, successUrl, cancelUrl }) {
  return request('POST', '/v1/checkout/sessions', {
    mode: 'payment',
    client_reference_id: booking.id,
    customer_email: booking.email,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: Math.floor(Date.now() / 1000) + 32 * 60, // Stripe minimum is 30 min; roughly matches the seat hold
    line_items: { 0: { quantity: booking.qty, price_data: { currency: config.currency.toLowerCase(), unit_amount: unitAmount, product_data: { name: productName } } } },
    metadata: { booking: booking.id },
    payment_intent_data: { metadata: { booking: booking.id } },
  });
}

const retrieveSession = (id) => request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`);

// Stripe-Signature: t=timestamp,v1=hex(hmac_sha256(secret, `${t}.${rawBody}`))
function verifyWebhook(rawBody, header) {
  if (!config.stripe.webhookSecret || !header) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')));
  const t = parts.t; const sigs = String(header).split(',').filter((p) => p.startsWith('v1=')).map((p) => p.slice(3));
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // replay window
  const expected = crypto.createHmac('sha256', config.stripe.webhookSecret).update(`${t}.${rawBody}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

module.exports = { enabled, createCheckoutSession, retrieveSession, verifyWebhook };
