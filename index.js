require('dotenv').config();
const express = require('express');
const qrcode = require('qrcode-terminal');
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
  ssl: { rejectUnauthorized: false }, // required for Neon
});

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const SECONDARY_NUMBER = process.env.SECONDARY_NUMBER;

let sock = null;
let connectionState = 'connecting';

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const key = req.header('X-API-Key');
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, reason: 'unauthorized' });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', whatsapp: connectionState });
});

app.post('/api/send-verification', async (req, res) => {
  try {
    const { phone, orderId, amount, customerName } = req.body;

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

    const text =
      `Hi ${customerName || 'there'}! This is to confirm order #${orderId} ` +
      `(Rs ${amount || ''}) with WatchStore.\n\n` +
      `Please reply with a screenshot of your payment transfer to confirm. ` +
      `We'll ship as soon as it's verified. Thank you!`;

    await sock.sendMessage(result.jid, { text });

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

  if (!sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const code = await sock.requestPairingCode(process.env.PRIMARY_NUMBER);
        console.log('\n==================================');
        console.log('WHATSAPP PAIRING CODE:', code);
        console.log('On your phone: WhatsApp > Settings > Linked Devices >');
        console.log('Link a Device > "Link with phone number instead" > enter this code.');
        console.log('==================================\n');
      } catch (err) {
        console.error('Failed to request pairing code:', err);
      }
    }, 3000);
  }

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n(QR also available, but use the pairing code above if this looks garbled)\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionState = 'open';
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
}

startBaileys();

app.listen(PORT, () => {
  console.log(`WatchStore WhatsApp server listening on port ${PORT}`);
});
