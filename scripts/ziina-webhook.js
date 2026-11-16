'use strict';
// Registers this site's webhook with Ziina, so payments are confirmed even if the buyer closes the tab.
//   npm run ziina:webhook
// Needs ZIINA_API_KEY (with the write_webhooks permission), SITE_URL (https) and ZIINA_WEBHOOK_SECRET in .env.
// Ziina keeps one webhook per account: running this again replaces it.
const crypto = require('crypto');
const config = require('../lib/config');
const ziina = require('../lib/ziina');

(async () => {
  if (!config.ziina.apiKey) throw new Error('Set ZIINA_API_KEY first.');
  if (!/^https:\/\//.test(config.siteUrl) || /localhost/.test(config.siteUrl)) throw new Error(`SITE_URL must be your public https address (now: ${config.siteUrl}).`);
  if (!config.ziina.webhookSecret) {
    const s = crypto.randomBytes(24).toString('hex');
    console.log('No ZIINA_WEBHOOK_SECRET set. Add this line to your server settings (.env or Vercel → Settings → Environment Variables), redeploy, then run this again:\n');
    console.log(`ZIINA_WEBHOOK_SECRET=${s}\n`);
    process.exit(1);
  }
  const url = `${config.siteUrl}/api/webhooks/ziina`;
  const r = await ziina.registerWebhook(url, config.ziina.webhookSecret);
  if (r && r.success === false) throw new Error(r.error || 'Ziina refused the webhook');
  console.log(`✔ Ziina will send payment updates to ${url}`);
})().catch((e) => { console.error('✖ ' + e.message); process.exit(1); });
