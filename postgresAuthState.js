const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

async function usePostgresAuthState(pool, sessionId) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_state (
      session_id TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (session_id, key)
    )
  `);

  const readData = async (key) => {
    const res = await pool.query(
      'SELECT value FROM auth_state WHERE session_id = $1 AND key = $2',
      [sessionId, key]
    );
    if (res.rows.length === 0 || res.rows[0].value === null) return null;
    return JSON.parse(res.rows[0].value, BufferJSON.reviver);
  };

  const writeData = async (key, value) => {
    const json = JSON.stringify(value, BufferJSON.replacer);
    await pool.query(
      `INSERT INTO auth_state (session_id, key, value) VALUES ($1, $2, $3)
       ON CONFLICT (session_id, key) DO UPDATE SET value = EXCLUDED.value`,
      [sessionId, key, json]
    );
  };

  const removeData = async (key) => {
    await pool.query(
      'DELETE FROM auth_state WHERE session_id = $1 AND key = $2',
      [sessionId, key]
    );
  };

  const existingCreds = await readData('creds');
  const creds = existingCreds || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(key, value) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

module.exports = { usePostgresAuthState };
