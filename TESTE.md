# Testar ligação WhatsApp ↔ Evolution ↔ Evo

Seguir por ordem. Se algo falhar, para aí e corrige antes de avançar.

---

## 1. Ligar a instância "Joana" ao WhatsApp (QR code)

**Sem este passo, a Evolution não recebe nem envia mensagens.**

1. No browser ou com `curl`, abre (substitui pela tua apikey):

   ```
   GET http://72.60.45.216:8080/instance/connect/Joana
   Header: apikey: Raf@@pelomundo645061
   ```

   Exemplo no browser: não dá para enviar o header fácil. Usa antes no terminal:

   ```bash
   curl -H "apikey: Raf@@pelomundo645061" "http://72.60.45.216:8080/instance/connect/Joana"
   ```

2. A resposta deve trazer um **QR code** (por exemplo em base64 ou URL).  
   Se tiveres uma UI (ex.: front da Evolution), abre a página que mostra o QR

3. No **WhatsApp** (telemóvel):  
   **Definições → Aparelhos ligados → Ligar um aparelho**  
   Escaneia o QR code que a Evolution mostrou.

4. Depois de escanear, a instância "Joana" fica ligada ao teu número. Só a partir daqui é que recebes/envias mensagens por essa instância.

---

## 2. Ver estado da ligação (Evolution)

```bash
curl -H "apikey: Raf@@pelomundo645061" "http://72.60.45.216:8080/instance/connectionState/Joana"
```

- Se estiver ligado, a resposta deve indicar algo como `open` ou `connected`.  
- Se o path for diferente na tua versão da Evolution, consulta a doc:  
  https://doc.evolution-api.com/v2/api-reference/instance-controller/connection-state

---

## 3. Ver se o Evo está bem configurado e a falar com a Evolution

No browser (ou `curl`):

```
https://evo.rafaapelomundo.com/api/debug
```

A resposta mostra:

- Se as variáveis de ambiente estão definidas (sem mostrar chaves).
- Se o Evo consegue chegar à Evolution API e qual o estado da instância "Joana".

Se `evolution` vier com `ok: false`, o problema é rede ou URL/apikey (Hostinger → VPS 72.60.45.216:8080).

---

## 4. Ver se a Evolution consegue chamar o webhook (Evo)

A Evolution só chama `https://evo.rafaapelomundo.com/webhook/evolution` quando **recebe uma mensagem** na instância "Joana".

- Se **não escaneaste o QR** (passo 1), a instância não está ligada → não recebes mensagens → o webhook nunca é chamado.
- Se já escaneaste: envia uma mensagem **para o número** que está ligado à "Joana" (de outro telemóvel ou de outro número). O webhook deve ser chamado e o Evo responde com a IA (se o `.env` na Hostinger tiver `OPENAI_API_KEY`).

Para confirmar que o webhook existe e responde:

```bash
curl -X POST "https://evo.rafaapelomundo.com/webhook/evolution" \
  -H "Content-Type: application/json" \
  -d '{}'
```

Deve devolver `OK` (200). Isto não simula uma mensagem real, só confirma que a rota existe.

---

## Resumo

| Onde falha | O que verificar |
|------------|------------------|
| Nunca escanei QR | Fazer **passo 1** – sem isso a "Joana" não está ligada ao WhatsApp. |
| Evolution não responde | VPS a correr? Porta 8080 aberta? URL e apikey corretas no Evo? |
| Evo não recebe webhook | Evolution só chama o webhook quando **recebe** uma mensagem; instância tem de estar ligada (QR). |
| Evo não responde no WhatsApp | Ver `/api/debug` (Evolution URL/apikey, estado da instância) e logs do Evo na Hostinger. |

Depois de o QR estar escaneado e o `/api/debug` mostrar `evolution.ok: true` e estado ligado, envia uma mensagem para o número da "Joana" e a resposta da IA deve aparecer no WhatsApp.

---

## 5. Troubleshooting Evolution API

### Restart da instância (404 "Cannot GET /instance/restart/...")

O endpoint de **restart** na Evolution API é **PUT**, não GET. Se usares GET recebes 404.

**Correto:**

```bash
curl -X PUT -H "apikey: Raf@@pelomundo645061" "http://72.60.45.216:8080/instance/restart/DiegoWoo"
```

Resposta esperada: `{"instance":{"instanceName":"DiegoWoo","state":"open"}}` (ou similar).

Doc: https://doc.evolution-api.com/v1/api-reference/instance-controller/restart-instance

### Mensagens não são enviadas

Se o `fetchInstances` mostra a instância com `connectionStatus: "open"` mas as mensagens não saem:

1. **API key** – O Evo envia o header `apikey` em todas as chamadas. Confirma que `EVOLUTION_API_KEY` no `.env` do Evo é exatamente a mesma que a Evolution espera.
2. **URL base** – Sem barra no fim: `http://72.60.45.216:8080` (não `...8080/`).
3. **Nome da instância** – `EVOLUTION_INSTANCE` no Evo tem de ser exatamente o nome devolvido pela Evolution (ex.: `DiegoWoo`).
4. **Ver erro da Evolution** – Testar envio manual para ver a resposta:
   ```bash
   curl -X POST "http://72.60.45.216:8080/message/sendText/DiegoWoo" \
     -H "Content-Type: application/json" \
     -H "apikey: TUA_API_KEY" \
     -d '{"number":"351912345678","text":"Teste"}'
   ```
   Se a tua Evolution for v1, o path pode ser diferente (ex.: `/api/sendText` ou com prefixo). Consulta a doc da versão que tens instalada.
5. **Logs do Evo** – Em caso de falha no envio, o Evo regista erro no log (ou no PM2). Ver stdout/stderr do processo ao enviar uma mensagem.

### Ver logs da Evolution API (no VPS)

Conecta-te por **SSH** ao VPS (72.60.45.216) e usa os comandos conforme instalaste a Evolution:

**Se instalaste com Docker:**

```bash
# Listar contentores (ver o nome do da Evolution)
docker ps

# Ver logs em tempo real (substitui evolution-api ou o nome do contentor)
docker logs -f evolution-api

# Ou pelo ID
docker logs -f <container_id>
```

**Se instalaste com PM2:**

```bash
# Listar processos
pm2 list

# Logs em tempo real (substitui o nome do processo se for diferente)
pm2 logs evolution
# ou
pm2 logs
```

**Se corres com `npm start` ou `node` diretamente:**  
Os logs saem no terminal onde executaste. Se usas `nohup` ou `screen`, estão no ficheiro que redirecionaste (ex.: `nohup.out`).

**Útil:** Para mais detalhe da ligação WhatsApp (Baileys), define no ambiente da Evolution:  
`LOG_LEVEL=DEBUG` e/ou `LOG_BAILEYS=debug`. Reinicia a Evolution e volta a ver os logs.
