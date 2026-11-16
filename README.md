# Bookmyshow.world: festival ticket site, backend and admin dashboard

The ticket website for the World Festival (Dubai), with Ziina payments in AED, e-tickets emailed straight away, a contact form, and an admin dashboard for bookings, queries, emails and ticket checks.

It is plain Node.js 18+ with **no npm dependencies**. It runs as a normal server (Render, Railway, a VPS or Docker) or as a Vercel function.

## What's inside

| Path | What it is |
|---|---|
| `server.js` | The web server and API (pages, orders, Ziina, contact form, admin) |
| `api/index.js`, `vercel.json` | Entry point and routing for Vercel |
| `lib/ziina.js` | Ziina payment intents, webhook checks and webhook registration |
| `lib/store.js` | Data storage: a JSON file on disk, or Upstash Redis when configured |
| `lib/mailer.js` | Gmail SMTP: e-tickets to buyers, query alerts to connect.technow@gmail.com |
| `lib/tickets.js` | Signed ticket codes and QR codes |
| `lib/config.js` | Settings from environment variables, with start-up checks |
| `public/` | The website pages, plus the admin dashboard at `/admin` |
| `scripts/` | Sample data (`npm run seed:demo`) and Ziina webhook setup (`npm run ziina:webhook`) |
| `tests/` | Automated tests (`npm test`), using stand-in Ziina, Redis and mail servers |

## Run it locally

```bash
cp .env.example .env      # then set ADMIN_PASSWORD at least
npm start                 # http://localhost:3000, admin at /admin
npm test                  # 25 tests
npm run check             # checks your settings without starting the server
```

Without a Ziina key the site runs in **test mode**. Checkout shows a simulated payment screen, so you can try the whole flow and see the e-ticket.

## Ziina payments

1. Create a Ziina Business account and get an API key from **ziina.com/business/connect**.
2. Set `ZIINA_API_KEY`. While you are testing, also set `ZIINA_TEST_MODE=true` so no real money moves. Remove it to go live.
3. Set `SITE_URL` to your public https address. Ziina sends buyers back to `SITE_URL/checkout`.
4. Register the webhook once, so payments confirm even if the buyer closes the tab:
   ```bash
   npm run ziina:webhook      # prints a ZIINA_WEBHOOK_SECRET if you have not set one
   ```
   Put the same `ZIINA_WEBHOOK_SECRET` in your environment. Ziina allows one webhook per account.

How a payment works:

- The server sets the price; it never trusts the browser for it. It creates a Ziina payment intent in fils (AED × 100) and sends the buyer to Ziina, where they can pay by card, Apple Pay or Google Pay.
- When the buyer returns, or when the webhook arrives, the server **asks Ziina for the payment's status**. A booking is marked paid only when Ziina says `completed`; the redirect or webhook alone never confirms it. Then the e-tickets are emailed.
- Pending bookings have a **Re-check** button in the admin dashboard. Unpaid checkouts expire after 30 minutes.

## Deploy

### Vercel (with Upstash Redis)

Vercel functions have no lasting disk, so data must go to Redis:

1. Import the repo into Vercel. `vercel.json` routes everything to `api/index.js`, so there is no build step.
2. In the project, go to **Storage → Upstash (Redis) → Create**, then connect it to the project. This adds `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`), and either pair works.
3. Add the environment variables: `ADMIN_PASSWORD`, `SITE_URL`, `ZIINA_API_KEY`, `ZIINA_WEBHOOK_SECRET`, `SMTP_USER`, `SMTP_PASS`, and `TICKET_SECRET` (any long random string).
4. Deploy, then run `npm run ziina:webhook` once from your computer with the same `.env`.

If Redis is missing on Vercel, the admin dashboard shows a red **storage warning**. Data written to Vercel's temporary disk is lost.

### Render, Railway, a VPS or Docker

Run `npm start` with the same variables. Data is saved to `DATA_DIR/db.json`, so put `DATA_DIR` on a persistent disk. You can use Redis here too by setting the Upstash variables. A `Dockerfile` is included, and `/api/health` is the health check.

## How queries and tickets flow

- **Contact form:** the query is saved to the dashboard (Queries tab) and emailed to `MAIL_TO` (connect.technow@gmail.com). Bots and repeated sends are filtered out.
- **Purchase:** once Ziina confirms the payment, the buyer gets an email with one QR e-ticket per person. The office gets a copy. A link to the ticket page also opens straight after payment.
- **At the gate:** staff type or scan the ticket code in **Admin → Check a ticket**.

## Notes

- Gmail needs a 16-character **App Password** (Google Account → Security → App passwords), not the normal password.
- Sample data: `npm run seed:demo` adds sample bookings and `npm run seed:clear` removes them (file storage only).
- Keep `.env` out of git; `.gitignore` already excludes it.
