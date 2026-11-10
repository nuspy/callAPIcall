# Gateway API Server — Full Agent Architecture

## Problema

Il phone server (`hermes_phone_server.py`) chiama direttamente l'LLM — è un modello "nudo" senza skills, tools avanzati, memoria, o ricerca web intelligente. Solo 3 tool basilari (web search DDG, exchange rate, crypto).

Quando l'utente usa F1/F2/F3 con `acp_enabled: false` e `hermes_mode: "http"`, TUTTE le funzioni puntano al phone server limitato. Le risposte sono "stupide" rispetto a una chat Telegram con Hermes.

## Soluzione: Gateway API Server (Opzione A — consigliata)

Il gateway Hermes espone un **API server** OpenAI-compatible su `:8642` con `/v1/chat/completions`. Questo endpoint ha **tutti gli 106 skill, tools, memoria, web search** caricati — identico a una chat Telegram.

### Setup

1. **Abilitare l'API server nel gateway**:
   ```bash
   # In ~/.hermes/.env o come env var:
   export API_SERVER_ENABLED=true
   # Opzionale: API_SERVER_PORT=8642 (default), API_SERVER_HOST=127.0.0.1
   # Opzionale: API_SERVER_KEY=<secret> per autenticazione
   ```

2. **Modificare `config.json` del call-bridge**:
   ```json
   {
     "hermes_base_url": "http://127.0.0.1:8642/v1",
     "hermes_mode": "http",
     "acp_enabled": false
   }
   ```

3. Il phone server (o direttamente `HermesClient`) invia richieste al gateway
4. Il gateway processa con l'agente completo — skills, tools, memoria

### Architettura risultante

```
F1/F2/F3 → HermesClient (HTTP) → Gateway :8642 /v1/chat/completions
  → AIAgent (run_agent.py) con tutti i tools
    → skill loading automatico
    → web_search, terminal, file, browser, ...
    → memoria persistente
    → risposta streaming SSE
```

## Soluzione: ACP (Opzione B — già implementata)

```json
{
  "acp_enabled": true
}
```

- F1/F2 usano `AcpAgentClient` → lancia `hermes acp` via stdio
- F3 rimane sul phone server limitato
- Svantaggi: startup ~90s, più fragile, dipende da WSL distro config

## Config corrente (da aggiornare)

```json
{
  "hermes_mode": "http",
  "acp_enabled": false,
  "hermes_base_url": "http://127.0.0.1:8780"
}
```

→ Tutto punta al phone server nudo. Nessun skill/tool avanzato.

## Codice rilevante

- `gateway/platforms/api_server.py` — API server platform adapter
- `acp_client.py` — ACP client (alternativa)
- `main.py` righe 86-113 — selezione brain_full/brain_limited
- `ptt.py` riga 37 — `brain_full` (ACP) vs `brain_limited` (HTTP)

## Gateway API Server — dettagli tecnici

Il server espone:
- `POST /v1/chat/completions` — OpenAI Chat Completions (streaming SSE)
- `POST /v1/responses` — OpenAI Responses API (stateful)
- `GET /v1/models` — lista modelli disponibili
- `GET /health` — health check

Abilitato da env var:
- `API_SERVER_ENABLED=true` — on/off
- `API_SERVER_KEY` — Bearer auth (opzionale)
- `API_SERVER_PORT` — default 8642
- `API_SERVER_HOST` — default 127.0.0.1
- `API_SERVER_CORS_ORIGINS` — CORS (opzionale)

Vedi `gateway/config.py` righe 1522+ per la risoluzione config.
