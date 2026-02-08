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

async function createLead({ remoteJid, nome, origemInstancia }) {
  const number = normalizeNumber(remoteJid);
  await query(
    `INSERT INTO ch_leads (whatsapp_number, nome, origem_instancia, estado_conversa, estado_docs, created_at, updated_at)
     VALUES (?, ?, ?, 'aguardando_escolha', 'aguardando_docs', NOW(), NOW())`,
    [number, nome || null, origemInstancia || null]
  );
  const rows = await query(
    'SELECT * FROM ch_leads WHERE whatsapp_number = ? ORDER BY created_at DESC LIMIT 1',
    [number]
  );
  return rows[0] || null;
}

/** Atualiza estado_conversa e/ou estado_docs. extra: { docs_enviados, docs_enviados_em } */
async function updateLeadState(id, updates, extra = {}) {
  const fields = ['updated_at = NOW()'];
  const values = [];

  if (typeof updates === 'string') {
    updates = { conversa: updates };
  }
  if (updates.conversa !== undefined) {
    fields.push('estado_conversa = ?');
    values.push(updates.conversa);
  }
  if (updates.docs !== undefined) {
    fields.push('estado_docs = ?');
    values.push(updates.docs);
  }
  if (extra.docs_enviados !== undefined) {
    fields.push('docs_enviados = ?');
    values.push(extra.docs_enviados);
  }
  if (extra.docs_enviados_em !== undefined) {
    fields.push('docs_enviados_em = ?');
    values.push(extra.docs_enviados_em);
  }

  if (values.length === 0 && Object.keys(extra).length === 0) return;
  values.push(id);
  await query(
    `UPDATE ch_leads SET ${fields.join(', ')} WHERE id = ?`,
    values
  );
}

// ---------- FAQ: perguntas + embeddings (mesma BD que ia-app) ----------
async function getPerguntasWithEmbeddings() {
  const rows = await query(
    `SELECT p.id, p.texto, COALESCE(p.eh_spam, 0) AS eh_spam, e.embedding
     FROM ch_perguntas p
     LEFT JOIN ch_pergunta_embeddings e ON e.pergunta_id = p.id
     ORDER BY p.id ASC`
  );
  return rows;
}

async function savePerguntaEmbedding(perguntaId, embedding) {
  const payload = JSON.stringify(Array.isArray(embedding) ? embedding : []);
  await query(
    `INSERT INTO ch_pergunta_embeddings (pergunta_id, embedding) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE embedding = VALUES(embedding), updated_at = NOW()`,
    [perguntaId, payload]
  );
}

module.exports = {
  getPool,
  query,
  findLeadByWhatsapp,
  createLead,
  updateLeadState,
  normalizeNumber,
  getPerguntasWithEmbeddings,
  savePerguntaEmbedding,
};

