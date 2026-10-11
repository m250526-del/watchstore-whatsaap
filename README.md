# WatchStore WhatsApp Order Verification Server

A Node.js backend that confirms online store orders over WhatsApp. When a customer places an order on the WordPress store, this server sends them a bilingual (English and Urdu) WhatsApp message, waits for their confirmation, then replies with payment instructions or a Cash on Delivery confirmation. It also handles payment screenshots and reports each order's status back to the store.

## How It Works

1. The WordPress store calls `POST /api/send-verification` when an order is placed.
2. The server saves the order to PostgreSQL, optionally notifies the shop owner on WhatsApp, and sends the customer a bilingual message asking them to reply **YES**.
3. The customer confirms by typing YES, an Urdu confirmation (such as ہاں), or by sending a message that contains their order number.
4. The server marks the order `confirmed` and sends a second message:
   - **Advance payment orders:** bank, EasyPaisa and JazzCash payment details, in English and Urdu.
   - **Cash on Delivery orders:** a confirmation that the order is being processed.
5. For advance payments, the customer sends a screenshot of the receipt. The server acknowledges it once and sets the status to `screenshot_received`.
6. The store can check any order's status at any time through `GET /api/order-status`.

If WhatsApp is disconnected, or the customer's number isn't on WhatsApp, the API returns `fallback: true` with a backup number, so the store can show a manual `wa.me` button instead.

## Features

- Bilingual order confirmation and payment messages (English and Urdu)
- Confirmation by typed YES, Urdu text or order number, with matching by phone number or order ID
- Handles WhatsApp's `@lid` addressing as well as classic phone-number JIDs
- Supports advance payment (bank, EasyPaisa, JazzCash) and Cash on Delivery flows
- Duplicate-safe: repeat confirmations and repeat screenshots don't trigger repeat replies
- WhatsApp session and message store kept in PostgreSQL, so the server survives restarts without re-scanning the QR code
- Message store for Baileys retry delivery, plus an in-memory cache for fast order lookups
- Owner notification on WhatsApp for every new order
- Browser QR page protected by a token, for pairing the WhatsApp number remotely
- API key authentication between WordPress and the server
- Graceful fallback to a secondary number when WhatsApp is unavailable

## Tech Stack

- **Runtime:** Node.js
- **Server:** Express
- **WhatsApp:** Baileys (`@whiskeysockets/baileys`)
- **Database:** PostgreSQL (`pg`), hosted on Neon
- **Other:** node-cache, pino, qrcode, dotenv, uuid
- **Deployment target:** Render (free web service)

## API

### `GET /health`
No authentication. Returns the WhatsApp connection status.

### `GET /qr?token=QR_TOKEN`
Shows the current WhatsApp pairing QR code as an image. Requires `QR_TOKEN`.

### `GET /api/order-status?orderId=<id>`
No API key. Returns `{ success: true, status }`, where status is `pending_confirmation`, `confirmed`, `screenshot_received` or `not_found`.

### `POST /api/send-verification`
Requires the `X-API-Key` header.

```json
{
  "phone": "923XXXXXXXXX",
  "orderId": "1001",
  "amount": "5000",
  "customerName": "Customer Name",
  "paymentMethod": "raast_transfer",
  "paymentDetails": {},
  "orderUrl": "https://your-store.com/order/1001"
}
```

- Success: `{ "success": true, "reason": "sent" }`
- Fallback: `{ "success": false, "fallback": true, "reason": "not_connected" | "not_on_whatsapp" | "server_error", "secondaryNumber": "..." }`

## Getting Started

```bash
git clone https://github.com/m250526-del/watchstore-whatsaap.git
cd watchstore-whatsaap
npm install
cp env.example .env
npm start
```

Fill in `.env` first, then open `/qr?token=<QR_TOKEN>` in your browser. On the phone you want to connect, go to WhatsApp, then Settings, Linked Devices, Link a Device, and scan the code. The terminal prints "WhatsApp connected." and the session is stored in PostgreSQL.

### Environment Variables

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Neon or any Postgres) |
| `API_KEY` | Shared secret the WordPress store sends in `X-API-Key` |
| `QR_TOKEN` | Token that protects the `/qr` page |
| `SECONDARY_NUMBER` | Fallback number shown in the manual `wa.me` button |
| `OWNER_NOTIFY_NUMBER` | Number that receives a message for each new order (optional) |
| `PRIMARY_NUMBER` | The WhatsApp number the server connects as |
| `PORT` | Port to listen on (default 3000) |

### Test it

```bash
curl -X POST http://localhost:3000/api/send-verification \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <your API_KEY>" \
  -d '{"phone":"923XXXXXXXXX","orderId":"1001","amount":"5000","customerName":"Test"}'
```

Use your own second number to confirm a real WhatsApp message arrives, then reply YES.

## Project Structure

```
.
├── index.js               # Express API, WhatsApp client, order confirmation flow
├── messageStore.js        # PostgreSQL message store for Baileys retry delivery
├── postgresAuthState.js   # WhatsApp session storage in PostgreSQL
├── env.example            # Environment variable template
└── package.json
```

## Deployment

Designed for Render's free tier, which has no persistent disk. That's why the WhatsApp session and message store live in PostgreSQL instead of local files. Set the environment variables in the Render dashboard and ping `/health` to keep the service warm.

## Notes

This project uses Baileys, an unofficial WhatsApp Web library, so it suits small-scale order confirmation rather than bulk messaging. The built-in fallback keeps customers able to confirm orders if the WhatsApp connection drops.
