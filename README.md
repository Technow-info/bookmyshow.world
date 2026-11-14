# Bookmyshow.world: festival ticket site, backend and admin dashboard

The festival ticket site for Bookmyshow.world.

- **Copy:** visitor-facing text, ticket names, AED prices, dates and venue come word for word from `bookmyshow_world_sample_with_prices.html`.
- **Look:** dark maroon and orange-spotlight theme, Space Grotesk type, with the crowd photo in the hero.
- **Stack:** plain Node.js 18+, **no npm packages**.

## What's inside

| Path | What it does |
|---|---|
| `/` `/tickets` `/info` `/contact` | Public pages. Each has its own title, description, keywords, Open Graph and Twitter Card tags, and canonical URL. |
| `/checkout` | Pass → quantity, festival day (Day passes only) and details → review → Stripe payment → success or failure, with retry. |
| `/admin` | Password-protected **bookings dashboard**: KPIs, bookings per day, sales per pass type, a searchable bookings table, CSV export and a queries inbox. |
| `/preview.html` | Design-review tool: desktop and phone frame side by side. Not linked from the site. |
| `lib/config.js` | **Ticket tiers, AED prices (in fils), festival days and capacities.** Edit here. |
| `lib/stripe.js` | Stripe Checkout session, server-side payment check and webhook signature check. |
| `lib/mailer.js` | Gmail SMTP sender (inline images, attachments). Every query and new-booking alert goes to **connect.technow@gmail.com**. |
| `lib/tickets.js`, `lib/qr.js` | E-tickets: one signed QR code per pass, the ticket email and the online ticket page (`/ticket?b=…&t=…`). |
| `data/db.json` | Bookings, queries and the email log. Created automatically, so back it up. |
| `tests/` | End-to-end tests (`npm test`) using a local stand-in for Gmail and Stripe. |
| `Dockerfile`, `ecosystem.config.js` | Docker image and PM2 config for deployment. |

## Run it locally

```bash
cp .env.example .env      # fill in the values (NODE_ENV=development for local use)
npm run check             # validates .env and lists anything missing
npm test                  # 19 end-to-end tests: pages, orders, Stripe, webhook, email, admin
node server.js            # http://localhost:3000
```

Without a Stripe key, the site runs in **test mode**: a banner says so, and the payment step simulates success or failure.
To see the dashboard with sample bookings, run `node scripts/seed-demo.js`. **Run `node scripts/seed-demo.js --clear` before launch.**

## Deploy

Requirements: Node.js 18 or newer, one process, a **persistent disk** for `DATA_DIR`, and HTTPS in front of the app.
The server refuses to start with a clear message if a setting is wrong, for example an `http://` `SITE_URL` in production or a publishable `pk_` Stripe key.

**Option A: VPS (Ubuntu) with PM2 and Nginx**
```bash
git clone https://github.com/Technow-info/Bookmyshow.world.git && cd Bookmyshow.world
cp .env.example .env && nano .env      # NODE_ENV=production, SITE_URL=https://…, TRUST_PROXY=1
npm run check && npm test
npm i -g pm2 && pm2 start ecosystem.config.js && pm2 save && pm2 startup
```
Point Nginx (or Caddy) at `http://127.0.0.1:3000` with HTTPS. Example Nginx block:
```
server {
  server_name bookmyshow.world;
  location / { proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Forwarded-For $remote_addr; }
  listen 443 ssl; # certbot adds the certificate lines
}
```

**Option B: Docker**
```bash
docker build -t bookmyshow-world .
docker run -d --name bmsw -p 3000:3000 --env-file .env -v bmsw-data:/data --restart unless-stopped bookmyshow-world
```

**Option C: Render / Railway / Fly.io**
Use start command `node server.js`, set the variables from `.env.example` in the dashboard, attach a **persistent disk** mounted at `DATA_DIR` (for example `/data`), and set `TRUST_PROXY=1`. The health check path is `/api/health`.

**After deploying**
1. Open `https://<domain>/api/health`. It should show `{"ok":true,…}`.
2. Stripe Dashboard → Webhooks → add `https://<domain>/api/webhooks/stripe` with the 4 events in `.env.example`, then put the signing secret in `STRIPE_WEBHOOK_SECRET`.
3. Make one test purchase with a Stripe test card (4242 4242 4242 4242). The e-tickets should arrive by email and the booking should show in `/admin/`.
4. Send a test message from the Contact page. It should appear in the admin Queries inbox and at connect.technow@gmail.com.
5. Back up `DATA_DIR` daily. It holds `db.json` (bookings, queries) and `.ticket-secret` (the key that signs QR codes).

**Troubleshooting**
| Symptom | Fix |
|---|---|
| Server exits at start with ✖ lines | Fix the listed `.env` settings. Run `npm run check` to re-test. |
| Emails show "failed" in the Email log | Check the reason shown. Usually it's a wrong App Password, or the host blocks port 465: set `SMTP_PORT=587`. |
| Paid on Stripe but booking still pending | The webhook isn't reaching the site. Check its URL and `STRIPE_WEBHOOK_SECRET`. Reloading the checkout return page also confirms it. |
| "db.json is not valid JSON" at start | The file was damaged (for example, the disk filled up). A copy is kept next to it; restore it from backup. |
| Admin logged out after a deploy | Expected: sessions reset on restart. Sign in again. |

## How queries and tickets flow

- **Customer sends a query** → saved to `data/db.json` → appears in **Admin → Queries inbox** within 10 seconds (toast + count in the tab title) → emailed to connect.technow@gmail.com.
- **Customer pays** → booking marked paid (after Stripe confirms) → **e-tickets emailed to the buyer immediately**: one QR code per pass, plus a "View tickets online" link → booking alert emailed to connect.technow@gmail.com.
- **Admin → Bookings** shows each booking's ticket email status (Emailed / Email failed). Each paid booking has **View** (open the tickets) and **Resend** buttons.
- **Admin → Email log** lists every email sent or failed, with the reason.
- **Admin → Check a ticket** verifies a scanned QR code or a typed ticket number. Forged QR codes are rejected.
- QR codes are signed with `TICKET_SECRET`, or a key generated in `data/.ticket-secret` if you don't set one. Keep it secret and back it up: changing it invalidates every ticket already issued.

## Notes

- **Prices:** set on the server only. The browser can't change what Stripe charges.
- **Payments:** Stripe hosts the card form, so card data never touches this server. A payment is only marked paid after the server asks Stripe directly or receives a signed webhook.
- **Spam protection:** the contact form uses a honeypot field, a too-fast-submit check and rate limiting. Every query is saved to the dashboard even if email fails.
- **Motion:** `prefers-reduced-motion` turns off the spotlight sway, photo drift, badge spin and entrance motion.
