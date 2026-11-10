# Phone Server Tool-Calling Strategies

Il phone server (`hermes_phone_server.py`) usa 3 strategie in cascata per permettere al modello LLM di accedere a dati esterni (web search, exchange rates, crypto).

## Strategia 1: Tool-calling nativo OpenAI

Per modelli che supportano `tools=` nell'API (glm-5.1, GPT-4, Claude via OpenAI-compatible endpoint).

```python
response = client.chat.completions.create(
    model=model,
    messages=messages,
    tools=TOOL_DEFINITIONS,
    tool_choice="auto",
)
# Se response.choices[0].finish_reason == "tool_calls":
#   → esegui i tools → seconda chiamata con role:"tool" → risposta finale
```

**Modelli compatibili**: glm-5.1 (Z.AI), GPT-4, qualsiasi modello con `tool_choice` support.

## Strategia 1.5: Text-based [TOOL_REQUEST] parsing

Per modelli locali che NON supportano tool-calling nativo ma generano testo con un formato strutturato.

Il modello genera: `[TOOL_REQUEST]{"name":"web_search","arguments":{"query":"..."}}[END_TOOL_REQUEST]`

Il server:
1. Raccoglie il testo completo (non streaming per questo turno)
2. Pattern-match `[TOOL_REQUEST]...[END_TOOL_REQUEST]` con regex
3. Parse JSON → esegui tool → inietta risultati come `role: "user"` message
4. Seconda chiamata: il modello risponde con i dati reali

**Modelli che usano questo**: qwen3.5 su LM Studio (nessun supporto tool-calling nativo).

## Strategia 2: Pre-search injection (fallback)

Se entrambe le strategie sopra falliscono o non sono applicabili:

1. `_needs_search(text)` decide se cercare (euristica aggressiva: cerca quasi tutto tranne saluti)
2. Se sì: `_web_search(query)` → 5 risultati DuckDuckGo
3. Risultati iniettati nel system prompt con istruzione forte
4. Singola chiamata LLM con contesto esteso

**Vantaggio**: funziona con qualsiasi modello, anche senza tool-calling.
**Svantaggio**: il modello può ignorare i risultati nel system prompt (meno affidabile).

## Tools disponibili

- `web_search` — Ricerca web DuckDuckGo (5 risultati, timeout 8s) via `ddgs`
- `get_exchange_rate` — Tassi di cambio in tempo reale da `open.er-api.com` (free)
- `get_crypto_price` — Prezzi crypto da `api.coingecko.com` (free)

## Libreria DuckDuckGo: `ddgs`

```bash
# ✅ CORRETTO (nuovo):
pip install ddgs
from ddgs import DDGS

# ❌ DEPRECATO (restituisce 0 risultati silenziosamente):
pip install duckduckgo-search  # RINOMINATO in ddgs!
from duckduckgo_search import DDGS  # RuntimeWarning + 0 risultati
```

Il phone server tenta entrambi gli import con fallback.

## Risoluzione dinamica del modello

`_get_active_client()` legge `~/.hermes/config.yaml` ad ogni richiesta (non all'avvio).
Se l'utente cambia modello nel config, il phone server segue senza restart.

La funzione ritorna `(OpenAI client, model_name)` — usata in tutte le strategie.

## _delta_text() — Fallback content/reasoning_content

glm-5.1 (Z.AI) può restituire il testo in `reasoning_content` invece di `content`, anche con `thinking: disabled`. Il phone server usa `_delta_text(chunk)` ovunque:

```python
def _delta_text(chunk) -> str:
    if not chunk.choices:
        return ""
    delta = chunk.choices[0].delta
    token = getattr(delta, "content", None) or ""
    if not token:
        token = getattr(delta, "reasoning_content", None) or ""
    return token
```

Analogamente per le risposte non-streaming:
```python
text = msg.content or getattr(msg, "reasoning_content", None) or ""
```

Questo previene il problema "risposta vuota / voce muta" con glm-5.1.

## Ordinamento post-TTS — 4-Phase Audio Flow

Il sistema usa 3 eventi (`_processing`, `_listening`, `_tts_active`) per gestire la transizione parlato→ascolto in half-duplex. Il finally del `_brain` esegue:

1. **FASE 1**: `_wait_tts_finished()` — aspetta che la coda TTS sia vuota per 1.0s (`quiet` param). `_processing=SET`, `_listening=CLEAR` → mic completamente MUTO.
2. **FASE 2**: `time.sleep(ptt_post_tts_pause_s)` (1.0s) — mic ancora MUTO. Aspetta che l'eco fisico si spenga dalle casse (il buffer sounddevice ha 200-500ms di ritardo).
3. **FASE 3**: `_processing.clear()` + `time.sleep(ptt_listen_warmup_s)` (0.8s) — mic ATTIVO (audio allo STT per calibrazione rumore), brain SCARTA enunciati (`_listening=CLEAR`). Poi svuota coda enunciati warmup.
4. **FASE 4**: `_listening.set()` — brain accetta enunciati. Ascolto attivo.

**Totale protezione**: ~2.8s tra l'ultimo chunk TTS e il primo enunciato accettato. Se il sistema si auto-interrompe ancora, aumentare `ptt_post_tts_pause_s` e/o `ptt_listen_warmup_s` nel config.
