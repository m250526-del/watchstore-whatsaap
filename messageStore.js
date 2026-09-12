/**
 * messageStore.js
 *
 * Persistent PostgreSQL-backed message store for Baileys.
 *
 * PURPOSE:
 *   When a WhatsApp message fails to deliver because the business phone is
 *   temporarily offline, Baileys will retry the send automatically — but ONLY
 *   if it can retrieve the original message payload via the `getMessage`
 *   callback passed to makeWASocket().
 *
 *   Without this store, Baileys discards the message on disconnect and the
 *   retry silently fails (sends nothing).
 *
 * HOW IT WORKS:
 *   1. Every outgoing/incoming message is saved into the `whatsapp_messages`
 *      table via saveMessage().
 *   2. When Baileys needs to retry a delivery it calls getMessage(key) which
 *      this module handles — returning the stored proto payload.
 *   3. Messages older than 7 days are automatically pruned to keep the table
 *      small.
 *
 * DOES NOT TOUCH:
 *   - auth_state table (Baileys session)
 *   - pending_orders table (business logic)
 */

'use strict';

// In-memory LRU-style cache to avoid hammering DB for hot messages
// Key: "id:remoteJid", Value: full message object
const memCache = new Map();
const MEM_CACHE_MAX = 500;

/**
 * Initialise the whatsapp_messages table if it doesn't exist.
 * Call once at startup before using saveMessage / getMessage.
 *
 * @param {import('pg').Pool} pool
 */
async function initMessageStore(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_messages (
      msg_id      TEXT NOT NULL,
      remote_jid  TEXT NOT NULL,
      payload     TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (msg_id, remote_jid)
    );
  `);
  console.log('✅ whatsapp_messages table initialized.');

  // Prune messages older than 7 days on startup to keep table lean
  try {
    const pruned = await pool.query(
      `DELETE FROM whatsapp_messages WHERE created_at < NOW() - INTERVAL '7 days'`
    );
    if (pruned.rowCount > 0) {
      console.log(`🗑️  Pruned ${pruned.rowCount} old message(s) from whatsapp_messages.`);
    }
  } catch (pruneErr) {
    console.warn('Could not prune old messages:', pruneErr.message);
  }
}

/**
 * Build a message store instance bound to a pg Pool.
 *
 * Usage in index.js:
 *   const store = createMessageStore(pgPool);
 *   // Pass to makeWASocket:
 *   getMessage: store.getMessage
 *   // Save every message on messages.upsert:
 *   for (const msg of m.messages) { await store.saveMessage(msg); }
 *
 * @param {import('pg').Pool} pool
 * @returns {{ saveMessage: Function, getMessage: Function }}
 */
function createMessageStore(pool) {
  /**
   * Persist a message to DB + in-memory cache.
   * @param {object} msg  Baileys WAMessage
   */
  async function saveMessage(msg) {
    try {
      if (!msg?.key?.id || !msg?.key?.remoteJid) return;

      const msgId     = msg.key.id;
      const remoteJid = msg.key.remoteJid;
      const cacheKey  = `${msgId}:${remoteJid}`;

      // Maintain mem-cache size limit (evict oldest entry)
      if (memCache.size >= MEM_CACHE_MAX) {
        const firstKey = memCache.keys().next().value;
        memCache.delete(firstKey);
      }
      memCache.set(cacheKey, msg);

      const payload = JSON.stringify(msg);

      await pool.query(
        `INSERT INTO whatsapp_messages (msg_id, remote_jid, payload)
         VALUES ($1, $2, $3)
         ON CONFLICT (msg_id, remote_jid) DO NOTHING`,
        [msgId, remoteJid, payload]
      );
    } catch (err) {
      // Non-fatal — a failed save will not break delivery; log and continue
      console.warn('[messageStore] saveMessage error:', err.message);
    }
  }

  /**
   * Retrieve a message by its WAMessageKey.
   * Called by Baileys internally when retrying undelivered messages.
   *
   * @param {object} key  { id, remoteJid, fromMe? }
   * @returns {Promise<object|undefined>}  The proto.IMessage payload, or undefined
   */
  async function getMessage(key) {
    try {
      const msgId     = key?.id;
      const remoteJid = key?.remoteJid;
      if (!msgId || !remoteJid) return undefined;

      const cacheKey = `${msgId}:${remoteJid}`;

      // 1. Check memory cache first (fastest path)
      if (memCache.has(cacheKey)) {
        return memCache.get(cacheKey)?.message || undefined;
      }

      // 2. Fall back to PostgreSQL
      const res = await pool.query(
        `SELECT payload FROM whatsapp_messages
         WHERE msg_id = $1 AND remote_jid = $2
         LIMIT 1`,
        [msgId, remoteJid]
      );

      if (res.rows.length === 0) return undefined;

      const msg = JSON.parse(res.rows[0].payload);

      // Warm memory cache for future retries
      memCache.set(cacheKey, msg);

      return msg?.message || undefined;
    } catch (err) {
      console.warn('[messageStore] getMessage error:', err.message);
      return undefined;
    }
  }

  return { saveMessage, getMessage };
}

module.exports = { initMessageStore, createMessageStore };
