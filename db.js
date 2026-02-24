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

async function createLead({ remoteJid, nome, origemInstancia, estadoConversa = 'aguardando_escolha' }) {
  const number = normalizeNumber(remoteJid);
  const estado = estadoConversa || 'aguardando_escolha';
  await query(
    `INSERT INTO ch_leads (whatsapp_number, nome, origem_instancia, estado_conversa, estado_docs, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'sem_docs', NOW(), NOW())`,
    [number, nome || null, origemInstancia || null, estado]
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
  if (updates.querFalarComRafa !== undefined) {
    fields.push('quer_falar_com_rafa = ?');
    values.push(updates.querFalarComRafa ? 1 : 0);
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

// ---------- Dúvidas unificadas (ch_duvidas com coluna embedding) ----------
/** eh_pendente: 0 = FAQ (perguntas com respostas), 1 = pendentes. */
async function getDuvidasWithEmbeddings(ehPendente) {
  const ep = ehPendente ? 1 : 0;
  const rows = await query(
    `SELECT id, texto, embedding
     FROM ch_duvidas
     WHERE eh_pendente = ? AND texto IS NOT NULL AND TRIM(texto) != ''
     ORDER BY id ASC`,
    [ep]
  );
  return rows;
}

/** Atualiza a coluna embedding de ch_duvidas (JSON). */
async function saveDuvidaEmbedding(duvidaId, embedding) {
  const payload = JSON.stringify(Array.isArray(embedding) ? embedding : []);
  await query('UPDATE ch_duvidas SET embedding = ? WHERE id = ?', [payload, duvidaId]);
}

// ---------- Estado do simulador (por lead) ----------
async function getSimuladorState(leadId) {
  const rows = await query(
    'SELECT simulador_step AS step, simulador_age AS age, simulador_valor_imovel AS valorImovel, simulador_anos AS anos, simulador_entrada AS entrada FROM ch_leads WHERE id = ?',
    [leadId]
  );
  const r = rows[0];
  if (!r || !r.step) return null;
  return {
    step: r.step,
    age: r.age != null ? Number(r.age) : undefined,
    valorImovel: r.valorImovel != null ? Number(r.valorImovel) : undefined,
    anos: r.anos != null ? Number(r.anos) : undefined,
    entrada: r.entrada != null ? Number(r.entrada) : undefined,
  };
}

async function setSimuladorState(leadId, state) {
  await query(
    'UPDATE ch_leads SET simulador_step = ?, simulador_age = ?, simulador_valor_imovel = ?, simulador_anos = ?, simulador_entrada = ?, updated_at = NOW() WHERE id = ?',
    [
      state.step || null,
      state.age != null ? state.age : null,
      state.valorImovel != null ? state.valorImovel : null,
      state.anos != null ? state.anos : null,
      state.entrada != null ? state.entrada : null,
      leadId,
    ]
  );
}

async function clearSimuladorState(leadId) {
  await query(
    'UPDATE ch_leads SET simulador_step = NULL, simulador_age = NULL, simulador_valor_imovel = NULL, simulador_anos = NULL, simulador_entrada = NULL, updated_at = NOW() WHERE id = ?',
    [leadId]
  );
}

// ---------- Estado de boas-vindas por lead (persistido em ch_boas_vindas_queue) ----------
async function getBoasVindasStep(instanceName, remoteJid) {
  const rows = await query(
    'SELECT step FROM ch_boas_vindas_queue WHERE instance_name = ? AND remote_jid = ? ORDER BY id DESC LIMIT 1',
    [instanceName, remoteJid]
  );
  return rows[0] ? Number(rows[0].step) : null;
}

async function setBoasVindasStep(instanceName, remoteJid, step) {
  // Mantemos apenas um registo por (instance_name, remote_jid) como estado atual.
  await query('DELETE FROM ch_boas_vindas_queue WHERE instance_name = ? AND remote_jid = ?', [
    instanceName,
    remoteJid,
  ]);
  await query(
    'INSERT INTO ch_boas_vindas_queue (instance_name, remote_jid, step, execute_at, payload) VALUES (?, ?, ?, NOW(), NULL)',
    [instanceName, remoteJid, step]
  );
}

async function clearBoasVindasStep(instanceName, remoteJid) {
  await query('DELETE FROM ch_boas_vindas_queue WHERE instance_name = ? AND remote_jid = ?', [
    instanceName,
    remoteJid,
  ]);
}

/** Dados da gestora para contacto pelo lead (nome, email para exibir, whatsapp). */
async function getGestoraById(gestoraId) {
  if (!gestoraId) return null;
  const rows = await query(
    'SELECT nome, email, email_para_leads, whatsapp FROM ch_gestoras WHERE id = ? LIMIT 1',
    [gestoraId]
  );
  const r = rows[0];
  if (!r) return null;
  const email = (r.email_para_leads && String(r.email_para_leads).trim()) || (r.email && String(r.email).trim()) || '';
  const whatsapp = (r.whatsapp && String(r.whatsapp).replace(/\D/g, '')) || '';
  return {
    nome: (r.nome && String(r.nome).trim()) || 'Gestora',
    email,
    whatsapp: whatsapp || null,
  };
}

module.exports = {
  getPool,
  query,
  findLeadByWhatsapp,
  createLead,
  updateLeadState,
  normalizeNumber,
  getDuvidasWithEmbeddings,
  saveDuvidaEmbedding,
  getSimuladorState,
  setSimuladorState,
  clearSimuladorState,
  getBoasVindasStep,
  setBoasVindasStep,
  clearBoasVindasStep,
  getGestoraById,
};

