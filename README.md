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
| `data/db.json` | Bookings and queries. Created automatically, so back it up. |

## Run it

```bash
cp .env.example .env      # then fill in the values
node server.js            # http://localhost:3000
```

With no Stripe key, the site runs in **test mode**. A banner says so, and the payment step simulates success or failure.

To see the dashboard with sample bookings, run `node scripts/seed-demo.js`. **Run `node scripts/seed-demo.js --clear` before launch.**

## Go live checklist

1. **Stripe**
   - Activate your account for AED payouts and put `STRIPE_SECRET_KEY` in `.env`. Use `sk_test_...` first, then `sk_live_...`.
   - Add a webhook to `https://<domain>/api/webhooks/stripe` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed` and `checkout.session.expired`.
   - Put its signing secret in `STRIPE_WEBHOOK_SECRET`.
2. **Gmail**
   - Turn on 2-Step Verification for connect.technow@gmail.com.
   - Create an **App password** and set `SMTP_PASS`.
3. **Admin:** set a long `ADMIN_PASSWORD`.
4. **Domain:** set `SITE_URL`. It's used for canonical, Open Graph and sitemap links and for Stripe's return URLs. Serve the site over HTTPS.
5. **Before taking orders:** the sample's own notice says ticket categories, prices, inventory and seller authorization must be verified first. Its event details are marked * for reconfirmation, and the "Sample website preview" notice should be reworded once the shop is live.
6. **Capacity:** if the ticket issuer gives you an allocation, set `capacity` per tier in `lib/config.js`. When it's set, checkout stops at the limit and the dashboard shows the % sold.

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
