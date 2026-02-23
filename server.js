const path = require('path');
const fs = require('fs');

// Logger simples para ficheiro em hospedagem partilhada
const LOG_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (e) {
    console.error('Não consegui criar pasta de logs:', e.message);
  }
}
function writeLog(line) {
  try {
    const msg = `[${new Date().toISOString()}] ${line}\n`;
    const file = path.join(LOG_DIR, 'app.log');
    fs.appendFile(file, msg, (err) => {
      if (err) console.error('Erro ao escrever no log:', err.message);
    });
  } catch (err) {
    console.error('writeLog falhou:', err.message);
  }
}

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

// Envio de áudio para um número (quando a gestora responde com áudio no dashboard)
app.post('/api/internal/send-audio', (req, res) => {
  if (EVO_INTERNAL_SECRET && req.get('X-Internal-Secret') !== EVO_INTERNAL_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const number = (req.body && req.body.number && String(req.body.number).replace(/\D/g, '')) || '';
  const audioUrl = (req.body && req.body.audio_url && String(req.body.audio_url).trim()) || '';
  if (!number || !audioUrl) return res.status(400).json({ message: 'number e audio_url são obrigatórios.' });
  sendAudio(null, number, audioUrl)
    .then(() => res.json({ ok: true }))
    .catch((err) => {
      console.error('send-audio:', err.message);
      res.status(500).json({ message: err.response?.data?.message || err.message });
    });
});

// Atualizar embedding de uma dúvida (ch_duvidas; chamado pelo ia-app ao editar pergunta ou dúvida pendente)
app.post('/api/internal/atualizar-embedding-duvida', async (req, res) => {
  if (EVO_INTERNAL_SECRET && req.get('X-Internal-Secret') !== EVO_INTERNAL_SECRET) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  const duvidaId = req.body && req.body.duvida_id != null ? Number(req.body.duvida_id) : null;
  const texto = req.body && req.body.texto != null ? String(req.body.texto).trim() : '';
  if (!duvidaId || !Number.isInteger(duvidaId) || duvidaId < 1) {
    return res.status(400).json({ message: 'duvida_id (número) é obrigatório.' });
  }
  if (!texto) {
    return res.status(400).json({ message: 'texto é obrigatório.' });
  }
  try {
    const normalized = await normalizeQuestionText(texto);
    const emb = await getEmbedding(normalized || texto);
    if (!emb) {
      return res.status(500).json({ message: 'Não foi possível gerar o embedding.' });
    }
    await db.saveDuvidaEmbedding(duvidaId, emb);
    res.json({ ok: true });
  } catch (err) {
    console.error('atualizar-embedding-duvida:', err.message);
    res.status(500).json({ message: err.message || 'Erro ao atualizar embedding.' });
  }
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

// Triggers: só contam se a mensagem for exatamente uma destas (não no meio de outra frase)
const TRIGGER_EXACT = [
  'atendimento',
  'ola! vim pela rafa e gostaria de comprar um imovel financiado. voce poderia me ajudar?',
]
  .concat(process.env.EVO_TRIGGER_PHRASE ? [process.env.EVO_TRIGGER_PHRASE] : [])
  .map((s) =>
    (s || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim()
  )
  .filter(Boolean);

function normalizeText(text) {
  return (text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Normaliza para comparação exata (colapsa espaços múltiplos, remove \\r). */
function normalizeTextForTrigger(text) {
  return (text || '')
    .replace(/\r/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isTriggerPhrase(text) {
  const t = normalizeTextForTrigger(text);
  return TRIGGER_EXACT.some((trigger) => t === trigger);
}

// Frase que inicia o fluxo de boas-vindas com mensagens atrasadas (oi → Tudo bem? → áudio → texto final)
const BOAS_VINDAS_FLOW_TRIGGER = normalizeTextForTrigger(
  'Ola, gostaria de ajuda para conseguir meu credito habitação em portugal'
);
function isBoasVindasFlowTrigger(text) {
  return normalizeTextForTrigger(text) === BOAS_VINDAS_FLOW_TRIGGER;
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
const CMD_SIMULADOR = ['simulador'];

function isCommand(text, variants) {
  const t = normalizeText(text);
  return variants.includes(t);
}

// ---------- Simulador de primeira parcela ----------
// Fallback Euribor 3M quando a API BCE falha (ex.: ref. 06/02/2026: 1,999%)
const SIMULADOR_EURIBOR_DEFAULT = Number(process.env.SIMULADOR_EURIBOR) || 1.999;
const SIMULADOR_SPREAD = Number(process.env.SIMULADOR_SPREAD) || 0.7;
const SIMULADOR_IDADE_MAXIMA = 70; // muitos bancos só financiam até aos 70 anos

// Cache da Euribor 3M (API BCE): válido 12h
let euribor3mCache = { value: null, fetchedAt: 0 };
const EURIBOR_CACHE_MS = 12 * 60 * 60 * 1000;

/** Obtém a taxa Euribor 3 meses (API ECB Data Portal - EDP). Usa cache de 12h. Fallback para SIMULADOR_EURIBOR. */
async function getEuribor3M() {
  if (euribor3mCache.value != null && Date.now() - euribor3mCache.fetchedAt < EURIBOR_CACHE_MS) {
    return euribor3mCache.value;
  }
  // Apenas ECB Data Portal API (EDP). SDW (sdw-wsrest) foi descontinuado em out/2025.
  const urls = [
    'https://data-api.ecb.europa.eu/service/data/FM/M.U2.EUR.RT.MM.EURIBOR3MD_.HSTA?lastNObservations=1&format=jsondata',
    'https://data-api.ecb.europa.eu/service/data/RTD/M.S0.N.C_EUR3M.E?lastNObservations=1&format=jsondata',
  ];
  for (const url of urls) {
    try {
      const res = await axios.get(url, { timeout: 15000 });
      const data = res.data;
      let value = null;
      // Estrutura ECB dataSets/series/observations
      if (data && data.data && data.data.dataSets && data.data.dataSets[0]) {
        const ds = data.data.dataSets[0];
        const series = ds.series;
        if (series) {
          const keys = Object.keys(series);
          const first = series[keys[0]];
          if (first && first.observations) {
            const obsKeys = Object.keys(first.observations).sort((a, b) => Number(a) - Number(b));
            const lastKey = obsKeys[obsKeys.length - 1];
            const obs = first.observations[lastKey];
            if (Array.isArray(obs) && obs.length >= 2) value = parseFloat(obs[1]);
            else if (Array.isArray(obs) && obs.length === 1) value = parseFloat(obs[0]);
          }
        }
      }
      // Estrutura alternativa: dataSets na raiz (algumas respostas EDP)
      if (value == null && data && data.dataSets && data.dataSets[0]) {
        const ds = data.dataSets[0];
        const series = ds.series || ds.Series;
        if (series) {
          const keys = Object.keys(series);
          const first = series[keys[0]];
          const obs = first && (first.observations || first.Obs);
          if (obs && typeof obs === 'object') {
            const obsKeys = Object.keys(obs).sort((a, b) => Number(a) - Number(b));
            const lastKey = obsKeys[obsKeys.length - 1];
            const o = obs[lastKey];
            const arr = Array.isArray(o) ? o : (o && (o['@OBS_VALUE'] != null ? [o['@OBS_VALUE']] : [o.OBS_VALUE]));
            if (arr && arr.length) value = parseFloat(arr[arr.length - 1]);
          }
        }
      }
      // Estrutura alternativa: GenericData / Series / Obs com @OBS_VALUE
      if (value == null && data && data.GenericData && data.GenericData.DataSet && data.GenericData.DataSet.Series) {
        const series = data.GenericData.DataSet.Series;
        const s = Array.isArray(series) ? series[0] : series;
        if (s && s.Obs && Array.isArray(s.Obs) && s.Obs.length) {
          const last = s.Obs[s.Obs.length - 1];
          const v = last['@OBS_VALUE'] != null ? last['@OBS_VALUE'] : last.OBS_VALUE;
          if (v != null) value = parseFloat(v);
        }
      }
      if (value != null && !Number.isNaN(value) && value > 0 && value < 20) {
        euribor3mCache = { value, fetchedAt: Date.now() };
        console.log('Euribor 3M (API BCE):', value + '%');
        return value;
      }
    } catch (err) {
      console.error('getEuribor3M', url, err.message);
    }
  }
  console.warn('Euribor 3M: API indisponível, a usar valor por defeito', SIMULADOR_EURIBOR_DEFAULT + '%');
  return SIMULADOR_EURIBOR_DEFAULT;
}

/** Euribor atual para o simulador (valor em uso nos cálculos). */
async function getSimuladorEuribor() {
  if (process.env.SIMULADOR_EURIBOR != null && process.env.SIMULADOR_EURIBOR !== '') {
    const v = Number(process.env.SIMULADOR_EURIBOR);
    if (!Number.isNaN(v)) return v;
  }
  return getEuribor3M();
}

/** Prazo máximo em anos (até aos 70), entre 5 e 40 anos. */
function prazoMaximoAnos(idade) {
  const anos = SIMULADOR_IDADE_MAXIMA - idade;
  return Math.min(40, Math.max(5, anos));
}

function parseAge(str) {
  const s = (str || '').trim().replace(/\s/g, '');
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 18 || n > 100) return null;
  return n;
}

/** Valor do imóvel em euros. Aceita valor direto (ex.: 250000) ou em milhares (ex.: 250). Mínimo 5000 €. */
function parseValorImovel(str) {
  const s = (str || '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n <= 0) return null;
  const asEuros = n >= 1000 ? n : n * 1000; // 250 -> 250000; 250000 -> 250000
  if (asEuros < 5000) return null; // mínimo 5k ou 5 (milhares)
  return Math.round(asEuros);
}

/** Número de anos de financiamento (entre 5 e maxAnos). */
function parseAnos(str, maxAnos) {
  const s = (str || '').trim().replace(/\s/g, '');
  const n = parseInt(s, 10);
  if (!Number.isFinite(n) || n < 5 || n > maxAnos) return null;
  return n;
}

/** Valor de entrada em euros (0 até valorImovel - 1). Aceita valor direto ou em milhares. */
function parseEntrada(str, valorImovel) {
  const s = (str || '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n) || n < 0) return null;
  const asEuros = n >= 1000 ? n : n * 1000;
  if (asEuros >= valorImovel) return null;
  return Math.round(asEuros);
}

/** Interpreta número como anos (5–50) ou valor do imóvel em euros. Retorna { anos } ou { valor } ou null. */
function parseAnosOuValor(str) {
  const s = (str || '').trim().replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return null;
  const asAnos = parseInt(n, 10);
  if (asAnos >= 5 && asAnos <= 50 && asAnos === n) return { anos: asAnos };
  const valor = parseValorImovel(str);
  if (valor != null) return { valor };
  return null;
}

function calcularPrestacaoMensal(principal, taxaAnualPercent, anos) {
  const r = taxaAnualPercent / 100 / 12;
  const n = anos * 12;
  if (r === 0) return principal / n;
  const factor = Math.pow(1 + r, n);
  return principal * (r * factor) / (factor - 1);
}

function calcularSeguroImovelMensal(valorImovel) {
  return Math.round(valorImovel * 0.00012 * 10) / 10; // ~0.012% valor/ mês (média multirrisco)
}

function calcularSeguroCreditoMensal(idade, capital) {
  const base = 0.12;
  const ageFactor = 1 + (idade - 30) * 0.018;
  const premio = (capital / 1000) * base * Math.max(0.5, ageFactor);
  return Math.round(premio * 10) / 10;
}

async function enviarResultadoSimulador(instanceName, remoteJid, valorImovel, idade, anos, entrada) {
  const ent = entrada != null ? Math.round(entrada * 100) / 100 : 0;
  const capital = Math.round((valorImovel - ent) * 100) / 100;
  if (capital <= 0) return;
  const euribor = await getSimuladorEuribor();
  const taxaAnual = euribor + SIMULADOR_SPREAD;
  const prestacao = calcularPrestacaoMensal(capital, taxaAnual, anos);
  const seguroImovel = calcularSeguroImovelMensal(valorImovel);
  const seguroCredito = calcularSeguroCreditoMensal(idade, capital);
  const total = Math.round((prestacao + seguroImovel + seguroCredito) * 100) / 100;
  const prestacaoR = Math.round(prestacao * 100) / 100;
  const valorImovelFmt = Math.round(valorImovel).toLocaleString('pt-PT');
  const entFmt = Math.round(ent).toLocaleString('pt-PT');
  const msg =
    '📊 *Estimativa da primeira parcela*\n\n' +
    '*Dados considerados:*\n' +
    '• Valor do imóvel: ' + valorImovelFmt + ' €\n' +
    '• Entrada: ' + entFmt + ' €\n' +
    '• Prazo do financiamento: ' + anos + ' anos\n\n' +
    '*Primeira parcela:*\n' +
    '• Prestação ao banco: ' + prestacaoR.toFixed(2) + ' €\n' +
    '• Seguro multirrisco (média): ' + seguroImovel.toFixed(2) + ' €\n' +
    '• Seguro de crédito (média): ' + seguroCredito.toFixed(2) + ' €\n\n' +
    '*Total primeira parcela:* ' + total.toFixed(2) + ' €\n\n' +
    '(Valores aproximados. A prestação pode variar com a Euribor e o seguro de crédito com a idade. Para uma análise personalizada, escreve GESTORA ou escreve SIMULADOR para simular outros valores.)';
  await sendText(instanceName, remoteJid, msg);
}

async function handleSimuladorStep(instanceName, leadId, remoteJid, text) {
  const state = await db.getSimuladorState(leadId);
  if (!state) return false;

  if (state.step === 'age') {
    const age = parseAge(text);
    if (age === null) {
      await sendText(instanceName, remoteJid, 'Por favor indica a tua idade em número (por exemplo: 35)');
      return true;
    }
    await db.setSimuladorState(leadId, { step: 'valor_imovel', age });
    await sendText(
      instanceName,
      remoteJid,
      'Qual é o valor do imóvel que tens em mente? (indica o valor em euros, ex.: 200000 ou 250)'
    );
    return true;
  }

  if (state.step === 'valor_imovel') {
    const valor = parseValorImovel(text);
    if (valor === null) {
      await sendText(
        instanceName,
        remoteJid,
        'Por favor indica o valor do imóvel em euros (por exemplo: 200000 ou 250 para 250 000 €).'
      );
      return true;
    }
    const maxAnos = prazoMaximoAnos(state.age);
    await db.setSimuladorState(leadId, { step: 'anos', age: state.age, valorImovel: valor });
    await sendText(
      instanceName,
      remoteJid,
      'Em quantos anos pretende financiar? O máximo para a tua idade (' + state.age + ' anos) é ' + maxAnos + ' anos. (ex.: ' + maxAnos + ')'
    );
    return true;
  }

  if (state.step === 'anos') {
    const maxAnos = prazoMaximoAnos(state.age);
    const anos = parseAnos(text, maxAnos);
    if (anos === null) {
      await sendText(
        instanceName,
        remoteJid,
        'Por favor indica um número de anos entre 5 e ' + maxAnos + ' (ex.: ' + maxAnos + ').'
      );
      return true;
    }
    await db.setSimuladorState(leadId, { step: 'entrada', age: state.age, valorImovel: state.valorImovel, anos });
    await sendText(
      instanceName,
      remoteJid,
      'Quanto pretendes dar de entrada, em euros? (ex.: 20000 ou 0 se ainda não sabes)'
    );
    return true;
  }

  if (state.step === 'entrada') {
    const entrada = parseEntrada(text, state.valorImovel);
    if (entrada === null) {
      await sendText(
        instanceName,
        remoteJid,
        'Por favor indica o valor de entrada em euros (0 a ' + (state.valorImovel - 1).toFixed(0) + '). Ex.: 20000 ou 0.'
      );
      return true;
    }
    await enviarResultadoSimulador(instanceName, remoteJid, state.valorImovel, state.age, state.anos, entrada);
    await db.clearSimuladorState(leadId);
    await db.updateLeadState(leadId, { conversa: 'aguardando_escolha' });
    return true;
  }

  return false;
}

// Deteta "boa sorte!" ou "boa sorte" (normalizado) para desativar modo falar_com_rafa
function isBoaSorteMessage(text) {
  const t = normalizeText(text);
  return t === 'boa sorte!' || t === 'boa sorte';
}

// Deteta "pausar" (admin) para colocar o lead em em_pausa
function isPausarMessage(text) {
  return normalizeText(text) === 'pausar';
}

// Saudações/perguntas genéricas: resposta pronta, não envia para gestoras
const GREETING_RESPONSE = 'Oi! Tudo bem, obrigada! 😊 Em que posso ajudar? Se tiveres dúvidas sobre crédito habitação, escreve aqui que eu envio para as gestoras.';
const GREETING_PATTERNS = [
  /^oi\s*!?\s*(\?)?\s*$/i,
  /^olá?\s*!?\s*(\?)?\s*$/i,
  /^tudo\s+bem\s*!?\s*(\?)?\s*$/i,
  /^tudo\s+bom\s*!?\s*(\?)?\s*$/i,
  /^como\s+vai\s*!?\s*(\?)?\s*$/i,
  /^como\s+está\s*!?\s*(\?)?\s*$/i,
  /^como\s+estas\s*!?\s*(\?)?\s*$/i,
  /^como\s+estás\s*!?\s*(\?)?\s*$/i,
  /^e\s+(aí|ai|você|voce)\s*!?\s*(\?)?\s*$/i,
  /^bom\s+dia\s*!?\s*\.?\s*$/i,
  /^boa\s+tarde\s*!?\s*\.?\s*$/i,
  /^boa\s+noite\s*!?\s*\.?\s*$/i,
  /^hey\s*!?\s*(\?)?\s*$/i,
  /^ei\s*!?\s*(\?)?\s*$/i,
  /^eai\s*!?\s*(\?)?\s*$/i,
  /^ola\s*!?\s*(\?)?\s*$/i,
  /^oi\s+tudo\s+bem\s*!?\s*(\?)?\s*$/i,
  /^olá?\s+tudo\s+bem\s*!?\s*(\?)?\s*$/i,
  /^oi\s+tudo\s+bom\s*!?\s*(\?)?\s*$/i,
  /^olá?\s+tudo\s+bom\s*!?\s*(\?)?\s*$/i,
];

function isGreeting(text) {
  const t = (text || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[?!.]+\s*$/g, '').trim();
  if (!t) return false;
  return GREETING_PATTERNS.some((re) => re.test(t));
}

// Buffer de mensagens no modo dúvida até o lead enviar "?" (pergunta completa)
const duvidaBufferByLead = new Map();

/** Considera ? (U+003F) e ？ (U+FF1F fullwidth) para não bufferizar perguntas que já terminam com ? */
function hasQuestionMark(str) {
  if (!str || typeof str !== 'string') return false;
  return str.includes('\u003F') || str.includes('\uFF1F');
}

function getDuvidaBufferKey(instanceName, leadId) {
  return `${instanceName || ''}:${leadId}`;
}

function pushDuvidaBuffer(instanceName, leadId, text) {
  const key = getDuvidaBufferKey(instanceName, leadId);
  const arr = duvidaBufferByLead.get(key) || [];
  arr.push((text || '').trim());
  duvidaBufferByLead.set(key, arr);
  return arr;
}

function consumeDuvidaBuffer(instanceName, leadId, lastMessage) {
  const key = getDuvidaBufferKey(instanceName, leadId);
  clearDuvidaBufferTimer(key);
  const arr = duvidaBufferByLead.get(key) || [];
  duvidaBufferByLead.delete(key);
  const parts = [...arr, (lastMessage || '').trim()].filter(Boolean);
  return parts.join(' ').trim();
}

const DUVIDA_BUFFER_REMINDER_MS = 1 * 60 * 1000;
const DUVIDA_BUFFER_REMINDER_TEXT =
  '💬 Só mais um detalhe: ao final da tua pergunta adiciona um "?" para eu entender que concluíste, ok? 😊';
const duvidaBufferTimerByKey = new Map();

function clearDuvidaBufferTimer(key) {
  const entry = duvidaBufferTimerByKey.get(key);
  if (entry && entry.timeoutId) clearTimeout(entry.timeoutId);
  duvidaBufferTimerByKey.delete(key);
}

function scheduleDuvidaBufferReminder(instanceName, leadId, remoteJid) {
  const key = getDuvidaBufferKey(instanceName, leadId);
  clearDuvidaBufferTimer(key);
  const timeoutId = setTimeout(() => {
    duvidaBufferTimerByKey.delete(key);
    sendText(instanceName, remoteJid, DUVIDA_BUFFER_REMINDER_TEXT).catch((err) =>
      console.error('duvidaBufferReminder send:', err.message)
    );
  }, DUVIDA_BUFFER_REMINDER_MS);
  duvidaBufferTimerByKey.set(key, { timeoutId, remoteJid, instanceName });
}

async function sendText(instanceName, remoteJid, text, options) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    console.warn('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configuradas – resposta não enviada');
    return;
  }
  const instance = instanceName || EVOLUTION_INSTANCE;
  const number =
    typeof remoteJid === 'string' && remoteJid.includes('@')
      ? db.normalizeNumber(remoteJid)
      : (remoteJid || '').replace(/\D/g, '');
  if (!number) return;
  // Prefixo padrão para mensagens enviadas pela Joana para leads (pode ser desativado, ex.: fluxo boas-vindas)
  const skipJoanaPrefix = options && options.skipJoanaPrefix === true;
  const adminNumber = (ADMIN_WHATSAPP || '').replace(/\D/g, '');
  const isAdmin = adminNumber && number === adminNumber;
  let finalText = text || '';
  if (!isAdmin && !skipJoanaPrefix) {
    const prefix = '👱‍♀️ Joana: ';
    if (!finalText.startsWith('👱‍♀️ Joana')) {
      finalText = prefix + finalText;
    }
  }
  await axios.post(
    `${EVOLUTION_URL}/message/sendText/${instance}`,
    { number, text: finalText },
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_API_KEY,
      },
      timeout: 15000,
    }
  );
}

/**
 * Fluxo de boas-vindas com mensagens atrasadas (trigger: "Ola, gostaria de ajuda para conseguir meu credito habitação em portugal").
 * Passos são guardados na fila ch_boas_vindas_queue e processados por um job a cada 12s, para sobreviver a reinícios do processo.
 * 1) 15s: oi (nome)
 * 2) +5s: Tudo bem? 😊 + presence "recording"
 * 3) +70s: áudio de boas vindas (ia-app)
 * 4) +20s: texto final com "atendimento" e boa sorte
 */
async function runBoasVindasFlow(instanceName, remoteJid, firstName) {
  const nome = (firstName || '').trim();
  const msg1 = nome ? `oi ${nome}` : 'oieee';
  const msg2 = 'Tudo bem? 😊';
  const msg4 =
    'Criamos uma automação para ajudar no seu atendimento. É gratuito e para iniciar, basta escrever "atendimento". E qualquer coisa que precisar me chama 🤗 boa sorte!🍀';

  try {
    await db.insertBoasVindasSteps(instanceName, remoteJid, msg1, msg2, msg4);
  } catch (err) {
    writeLog(`boas-vindas queue insert failed: ${err.message}`);
  }
}

const boasVindasOpt = { skipJoanaPrefix: true };

async function processBoasVindasQueue() {
  let rows;
  try {
    rows = await db.getDueBoasVindasSteps();
  } catch (err) {
    writeLog(`boas-vindas getDue failed: ${err.message}`);
    return;
  }
  for (const row of rows || []) {
    const { id, instance_name, remote_jid, step, payload } = row;
    try {
      if (step === 1 || step === 2 || step === 4) {
        const text = payload || '';
        await sendText(instance_name, remote_jid, text, boasVindasOpt);
        if (step === 2) {
          sendPresence(instance_name, remote_jid, 'recording', 70 * 1000).catch(() => {});
        }
      } else if (step === 3) {
        if (IA_APP_BASE_URL && EVO_INTERNAL_SECRET) {
          const audioUrl = `${IA_APP_BASE_URL}/api/internal/audios-rafa/boas_vindas?token=${encodeURIComponent(EVO_INTERNAL_SECRET)}`;
          await sendAudio(instance_name, remote_jid, audioUrl);
        }
      }
    } catch (err) {
      writeLog(`boas-vindas step ${step} error: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}`);
    }
    try {
      await db.deleteBoasVindasStep(id);
    } catch (e) {
      writeLog(`boas-vindas delete step ${id} failed: ${e.message}`);
    }
  }
}

// Envio de presence (composing = "a escrever...", recording = "a gravar áudio...")
// Evolution API: POST /chat/sendPresence/{instance} com body { number, presence, delay } (presence e delay no topo).
// A API pode manter a conexão aberta durante o delay, por isso usamos timeout curto e tratamos timeout como sucesso.
async function sendPresence(instanceName, remoteJid, presence, delayMs) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) return;
  const instance = instanceName || EVOLUTION_INSTANCE;
  const number =
    typeof remoteJid === 'string' && remoteJid.includes('@')
      ? db.normalizeNumber(remoteJid)
      : (remoteJid || '').replace(/\D/g, '');
  if (!number || !presence) return;
  const delay = Math.max(0, Math.min(Number(delayMs) || 60000, 180000)); // 0–180s
  const presenceType = presence === 'recording' ? 'recording' : 'composing';
  const path = `${EVOLUTION_URL}/chat/sendPresence/${instance}`;
  const body = { number, presence: presenceType, delay };

  try {
    await axios.post(path, body, {
      headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
      timeout: 5000, // API pode não responder até ao fim do delay; 5s é suficiente para aceitar o pedido
    });
  } catch (err) {
    const status = err.response?.status;
    const data = err.response?.data;
    const isTimeout = err.code === 'ECONNABORTED' || err.message?.includes('timeout');
    if (isTimeout) return;
    writeLog(`sendPresence failed -> ${path} ${status || ''} ${data ? JSON.stringify(data) : err.message}`);
  }
}

// Envio de áudio (quando houver resposta em áudio no FAQ)
async function sendAudio(instanceName, remoteJid, audioUrl) {
  if (!EVOLUTION_URL || !EVOLUTION_API_KEY) {
    console.warn('EVOLUTION_API_URL ou EVOLUTION_API_KEY não configuradas – áudio não enviado');
    return;
  }
  const instance = instanceName || EVOLUTION_INSTANCE;
  const number =
    typeof remoteJid === 'string' && remoteJid.includes('@')
      ? db.normalizeNumber(remoteJid)
      : (remoteJid || '').replace(/\D/g, '');
  if (!number) return;
  const url = (audioUrl || '').trim();
  if (!url) return;
  await axios.post(
    `${EVOLUTION_URL}/message/sendWhatsAppAudio/${instance}`,
    { number, audio: url },
    {
      headers: {
        'Content-Type': 'application/json',
        apikey: EVOLUTION_API_KEY,
      },
      timeout: 20000,
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
const DUVIDA_DUPLICATE_THRESHOLD = Number(process.env.DUVIDA_DUPLICATE_THRESHOLD) || 0.82;

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
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return 0;
  const n = norm(a) * norm(b);
  if (!n || n === 0) return 0;
  const s = dot(a, b) / n;
  return Number.isFinite(s) ? s : 0;
}

// Normaliza o texto da pergunta com IA para remover ruído e repetições,
// mantendo o significado (usado antes de gerar embeddings).
async function normalizeQuestionText(rawText) {
  const text = (rawText || '').trim();
  if (!text || !openai || !OPENAI_API_KEY) return rawText;
  try {
    const promptUser = text.slice(0, 800); // limitar tamanho para reduzir tokens
    const completion = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Estás a receber mensagens de utilizadores com dúvidas sobre crédito habitação em Portugal. ' +
            'O contexto é sempre perguntas de pessoas que querem comprar casa, sair do arrendamento, rever crédito, ' +
            'entender taxas (Euribor, spread), seguros, prazos, aprovação, bancos em Portugal, etc. ' +
            'Reescreve a pergunta seguinte em português de Portugal numa frase única, limpa, clara e gramaticalmente correta, ' +
            'mantendo exatamente o mesmo significado e a intenção original. Remove repetições, emojis, cumprimentos iniciais ' +
            '(ex.: \"olá\", \"boa noite\"), agradecimentos e texto irrelevante ou muito coloquial que não mude o sentido. ' +
            'Se o utilizador misturar vários temas, mantém todos os temas relevantes numa pergunta só, sem inventar informação nova. ' +
            'Não respondas à pergunta. Devolve apenas a pergunta reformulada, sem texto extra, sem aspas e sem comentários.',
        },
        { role: 'user', content: promptUser },
      ],
      max_tokens: 120,
      temperature: 0.2,
    });
    const normalized = completion.choices[0]?.message?.content?.trim();
    if (normalized && normalized.length > 0) return normalized;
    return rawText;
  } catch (err) {
    console.error('normalizeQuestionText error:', err.message);
    writeLog('normalizeQuestionText error: ' + (err.response?.data ? JSON.stringify(err.response.data) : err.message));
    return rawText;
  }
}

async function getEmbedding(text) {
  if (!openai || !text || !text.trim()) return null;
  try {
    const res = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.trim().slice(0, 8000),
    });
    const arr = res.data && res.data[0] && res.data[0].embedding;
    return Array.isArray(arr) ? arr : null;
  } catch (err) {
    console.error('getEmbedding error:', err.response?.data || err.message || err);
    writeLog(
      'getEmbedding error: ' +
        (err.response?.data ? JSON.stringify(err.response.data) : err.message || String(err))
    );
    return null;
  }
}

// FAQ: busca por vetores e responde com respostas das gestoras
async function answerWithFAQ(lead, text, instanceName) {
  if (!text.trim()) return;
  const number = db.normalizeNumber(lead.whatsapp_number || '');
  if (!number) return;

  try {
    // Pergunta normalizada (IA) para usar tanto no armazenamento como nos embeddings
    const normalizedQuestion = await normalizeQuestionText(text);
    let baseQuestionText = (normalizedQuestion && normalizedQuestion.trim()) || text.trim();
    // Se a IA devolveu frase de erro (ex.: quando o input era só "?"), usar o texto original do lead
    if (
      !baseQuestionText ||
      baseQuestionText.length < 15 ||
      /não há uma pergunta para reformular|desculpe.*reformular/i.test(baseQuestionText)
    ) {
      baseQuestionText = text.trim();
    }
    if (!baseQuestionText) return;

    let perguntas = await db.getDuvidasWithEmbeddings(0);
    if (!perguntas || !perguntas.length) {
      let created = false;
      try {
        const res = await axios.post(
          `${IA_APP_BASE_URL}/api/faq/duvidas-pendentes`,
          {
            contacto_whatsapp: number,
            lead_id: lead.id,
            texto: baseQuestionText,
            origem: 'evo',
          },
          { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
        );
        created = res && res.status >= 200 && res.status < 300;
      } catch (err) {
        console.error('createDuvidaPendente (sem FAQ):', err.response?.data || err.message);
      }
      if (created) {
        await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
        await sendText(
          instanceName,
          lead.whatsapp_number,
          'Ainda não temos respostas para essa pergunta. Enviamos sua dúvida para as gestoras e assim que tivermos um retorno delas eu vou te avisando por aqui ok? Escreva DUVIDA para nova pergunta.'
        );
      } else {
        await sendText(
          instanceName,
          lead.whatsapp_number,
          'Ocorreu um erro ao registar a tua dúvida. Por favor tenta novamente dentro de momentos ou escreve FALAR COM RAFA e vamos te ajudar.'
        );
      }
      return;
    }

    if (!openai || !OPENAI_API_KEY) {
      await sendText(instanceName, lead.whatsapp_number, 'O serviço de dúvidas está temporariamente indisponível. Escreve GESTORA para falar com a gestora.');
      return;
    }

    // Gerar embedding em cima da pergunta normalizada (ou original em fallback)
    const queryEmbedding = await getEmbedding(baseQuestionText);
    if (!queryEmbedding) {
      await sendText(instanceName, lead.whatsapp_number, 'Não consegui processar a tua pergunta. Tenta reformular ou escreve GESTORA para falar com a gestora.');
      return;
    }

    for (const p of perguntas) {
      const hasEmb = p.embedding != null && (Array.isArray(p.embedding) ? p.embedding.length > 0 : (typeof p.embedding === 'string' ? p.embedding.length > 2 : false));
      if (!hasEmb && p.texto) {
        const norm = await normalizeQuestionText(p.texto);
        const emb = await getEmbedding((norm && norm.trim()) || p.texto);
        if (emb) {
          await db.saveDuvidaEmbedding(p.id, emb);
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
      try {
        const faqRes = await axios.get(`${IA_APP_BASE_URL}/api/faq/perguntas/${bestId}`, { timeout: 10000 });
        const { pergunta, respostas } = faqRes.data || {};
        if (pergunta && respostas && respostas.length) {
          await axios.post(`${IA_APP_BASE_URL}/api/faq/perguntas/${bestId}/incrementar-frequencia`, {}, { timeout: 5000 }).catch(() => {});

          const perguntaTexto = (pergunta.texto || '').trim();
          const baseUrlRaw = (process.env.IA_APP_BASE_URL || process.env.IA_PUBLIC_BASE_URL || '').trim();
          const baseUrl = baseUrlRaw ? baseUrlRaw.replace(/\/$/, '') : '';

          const respostasComAudio = respostas.filter(
            (r) =>
              r &&
              (r.audio_url && String(r.audio_url).trim().length > 0 ||
                (r.audio_direct_url && String(r.audio_direct_url).trim().length > 0) ||
                r.audio_in_db === 1)
          );
          const temAudio = respostasComAudio.length > 0;

          const nomes = respostas.map((r) => (r.gestora_nome || 'Gestora').trim() || 'Gestora');
          const nomeStr =
            nomes.length === 0
              ? 'Gestora'
              : nomes.length === 1
                ? nomes[0]
                : nomes.slice(0, -1).join(', ') + ' e ' + nomes[nomes.length - 1];
          const respondeuStr = nomes.length > 1 ? 'responderam' : 'respondeu';
          const msg =
            '✨\n✨ ' + nomeStr + ' ' + respondeuStr + ' sua dúvida\n\n❓ "' + (perguntaTexto || '').trim() + '"';

          await sendText(instanceName, lead.whatsapp_number, msg);

          if (temAudio) {
            for (const r of respostasComAudio) {
              // Preferir o endpoint interno com token (audio_url), que sabemos que funciona com a Evolution.
              const rawPrimary = String(r.audio_url || '').trim();
              const rawDirect = String(r.audio_direct_url || '').trim();
              const rawUrl = rawPrimary || rawDirect;
              if (!rawUrl) continue;
              const fullAudioUrl =
                rawUrl.startsWith('http') || !baseUrl ? rawUrl : baseUrl + rawUrl;
              if (!fullAudioUrl || !fullAudioUrl.startsWith('http')) continue;
              try {
                await sendAudio(instanceName, lead.whatsapp_number, fullAudioUrl);
              } catch (err) {
                console.error('sendAudio (FAQ):', err.response?.data || err.message);
              }
            }
          } else if (temAudio && !baseUrl) {
            console.warn('IA_APP_BASE_URL/IA_PUBLIC_BASE_URL não configurado – não é possível enviar áudio pelo FAQ.');
          }
          return;
        }
      } catch (faqErr) {
        // Falha ao obter FAQ do ia-app (rede, 404, 500): tratar como "sem resposta" e registar como nova dúvida
        console.error('FAQ fetch (ia-app):', faqErr.response?.data || faqErr.message);
      }
    }

    // Verificar se já existe uma dúvida pendente muito parecida (usar embeddings guardados)
    try {
      const duvidas = await db.getDuvidasWithEmbeddings(1);
      if (duvidas && duvidas.length > 0) {
        let bestDuvidaScore = -1;
        for (const d of duvidas) {
          let arr = d.embedding;
          if (arr == null || (Array.isArray(arr) && arr.length === 0) || (typeof arr === 'string' && arr.length < 3)) {
            if (d.texto && d.texto.trim()) {
              const norm = await normalizeQuestionText(d.texto);
              const emb = await getEmbedding((norm && norm.trim()) || d.texto);
              if (emb) {
                await db.saveDuvidaEmbedding(d.id, emb);
                arr = emb;
              }
            }
          }
          if (Buffer.isBuffer(arr)) arr = arr.toString('utf8');
          if (typeof arr === 'string') {
            try {
              arr = JSON.parse(arr);
            } catch (_) {
              arr = [];
            }
          }
          if (!Array.isArray(arr) || arr.length === 0) continue;
          const score = cosineSimilarity(queryEmbedding, arr);
          if (score > bestDuvidaScore) bestDuvidaScore = score;
        }
        if (bestDuvidaScore >= DUVIDA_DUPLICATE_THRESHOLD) {
          await sendText(
            instanceName,
            lead.whatsapp_number,
            'Já temos uma dúvida muito parecida em análise. Assim que tivermos resposta das gestoras, avisamos por aqui. Fique à vontade para fazer outras perguntas 😊'
          );
          return;
        }
      }
    } catch (err) {
      console.error('getDuvidasWithEmbeddings(1):', err.message);
    }

    let createdDuvida = false;
    try {
      const res = await axios.post(
        `${IA_APP_BASE_URL}/api/faq/duvidas-pendentes`,
        {
          contacto_whatsapp: number,
          lead_id: lead.id,
          texto: baseQuestionText,
          origem: 'evo',
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 10000 }
      );
      createdDuvida = res && res.status >= 200 && res.status < 300;
      if (createdDuvida && res.data && res.data.id && res.data.texto) {
        try {
          const emb = await getEmbedding(String(res.data.texto).trim());
          if (emb) await db.saveDuvidaEmbedding(Number(res.data.id), emb);
        } catch (embErr) {
          console.error('saveDuvidaEmbedding após criar:', embErr.message);
        }
      }
    } catch (err) {
      console.error('createDuvidaPendente:', err.response?.data || err.message);
    }
    if (createdDuvida) {
      await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
      await sendText(
        instanceName,
        lead.whatsapp_number,
        'Ainda não temos respostas para essa pergunta. Enviamos sua dúvida para as gestoras e assim que tivermos um retorno delas eu vou te avisando por aqui ok? Escreva DUVIDA para nova pergunta.'
      );
    } else {
      await sendText(
        instanceName,
        lead.whatsapp_number,
        'Ocorreu um erro ao registar a tua dúvida. Por favor tenta novamente dentro de momentos ou escreve FALAR COM RAFA e vamos te ajudar.'
      );
    }
  } catch (err) {
    console.error('answerWithFAQ:', err.response?.data || err.message);
    writeLog(
      'answerWithFAQ error: ' + 
        (err.response?.data ? JSON.stringify(err.response.data) : err.message || String(err))
    );
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
  const isBoasVindas = isBoasVindasFlowTrigger(text);

  // Lead ainda não existe
  if (!existingLead) {
    if (isBoasVindas) {
      try {
        const firstName = getFirstName(profileName);
        const lead = await db.createLead({
          remoteJid,
          nome: firstName,
          origemInstancia: instanceName,
          estadoConversa: 'em_boas_vindas',
        });
        runBoasVindasFlow(instanceName, remoteJid, firstName || lead.nome);
      } catch (err) {
        writeLog(`handleIncomingMessage createLead (boas-vindas) ERRO: ${err.message}`);
        throw err;
      }
      return;
    }
    if (!isTriggerPhrase(cleanText)) return;

    const firstName = getFirstName(profileName);
    let lead;
    try {
      lead = await db.createLead({
        remoteJid,
        nome: firstName,
        origemInstancia: instanceName,
      });
    } catch (err) {
      writeLog(`handleIncomingMessage createLead (trigger) ERRO: ${err.message}`);
      throw err;
    }

    const agora = new Date();
    const hora = agora.getHours();
    let saudacaoTempo = '';
    if (hora >= 5 && hora < 12) saudacaoTempo = 'bom dia!';
    else if (hora >= 12 && hora < 18) saudacaoTempo = 'boa tarde!';
    else saudacaoTempo = 'boa noite!';

    const saudacaoNome = firstName
      ? `Oi ${firstName}, ${saudacaoTempo} tudo bem?\n`
      : `Oi, ${saudacaoTempo} tudo bem?\n`;

    await sendText(
      instanceName,
      remoteJid,
      `${saudacaoNome}Vou te ajudar por aqui 🙂\r\n\r\nPara começar, escreve:\r\n\r\nDUVIDA - se tens dúvidas sobre crédito habitação\r\n\r\nGESTORA - se queres que a gestora inicie a analise do teu caso gratuitamente\r\n\r\nSIMULADOR - para simular a primeira parcela do crédito\r\n\r\nFALAR COM RAFA - se precisas falar diretamente com a Rafa`
    );
    return;
  }

  const lead = existingLead;

  // Em boas-vindas: flow automático a correr; a Joana só responde quando o lead escreve "atendimento" (ou frase trigger) ou repete a frase de boas-vindas → passa a aguardando_escolha e envia o menu
  if (lead.estado_conversa === 'em_boas_vindas') {
    if (isTriggerPhrase(cleanText) || isBoasVindasFlowTrigger(text)) {
      await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
      const agora = new Date();
      const hora = agora.getHours();
      let saudacaoTempo = '';
      if (hora >= 5 && hora < 12) saudacaoTempo = 'bom dia!';
      else if (hora >= 12 && hora < 18) saudacaoTempo = 'boa tarde!';
      else saudacaoTempo = 'boa noite!';
      const firstName = getFirstName(lead.nome) || getFirstName(profileName);
      const saudacaoNome = firstName
        ? `Oi ${firstName}, ${saudacaoTempo} tudo bem?\n`
        : `Oi, ${saudacaoTempo} tudo bem?\n`;
      await sendText(
        instanceName,
        remoteJid,
        `${saudacaoNome}Vou te ajudar por aqui 🙂\r\n\r\nPara começar, escreve:\r\n\r\nDUVIDA - se tens dúvidas sobre crédito habitação\r\n\r\nSIMULADOR - para simular a primeira parcela do crédito\r\n\r\nGESTORA - se queres que a gestora inicie a analise do teu caso gratuitamente\r\n\r\nFALAR COM RAFA - se precisas falar diretamente com a Rafa`
      );
    }
    return;
  }

  // Em pausa: Rafa/admin está a falar com o lead; a Joana não responde — exceto se o lead escrever atendimento, duvida, simulador ou gestora (sai e entra no fluxo correspondente)
  if (lead.estado_conversa === 'em_pausa') {
    if (isTriggerPhrase(cleanText)) {
      await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
      const agora = new Date();
      const hora = agora.getHours();
      let saudacaoTempo = '';
      if (hora >= 5 && hora < 12) saudacaoTempo = 'bom dia!';
      else if (hora >= 12 && hora < 18) saudacaoTempo = 'boa tarde!';
      else saudacaoTempo = 'boa noite!';
      const firstName = getFirstName(lead.nome) || getFirstName(profileName);
      const saudacaoNome = firstName
        ? `Oi ${firstName}, ${saudacaoTempo} tudo bem?\n`
        : `Oi, ${saudacaoTempo} tudo bem?\n`;
      await sendText(
        instanceName,
        remoteJid,
        `${saudacaoNome}Vou te ajudar por aqui 🙂\r\n\r\nPara começar, escreve:\r\n\r\nDUVIDA - se tens dúvidas sobre crédito habitação\r\n\r\nSIMULADOR - para simular a primeira parcela do crédito\r\n\r\nGESTORA - se queres que a gestora inicie a analise do teu caso gratuitamente\r\n\r\nFALAR COM RAFA - se precisas falar diretamente com a Rafa`
      );
      return;
    }
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
      await sendText(
        instanceName,
        remoteJid,
        'Perfeito, pode me perguntar e eu encaminho para as nossas gestoras especialistas no assunto'
      );
      return;
    }
    if (isCommand(text, CMD_SIMULADOR)) {
      await db.setSimuladorState(lead.id, { step: 'age' });
      const euribor = await getSimuladorEuribor();
      const intro =
        'Os valores que vou apresentar são calculados de forma aproximada, considerando a Euribor ' +
        euribor.toFixed(2) + '% e um spread fixo de ' + SIMULADOR_SPREAD + '% para o cálculo da PRIMEIRA parcela. ' +
        'Esta parcela VAI VARIAR ao longo do empréstimo.\n\nQual é a tua idade?';
      await sendText(instanceName, remoteJid, intro);
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      if (lead.estado_docs !== 'docs_enviados') {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      } else {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora' });
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
      );
      await sendText(instanceName, remoteJid, uploadLink);
      return;
    }
    return;
  }

  // Se o lead está no fluxo do simulador, permitir sair com DUVIDA ou GESTORA em qualquer momento
  {
    const simState = await db.getSimuladorState(lead.id);
    if (simState) {
      if (isCommand(text, CMD_DUVIDA)) {
        await db.clearSimuladorState(lead.id);
        await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
        await sendText(
          instanceName,
          remoteJid,
          'Perfeito, pode me perguntar e eu encaminho para as nossas gestoras especialistas no assunto'
        );
        return;
      }
      if (isCommand(text, CMD_GESTORA)) {
        await db.clearSimuladorState(lead.id);
        if (lead.estado_docs !== 'docs_enviados') {
          await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
        } else {
          await db.updateLeadState(lead.id, { conversa: 'com_gestora' });
        }
        const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
        await sendText(
          instanceName,
          remoteJid,
          'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
        );
        await sendText(instanceName, remoteJid, uploadLink);
        return;
      }
      if (isCommand(text, CMD_FALAR_COM_RAFA)) {
        await db.clearSimuladorState(lead.id);
        await db.updateLeadState(lead.id, { conversa: 'em_pausa', querFalarComRafa: true });
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
      // Caso continue no simulador, delegar para o handler específico
      const inSimulador = await handleSimuladorStep(instanceName, lead.id, remoteJid, text);
      if (inSimulador) return;
    }
  }

  // Se o lead já existe e escrever "atendimento" (ou frase trigger), regressar ao menu apenas se estiver em aguardando_escolha.
  // Se estiver em com_duvida, a mensagem pode conter "crédito" (é a pergunta) — não resetar para não reenviar o menu.
  if ((lead.estado_conversa === 'aguardando_escolha' || lead.estado_conversa == null) && isTriggerPhrase(cleanText)) {
    await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha' });
    const agora = new Date();
    const hora = agora.getHours();
    let saudacaoTempo = '';
    if (hora >= 5 && hora < 12) saudacaoTempo = 'bom dia!';
    else if (hora >= 12 && hora < 18) saudacaoTempo = 'boa tarde!';
    else saudacaoTempo = 'boa noite!';
    const firstName = getFirstName(lead.nome) || getFirstName(profileName);
    const saudacaoNome = firstName
      ? `Oi ${firstName}, ${saudacaoTempo} tudo bem?\n`
      : `Oi, ${saudacaoTempo} tudo bem?\n`;
    await sendText(
      instanceName,
      remoteJid,
      `${saudacaoNome}Vou te ajudar por aqui 🙂\r\n\r\nPara começar, escreve:\r\n\r\nDUVIDA - se tens dúvidas sobre crédito habitação\r\n\r\nSIMULADOR - para simular a primeira parcela do crédito\r\n\r\nGESTORA - se queres que a gestora inicie a analise do teu caso gratuitamente\r\n\r\nFALAR COM RAFA - se precisas falar diretamente com a Rafa`
    );
    return;
  }

  // Comando SIMULADOR: inicia o fluxo em qualquer estado
  if (isCommand(text, CMD_SIMULADOR)) {
    await db.setSimuladorState(lead.id, { step: 'age' });
    const euribor = await getSimuladorEuribor();
    const intro =
      'Os valores que vou apresentar são calculados de forma aproximada, considerando a Euribor ' +
      euribor.toFixed(2) + '% e um spread fixo de ' + SIMULADOR_SPREAD + '% para o cálculo da PRIMEIRA parcela. ' +
      'Esta parcela VAI VARIAR ao longo do empréstimo.\n\nQual é a tua idade?';
    await sendText(instanceName, remoteJid, intro);
    return;
  }

  // Estados: estado_conversa (NULL | aguardando_escolha | com_duvida | com_gestora); quer_falar_com_rafa é flag separada
  if (lead.estado_conversa === 'aguardando_escolha' || lead.estado_conversa == null) {
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
      await sendText(
        instanceName,
        remoteJid,
        'Perfeito, pode me perguntar e eu encaminho para as nossas gestoras especialistas no assunto'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
      );
      await sendText(instanceName, remoteJid, uploadLink);
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, { conversa: 'em_pausa', querFalarComRafa: true });
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
      'Para continuar, escreve uma das opções exatamente assim:\nDUVIDA\nSIMULADOR\nGESTORA\nFALAR COM RAFA'
    );
    return;
  }

  // com_gestora: qualquer mensagem que não seja comando → resposta fixa (não regista dúvida)
  if (lead.estado_conversa === 'com_gestora') {
    if (isCommand(text, CMD_DUVIDA)) {
      const key = getDuvidaBufferKey(instanceName, lead.id);
      clearDuvidaBufferTimer(key);
      duvidaBufferByLead.delete(key);
      await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
      await sendText(
        instanceName,
        remoteJid,
        'Sem problema! Podes voltar a enviar as tuas dúvidas sobre crédito habitação e eu respondo por aqui.'
      );
      return;
    }
    if (isCommand(text, CMD_GESTORA)) {
      if (lead.estado_docs !== 'docs_enviados') {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
      );
      await sendText(instanceName, remoteJid, uploadLink);
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, { conversa: 'em_pausa', querFalarComRafa: true });
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
    // Qualquer outra mensagem → resposta fixa (texto conforme estado_docs só para nuance, não como condição de fluxo)
    const msgDocsEnviados =
      'Se tua duvida é sobre credito habitação escreve DUVIDA, mas se é em relação ao seu processo ou sobre envio de documentos, escreve FALAR COM RAFA que a produção vem aqui te ajudar 😊';
    const msgAguardandoDocs =
      'Se tua duvida é sobre credito habitação escreve DUVIDA, mas se é em relação a algum bug ou dificuldade para enviar os documentos, escreve FALAR COM RAFA que a produção vem aqui te ajudar 😊';
    await sendText(
      instanceName,
      remoteJid,
      lead.estado_docs === 'docs_enviados' ? msgDocsEnviados : msgAguardandoDocs
    );
    return;
  }

  if (lead.estado_conversa === 'com_duvida') {
    // DUVIDA aqui deve ser tratada como comando para iniciar uma nova pergunta,
    // não como texto da própria pergunta.
    if (isCommand(text, CMD_DUVIDA)) {
      const key = getDuvidaBufferKey(instanceName, lead.id);
      clearDuvidaBufferTimer(key);
      duvidaBufferByLead.delete(key);
      await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
      await sendText(
        instanceName,
        remoteJid,
        'Sem problema! Podes voltar a enviar as tuas dúvidas sobre crédito habitação e eu respondo por aqui.'
      );
      return;
    }

    if (isCommand(text, CMD_GESTORA)) {
      if (lead.estado_docs !== 'docs_enviados') {
        await db.updateLeadState(lead.id, { conversa: 'com_gestora', docs: 'aguardando_docs' });
      }
      const uploadLink = `${process.env.UPLOAD_BASE_URL || 'https://ia.rafaapelomundo.com'}/upload/${lead.id}`;
      await sendText(
        instanceName,
        remoteJid,
        'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
      );
      await sendText(instanceName, remoteJid, uploadLink);
      return;
    }
    if (isCommand(text, CMD_FALAR_COM_RAFA)) {
      await db.updateLeadState(lead.id, { conversa: 'em_pausa', querFalarComRafa: true });
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

    let textToAnalyze = text;
    if (lead.estado_conversa === 'com_duvida') {
      if (!hasQuestionMark(text)) {
        pushDuvidaBuffer(instanceName, lead.id, text);
        scheduleDuvidaBufferReminder(instanceName, lead.id, remoteJid);
        return;
      }
      textToAnalyze = consumeDuvidaBuffer(instanceName, lead.id, text) || text.trim();
      if (!textToAnalyze) return;
      // Se ficou só "?" (ex.: buffer vazio noutro processo) ou texto muito curto, pedir a pergunta de novo
      const trimmed = textToAnalyze.replace(/[\u003F\uFF1F\s]/g, '').trim();
      if (trimmed.length < 10) {
        await sendText(
          instanceName,
          remoteJid,
          'Não recebi a tua pergunta. Escreve-a por completo numa mensagem (podes terminar com ?) e eu encaminho para as gestoras.'
        );
        return;
      }
      if (isGreeting(textToAnalyze)) {
        await sendText(instanceName, remoteJid, GREETING_RESPONSE);
        return;
      }
    }

    const leadKey = String(lead.id);
    aiQuestionCountByLead[leadKey] = (aiQuestionCountByLead[leadKey] || 0) + 1;
    if (aiQuestionCountByLead[leadKey] > 20) {
      await sendText(
        instanceName,
        remoteJid,
        'Chegaste ao limite de 20 perguntas com a Joana 😊\n\nA partir daqui, escreve GESTORA para falar com a gestora e iniciar a análise do teu caso, ou FALAR COM RAFA se precisares falar diretamente com a Rafa.'
      );
      return;
    }

    await answerWithFAQ(lead, textToAnalyze, instanceName);
    return;
  }

  if (lead.quer_falar_com_rafa) {
    // Lead está na lista da Rafa; continua a poder usar DUVIDA/GESTORA; "boa sorte!" desativa a flag (mensagem fromMe)
    if (isCommand(text, CMD_DUVIDA)) {
      await db.updateLeadState(lead.id, { conversa: 'com_duvida' });
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
        'Ótimo! Para que a gestora inicie a análise do seu caso, você precisa enviar alguns documentos. Esses documentos podem ser enviados diretamente para ela através dessa plataforma:'
      );
      await sendText(instanceName, remoteJid, uploadLink);
      return;
    }
  }
}

// Quando a Rafa/admin envia "Boa sorte!" para o lead (mensagem fromMe), volta ao aguardando_escolha e remove flag
async function handleOutgoingBoaSorte(remoteJid, text, instanceName) {
  if (!remoteJid || !isBoaSorteMessage(text)) return;
  const lead = await db.findLeadByWhatsapp(remoteJid);
  if (!lead) return;
  await db.updateLeadState(lead.id, { conversa: 'aguardando_escolha', querFalarComRafa: false });
  console.log(`[evo] Lead ${lead.id} (${remoteJid}): "Boa sorte!" → aguardando_escolha, quer_falar_com_rafa = 0`);
}

// Quando o admin envia "pausar" para o lead (mensagem fromMe), coloca o lead em em_pausa
async function handleOutgoingPausar(remoteJid, text, instanceName) {
  if (!remoteJid || !isPausarMessage(text)) return;
  const lead = await db.findLeadByWhatsapp(remoteJid);
  if (!lead) return;
  await db.updateLeadState(lead.id, { conversa: 'em_pausa' });
  console.log(`[evo] Lead ${lead.id} (${remoteJid}): admin "pausar" → estado_conversa = em_pausa`);
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
      handleOutgoingPausar(jid, text, instanceName).catch((err) =>
        console.error('handleOutgoingPausar:', err)
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
        handleOutgoingPausar(remoteJid, text, instanceName).catch((err) =>
          console.error('handleOutgoingPausar:', err)
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
  setInterval(processBoasVindasQueue, 12 * 1000);
});
