const mysql = require('mysql2/promise');

let pool;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
    });
  }
  return pool;
}

async function query(sql, params) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

function normalizeNumber(remoteJid) {
  if (!remoteJid) return null;
  // Ex.: "351927398547@s.whatsapp.net" → "351927398547"
  return remoteJid.split('@')[0];
}

async function findLeadByWhatsapp(remoteJid) {
  const number = normalizeNumber(remoteJid);
  if (!number) return null;
  const rows = await query(
    'SELECT * FROM ch_leads WHERE whatsapp_number = ? ORDER BY created_at DESC LIMIT 1',
    [number]
  );
  return rows[0] || null;
}

async function createLead({ remoteJid, nome, origemInstancia, estado }) {
  const number = normalizeNumber(remoteJid);
  await query(
    `INSERT INTO ch_leads (whatsapp_number, nome, origem_instancia, estado, created_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [number, nome || null, origemInstancia || null, estado]
  );
  const rows = await query(
    'SELECT * FROM ch_leads WHERE whatsapp_number = ? ORDER BY created_at DESC LIMIT 1',
    [number]
  );
  return rows[0] || null;
}

async function updateLeadState(id, estado, extra = {}) {
  const fields = ['estado = ?', 'updated_at = NOW()'];
  const values = [estado];

  if (extra.estado_anterior !== undefined) {
    fields.push('estado_anterior = ?');
    values.push(extra.estado_anterior);
  }
  if (extra.docs_enviados !== undefined) {
    fields.push('docs_enviados = ?');
    values.push(extra.docs_enviados);
  }
  if (extra.docs_enviados_em !== undefined) {
    fields.push('docs_enviados_em = ?');
    values.push(extra.docs_enviados_em);
  }

  await query(
    `UPDATE ch_leads SET ${fields.join(', ')} WHERE id = ?`,
    [...values, id]
  );
}

module.exports = {
  getPool,
  query,
  findLeadByWhatsapp,
  createLead,
  updateLeadState,
  normalizeNumber,
};

