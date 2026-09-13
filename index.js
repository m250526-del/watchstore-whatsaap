require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const NodeCache = require('node-cache');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
} = require('@whiskeysockets/baileys');
const { usePostgresAuthState } = require('./postgresAuthState');
const { initMessageStore, createMessageStore } = require('./messageStore');
const { Pool } = require('pg');

// Baileys retry counter — tracks how many times each message has been retried
const msgRetryCounterCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });

const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const SECONDARY_NUMBER = process.env.SECONDARY_NUMBER;

let sock = null;
let connectionState = 'connecting';
let latestQr = null;

const pendingOrdersCache = new Map();

// ── Canonical Pakistani Phone Normalizer ──────────────────────────────────
function normalizePakistaniPhone(phoneInput) {
  let digits = String(phoneInput || '').replace(/\D/g, '');
  if (digits.startsWith('0092')) {
    digits = digits.substring(2);
  }
  if (digits.startsWith('0')) {
    digits = '92' + digits.substring(1);
  } else if (digits.length === 10 && digits.startsWith('3')) {
    digits = '92' + digits;
  }
  return digits;
}

function normalizeToJid(phone) {
  const digits = normalizePakistaniPhone(phone);
  return `${digits}@s.whatsapp.net`;
}

// ── Message store (for Baileys retry delivery) ───────────────────────────
const messageStore = createMessageStore(pgPool);

async function initDb() {
  try {
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS pending_orders (
        order_id VARCHAR(50) PRIMARY KEY,
        phone VARCHAR(50) NOT NULL,
        customer_name VARCHAR(255),
        amount VARCHAR(50),
        payment_method VARCHAR(50),
        payment_details JSONB,
        status VARCHAR(50) DEFAULT 'pending_confirmation',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ pending_orders table initialized.');

    await initMessageStore(pgPool);
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDb();

async function savePendingOrder(orderData) {
  const { orderId, phone, customerName, amount, paymentMethod, paymentDetails } = orderData;
  const digits = normalizePakistaniPhone(phone);

  const record = {
    order_id: String(orderId),
    phone: digits,
    customer_name: customerName || '',
    amount: String(amount || ''),
    payment_method: paymentMethod || 'raast_transfer',
    payment_details: paymentDetails || {},
    status: 'pending_confirmation',
  };

  pendingOrdersCache.set(digits, record);
  pendingOrdersCache.set(String(orderId), record);

  try {
    await pgPool.query(
      `INSERT INTO pending_orders (order_id, phone, customer_name, amount, payment_method, payment_details, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (order_id) DO UPDATE SET
         phone = EXCLUDED.phone,
         customer_name = EXCLUDED.customer_name,
         amount = EXCLUDED.amount,
         payment_method = EXCLUDED.payment_method,
         payment_details = EXCLUDED.payment_details,
         status = EXCLUDED.status,
         created_at = CURRENT_TIMESTAMP`,
      [
        record.order_id,
        record.phone,
        record.customer_name,
        record.amount,
        record.payment_method,
        JSON.stringify(record.payment_details),
        record.status,
      ]
    );
    console.log(`✅ Saved pending order #${record.order_id} for canonical phone ${digits}`);
  } catch (err) {
    console.error('Failed to persist pending order:', err);
  }
}

async function getPendingOrder(phoneOrDigits) {
  const normalizedDigits = normalizePakistaniPhone(phoneOrDigits);
  const rawInput = String(phoneOrDigits).replace(/\D/g, '');
  const localFormat = normalizedDigits.startsWith('92') ? '0' + normalizedDigits.substring(2) : normalizedDigits;

  // 1. Check in-memory cache
  if (pendingOrdersCache.has(normalizedDigits)) {
    return pendingOrdersCache.get(normalizedDigits);
  }
  if (pendingOrdersCache.has(rawInput)) {
    return pendingOrdersCache.get(rawInput);
  }
  if (pendingOrdersCache.has(localFormat)) {
    return pendingOrdersCache.get(localFormat);
  }

  // 2. Query PostgreSQL Database (supports canonical 923..., local 03..., raw input, and order_id)
  try {
    const res = await pgPool.query(
      `SELECT * FROM pending_orders WHERE phone = $1 OR phone = $2 OR phone = $3 OR order_id = $3 ORDER BY created_at DESC LIMIT 1`,
      [normalizedDigits, localFormat, rawInput]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
      // Index in cache under canonical normalized format and row fields for future instant hits
      pendingOrdersCache.set(normalizedDigits, row);
      pendingOrdersCache.set(row.phone, row);
      pendingOrdersCache.set(row.order_id, row);
      return row;
    }
  } catch (err) {
    console.error('Error fetching pending order:', err);
  }
  return null;
}

async function updateOrderStatus(orderId, status) {
  try {
    await pgPool.query(
      `UPDATE pending_orders SET status = $1 WHERE order_id = $2`,
      [status, String(orderId)]
    );
    for (const [key, val] of pendingOrdersCache.entries()) {
      if (val.order_id === String(orderId)) {
        val.status = status;
      }
    }
  } catch (err) {
    console.error('Error updating order status:', err);
  }
}

// ── Unified Confirmation Handler (Button or Typed YES / ہاں) ─────────────
async function handleOrderConfirmation(pendingOrder, fromJid) {
  // Prevent duplicate Message #2 if already confirmed
  if (pendingOrder.status !== 'pending_confirmation') {
    console.log(`Order #${pendingOrder.order_id} is already confirmed (${pendingOrder.status}). Skipping duplicate Message #2.`);
    return;
  }

  // Atomically update status in DB & cache first
  await updateOrderStatus(pendingOrder.order_id, 'confirmed');

  const details = typeof pendingOrder.payment_details === 'string'
    ? JSON.parse(pendingOrder.payment_details)
    : (pendingOrder.payment_details || {});

  const isAdvance = pendingOrder.payment_method === 'raast_transfer' || pendingOrder.payment_method === 'advance';

  if (isAdvance) {
    let bankBlock = '';
    if (details.bankName || details.accountNumber) {
      bankBlock = `Bank Deposit / بینک ڈپازٹ:\nBank: ${details.bankName || ''}\nAccount Title: ${details.accountName || ''}\nAccount #: ${details.accountNumber || ''}\nIBAN: ${details.iban || ''}\n`;
    }

    let epBlock = '';
    if (details.easypaisaNumber) {
      epBlock = `EasyPaisa / ایزی پیسہ:\nNumber: ${details.easypaisaNumber}\nAccount Title: ${details.easypaisaName || ''}\n`;
    }

    let jcBlock = '';
    if (details.jazzcashNumber) {
      jcBlock = `JazzCash / جاز کیش:\nNumber: ${details.jazzcashNumber}\nAccount Title: ${details.jazzcashName || ''}\n`;
    }

    const msg2Advance =
      `Order #${pendingOrder.order_id} confirmed!\n\n` +
      `Amount to pay: Rs. ${pendingOrder.amount}\n\n` +
      `Payment Details:\n\n` +
      (bankBlock ? `${bankBlock}\n` : '') +
      (epBlock ? `${epBlock}\n` : '') +
      (jcBlock ? `${jcBlock}\n` : '') +
      `Please make the payment and send us a screenshot of the payment receipt here on WhatsApp.\n\n` +
      `------------------------------\n` +
      `آپ کے آرڈر #${pendingOrder.order_id} کی تصدیق ہو گئی ہے۔\n\n` +
      `ادا کرنے کی رقم: Rs. ${pendingOrder.amount}\n\n` +
      `ادائیگی کی تفصیلات:\n\n` +
      (bankBlock ? `${bankBlock}\n` : '') +
      (epBlock ? `${epBlock}\n` : '') +
      (jcBlock ? `${jcBlock}\n` : '') +
      `براہِ کرم ادائیگی کرنے کے بعد ادائیگی کی رسید کا اسکرین شاٹ اسی WhatsApp پر بھیج دیں۔`;

    await sock.sendMessage(fromJid, { text: msg2Advance });
    console.log(`✅ Message #2 (Advance Payment) sent to ${fromJid} for order #${pendingOrder.order_id}`);
  } else {
    // COD Message #2
    const msg2Cod =
      `Your order #${pendingOrder.order_id} has been confirmed.\n\n` +
      `We will process your Cash on Delivery order.\n\n` +
      `------------------------------\n` +
      `آپ کا آرڈر #${pendingOrder.order_id} کنفرم ہو گیا ہے۔\n\n` +
      `آپ کا Cash on Delivery آرڈر اب پروسیس کیا جائے گا۔`;

    await sock.sendMessage(fromJid, { text: msg2Cod });
    console.log(`✅ Message #2 (COD) sent to ${fromJid} for order #${pendingOrder.order_id}`);
  }
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/qr' || req.path === '/api/order-status') return next();
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, reason: 'unauthorized' });
  }
  next();
});

app.get('/api/order-status', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const orderId = req.query.orderId;
  if (!orderId) {
    return res.status(400).json({ success: false, reason: 'missing_order_id' });
  }
  try {
    const order = await getPendingOrder(String(orderId));
    if (!order) {
      return res.json({ success: true, status: 'not_found' });
    }
    return res.json({ success: true, status: order.status });
  } catch (err) {
    console.error('order-status lookup error:', err);
    return res.status(500).json({ success: false, reason: 'server_error' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: connectionState });
});

app.get('/qr', async (req, res) => {
  if (!latestQr) {
    return res.status(404).send('No QR code available right now (already connected, or not generated yet — check back in a few seconds).');
  }
  try {
    const png = await QRCode.toBuffer(latestQr, { width: 400, margin: 2 });
    res.type('png').send(png);
  } catch (err) {
    res.status(500).send('Failed to render QR code.');
  }
});

app.post('/api/send-verification', async (req, res) => {
  try {
    const { phone, orderId, amount, customerName, paymentMethod, paymentDetails } = req.body;

    if (!phone || !orderId) {
      return res.status(400).json({ success: false, reason: 'missing_fields' });
    }

    if (connectionState !== 'open' || !sock) {
      return res.json({
        success: false,
        reason: 'not_connected',
        fallback: true,
        secondaryNumber: SECONDARY_NUMBER,
      });
    }

    const jid = normalizeToJid(phone);

    // Always persist the order FIRST, regardless of what the onWhatsApp check
    // returns — that check is known to be unreliable on unofficial WhatsApp
    // libraries, and the customer may also end up confirming from a different
    // WhatsApp number/device by typing their Order ID, so the order must exist
    // in the database no matter what happens next.
    await savePendingOrder({
      phone,
      orderId,
      amount,
      customerName,
      paymentMethod,
      paymentDetails,
    });

    const [result] = await sock.onWhatsApp(jid);
    if (!result || !result.exists) {
      return res.json({
        success: false,
        reason: 'not_on_whatsapp',
        fallback: true,
        secondaryNumber: SECONDARY_NUMBER,
      });
    }

    // Message #1 (Bilingual English + Urdu — plain text only; WhatsApp/Baileys no longer
    // reliably renders interactive buttons on unofficial clients, so we rely on typed replies)
    const msg1Text =
      `Hello ${customerName || 'Customer'}!\n\n` +
      `We have received your order #${orderId}.\n` +
      `Order Total: Rs. ${amount || '0'}\n\n` +
      `Please reply YES to confirm your order.\n\n` +
      `------------------------------\n` +
      `السلام علیکم ${customerName || 'محترم'}!\n\n` +
      `ہمیں آپ کا آرڈر #${orderId} موصول ہو گیا ہے۔\n` +
      `آرڈر کی کل رقم: Rs. ${amount || '0'}\n\n` +
      `براہِ کرم اپنے آرڈر کی تصدیق کے لیے YES لکھ کر جواب دیں۔`;

    try {
      console.log(`Sending Message #1 to ${result.jid}...`);
      await sock.sendMessage(result.jid, { text: msg1Text });
      console.log(`✅ Message #1 sent to ${result.jid}`);
    } catch (sendErr) {
      console.error('❌ MESSAGE #1 SEND FAILED:', sendErr);
      throw sendErr;
    }

    return res.json({ success: true, reason: 'sent' });
  } catch (err) {
    console.error('send-verification error:', err);
    return res.status(500).json({
      success: false,
      reason: 'server_error',
      fallback: true,
      secondaryNumber: SECONDARY_NUMBER,
    });
  }
});

async function startBaileys() {
  const { state, saveCreds } = await usePostgresAuthState(pgPool, 'watchstore_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(
        state.keys,
        pino({ level: 'silent' })
      ),
    },
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,

    markOnlineOnConnect: false,

    msgRetryCounterCache,

    enableRecentMessageCache: true,

    enableAutoSessionRecreation: true,

    getMessage: async (key) => {
      return await messageStore.getMessage(key);
    },
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQr = qr;
      console.log('New QR generated — open the /qr URL of this service in a browser to scan it.');
    }

    if (connection === 'open') {
      connectionState = 'open';
      latestQr = null;
      console.log('✅ WhatsApp connected.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        connectionState = 'logged_out';
        console.log('❌ Logged out / banned. Not reconnecting automatically — falls back to secondary number until re-paired.');
      } else {
        connectionState = 'closed';
        console.log('⚠️  Connection closed, reconnecting...');
        startBaileys();
      }
    }
  });

  // Incoming Message Listener (Detect Confirm Order button, typed YES / ہاں, and Screenshots)
  sock.ev.on('messages.upsert', async (m) => {

    for (const storedMessage of m.messages) {
      await messageStore.saveMessage(storedMessage);
    }

    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const fromJid = msg.key.remoteJid;
      if (!fromJid) continue;

      // WhatsApp can address messages via an opaque "@lid" JID instead of the classic
      // phone-number "@s.whatsapp.net" JID. The phone-based JID, when available, may be in
      // remoteJid OR remoteJidAlt depending on addressing mode — check both.
      const altJid = msg.key.remoteJidAlt;
      const phoneJid = [fromJid, altJid].find((j) => j && j.endsWith('@s.whatsapp.net'));
      if (!phoneJid) continue; // no phone number available from this message at all

      const senderPhone = normalizePakistaniPhone(phoneJid);

      const textContent = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        ''
      ).trim().toLowerCase();

      const isImage = !!msg.message?.imageMessage;

      // Diagnostic logging before lookup
      console.log('[WA CONFIRM DEBUG]', {
        fromJid,
        normalizedPhone: senderPhone,
        textContent
      });

      // Look for an explicit Order ID anywhere in the message text FIRST — this is
      // present in every automated pre-filled WhatsApp message (and can be typed
      // manually too), so it's the most reliable signal regardless of which phone
      // number sent it. Checking this before anything else also means we never
      // reply to a random message that references no real, still-open order.
      let pendingOrder = null;
      let matchedByOrderId = false;
      const candidateIds = (textContent.match(/\d{1,10}/g) || []);
      for (const candidate of candidateIds) {
        const found = await getPendingOrder(candidate);
        if (found && String(found.order_id) === candidate) {
          pendingOrder = found;
          matchedByOrderId = true;
          break;
        }
      }

      // Fall back to phone-based lookup — covers a bare typed "yes" / "ہاں" reply
      // (no order number in it) from a number already on file for an open order.
      if (!pendingOrder) {
        pendingOrder = await getPendingOrder(senderPhone);
      }

      console.log('[WA CONFIRM DEBUG] pending order:', pendingOrder
        ? `${pendingOrder.order_id} (matched by ${matchedByOrderId ? 'ORDER ID' : 'PHONE'})`
        : 'NOT FOUND'
      );

      if (!pendingOrder) {
        continue; // No real, known, open order referenced — ignore, no reply
      }

      // 1. Typed YES / English Confirmation Detection
      const isYesConfirm =
        textContent === 'yes' ||
        textContent === 'y' ||
        textContent === 'yeah' ||
        textContent === 'yep' ||
        textContent === 'confirm' ||
        textContent === 'ok' ||
        textContent === 'okay' ||
        textContent === '1';

      // 2. Typed Urdu Confirmation Detection
      const isUrduConfirm =
        textContent.includes('ہاں') ||
        textContent.includes('جی') ||
        textContent.includes('تصدیق');

      const shouldConfirm =
        pendingOrder.status === 'pending_confirmation' &&
        (matchedByOrderId || isYesConfirm || isUrduConfirm);

      if (shouldConfirm) {
        console.log(`📩 Order confirmation for #${pendingOrder.order_id} via ${matchedByOrderId ? 'ORDER ID' : (isYesConfirm ? 'TYPED YES' : 'URDU TEXT')}`);
        await handleOrderConfirmation(pendingOrder, fromJid);
      } else if (isImage && pendingOrder.status === 'confirmed') {
        // Customer sent payment screenshot after confirmation.
        // Acknowledge ONCE, then mark as acknowledged so repeated screenshots
        // don't trigger repeated automated replies (WhatsApp spam-detection risk).
        const ackMsg =
          `Thank you! We have received your payment screenshot. Our team will manually verify the payment and update your order shortly.\n\n` +
          `------------------------------\n` +
          `شکریہ! ہمیں آپ کا اسکرین شاٹ موصول ہو گیا ہے۔ ہماری ٹیم جلد آپ کی ادائیگی کی تصدیق کر کے آرڈر پروسیس کرے گی۔`;

        await sock.sendMessage(fromJid, { text: ackMsg });
        await updateOrderStatus(pendingOrder.order_id, 'screenshot_received');
        console.log(`✅ Screenshot acknowledged once for order #${pendingOrder.order_id}; further automated replies suppressed for this order.`);
      }
    }
  });
}

startBaileys();

app.listen(PORT, () => {
  console.log(`WatchStore WhatsApp server listening on port ${PORT}`);
});
