# Piano — Modalità voce near-real-time su LM Studio + memoria/personalità per-avatar

## Context

Oggi le sessioni voce/avatar (Ctrl+Shift+F1/F2) parlano con l'agente **Hermes** (via ACP), che gestisce internamente compattazione del contesto e memoria. Serve una **nuova modalità non-agentica near-real-time** (Ctrl+Shift+**F4** half-duplex / **F5** full-duplex) che si colleghi **direttamente a LM Studio** (API OpenAI-compatibile), per conversazioni più immediate. Eliminando Hermes dal percorso, dobbiamo ricreare noi le due cose di cui si occupava: **compattazione del contesto** e **memoria persistente**. Inoltre l'utente vuole che ogni **avatar** abbia **personalità e sapere propri**, acquisibili da **documenti/libri** (anche via OCR), con **continuità di ricordi tra sessioni** (tenendo conto del tempo trascorso). Test di accettazione finale: **importare libri su/di Giulio Cesare e conversare come Giulio Cesare**.

Decisioni utente confermate: memoria = **wikibridge + recall semantico + knowledge graph** (near-real-time preservato separando acquisizione da conversazione); avatar F4/F5 = **quello globale** (`cfg.avatar_persona`, come F1/F2); personalità = **dalla wiki**, con **editor GUI a dialog** + **pipeline documenti→personalità** (chunked, multi-formato, OCR locale). **OCR via API/cloud (Mistral OCR) escluso**: solo PaddleOCR locale.

## Principio architetturale (near-real-time)

**Separare ACQUISIZIONE (offline, pesante) da CONVERSAZIONE (hot-path, veloce).** Nulla di rete/grafo sta sul turno.
- **Acquisizione** (offline): documenti → OCR se serve → chunking → estrazione LLM a blocchi → popola wiki (umana) + vettore (semantico) + grafo (relazioni/tempo).
- **Conversazione**: inizio sessione = carica profilo+personalità locali (istantaneo); per-battuta = **una** ricerca vettoriale locale (~10-50ms, in parallelo allo STT) → RAG all'LLM; il grafo si interroga di rado (inizio sessione), non ogni turno.

## Stack memoria (decisione)

| Livello | Cosa | Ruolo | Hot-path? |
|---|---|---|---|
| **Tier 0** — `avatar/persone/<n>/memory.json` | profilo compatto locale (last_seen_ts, rolling_profile, recent_sessions, stats) | continuità F5, caricato a inizio sessione | **sì** (locale, istantaneo) |
| **Tier 1** — wikibridge (progetto per-avatar) | wiki editabile (personalità, sapere, archivio conversazioni) + FTS5 | F6 GUI + fonte editabile + storico | no (async a fine sessione) |
| **Tier 2** — **cognee** (self-hosted locale) | vettore + knowledge graph sul corpus dell'avatar | recall semantico (Mem0-like) **+** grafo (Graphiti-like) in un unico motore | retrieval vettoriale sì (veloce); grafo no |

**cognee unifica** il recall semantico e il knowledge graph richiesti (evita di gestire Mem0 e Graphiti separatamente). Alternativa più leggera se cognee risultasse troppo pesante: indice embeddings locale (`sqlite-vec` + sentence-transformers) per il solo recall, rimandando il grafo. La compattazione in-sessione NON usa vettori (vedi F2).

## Funzioni

- **F1** — Brain `LmStudioClient` + hotkey Ctrl+Shift+F4/F5 → conversazione streaming diretta LM Studio, non-agentica, stesso avatar di F1/F2.
- **F2** — Compattazione: sliding window + rolling summary in background (call diretta a LM Studio), niente blocco del turno.
- **F3/F5** — Memoria per-avatar: flush a fine sessione (profilo locale + archivio wiki), load a inizio sessione (personalità + profilo + "ci siamo sentiti N giorni fa").
- **F6** — GUI: editor personalità (dialog) + ingest sapere per-avatar (riuso KnowledgeSection) + config LM Studio.
- **F7** (nuovo) — Pipeline documenti/libri → personalità+sapere: multi-formato, OCR locale (PaddleOCR), chunking, estrazione LLM classificata, popola i tre livelli.

## Dettagli implementativi chiave (verificati dall'esplorazione)

**Brain duck-typed** (`streaming.py`): obbligatorio solo `respond(text)->Iterator[str|dict]`. Opzionali via getattr: `set_reply_language`, `reset_session`, `prime`, `warm_up`, `end`. `AvatarPushToTalkSession` accetta qualsiasi brain → **nessuna nuova classe di sessione**.

**`LmStudioClient`** (nuovo `call-bridge/callbridge/lmstudio_client.py`): **stateful in-process** (LM Studio è stateless). Client `OpenAI(base_url=cfg.lmstudio_base_url, api_key=cfg.lmstudio_api_key)`; `_delta_text` clonato da `hermes_phone_server.py:172` **MA senza pronunciare `reasoning_content`** (no chain-of-thought nel TTS). History sotto `threading.Lock` (respond + compaction concorrenti). Nuovo hook **`begin_session(persona)`** (sincrono, prima del thread sessione): resetta la history, carica memoria, compone system prompt. `prime` = no-op (il `voice_session_init` è per l'agente ACP, non deve contaminare il system prompt persona).

**Tre fix di wiring obbligatori** (verificati nel codice):
1. **`end()` non è cablato genericamente** — in `ptt.py:_start_session_reserved` `session_end` è valorizzato solo per `HermesClient`. Fix: `session_end = session_end or getattr(hermes_obj, "end", None)` → senza, la memoria non viene mai flushata.
2. **persona non arriva al brain** — aggiungere hook sincrono `getattr(hermes_obj,"begin_session",None)(persona)` prima di avviare il thread sessione.
3. **collisione Ctrl+Shift+F4 ↔ Shift+F4 copilota** — pynput non fa match esatto dei modificatori (commento in `ptt.py:_ctrl_down`): Ctrl+Shift+F4 fa scattare **anche** la callback copilota Shift+F4 (oggi senza guard). Fix: avvolgere la callback copilota con `None if _ctrl_down() else ...`.

**Compattazione F2**: dopo `respond()`, se stima token > soglia, un **thread daemon** riassume la porzione più vecchia con **una call diretta a LM Studio** (prompt dedicato, NON `analyze_transcript` che passa da ACP e reintrodurrebbe Hermes), poi sotto lock sostituisce quei messaggi con un system message "Riassunto finora: …". Ultimi N turni verbatim. Token: `stream_options={"include_usage":true}` (LM Studio recenti lo onorano) con fallback euristico `len(serialized)/4` (no tiktoken).

**Memoria F3/F5**: `end()` = reconcile locale (1 call LM Studio che fonde profilo+nuova conversazione) + `push_meeting` async al `knowledge_project` dell'avatar (riuso pattern `copilot.py:save_meeting_async:585`). `begin_session` legge `memory.json` (istantaneo), calcola delta temporale da `last_seen_ts`, compone system prompt (personalità dalla wiki + profilo + "ci siamo sentiti N giorni fa"). wikibridge spento = hot-path indifferente (Tier 0 locale); Tier 1/2 falliscono grazioso.

**Persona↔progetto**: nuovo campo manifest `knowledge_project` (slug validato con `is_safe_artifact_id`), auto-creato alla creazione persona (`POST /projects` wikibridge). `personas_update`/`personas_create` (`api_personas.py`) oggi filtrano solo `voice` → propagare i nuovi campi (`personality`, `system_prompt`, `knowledge_project`).

**F7 — pipeline documenti→personalità** (nuovo modulo, es. `call-bridge/callbridge/persona_ingest.py`, eseguito offline/async):
1. **Estrazione testo per formato**: testuali (PDF/EPUB/DOCX/TXT/MD) → markitdown (già in wikibridge). Scansioni/immagini → **PaddleOCR locale** (Baidu, open-source, offline). *Mistral OCR / OCR via cloud esclusi per scelta utente.*
2. **Chunking a blocchi** (documento dopo documento; blocchi ~2-4k token con overlap) — necessario per libri lunghi.
3. **Estrazione LLM map-reduce** (via LM Studio) per blocco → classifica in: linguaggio/espressioni tipiche, tratti di personalità, valori, contesto storico/ambientale, eventi, fatti. Reduce → (a) **profilo personalità / system prompt** in-persona, (b) **base di conoscenza** (fatti+citazioni) per RAG.
4. **Popola i tre livelli**: pagine wiki classificate (wikibridge `/ingest` + sezioni), embeddings+grafo (cognee `cognify`), e aggiorna la personalità della persona.
5. **Retrieval a conversazione**: per-battuta, `cognee.search` vettoriale (top-K) → contesto RAG all'LLM; a inizio sessione, sintesi profilo dal grafo/wiki.

**GUI F6**: `PersonasSection.tsx` estesa con dialog **editor personalità/system_prompt**, select `knowledge_project`, e pannello ingest che riusa `KnowledgeSection.tsx` puntato al progetto della persona (upload libri/documenti; PaddleOCR locale automatico per gli scansionati); auto-create progetto alla creazione persona. Card **config LM Studio** (base_url/model/system_prompt/soglia compattazione) sul pattern della card setup in `SessionSection.tsx`.

## Fasi (con verifica end-to-end)

| Fase | Contenuto | Verifica |
|---|---|---|
| **0 — Config** | Nuovi campi in `config.py`+`config.json`: hotkey F4/F5, `lmstudio_*` (base_url/model/api_key/system_prompt/soglia/window), niente comportamento | il bridge parte, campi leggibili |
| **1 — MVP voce (F1)** | `lmstudio_client.py` (respond/set_reply_language/reset_session/warm_up), `make_lmstudio_brain` in `brains.py`, hotkey F4/F5 in `ptt.py` (+fix guard copilota), wiring `main.py`/`control_server.py`/`api_session.py` | F4 apre sessione → parlato → risposta streaming LM Studio → TTS/avatar; niente CoT parlato; reset vocale ok; F4 non apre più il copilota |
| **2 — Compattazione (F2)** | stima token + trigger soglia + thread rolling summary + sliding window in `lmstudio_client.py` | conversazione lunga resta coerente, latenza per-turno invariata |
| **3 — Memoria per-avatar (F3/F5)** | `begin_session`/`end` + `memory.json` + hook sincroni in `ptt.py` + `push_meeting` async | due sessioni stessa persona continuano il discorso; compare "N giorni fa"; meeting nel wiki della persona |
| **4 — GUI (F6)** | `PersonasSection.tsx` (dialog personalità, select progetto, ingest), auto-create progetto, propagazione manifest in `api_personas.py`, card config LM Studio | crea persona da GUI → progetto creato → edita personalità → sessione F4 la usa |
| **5 — Ingest documenti→personalità (F7)** | `persona_ingest.py` (markitdown + PaddleOCR locale, chunking, estrazione LLM classificata) + store vettoriale/`cognee` + retrieval RAG per-battuta | importa un libro → pagine wiki classificate + recall semantico funzionante |
| **6 — Knowledge graph (cognee)** | `cognify` sul corpus per grafo/tempo; interrogazione a inizio sessione | domande strutturate/temporali migliori |
| **ACCETTAZIONE** | dopo Fase 5 (grafo Fase 6 è additivo) | **importa libri su/di Giulio Cesare → conversazione in-persona come Giulio Cesare, con fatti corretti dal RAG** |

## File critici

- `call-bridge/callbridge/lmstudio_client.py` — **nuovo**: brain, compattazione, begin_session/end, retrieval RAG
- `call-bridge/callbridge/persona_ingest.py` — **nuovo**: pipeline documenti→personalità (OCR/chunking/estrazione)
- `call-bridge/callbridge/ptt.py` — hotkey F4/F5, fix guard copilota, hook begin_session/end
- `call-bridge/callbridge/brains.py` — `make_lmstudio_brain`
- `call-bridge/callbridge/api_personas.py` — propagazione manifest (personality/system_prompt/knowledge_project) + auto-create progetto
- `call-bridge/callbridge/knowledge_client.py` — `push_meeting`/`project_preamble` per Tier-1
- `call-bridge/callbridge/config.py` + `config.json` — nuovi campi
- `gui/src/components/sections/PersonasSection.tsx` — editor personalità + ingest + config
- Pattern da imitare (non modificare): `hermes_phone_server.py` (streaming OpenAI + `_delta_text`), `copilot.py:585` (`save_meeting_async`), `analysis.py:150` (`analyze_transcript` per il Tier-1)
- Nuove dipendenze: `paddleocr` (OCR locale), `cognee` (Fase 5-6) o fallback `sqlite-vec`+`sentence-transformers`. **No Mistral OCR / no OCR via cloud.**

## Rischi/gotcha (dall'analisi)

1. **CoT nel TTS** — non pronunciare `reasoning_content`; per modelli reasoning disabilitare il thinking (`extra_body`) o usare instruct. Riassunti/reconcile usano solo il testo parlato.
2. **Avatar `stream_tts=False`** — la risposta è accumulata prima del lip-sync: primo audio dopo la generazione completa. OK per risposte brevi; streaming per-frase = cambio invasivo, non in Fase 1.
3. **Brain stateful riusato** — `begin_session` DEVE azzerare la history; lock per respond+compaction.
4. **cognee pesante** — se troppo, ripiego su `sqlite-vec` (in-process) per il solo recall, grafo rimandato.
5. **wikibridge/OCR/cognee spenti** — hot-path locale indifferente; acquisizione e Tier-1/2 falliscono grazioso.
6. **slug non sicuro** — validare `knowledge_project` con `is_safe_artifact_id`.
7. **token usage non garantita** — verificare `stream_options.include_usage` sulla build LM Studio; fallback euristico.
8. **near-real-time vs qualità recall** — retrieval per-battuta in parallelo allo STT; se rallenta, cache/limit top-K.

## Ricerca di supporto (fonti)

**Compattazione contesto**: rolling summary (converged), observation masking (~metà costo, pari solve-rate — studio JetBrains), zone-based pruning, "context rot"/"lost-in-the-middle" (‑30% su info sepolte → compattare presto). Pattern claude-mem: capture→compress(fine sessione)→inject(inizio sessione) con SQLite+FTS5+Chroma.

**Memoria agenti**: Mem0 (vector, drop-in, OSS solo vector), Zep/Graphiti (grafo temporale, +15pt LongMemEval, self-host Graphiti/Neo4j), Letta/MemGPT (OS-tiered, LM Studio nativo ma **agentico** = escluso per il vincolo non-agentico), **cognee** (grafo+vector ibrido self-hosted, "cognify", 14 retrieval → scelto perché unifica recall+grafo).

**OCR**: markitdown (testo, no OCR) per PDF/EPUB testuali; **PaddleOCR** (Baidu, open-source, locale/offline) per scansioni. Mistral OCR (API cloud) **escluso** su richiesta.

**Estrazione personalità**: map-reduce LLM su chunk → tratti/valori/espressioni/eventi (framework tipo PersonaPulse); persona come system prompt + RAG sul corpus per fatti in-carattere.
