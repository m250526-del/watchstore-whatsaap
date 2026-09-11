require('dotenv').config();
const express = require('express');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { usePostgresAuthState } = require('./postgresAuthState');
const { Pool } = require('pg');

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
  } catch (err) {
    console.error('Database initialization error:', err);
  }
}
initDb();

async function savePendingOrder(orderData) {
  const { orderId, phone, customerName, amount, paymentMethod, paymentDetails } = orderData;
  const digits = String(phone).replace(/\D/g, '');

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
  } catch (err) {
    console.error('Failed to persist pending order:', err);
  }
}

async function getPendingOrder(phoneOrDigits) {
  const digits = String(phoneOrDigits).replace(/\D/g, '');
  if (pendingOrdersCache.has(digits)) {
    return pendingOrdersCache.get(digits);
  }
  try {
    const res = await pgPool.query(
      `SELECT * FROM pending_orders WHERE phone = $1 OR order_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [digits]
    );
    if (res.rows.length > 0) {
      const row = res.rows[0];
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
  } else {
    // COD Message #2
    const msg2Cod =
      `Your order #${pendingOrder.order_id} has been confirmed.\n\n` +
      `We will process your Cash on Delivery order.\n\n` +
      `------------------------------\n` +
      `آپ کا آرڈر #${pendingOrder.order_id} کنفرم ہو گیا ہے۔\n\n` +
      `آپ کا Cash on Delivery آرڈر اب پروسیس کیا جائے گا۔`;

    await sock.sendMessage(fromJid, { text: msg2Cod });
  }
}

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health' || req.path === '/qr') return next();
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, reason: 'unauthorized' });
  }
  next();
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

    const [result] = await sock.onWhatsApp(jid);
    if (!result || !result.exists) {
      return res.json({
        success: false,
        reason: 'not_on_whatsapp',
        fallback: true,
        secondaryNumber: SECONDARY_NUMBER,
      });
    }

    // Persist order details for incoming confirmation
    await savePendingOrder({
      phone,
      orderId,
      amount,
      customerName,
      paymentMethod,
      paymentDetails,
    });

    // Message #1 (Bilingual English + Urdu with dual instructions)
    const msg1Text =
      `Hello ${customerName || 'Customer'}!\n\n` +
      `We have received your order #${orderId}.\n` +
      `Order Total: Rs. ${amount || '0'}\n\n` +
      `Please confirm your order by pressing the button below, or simply reply YES.\n\n` +
      `------------------------------\n` +
      `السلام علیکم ${customerName || 'محترم'}!\n\n` +
      `ہمیں آپ کا آرڈر #${orderId} موصول ہو گیا ہے۔\n` +
      `آرڈر کی کل رقم: Rs. ${amount || '0'}\n\n` +
      `براہِ کرم نیچے دیا گیا بٹن دبا کر اپنے آرڈر کی تصدیق کریں، یا صرف YES لکھ کر جواب دیں۔`;

    const buttons = [
      {
        buttonId: `confirm_order_${orderId}`,
        buttonText: { displayText: 'Confirm Order' },
        type: 1,
      },
    ];

    try {
      // Send interactive quick-reply button via Baileys 6.7.9
      await sock.sendMessage(result.jid, {
        text: msg1Text,
        buttons: buttons,
        headerType: 1,
      });
    } catch (btnErr) {
      console.warn('Interactive button delivery warning, falling back to text:', btnErr);
      await sock.sendMessage(result.jid, { text: msg1Text });
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

function normalizeToJid(phone) {
  const digits = String(phone).replace(/\D/g, '');
  return digits.includes('@') ? digits : `${digits}@s.whatsapp.net`;
}

async function startBaileys() {
  const { state, saveCreds } = await usePostgresAuthState(pgPool, 'watchstore_session');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
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
    if (m.type !== 'notify') return;

    for (const msg of m.messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const fromJid = msg.key.remoteJid;
      if (!fromJid || !fromJid.endsWith('@s.whatsapp.net')) continue;

      const cleanPhone = fromJid.replace('@s.whatsapp.net', '');

      // Parse interactive button responses across Baileys payload variations
      const selectedButtonId =
        msg.message?.buttonsResponseMessage?.selectedButtonId ||
        msg.message?.templateButtonReplyMessage?.selectedId ||
        msg.message?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson ||
        '';

      const textContent = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.buttonsResponseMessage?.selectedDisplayText ||
        ''
      ).trim().toLowerCase();

      const isImage = !!msg.message?.imageMessage;

      const pendingOrder = await getPendingOrder(cleanPhone);
      if (!pendingOrder) continue;

      // 1. Button Response Detection
      const isButtonConfirm =
        (selectedButtonId && selectedButtonId.includes('confirm_order')) ||
        (selectedButtonId && selectedButtonId.includes(pendingOrder.order_id));

      // 2. Typed YES / English Confirmation Detection (trimmed & case-insensitive)
      const isYesConfirm =
        textContent === 'yes' ||
        textContent === 'y' ||
        textContent === 'yeah' ||
        textContent === 'yep' ||
        textContent === 'confirm' ||
        textContent === 'ok' ||
        textContent === 'okay' ||
        textContent === '1';

      // 3. Typed Urdu Confirmation Detection (ہاں / ہاں جی / جی ہاں)
      const isUrduConfirm =
        textContent.includes('ہاں') ||
        textContent.includes('جی') ||
        textContent.includes('تصدیق');

      if ((isButtonConfirm || isYesConfirm || isUrduConfirm) && pendingOrder.status === 'pending_confirmation') {
        // Execute unified confirmation handler
        await handleOrderConfirmation(pendingOrder, fromJid);
      } else if (isImage && pendingOrder.status === 'confirmed') {
        // Customer sent payment screenshot after confirmation
        // Acknowledge receipt WITHOUT auto-verifying payment
        const ackMsg =
          `Thank you! We have received your payment screenshot. Our team will manually verify the payment and update your order shortly.\n\n` +
          `------------------------------\n` +
          `شکریہ! ہمیں آپ کا اسکرین شاٹ موصول ہو گیا ہے۔ ہماری ٹیم جلد آپ کی ادائیگی کی تصدیق کر کے آرڈر پروسیس کرے گی۔`;

        await sock.sendMessage(fromJid, { text: ackMsg });
      }
    }
  });
}

startBaileys();

app.listen(PORT, () => {
  console.log(`WatchStore WhatsApp server listening on port ${PORT}`);
});
