# Piano: integrare STT/TTS di Handy dentro callAPIcall (eliminazione di Handy)

## Contesto e obiettivo

Oggi callAPIcall (bridge Python) dipende da **Handy** come processo separato (app Tauri/Rust,
server axum su `127.0.0.1:8720`) per STT e TTS. Il bridge lo chiama via HTTP (`/models/*`,
`/tts/test`, `/transcribe`, `/health`) e WebSocket (`/stt/stream`, `/tts/stream`). Questa
dipendenza è fragile: ieri l'helper Kokoro *dentro* Handy è crashato in modo opaco e il bridge
vedeva solo "TTS non disponibile" sul WS, con la sessione che moriva e l'overlay che spariva.

Obiettivo (deciso dall'utente): **eliminare del tutto Handy**, portando STT e TTS nativi dentro
il bridge. GUI ibrida: nuovi tab solo dove le funzioni sono *additive* rispetto a callAPIcall
(gestione/download modelli, accelerazione); riuso dei tab esistenti dove la funzione è già
coerente (voci clonate → Voci; voce di default → Handy/Session).

## Fatto tecnico chiave (da cui deriva tutto il piano)

- **TTS = già Python.** I 4 motori sono `Handy/resources/{kokoro,piper,chatterbox,zonos2}_tts_helper.py`.
  Rust è solo un supervisore di subprocess (protocollo stdio binario). Portabile quasi 1:1.
  - Kokoro (`kokoro-onnx`) e Piper (`piper`) sono leggeri/puro-Python → **in-process** nel bridge.
  - Chatterbox richiede venv dedicato (torch CUDA, ~3 GB) → resta **subprocess** col suo venv.
  - ZONOS2 è Linux/WSL-only e non verificato → resta **subprocess** via WSL (opzionale, best-effort).
- **STT = Rust nativo.** Handy usa la crate `transcribe-rs` (whisper.cpp + 8 engine ONNX) + VAD
  Silero + decode/resample (symphonia/rubato), con CUDA/DirectML compilati. Questo è l'effort
  maggiore. **Parità pragmatica: si replica solo Whisper** (è il modello realmente selezionato,
  `selected_model="small"`) con `faster-whisper` (CTranslate2, GPU CUDA, niente torch). Gli engine
  esotici (Parakeet/Moonshine/…) sono fuori scope iniziale.
- **VAD Silero** = banale in Python: riuso di `silero_vad_v4.onnx` (già in Handy/resources) via
  onnxruntime, replica di `SmoothedVad(15,15,2)` a 30 ms/16 kHz.

## Architettura target: adattatori, non big-bang

Principio guida: **mantenere invariate le interfacce che il resto del bridge già usa**, cambiando
solo il backend sotto. `streaming.py`, `voice_gateway.py`, `copilot.py`, `gsm_call.py`,
`meetbot/bot.py` non vanno toccati.

1. **Engine layer nativo** (nuovo pacchetto `callbridge/engines/`):
   - `stt_engine.py` — `faster-whisper` + VAD Silero + logica streaming VAD→utterance.
   - `tts_engine.py` — dispatcher: Kokoro/Piper in-process; Chatterbox/ZONOS2 subprocess (riusa
     gli helper e il protocollo stdio esistenti, spawnati dal bridge).
   - `models.py` — registro modelli (URL/sha256/engine_type), download con progresso, cartella
     modelli, lifecycle VRAM (warm-up, idle-unload, watchdog).
   - `voices.py` — catalogo voci Kokoro, voci clonate (`models/cloned_voices/`).
2. **Adattatori a interfaccia invariata** (riscrittura interna di due file, stessa API pubblica):
   - `stt_client.py::HandySttClient` → wrappa `stt_engine` con lo **stesso** contratto:
     `start()`, `send_audio(pcm_f32_16k)`, coda `utterances` di `{text}`, `speech_events`.
   - `tts_client.py::HandyTtsClient` → wrappa `tts_engine`: `start()`, `configure(voice,lang,speed)`,
     `send_text(chunk)`, `flush()`, `end()`, coda `audio` di `TtsSegment(samples,sample_rate,generation)`,
     `bump_generation()`.
   - Così `configure_tts`, il barge-in (`bump_generation`), i thread downlink/brain/uplink restano
     identici. **Contenimento massimo del rischio.**
3. **Endpoint di controllo** (per la GUI e i proxy interni): i proxy che oggi inoltrano a Handy in
   `control_server.py`/`api_*.py` vengono ripuntati sull'engine layer locale (niente più HTTP a :8720).
   Si aggiungono al control server (:8770) gli endpoint mancanti che la GUI usa oggi in diretta verso
   Handy: `/tts/models`, `/tts/model`, `/tts/voice`, `/voices/cloned`, `/voices/clone`,
   `DELETE /voices/cloned/:name`, `/tts/test`, `/transcribe`, più `/models/{load,unload,status,available}`.

Nota transito: sul percorso caldo (PTT/chiamate) NON c'è più WebSocket loopback — le utterance e i
segmenti audio passano in-process via code, esattamente come oggi ma senza rete. Le "call a Handy"
spariscono davvero.

## Stato ambiente (probe 2026-07-23, Python 3.10 del bridge, GPU RTX 5090 / driver 610.62)
- **GIÀ installati**: `kokoro-onnx 0.5.0`, `piper-tts 1.4.2`, `soundfile 0.13.1`, `numpy 2.2.6`,
  `torch 2.11.0+cu130` (+ torchaudio). ⇒ **TTS Kokoro/Piper in-process fattibile subito, zero nuove dip.**
- **Mancante**: `ctranslate2`/`faster-whisper`. `onnxruntime 1.23.2` ha solo provider CPU/Azure (no CUDA)
  — ok per il VAD Silero (minuscolo, CPU).
- **Implicazione STT**: il 5090 è Blackwell (sm_120); CTranslate2/faster-whisper su Blackwell è a rischio
  di compatibilità. Ma **torch cu130 è già presente e gira sul 5090** ⇒ alternativa a rischio più basso =
  Whisper su torch (`transformers` `WhisperForConditionalGeneration` o `openai-whisper`), che riusa torch.
  Il de-risking deve confrontare le due strade sul 5090 e scegliere.

## Risultati de-risk Fase 0 (2026-07-23, RTX 5090 sm_120, whisper "small")
- **TTS Kokoro in-process**: OK. 11.3s di audio sintetizzati in 3.33s con `kokoro-onnx` (già installato),
  puntando ai modelli esistenti. ⇒ TTS nativo confermato senza Handy né nuove dipendenze.
- **STT `openai-whisper` (torch cu130, già installato)** — trascrizione PERFETTA (italiano con accenti):
  - **GPU (cuda, fp16)**: media **0.70s** per 11.3s di audio (RTF 0.06x), VRAM picco **~1.5 GB**, load 10.8s (una tantum).
  - **CPU (fp32)**: media **2.36s** (RTF 0.21x), load 1.3s.
  - **GPU ≈ 3.4x più veloce della CPU**; entrambe ben sotto il realtime ⇒ **distribuibile anche senza GPU**.
- **Scelta engine STT**: `openai-whisper`/torch funziona SUBITO su Blackwell (5090) senza installare CT2 →
  si evita il rischio faster-whisper/Blackwell. `faster-whisper` resta un'ottimizzazione CPU futura opzionale.
- **GPU memory dedicata vs shared**: whisper small = ~1.5 GB VRAM ⇒ su qualsiasi GPU con ≥2 GB liberi la
  **dedicata è la scelta ovvia** (misurata). "Shared" (sysmem fallback WDDM) è solo un ripiego più lento per
  GPU a VRAM insufficiente e non è un flag di libreria. **Raccomandazione**: sostituire l'opzione
  shared/dedicated con un semplice switch `stt_device = cuda|cpu` (default cuda) + auto-fallback a CPU;
  su VRAM insufficiente si scende a CPU (2.36s, usabile), non a shared. Da confermare con l'utente.

## Stato build
- **Fase 0 COMPLETATA** (branch `MonolitOne`, commit iniziale): pacchetto `callbridge/engines/`
  (whisper_stt + kokoro_tts + factory), campi config, `streaming.py` via factory, `ensure_models_loaded`
  backend-aware. Default `backend=handy` (nessun impatto sul sistema live). Slice verticale round-trip
  Kokoro→whisper verificato. Prossimo: abilitare `native` in test reale (Shift+F1), poi Fase 1 (TTS
  completo) e sotto-fase Avatar/voci.

## Requisiti aggiuntivi (utente, 2026-07-23)
- **Dettatura → tastiera** (assorbire la feature core di Handy): hotkey globale → registra → VAD/fine →
  trascrivi → **inietta il testo nell'app in primo piano** (paste via clipboard `Ctrl+V` o typing). Handy
  lo fa con `bindings.transcribe` (Alt+Space nel setup attuale) + `paste_method`/`typing_tool`. In
  callAPIcall diventa: nuova hotkey PTT "dettatura" (in `ptt.py`), un iniettore di testo Windows
  (`keyboard`/`SendInput`/clipboard) e opzioni in GUI (tab Advanced/Models). NB: usa lo STESSO
  `stt_engine`, ma NON passa da Hermes — l'output è testo grezzo trascritto (con eventuale post-process).
### Decisione device/memoria (utente, 2026-07-23) — DA IMPLEMENTARE COSÌ
Implementare **tutte** le combinazioni, con **impostazioni persistenti** (in config.json del bridge):
- `stt_device = "cuda" | "cpu"` (entrambi supportati).
- `stt_gpu_memory = "shared" | "dedicated"` (attivo solo se device=cuda).
- **Default: `stt_device="cuda"`, `stt_gpu_memory="shared"`.**
- Fallback automatico a CPU se CUDA assente.

Motivazione plausibile della scelta "shared" di default: tenere il modello STT (~1.5 GB) fuori dalla
**VRAM dedicata**, che su questa macchina è contesa da avatar MuseTalk + LLM (LM Studio) + TTS.

Nota implementativa (onesta): "shared GPU memory" NON è un flag di libreria. Vie realistiche, da validare
in Fase 2 con benchmark reale (dedicata vs shared vs cpu):
1. **CUDA Unified/Managed Memory** (`cudaMallocManaged`) via allocatore torch pluggable
   (`torch.cuda.memory.CUDAPluggableAllocator`) → le pagine possono risiedere in host RAM e migrare;
   è la mappatura più fedele a "modello in shared". Complesso su Windows ma fattibile.
2. **CUDA Sysmem Fallback Policy** del driver NVIDIA (per-app via NVAPI) impostata su "Prefer Sysmem
   Fallback": sposta in shared su pressione VRAM.
Se la latenza "shared" risultasse molto peggiore della dedicata, riporto i numeri; il default resta
GPU+shared come deciso salvo tua revisione. Compute type: `float16` (cuda) / `int8` o `float32` (cpu).

## Fasi

### Fase 0 — De-risking + scaffolding (prima di tutto)
- **STT (rischio n.1)**: provare SUL 5090, con un WAV noto, sia `faster-whisper(cuda)` sia Whisper-torch
  (`transformers`/`openai-whisper`); scegliere per qualità/latenza/compatibilità Blackwell. Non c'è STT
  nativo finché una delle due non è verificata.
- Creare `callbridge/engines/` (pacchetto + probe capacità già fatto: GPU, provider onnxruntime).
- Dipendenze: TTS **nessuna** (kokoro-onnx/piper già presenti). STT: `faster-whisper` **oppure**
  `transformers`/`openai-whisper` a seconda dell'esito. Chatterbox/ZONOS2: nessuna nuova dip (venv propri).
- **Slice verticale**: STT scelto + TTS Kokoro in-process SOLO per una sessione PTT, dietro flag di config
  `stt_backend`/`tts_backend = "native"|"handy"` (default `handy`). Shift+F1 end-to-end col backend nativo
  senza toccare il percorso Handy.

### Fase 1b — Avatar + voci selezionate (ATTENZIONE PRIORITARIA)
Parti più fragili della migrazione: il routing **engine↔voce** e il percorso avatar. Da trattare come
sotto-fase esplicita con test dedicati.
- **Routing engine↔voce** (`tts_engine.py`): una voce va sintetizzata dall'engine GIUSTO —
  voce Kokoro (`if_sara`, `af_heart`, …) → helper in-process Kokoro; voce **clonata** (es. `sara_clone`)
  → Chatterbox/ZONOS2 subprocess. Oggi il formato GUI è `engine:voce` (`gui/src/lib/voices.ts`) mentre in
  `config.default_voice` va SOLO il nome: il dispatcher nativo deve dedurre l'engine dalla voce
  (lookup nel catalogo Kokoro vs elenco voci clonate). Bug storico da NON riprodurre: `selected_tts_voice`
  clonata sotto engine `kokoro-voices` (vedi memoria handy-kokoro-helper-crash).
- **Voce di default Shift+F1/F2** (`config.default_voice`) e **cambio lingua** (`voice_commands.py`
  `LANG_TABLE`, `configure(voice,lang,speed)`): il backend nativo deve onorare `configure()` a runtime
  (cambio voce/lingua a metà sessione) esattamente come oggi.
- **Avatar** (`api_personas.py::/avatar/speak` → `/tts/test` → WAV → worker MuseTalk lipsync): la persona
  usa la sua voce dal manifest, spesso **clonata**. Serve: (a) sintesi batch nativa equivalente a
  `/tts/test` che ritorni WAV; (b) parità della voce clonata (Chatterbox: warm-up minuti, cache
  conditionals per-voce); (c) sample rate corretto verso il worker. Con `keep_voice` (avatar) il cambio
  lingua mantiene la voce persona → il dispatcher NON deve degradare a Kokoro.
- Test dedicati: sintesi di una voce clonata via percorso nativo; `/avatar/speak` end-to-end con lipsync;
  Shift+F1 con `default_voice` clonata e con voce Kokoro; comando "cambia lingua" durante avatar.

### Fase 1 — TTS nativo completo
- `tts_engine.py`: Kokoro + Piper in-process; Chatterbox/ZONOS2 come subprocess (riuso helper).
- Porting della logica di `model_control.rs`/`call_stream.rs` lato TTS: sentence-splitting
  frase-per-frase (`take_sentence`: split su `.!?\n` o >200 char) per streaming, warm-up al load,
  watchdog per sintesi bloccata, idle-unload 15 min, `reap` helper morti.
- `HandyTtsClient` ripuntato su `tts_engine`. Verifica: PTT, gateway, copilot, gsm.
- Voci: catalogo Kokoro (17 voci, coerente con `LANG_TABLE` in `voice_commands.py`), voci clonate
  da `models/cloned_voices/`.

### Fase 2 — STT nativo completo
- `stt_engine.py`: streaming `/stt/stream`-equivalente in-process — accumulo PCM f32 16k, VAD Silero
  smoothed → `speech_start` + fine-enunciato → `faster-whisper.transcribe()` in thread → utterance.
- `/transcribe` batch (file→testo) per `api_analysis.py` e `api_diag.py`: decode con `soundfile`/ffmpeg,
  resample 16k, transcribe.
- Selezione modello + lingua + `translate_to_english`; download modelli faster-whisper (formato CT2,
  **diverso** dai ggml di Handy → ri-scaricati da HF, es. `Systran/faster-whisper-small`).
- Accelerazione: `device`/`compute_type` (`cuda`/`float16`), scelta GPU.

### Fase 3 — Endpoint di controllo sull'engine layer
- Sostituire i proxy Handy in `control_server.py`/`api_components.py`/`api_diag.py`/`api_personas.py`/
  `api_analysis.py` con chiamate all'engine layer.
- Aggiungere gli endpoint che oggi la GUI chiama in diretta a :8720 (lista sopra) al control server.
- `models.py`: registro + download con progresso (requests + sha256 + estrazione tar), cartella
  modelli bridge-owned (es. `%LOCALAPPDATA%\callAPIcall\models`) con **import una-tantum** dei modelli
  Kokoro/voci già scaricati da Handy per non riscaricare (i whisper ggml NON sono riusabili → CT2).

### Fase 4 — GUI (ibrida, per UX)
- Ripuntare `gui/src/lib/api/handyApi.ts` dal :8720 di Handy al control server del bridge (:8770,
  con auth) — oppure fondere in `bridgeApi.ts`. Nessuna modifica Rust necessaria.
- **Riuso coerente** (nei tab esistenti):
  - *Voci*: `VoicesSection` già gestisce voci clonate + engine di cloning → resta lì.
  - *Handy → rinominare "Voce/Audio"*: `HandySection` già ha voce di default + stato modelli in VRAM
    + engine TTS attivo → resta lì (con label aggiornata, non più "Handy").
  - *Session*: voce di default per Shift+F1/F2 già coerente qui.
- **Nuovi tab additivi** (funzioni che oggi non esistono in callAPIcall):
  - *Models*: download/seleziona/elimina modelli STT e TTS (come tab Models di Handy), con stato
    download e filtro lingua.
  - *Advanced*: accelerazione (Whisper accelerator, ORT provider, GPU device TTS/STT), unload timeout,
    opzioni sperimentali.
- i18n: nuovi namespace in `gui/src/i18n/locales/*.json` + voci sidebar (pattern già documentato:
  registrazione unica in `Sidebar.tsx::SECTIONS_CONFIG`).

### Fase 5 — Cutover e ritiro di Handy
- Flag `stt_backend`/`tts_backend` → default `native`; periodo di convivenza col fallback `handy`.
- Rimuovere la gestione processo Handy (`handy_exe_path`, start/stop/restart in `api_components.py`),
  l'autostart di Handy, e le env HANDY_* non più necessarie.
- Aggiornare INSTALL.md / README e le memorie.

## File principali toccati / creati
- Nuovi: `call-bridge/callbridge/engines/{__init__,stt_engine,tts_engine,models,voices}.py`.
- Riscritti (API invariata): `callbridge/stt_client.py`, `callbridge/tts_client.py`.
- Modificati: `callbridge/config.py` (flag backend, cartella modelli, campi accelerazione),
  `callbridge/handy_client.py` (→ facade sull'engine layer o rimosso), `control_server.py`,
  `api_components.py`, `api_diag.py`, `api_personas.py`, `api_analysis.py`, `orchestrator.py`.
- GUI: `gui/src/lib/api/handyApi.ts` (repoint), nuove sezioni `ModelsSection.tsx`/`AdvancedSection.tsx`,
  `Sidebar.tsx`, i18n locali.
- Riuso da Handy (copia adattata): i 4 `*_tts_helper.py`, `silero_vad_v4.onnx`, il registro modelli
  (`managers/model.rs` → `models.py`).

## Rischi e mitigazioni
1. **Parità STT** (rischio n.1): CT2/faster-whisper vs whisper.cpp. Mitigazione: de-risking in Fase 0;
   fallback a binding whisper.cpp se la qualità/latenza non regge.
2. **Accelerazione GPU**: faster-whisper→CUDA (cuDNN/CTranslate2), onnxruntime→CUDA/DirectML. Serve
   verificare le wheel giuste sul Python 3.10 del bridge.
3. **Chatterbox/ZONOS2**: restano subprocess coi loro venv; nessuna regressione ma nessuna
   semplificazione. ZONOS2 resta best-effort (già non verificato).
4. **Download modelli**: gigabyte. Mitigazione: import dei Kokoro/voci esistenti; STT scaricato una volta.
5. **Convivenza**: il flag `*_backend` permette rollback immediato a Handy durante la migrazione.

## Verifica (per fase)
- Fase 0/1/2: `python -c` di smoke test sull'engine (transcribe di un WAV noto; sintesi di una frase e
  salvataggio WAV) + una sessione PTT reale (Shift+F1) con `*_backend=native`, confrontando latenza e
  qualità col percorso Handy.
- `/diag/tts-roundtrip` (TTS→STT) deve passare col backend nativo.
- GUI: caricare/scaricare un modello, clonare/anteprima una voce, cambiare accelerazione — tutto
  contro il bridge, con Handy spento.
- Cutover: Handy.exe terminato e disautostartato; l'intero flusso voce/chiamate/gateway funziona.
