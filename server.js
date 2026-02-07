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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// Contadores simples em memória por lead
// - respostas de IA (para lembrete de navegação)
// - perguntas feitas (para limitar uso e economizar tokens)
const aiReplyCountByLead = {};
const aiQuestionCountByLead = {};

app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'evo', time: new Date().toISOString() });
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

async function sendText(instanceName, remoteJid, text) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    console.warn('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configuradas – resposta não enviada');
    return;
  }
  const instance = instanceName || EVOLUTION_INSTANCE;
  const number = db.normalizeNumber(remoteJid);
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

// IA para dúvidas
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

    // A cada 3 respostas, lembrar opções de navegação
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
      estado: 'aguardando_escolha',
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

  // Estados
  if (lead.estado === 'aguardando_escolha') {
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, 'em_conversa');
      await sendText(
        instanceName,
        remoteJid,
        'Perfeito, podes enviar as tuas dúvidas sobre crédito habitação em Portugal e eu respondo por aqui.'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      await db.updateLeadState(lead.id, 'aguardando_docs');
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Ótimo! Para começar, preciso que envies alguns documentos por este link: ${uploadLink}. Esses documentos são confidenciais e apenas a gestora terá acesso a eles.`
      );
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, 'falar_com_rafa', { estado_anterior: lead.estado });
      await sendText(
        instanceName,
        remoteJid,
        'Claro! Vou avisar a Rafa para falar contigo pessoalmente 😊\nEla vai mandar mensagem por aqui no WhatsApp assim que puder.'
      );
      return;
    }
    // Se escreveu outra coisa, repetir instruções
    await sendText(
      instanceName,
      remoteJid,
      'Para continuar, escreve uma das opções exatamente assim:\nDUVIDA\nGESTORA\nFALAR COM RAFA'
    );
    return;
  }

  if (lead.estado === 'em_conversa' || lead.estado === 'docs_enviados' || lead.estado === 'aguardando_docs') {
    // Comandos de navegação dentro da conversa
    if (isCommand(text, CMD_GESTORA)) {
      if (lead.estado !== 'docs_enviados') {
        await db.updateLeadState(lead.id, 'aguardando_docs');
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
      await db.updateLeadState(lead.id, 'falar_com_rafa', { estado_anterior: lead.estado });
      await sendText(
        instanceName,
        remoteJid,
        'Certo, vou pedir para a Rafa falar contigo diretamente. Em breve ela entra em contacto por aqui no WhatsApp.'
      );
      return;
    }

    // Limite de 10 perguntas por lead para economizar tokens
    const leadKey = String(lead.id);
    aiQuestionCountByLead[leadKey] = (aiQuestionCountByLead[leadKey] || 0) + 1;
    if (aiQuestionCountByLead[leadKey] > 4) {
      await sendText(
        instanceName,
        remoteJid,
        'Chegaste ao limite de 4 perguntas com a Joana 😊\n\nA partir daqui, escreve GESTORA para falar com a gestora e iniciar a análise do teu caso, ou FALAR COM RAFA se precisares falar diretamente com a Rafa.'
      );
      return;
    }

    // IA tira dúvidas; em aguardando_docs reforça o link no prompt/mensagem
    await answerWithAI(lead, text, instanceName);
    if (lead.estado === 'aguardando_docs') {
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Quando estiveres pronto, usa este link para enviar os documentos: ${uploadLink}.`
      );
    }
    return;
  }

  if (lead.estado === 'falar_com_rafa') {
    // Mesmo em modo Rafa, o utilizador pode voltar a DUVIDA ou GESTORA
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, 'em_conversa');
      await sendText(
        instanceName,
        remoteJid,
        'Sem problema! Podes voltar a enviar as tuas dúvidas sobre crédito habitação e eu respondo por aqui.'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      const jaEnviouDocs = lead.estado === 'docs_enviados' || lead.estado_anterior === 'docs_enviados';
      if (!jaEnviouDocs) {
        await db.updateLeadState(lead.id, 'aguardando_docs');
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        `Perfeito! Para avançarmos, usa este link para enviar os documentos: ${uploadLink}. Esses documentos são confidenciais e apenas a gestora terá acesso a eles.`
      );
      return;
    }
    // Qualquer outra mensagem em falar_com_rafa fica a cargo da Rafa (sem resposta automática)
  }
}

// Webhook Evolution API – MESSAGES_UPSERT
app.post('/webhook/evolution', (req, res) => {
  res.status(200).send('OK');

  const body = req.body || {};
  const event = (body.event || '').toLowerCase();

  if (event !== 'messages.upsert') return;

  const data = body.data || {};
  const key = data.key || {};

  const remoteJid = key.remoteJid;
  const instanceName = body.instance || EVOLUTION_INSTANCE;
  const profileName = data.pushName || data.profileName || null;

  const messages = Array.isArray(data.messages) ? data.messages : (data.message ? [data] : []);
  for (const msg of messages) {
    const message = msg.message || msg;
    const text = getMessageText(message);
    if (text) {
      handleIncomingMessage({ remoteJid, text, instanceName, profileName }).catch((err) =>
        console.error('handleIncomingMessage:', err)
      );
    }
  }

  // Payload alternativo: mensagem em data direto (um único objeto)
  if (!messages.length && data.message) {
    const text = getMessageText(data.message);
    if (text && remoteJid) {
      handleIncomingMessage({ remoteJid, text, instanceName, profileName }).catch((err) =>
        console.error('handleIncomingMessage:', err)
      );
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
