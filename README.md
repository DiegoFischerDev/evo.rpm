# Evo – evo.rafaapelomundo.com

App para receber mensagens do WhatsApp via **Evolution API**, processar com **OpenAI** e responder pelo WhatsApp.

## Estrutura

- `server.js` – Express, webhook `/webhook/evolution`, health `/api/health`
- `public/index.html` – Página inicial

## Repositório Git

- GitHub: **DiegoFischerDev/evo** (criar o repo e conectar)

## Deploy na Hostinger

- **Subdomínio:** evo.rafaapelomundo.com
- **Framework:** Express
- **Diretório raiz:** `./`
- **Comando de início:** `npm start`
- **Node:** 18.x
- Código em **CommonJS** (compatível com lsnode da Hostinger)

## Rodar localmente

```bash
npm install
npm start
```

Abre http://localhost:3000

## Próximos passos (app real)

1. Configurar webhook na Evolution API para `https://evo.rafaapelomundo.com/webhook/evolution`
2. Implementar parsing do payload Evolution + chamada OpenAI + envio de resposta
3. Variáveis de ambiente: `EVOLUTION_API_URL`, `EVOLUTION_API_KEY`, `OPENAI_API_KEY`
