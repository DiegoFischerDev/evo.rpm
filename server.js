const path = require('path');
const fs = require('fs');

// Carrega .env: primeiro na pasta do server, depois na pasta pai (sobrevive ao deploy na Hostinger)
const envPathLocal = path.join(__dirname, '.env');
const envPathParent = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPathLocal)) {
  require('dotenv').config({ path: envPathLocal });
} else if (fs.existsSync(envPathParent)) {
  require('dotenv').config({ path: envPathParent });
} else {
  require('dotenv').config({ path: envPathLocal });
}

const express = require('express');
const OpenAI = require('openai').default;
const axios = require('axios');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const EVOLUTION_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'DiegoWoo';
const ADMIN_WHATSAPP = '351927398547';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const IA_APP_BASE_URL = (process.env.IA_APP_URL || process.env.UPLOAD_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Contadores simples em memória por lead
// - respostas de IA (para lembrete de navegação)
// - perguntas feitas (para limitar uso e economizar tokens)
const aiReplyCountByLead = {};
const aiQuestionCountByLead = {};

app.use(express.json({ limit: '1mb' }));

const EVO_INTERNAL_SECRET = process.env.EVO_INTERNAL_SECRET || process.env.IA_APP_EVO_SECRET || '';

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'evo', time: new Date().toISOString() });
});

// Envio de texto para um número (chamado pelo ia-app quando gestora responde a dúvida pendente)
app.post('/api/internal/send-text', (req, res) => {
  if (EVO_INTERNAL_SECRET && req.get('X-Internal-Secret') !== EVO_INTERNAL_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const number = (req.body && req.body.number && String(req.body.number).replace(/\D/g, '')) || '';
  const text = (req.body && req.body.text && String(req.body.text)) || '';
  if (!number || !text) return res.status(400).json({ message: 'number e text são obrigatórios.' });
  sendText(null, number, text)
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      console.error('send-text:', err.message);
      res.status(500).json({ message: err.response?.data?.message || err.message });
    });
});

// Diagnóstico: verifica env e conectividade à Evolution API (sem expor chaves)
app.get('/api/debug', async (req, res) => {
  const env = {
    hasOpenAiKey: Boolean(OPENAI_API_KEY),
    hasEvolutionUrl: Boolean(EVOLUTION_URL),
    hasEvolutionKey: Boolean(EVOLUTION_API_KEY),
    evolutionInstance: EVOLUTION_INSTANCE,
  };

  let evolutionConnection = null;
  if (EVOLUTION_URL && EVOLUTION_API_KEY) {
    try {
      const r = await axios.get(
        `${EVOLUTION_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`,
        { headers: { apikey: EVOLUTION_API_KEY }, timeout: 8000 }
      );
      evolutionConnection = { ok: true, state: r.data?.state ?? r.data?.instance?.state ?? r.data };
    } catch (err) {
      evolutionConnection = {
        ok: false,
        error: err.response?.data?.message || err.response?.data?.error || err.message,
        status: err.response?.status,
      };
    }
  }

  res.json({
    app: 'evo',
    time: new Date().toISOString(),
    env,
    evolution: evolutionConnection,
    envFile: {
      local: envPathLocal,
      localExists: fs.existsSync(envPathLocal),
      parent: envPathParent,
      parentExists: fs.existsSync(envPathParent),
    },
  });
});

// Extrai o texto da mensagem do payload Evolution (conversation ou extendedTextMessage)
function getMessageText(message) {
  if (!message) return '';
  if (typeof message.conversation === 'string') return message.conversation;
  if (message.extendedTextMessage?.text) return message.extendedTextMessage.text;
  return '';
}

// Frase gatilho para criar lead (pode ser ajustada por env no futuro)
const TRIGGER_PHRASE =
  (process.env.EVO_TRIGGER_PHRASE ||
    'Ola, gostaria de ajuda para conseguir meu credito habitação em portugal')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function isTriggerPhrase(text) {
  return normalizeText(text) === TRIGGER_PHRASE;
}

// Extrai apenas o primeiro nome
function getFirstName(fullName) {
  if (!fullName) return null;
  const parts = fullName.trim().split(/\s+/);
  return parts[0] || null;
}

// Comandos de navegação (sempre mensagem isolada)
const CMD_DUVIDA = ['duvida', 'duvidas'];
const CMD_GESTORA = ['gestora'];
const CMD_FALAR_COM_RAFA = ['falar com rafa'];

function isCommand(text, variants) {
  const t = normalizeText(text);
  return variants.includes(t);
}

// Deteta "boa sorte!" ou "boa sorte" (normalizado) para desativar modo falar_com_rafa
function isBoaSorteMessage(text) {
  const t = normalizeText(text);
  return t === 'boa sorte!' || t === 'boa sorte';
}

async function sendText(instanceName, remoteJid, text) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    console.warn('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configuradas – resposta não enviada');
    return;
  }
  const instance = instanceName || EVOLUTION_INSTANCE;
  const number = typeof remoteJid === 'string' && remoteJid.includes('@') ? db.normalizeNumber(remoteJid) : (remoteJid || '').replace(/\D/g, '');
  if (!number) return;
  await axios.post(
    `${EVOLUTION_URL}/message/sendText/${instance}`,
    { number, text },
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_API_KEY,
      },
      timeout: 15000,
    }
  );
}

// Notifica o administrador (Rafa) quando um lead pede "Falar com rafa": mensagem + link wa.me com texto pré-preenchido.
async function notifyAdminFalarComRafa(instanceName, lead, remoteJid) {
  if (!ADMIN_WHATSAPP) return;
  const nomeCompleto = (lead.nome || 'Lead').trim() || 'Lead';
  const primeiroNome = getFirstName(lead.nome) || nomeCompleto;
  const leadNumber = db.normalizeNumber(remoteJid);
  if (!leadNumber) return;
  const msgPrefixada = `oi ${primeiroNome}! aqui é Rafa, pode falar 😊`;
  const link = `https://wa.me/${leadNumber}?text=${encodeURIComponent(msgPrefixada)}`;
  const text = `${nomeCompleto} quer falar com rafa\n\n${link}`;
  const adminJid = ADMIN_WHATSAPP + '@s.whatsapp.net';
  await sendText(instanceName, adminJid, text);
}

const EMBEDDING_MODEL = process.env.OPENAI_EMBEDDING_MODEL || 'text-embedding-3-small';
const FAQ_MATCH_THRESHOLD = Number(process.env.FAQ_MATCH_THRESHOLD) || 0.78;

function norm(v) {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  return Math.sqrt(s) || 1;
}

function dot(a, b) {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

function cosineSimilarity(a, b) {
  return dot(a, b) / (norm(a) * norm(b));
}

async function getEmbedding(text) {
  if (!openai || !text || !text.trim()) return null;
  const res = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text.trim().slice(0, 8000),
  });
  const arr = res.data && res.data[0] && res.data[0].embedding;
  return Array.isArray(arr) ? arr : null;
}

// FAQ: busca por vetores e responde com respostas das gestoras
async function answerWithFAQ(lead, text, instanceName) {
  if (!text.trim()) return;
  const number = db.normalizeNumber(lead.whatsapp_number || '');
  if (!number) return;

  try {
    let perguntas = await db.getPerguntasWithEmbeddings();
    if (!perguntas || !perguntas.length) {
      await sendText(
        instanceName,
        lead.whatsapp_number,
        'Ainda não temos respostas guardadas para dúvidas. Uma gestora responderá em breve. Enquanto isso, escreve GESTORA para falar com a gestora ou FALAR COM RAFA para falar com a Rafa.'
      );
      return;
    }

    if (!openai || !OPENAI_API_KEY) {
      await sendText(instanceName, lead.whatsapp_number, 'O serviço de dúvidas está temporariamente indisponível. Escreve GESTORA para falar com a gestora.');
      return;
    }

    const queryEmbedding = await getEmbedding(text);
    if (!queryEmbedding) {
      await sendText(instanceName, lead.whatsapp_number, 'Não consegui processar a tua pergunta. Tenta reformular ou escreve GESTORA para falar com a gestora.');
      return;
    }

    for (const p of perguntas) {
      const hasEmb = p.embedding != null && (Array.isArray(p.embedding) ? p.embedding.length > 0 : (typeof p.embedding === 'string' ? p.embedding.length > 2 : false));
      if (!hasEmb && p.texto) {
        const emb = await getEmbedding(p.texto);
        if (emb) {
          await db.savePerguntaEmbedding(p.id, emb);
          p.embedding = emb;
        }
      }
    }

    let bestId = null;
    let bestScore = -1;
    for (const p of perguntas) {
      const emb = p.embedding;
      const arr = typeof emb === 'string' ? (() => { try { return JSON.parse(emb); } catch (_) { return []; } })() : (Array.isArray(emb) ? emb : []);
      if (arr.length === 0) continue;
      const score = cosineSimilarity(queryEmbedding, arr);
      if (score > bestScore) {
        bestScore = score;
        bestId = p.id;
      }
    }

    if (bestId != null && bestScore >= FAQ_MATCH_THRESHOLD) {
      const faqRes = await axios.get(`${IA_APP_BASE_URL}/api/faq/perguntas/${bestId}`, { timeout: 10000 });
      const { pergunta, respostas } = faqRes.data || {};
      if (pergunta && respostas && respostas.length) {
        await axios.post(`${IA_APP_BASE_URL}/api/faq/perguntas/${bestId}/incrementar-frequencia`, {}, { timeout: 5000 }).catch(() => {});
        let msg = '📌 *Pergunta:*\n' + (pergunta.texto || '').trim() + '\n\n';
        respostas.forEach((r) => {
          msg += '💬 *' + (r.gestora_nome || 'Gestora') + ':*\n' + (r.texto || '').trim() + '\n\n';
        });
        msg += '— Isto respondeu à tua dúvida? Se quiseres, podes reformular a pergunta.';
        await sendText(instanceName, lead.whatsapp_number, msg);
        return;
      }
    }

    await axios.post(
      `${IA_APP_BASE_URL}/api/faq/duvidas-pendentes`,
      {
        contacto_whatsapp: number,
        lead_id: lead.id,
        texto: text.trim(),
        origem: 'evo',
      },
      { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
    ).catch((err) => console.error('createDuvidaPendente:', err.response?.data || err.message));

    await sendText(
      instanceName,
      lead.whatsapp_number,
      'Não encontrei uma resposta pronta para esta dúvida. Uma gestora vai analisar e responder em breve por aqui. Se quiseres, podes reformular a pergunta.'
    );
  } catch (err) {
    console.error('answerWithFAQ:', err.response?.data || err.message);
    await sendText(
      instanceName,
      lead.whatsapp_number,
      'Ocorreu um erro ao procurar a resposta. Tenta de novo ou escreve GESTORA para falar com a gestora.'
    );
  }
}

// IA para dúvidas (fallback se FAQ não existir ou para compatibilidade)
async function answerWithAI(lead, text, instanceName) {
  if (!text.trim()) return;
  if (!openai || !OPENAI_API_KEY) {
    console.warn('OPENAI_API_KEY não configurada – resposta ignorada');
    return;
  }

  try {
    const firstName = lead.nome || '';
    const nomeCliente = firstName ? `O nome do utilizador é ${firstName}. Usa esse primeiro nome de forma natural em algumas respostas, mas não em todas.` : 'O nome do utilizador não é conhecido, não inventes nomes.';

    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'O teu nome é Joana e és uma assistente virtual especializada em crédito habitação em Portugal. ' +
            'Responde sempre em português de Portugal, de forma clara, educada e relativamente curta. ' +
            'Nunca peças ao utilizador para partilhar dados pessoais sensíveis ou números concretos, como rendimentos exatos, valor da casa, NIF, morada, número de conta, etc. ' +
            'Responde de forma genérica, explicando como os bancos costumam analisar este tipo de situação e, quando fizer sentido, menciona fontes de forma genérica, por exemplo: "segundo informação pública do Banco de Portugal" ou "segundo as práticas habituais dos bancos em Portugal", sem inventar documentos ou números específicos. ' +
            'Não prometas aprovações nem garantias; limita-te a explicar passos, critérios e cuidados a ter. ' +
            nomeCliente,
        },
        {
          role: 'user',
          content: text,
        },
      ],
      max_tokens: 500,
    });
    let reply = completion.choices[0]?.message?.content?.trim();
    if (!reply) return;

    const leadKey = String(lead.id);
    aiReplyCountByLead[leadKey] = (aiReplyCountByLead[leadKey] || 0) + 1;
    if (aiReplyCountByLead[leadKey] % 3 === 0) {
      reply +=
        '\n\nSe a tua dúvida já foi esclarecida e estás pronto para avançar, escreve GESTORA para falar com a gestora e iniciar a análise do teu caso, ou FALAR COM RAFA se precisares falar diretamente com a Rafa.';
    }

    await sendText(instanceName, lead.whatsapp_number, reply);
  } catch (err) {
    console.error('Erro ao processar mensagem (OpenAI ou Evolution):', err.response?.data || err.message);
  }
}

// Máquina de estados principal
async function handleIncomingMessage({ remoteJid, text, instanceName, profileName }) {
  const cleanText = normalizeText(text);
  if (!cleanText) return;

  const existingLead = await db.findLeadByWhatsapp(remoteJid);

  // Lead ainda não existe
  if (!existingLead) {
    if (!isTriggerPhrase(cleanText)) return;

    const firstName = getFirstName(profileName);
    const lead = await db.createLead({
      remoteJid,
      nome: firstName,
      origemInstancia: instanceName,
    });

    const saudacaoNome = firstName ? `Oi ${firstName}, tudo bem?\n` : 'Oi, tudo bem?\n';

    await sendText(
      instanceName,
      remoteJid,
      `${saudacaoNome}Meu nome é Joana, sou atendente virtual da Rafa e vou te ajudar por aqui :)\r\n\r\nPara começar, escreve:\r\n\r\nDUVIDA - se tens dúvidas sobre crédito habitação\r\n\r\nGESTORA - se já queres falar com a gestora para iniciar a sua análise\r\n\r\nFALAR COM RAFA - se precisas falar diretamente com a Rafa`
    );
    return;
  }

  const lead = existingLead;

  // Estados: estado_conversa (aguardando_escolha | com_joana | com_gestora | com_rafa) + estado_docs (aguardando_docs | sem_docs | docs_enviados)
  if (lead.estado_conversa === 'aguardando_escolha') {
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_joana' });
      await sendText(
        instanceName,
        remoteJid,
        'Perfeito, podes enviar as tuas dúvidas sobre crédito habitação em Portugal e eu respondo por aqui.'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Ótimo! Para começar, preciso que envies alguns documentos por este link: ${uploadLink}. Esses documentos são confidenciais e apenas a gestora terá acesso a eles.`
      );
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_rafa' });
      await sendText(
        instanceName,
        remoteJid,
        'Claro! Vou avisar a Rafa para falar contigo pessoalmente 😊\nEla vai mandar mensagem por aqui no WhatsApp assim que puder.'
      );
      notifyAdminFalarComRafa(instanceName, lead, remoteJid).catch((err) =>
        console.error('notifyAdminFalarComRafa:', err.message)
      );
      return;
    }
    await sendText(
      instanceName,
      remoteJid,
      'Para continuar, escreve uma das opções exatamente assim:\nDUVIDA\nGESTORA\nFALAR COM RAFA'
    );
    return;
  }

  if (lead.estado_conversa === 'com_joana' || lead.estado_docs === 'docs_enviados' || (lead.estado_conversa === 'com_gestora' && lead.estado_docs === 'aguardando_docs')) {
    if (isCommand(text, CMD_GESTORA)) {
      if (lead.estado_docs !== 'docs_enviados') {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Perfeito! Para avançarmos, usa este link para enviar os documentos: ${uploadLink}. Esses documentos são confidenciais e apenas a gestora terá acesso a eles.`
      );
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_rafa' });
      await sendText(
        instanceName,
        remoteJid,
        'Certo, vou pedir para a Rafa falar contigo diretamente. Em breve ela entra em contacto por aqui no WhatsApp.'
      );
      notifyAdminFalarComRafa(instanceName, lead, remoteJid).catch((err) =>
        console.error('notifyAdminFalarComRafa:', err.message)
      );
      return;
    }

    const leadKey = String(lead.id);
    aiQuestionCountByLead[leadKey] = (aiQuestionCountByLead[leadKey] || 0) + 1;
    if (aiQuestionCountByLead[leadKey] > 10) {
      await sendText(
        instanceName,
        remoteJid,
        'Chegaste ao limite de 10 perguntas com a Joana 😊\n\nA partir daqui, escreve GESTORA para falar com a gestora e iniciar a análise do teu caso, ou FALAR COM RAFA se precisares falar diretamente com a Rafa.'
      );
      return;
    }

    await answerWithFAQ(lead, text, instanceName);
    if (lead.estado_conversa === 'com_gestora' && lead.estado_docs === 'aguardando_docs') {
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Quando estiveres pronto, usa este link para enviar os documentos: ${uploadLink}.`
      );
    }
    return;
  }

  if (lead.estado_conversa === 'com_rafa') {
    // Resposta do lead é tratada abaixo (DUVIDA, GESTORA); "boa sorte!" é detetada em mensagens enviadas pela Rafa (fromMe) no webhook
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_joana' });
      await sendText(
        instanceName,
        remoteJid,
        'Sem problema! Podes voltar a enviar as tuas dúvidas sobre crédito habitação e eu respondo por aqui.'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      const jaEnviouDocs = lead.estado_docs === 'docs_enviados';
      if (!jaEnviouDocs) {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Perfeito! Para avançarmos, usa este link para enviar os documentos: ${uploadLink}. Esses documentos são confidenciais e apenas a gestora terá acesso a eles.`
      );
      return;
    }
  }
}

// Quando a Rafa envia "boa sorte!" para o lead (mensagem fromMe), desativa modo com_rafa → aguardando_escolha
async function handleOutgoingBoaSorte(remoteJid, text, instanceName) {
  if (!remoteJid || !isBoaSorteMessage(text)) return;
  const lead = await db.findLeadByWhatsapp(remoteJid);
  if (!lead || lead.estado_conversa !== 'com_rafa') return;
  await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
  console.log(`[evo] Lead ${lead.id} (${remoteJid}): "boa sorte!" → estado_conversa = aguardando_escolha`);
}

// Webhook Evolution API – MESSAGES_UPSERT
app.post('/webhook/evolution', (req, res) => {
  res.status(200).send('OK');

  const body = req.body || {};
  const event = (body.event || '').toLowerCase();

  if (event !== 'messages.upsert') return;

  const data = body.data || {};
  const key = data.key || {};
  const fromMe = key.fromMe === true || key.fromMe === 'true';

  const remoteJid = key.remoteJid;
  const instanceName = body.instance || EVOLUTION_INSTANCE;
  const profileName = data.pushName || data.profileName || null;

  const messages = Array.isArray(data.messages) ? data.messages : (data.message ? [data] : []);
  for (const msg of messages) {
    const msgKey = msg.key || key;
    const isFromMe = msgKey.fromMe === true || msgKey.fromMe === 'true' || fromMe;
    const jid = msgKey.remoteJid || remoteJid;
    const message = msg.message || msg;
    const text = getMessageText(message);
    if (!text) continue;
    if (isFromMe) {
      handleOutgoingBoaSorte(jid, text, instanceName).catch((err) =>
        console.error('handleOutgoingBoaSorte:', err)
      );
    } else {
      handleIncomingMessage({ remoteJid: jid, text, instanceName, profileName }).catch((err) =>
        console.error('handleIncomingMessage:', err)
      );
    }
  }

  // Payload alternativo: mensagem em data direto (um único objeto)
  if (!messages.length && data.message) {
    const text = getMessageText(data.message);
    if (text && remoteJid) {
      if (fromMe) {
        handleOutgoingBoaSorte(remoteJid, text, instanceName).catch((err) =>
          console.error('handleOutgoingBoaSorte:', err)
        );
      } else {
        handleIncomingMessage({ remoteJid, text, instanceName, profileName }).catch((err) =>
          console.error('handleIncomingMessage:', err)
        );
      }
    }
  }
});

// Página inicial
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Evo ouvindo na porta ${PORT}`);
});
