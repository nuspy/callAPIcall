# Call-bridge — orchestratore dell'agente telefonico AI

Servizio Python che gira **sull'host Windows**. È:
- l'**orchestratore** delle sessioni di chiamata (audio in streaming)
- il **server di controllo** per i comandi che partono da Hermes e dalla skill

Possiede i device audio Bluetooth HFP; Handy resta un motore puro STT/TTS
raggiunto via WebSocket. Hermes è ancora uno **stub** finché non si integra
(Task #6).

## Setup

```
cd call-bridge
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy config.json.example config.json    # poi modifica IP/token/porte
```

## Uso

```
python main.py devices         # elenca i device audio HFP rilevati
python main.py ping            # verifica la connessione con l'app Android
python main.py call +39...     # chiamata in uscita + sessione di conversazione
python main.py answer          # attende una chiamata in arrivo e risponde
python main.py serve           # server di controllo + watcher chiamate in arrivo + push-to-talk
python main.py ptt             # solo push-to-talk (hotkey, dialogo diretto con Hermes)
```

`serve` e' la modalita' principale: avvia il server di controllo HTTP, il
watcher delle chiamate in arrivo e la hotkey push-to-talk, tutto insieme.

## Architettura

### Sessione di chiamata — modello a stream (`orchestrator.py`)

Durante una chiamata attiva, `CallSession` esegue quattro thread:

```
  downlink : HFP read  -> resample 16k -> HandySttClient.send_audio()
  brain    : stt.utterances.get() -> hermes.respond() (streaming) -> tts.send_text()
  uplink   : tts.audio.get() -> resample -> HFP write (a blocchi)
  watcher  : polling /status del telefono -> IDLE => chiude la sessione
```

`CallBridge` gestisce il lifecycle: prepare modelli (via Handy) → compone/
risponde → attende OFFHOOK → avvia `CallSession`.

### Server di controllo (`control_server.py`)

Flask. L'orchestrator è **server** per i comandi di Hermes/skill:
`/prepare`, `/call`, `/hangup`, `/status`, `/health` + proxy `/models/*` verso
Handy. Auth Bearer (`control_auth_token`).

### Moduli

| File | Ruolo |
|------|-------|
| `streaming.py` | `StreamingSession`: loop a thread downlink/brain/uplink + barge-in |
| `orchestrator.py` | `CallBridge` + `CallSession` (telefonate; estende `StreamingSession`) |
| `ptt.py` | `PushToTalkManager` + `PushToTalkSession` (hotkey, device di default OS) |
| `control_server.py` | server HTTP di controllo (Flask) |
| `phone_client.py` | client HTTP verso l'app Android (place/answer/hangup/status) |
| `handy_client.py` | client HTTP verso il canale di controllo di Handy (`/models/*`) |
| `hermes_client.py` | `HermesNotifier`: notifica Hermes delle chiamate in arrivo |
| `stt_client.py` | client WebSocket `HandySttClient` (`/stt/stream`) |
| `tts_client.py` | client WebSocket `HandyTtsClient` (`/tts/stream`) |
| `lang_map.py` | prefisso internazionale → (lingua, voce) per le chiamate in arrivo |
| `audio_hfp.py` | I/O sui device audio (HFP o default OS) + resampling (soxr) |
| `config.py` | configurazione/settings (`config.json` + env `CALLBRIDGE_*`) |
| `stubs.py` | `StubHermes` (eco in streaming) — sostituito dal Task #6 |

## Configurazione (`config.json`)

| Campo | Default | Note |
|-------|---------|------|
| `phone_host` / `phone_port` | `192.168.1.50` / `8080` | app Android sulla LAN |
| `auth_token` | `change-me-shared-token` | token verso l'app Android |
| `handy_host` / `handy_port` | `127.0.0.1` / `8720` | API di Handy |
| `control_host` / `control_port` | `127.0.0.1` / `8770` | bind del server di controllo |
| `control_auth_token` | `change-me-control-token` | token dei client (Hermes/skill) |
| `hfp_input_device` / `hfp_output_device` | `null` | indici device HFP (`null` = autodetect) |
| `sample_rate` / `block_ms` | `16000` / `100` | audio HFP |
| `default_voice` / `default_lang` | `if_sara` / `it` | default di chiamata |
| `default_stt_model` | `null` | `null` = default di Handy |
| `push_to_talk_hotkey` | `ctrl+space` | hotkey push-to-talk (Task #12) |
| `hermes_incoming_url` | `http://127.0.0.1:8780/incoming-call` | Hermes server per chiamate in arrivo |

Override anche via env: `CALLBRIDGE_<CAMPO_MAIUSCOLO>`.

## Limiti noti / TODO

- Hermes è uno stub → Task #6 (integrazione vera, adapter "phone")
- Barge-in: l'anti-eco è un'euristica a soglia di energia, non un AEC vero —
  da tarare a runtime (`barge_in_energy_threshold`)
- Una sola chiamata/sessione per volta
- `lang_map.py`: copertura prefissi curata (lingue Kokoro); per una copertura
  completa servirebbe `phonenumbers`
