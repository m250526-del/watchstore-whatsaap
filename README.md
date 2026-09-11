# WatchStore WhatsApp Verification Server

## Run it locally (do this first, before any deployment)

```bash
npm install
cp .env.example .env
# edit .env — set PRIMARY_NUMBER, SECONDARY_NUMBER, and a random API_KEY
npm start
```

A QR code prints in the terminal. Open WhatsApp on your PRIMARY_NUMBER phone →
Settings → Linked Devices → Link a Device → scan it. Terminal should print
"✅ WhatsApp connected." Session is saved to `./auth_session/` so you won't
need to rescan on restart (as long as this folder isn't deleted).

## Test it

With the server running, in a second terminal:

```bash
curl -X POST http://localhost:3000/api/send-verification \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <the API_KEY from your .env>" \
  -d '{"phone":"923XXXXXXXXX","orderId":"1001","amount":"5000","customerName":"Test"}'
```

Replace the phone number with your OWN second number (or a friend's) to confirm
a real WhatsApp message arrives.

## Behavior summary

- `/health` — unauthenticated, returns connection status. Used later for
  Render warm-up pings.
- `/api/send-verification` — requires `X-API-Key` header matching `.env`.
  - If WhatsApp is connected and the number is registered → sends the message,
    returns `{ success: true }`.
  - If the primary session is disconnected/banned, or the customer's number
    isn't on WhatsApp, or anything errors → returns
    `{ success: false, fallback: true, secondaryNumber: "..." }` so WordPress
    knows to show the manual wa.me button flow instead.

## Not done yet (next steps, in order)

1. Confirm this works locally end-to-end (above).
2. Swap `useMultiFileAuthState` for `postgres-baileys` (session persisted in a
   free Neon/Supabase Postgres) — required before deploying to Render, since
   Render's free tier has no persistent disk.
3. Deploy to Render as a free web service.
4. Build the WordPress side: PHP hook that calls `/api/send-verification` when
   an order is placed, plus the front-end popup (checkmark + blur, or the
   fallback wa.me button) based on the response.
