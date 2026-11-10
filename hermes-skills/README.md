# Hermes skills (redistribuibili con callAPIcall)

Copia **canonica** delle skill Hermes che fanno parte del sistema callAPIcall,
versionata nel repo cosi' viaggia con il progetto (branch `MonolitOne`).

## Contenuto
- **`phone-calls/`** — chiamate telefoniche + provider vocali di Hermes.
  - `scripts/kokoro_tts.py` — TTS di Hermes: `ws://127.0.0.1:8720/tts/stream`
    (motore **nativo** del bridge). Sceglie voce/lingua in base al testo; override
    via env `CALLBRIDGE_TTS_VOICE` / `CALLBRIDGE_TTS_LANG` / `CALLBRIDGE_TTS_SPEED`.
  - `scripts/transcribe.py` — STT di Hermes: `POST http://127.0.0.1:8720/transcribe`
    (file audio → testo). *(nuovo)*
  - `scripts/callctl.py` — controllo chiamate via control server `:8770`.
  - `scripts/hermes_server.py` + `hermes-phone.service` — phone server LIMITATO (:8780).
  - `references/` — architettura, protocolli, voci, flusso audio.
  - `SKILL.md` — spec (aggiornata a MonolitOne: STT/TTS nativi, niente app Handy).
- **`voice-mode/`** — pattern di stile per le risposte TTS (testo semplice, breve).

## Sorgente del bridge
Il **codice attivo** del bridge (motori nativi STT/TTS, server Handy-compat su :8720,
dettatura, orchestrazione) NON e' qui: e' in **`../call-bridge/callbridge/`** (stesso
repo). Le vecchie skill avevano copie congelate del bridge in `templates/`: sono
**deprecate** (andavano fuori sync) — la sorgente unica e' `call-bridge/`.

## Deploy (installazione nell'ambiente Hermes)
Copia le cartelle nella home skill di Hermes:
```
phone-calls  -> %LOCALAPPDATA%\hermes\skills\media\phone-calls
voice-mode   -> %LOCALAPPDATA%\hermes\skills\communication\voice-mode
```
Nessuna app esterna (Handy) da avviare: gli endpoint `:8720` li serve il bridge
nativo quando `handy_compat_enabled: true` in `call-bridge/config.json`.
