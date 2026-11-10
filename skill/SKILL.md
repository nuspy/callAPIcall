---
name: phone-calls
description: Effettua e gestisce chiamate telefoniche cellulari reali tramite il gateway callAPIcall. Permette all'agente sia di INIZIARE chiamate in uscita (via callctl.py) sia di GESTIRE chiamate in arrivo (esponendo un piccolo server HTTP che l'orchestrator chiama). Usala quando l'utente vuole fare una telefonata, quando devi gestire una chiamata che arriva, gestire i modelli vocali, o conoscere lo stato delle chiamate.
external: true
path: /mnt/c/Projects/callAPIcall/skill
---

# Phone Calls — gateway callAPIcall (EXTERNAL SKILL)

Skill collegata via symlink a `/mnt/c/Projects/callAPIcall/skill/`.

**IMPORTANTE**: La spec autorevole è in `/mnt/c/Projects/callAPIcall/skill/SKILL.md`.
Leggi quel file per il riferimento completo degli endpoint e del protocollo.

## Architecture — Dualismo WSL / Windows

Il progetto callAPIcall vive su **due ambienti** che collaborano:

```
┌──────────────────────────────────────────────────────────────────┐
│  WSL (Ubuntu)                                    Porta 8780     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  hermes_phone_server.py  (Flask, 0.0.0.0:8780)         │    │
│  │  - LLM brain (OpenAI-compatible streaming)             │    │
│  │  - Tool-calling (web search, exchange rates, crypto)   │    │
│  │  - Voice change detection                               │    │
│  └──────────────────────┬──────────────────────────────────┘    │
│                         │ SSE (/utterance)                      │
└─────────────────────────┼───────────────────────────────────────┘
                          │ 127.0.0.1:8780 (WSL2 port forwarding)
┌─────────────────────────┼───────────────────────────────────────┐
│  Windows                │                          Porte        │
│                         ▼                                       │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  callbridge/ (orchestrator, NSSM service)  Porta 8770   │    │
│  │  - main.py serve  → control_server.py + ptt.py         │    │
│  │  - streaming.py  → downlink/brain/uplink threads       │    │
│  │  - config.py + config.json                             │    │
│  └──────────┬──────────────────┬──────────────────────────┘    │
│             │                  │                                │
│             ▼                  ▼                                │
│  ┌────────────────┐  ┌────────────────┐                        │
│  │  Handy STT     │  │  Handy TTS     │    Porta 8720          │
│  │  (Whisper)     │  │  (Kokoro)      │                        │
│  └────────────────┘  └────────────────┘                        │
│             ▲                  │                                │
│             │ mic              ▼ speaker                        │
│         ┌───────┐        ┌──────────┐                          │
│         │  Mic  │        │ Speaker/ │                          │
│         │       │        │ Cuffie   │                          │
│         └───────┘        └──────────┘                          │
└──────────────────────────────────────────────────────────────────┘
```

### Codice in due copie

| Copia | Percorso | Scopo |
|-------|----------|-------|
| **WSL skill templates** | `~/.hermes/skills/media/phone-calls/templates/` | Codice sorgente di riferimento per Hermes |
| **Windows (produzione)** | `C:\Projects\callAPIcall\call-bridge\callbridge\` | Codice attivo che gira via NSSM |

**Regola di sincronizzazione**: I file in `templates/` e `callbridge/` devono essere identici. Le modifiche fatte in produzione (Windows) vanno riportate nei template e viceversa. L'eccezione è `hermes_phone_server.py` che risiede nella root del progetto Windows (`call-bridge/`), non dentro `callbridge/`.

### Flusso audio end-to-end

```
Mic → sounddevice (Windows) → Handy STT (ws://127.0.0.1:8720/stt/stream)
  → enunciato STT → Hermes brain (http/ACP) → testo streaming
    → Handy TTS (ws://127.0.0.1:8720/tts/stream) → PCM audio
      → sounddevice → Speaker/Cuffie
```

1. **Mic** cattura audio a 16 kHz via `sounddevice`
2. **Downlink thread** invia audio a Handy STT WebSocket → riceve enunciati
3. **Brain thread** invia enunciato a Hermes (HTTP SSE o ACP) → riceve testo in streaming
4. **Uplink thread** invia testo a Handy TTS WebSocket → riceve PCM → riproduce su speaker

### 4-Phase Post-TTS Audio Flow (half-duplex, anti-eco)

**Problema**: Quando il TTS smette di parlare, l'audio è ancora nel buffer `sounddevice` → esce dalle casse → il mic lo capta → lo STT genera un enunciato spurio → Hermes elabora su nulla. La soluzione è un sistema a 3 eventi (`_processing`, `_listening`, `_tts_active`) con 4 fasi:

```
TTS parla → uplink scrive audio sulle casse
     ↓
FASE 1: _wait_tts_finished()
  Aspetta che la coda TTS sia vuota per 1.0s (quiet timeout)
  _processing=SET, _listening=CLEAR → mic completamente MUTO
     ↓
FASE 2: Post-TTS mute pause (ptt_post_tts_pause_s = 1.0s)
  Aspetta che l'eco fisico si spenga dalle casse
  _processing=SET → mic ancora MUTO
     ↓
FASE 3: Listen warmup (ptt_listen_warmup_s = 0.8s)
  _processing=CLEAR → mic ATTIVO (audio va allo STT per calibrazione rumore)
  _listening=CLEAR → brain SCARTA gli enunciati
  Lo STT impara il rumore di fondo reale
     ↓
FASE 4: Ascolto attivo
  _listening=SET → brain accetta enunciati
  Mic ATTIVO, brain attivo → pronto per la prossima frase

Totale: ~2.8s tra l'ultimo chunk TTS e il primo enunciato accettato
```

**Variabili config correlate**:
- `_wait_tts_finished` quiet timeout: hardcoded a 1.0s (era 0.6s)
- `ptt_post_tts_pause_s`: 1.0s (mute, eco si spegne)
- `ptt_listen_warmup_s`: 0.8s (mic ON, brain ignora)

**Se il sistema si auto-interrompe ancora**: aumentare `ptt_post_tts_pause_s` (es. 1.5s) e/o `ptt_listen_warmup_s` (es. 1.2s). Il downlink ha due condizioni di blocco: `_processing.is_set()` (mute totale) e `not _listening.is_set()` (brain scarta).

## Componenti

**File** — **Scopo**
- `SKILL.md` — Spec autorevole del protocollo
- `hermes_server.py` — Server Flask di riferimento (~120 righe)
- `callctl.py` — CLI per chiamate in uscita e gestione modelli

### Templates (per installazione su nuovi sistemi)

I file in `templates/` contengono **tutto il codice necessario** per installare il call-bridge su una nuova macchina:

- `templates/hermes_phone_server.py` — Phone server (LLM + SSE), va nella root del progetto
- `templates/hermes_client.py` — Client Hermes con supporto voice_change
- `templates/streaming.py` — Streaming session con gestione voice_change TTS + **4-phase post-TTS audio flow** (vedi sotto)
- `templates/main.py` — Entry point (serve/call/answer/ptt/devices/ping)
- `templates/config.py` + `templates/config.json` — Configurazione
- `templates/control_server.py` — Control server Flask (porta 8770)
- `templates/ptt.py` + `templates/ptt_overlay.py` — Push-to-talk + overlay visivo
- `templates/tts_client.py` + `templates/stt_client.py` — Client TTS/STT WebSocket (Handy)
- `templates/acp_client.py` — Client ACP per agente completo
- `templates/orchestrator.py` — CallBridge orchestrator
- `templates/install-service.ps1` — Installer servizio NSSM (Python 3.12)
- `templates/install.ps1` — Installer completo callAPIcall

**Installazione**: copiare tutti i `templates/*.py` in `C:\\Projects\\callAPIcall\\call-bridge\\callbridge\\`, `templates/main.py` in `C:\\Projects\\callAPIcall\\call-bridge\\`, `templates/config.json` in `C:\\Projects\\callAPIcall\\call-bridge\\`, e `templates/hermes_phone_server.py` in `C:\\Projects\\callAPIcall\\call-bridge\\`.

**Template chiave aggiornati**:
- `hermes_client.py` — yield `str | dict` (chunk testo + voice_change metadata)
- `streaming.py` — gestisce dict `voice_change` chiamando `tts.configure()` a runtime (righe 214-225) + pausa post-TTS nel finally del brain
- `hermes_phone_server.py` — web search aggressiva + estrazione pagine + voice_change SSE
- `install-service.ps1` — Python 3.12 (NON 3.10)
- `config.py` — include `ptt_post_tts_pause_s` per gestione eco post-TTS
- `config.json` — include `ptt_post_tts_pause_s: 1.0` e `ptt_turn_pause_s: 1.5`

## Installazione su Windows

### Prerequisiti

- **Python 3.12** (`C:\Users\atain\AppData\Local\Programs\Python\Python312\python.exe`)
- **NSSM** (Non-Sucking Service Manager) installato e in PATH
- **Handy** desktop app avviata (`C:\Users\atain\AppData\Handy\handy.exe`)
- **Telefono Android** con app callAPIcall attiva su WiFi (`192.168.1.50`)

### Dipendenze Python

```bash
C:\Users\atain\AppData\Local\Programs\Python\Python312\python.exe -m pip install \
  flask openai ddgs numpy pyyaml sounddevice requests websocket-client soxr pynput pyserial
```

> Per il modem GSM USB (SIM800C) serve anche `pyserial` (qui sopra) e **ffmpeg** nel PATH con `libopencore_amrnb`. Vedi la sezione "Modem GSM/GPRS USB".

Per il phone server (se eseguito standalone):
```bash
pip install flask openai ddgs numpy pyyaml
```

### Setup del progetto

```powershell
# 1. Copiare i template nella cartella di produzione
Copy-Item templates\*.py C:\Projects\callAPIcall\call-bridge\callbridge\
Copy-Item templates\main.py C:\Projects\callAPIcall\call-bridge\
Copy-Item templates\config.json C:\Projects\callAPIcall\call-bridge\
Copy-Item templates\hermes_phone_server.py C:\Projects\callAPIcall\call-bridge\

# 2. Personalizzare config.json con i parametri desiderati (vedi sezione Configurazione)

# 3. Installare come servizio NSSM
powershell -ExecutionPolicy Bypass -File C:\Projects\callAPIcall\call-bridge\install-service.ps1
```

### Setup del phone server (WSL systemd)

Il phone server gira in WSL come servizio systemd, persistente al reboot:

```bash
# 1. Copiare il service file
cp scripts/hermes-phone.service ~/.config/systemd/user/

# 2. Adattare i path nel .service al sistema target
#    ExecStart=<path-to-venv>/bin/python3 <path-to-skill>/templates/hermes_phone_server.py

# 3. Abilitare e avviare
systemctl --user daemon-reload
systemctl --user enable hermes-phone.service
systemctl --user start hermes-phone.service

# 4. Verificare
systemctl --user status hermes-phone
curl -s http://127.0.0.1:8780/health
```

**Boot chain**: il servizio è agganciato a `hermes-gateway-monitor.sh` (lo script NSSM wrapper). Copiare il monitor aggiornato:
```bash
cp scripts/hermes-gateway-monitor.sh ~/hermes-gateway-monitor.sh
```

### NSSM Service Setup

```powershell
# Installare (come admin):
powershell -ExecutionPolicy Bypass -File C:\Projects\callAPIcall\call-bridge\install-service.ps1

# Gestione:
nssm status callAPIcall-orchestrator
nssm restart callAPIcall-orchestrator
nssm stop callAPIcall-orchestrator
nssm start callAPIcall-orchestrator
```

**Config servizio**:
- Nome: `callAPIcall-orchestrator`
- Start: `SERVICE_AUTO_START`
- Restart: automatico, 5s delay, illimitato
- Log: `C:\Projects\callAPIcall\call-bridge\serve.log` (rotazione 10MB)
- Python: `C:\Users\atain\AppData\Local\Programs\Python\Python312\python.exe` (NON 3.10)

**⚠️ PITFALL: NSSM StopPending zombie** — `nssm restart` spesso fallisce. Soluzione: script .ps1 che killa il PID, aspetta 4s, pulisce `__pycache__`, e fa `nssm start`.

## Supervisore PTT (sessione utente) — autostart invisibile + auto-restart

### Perché NON è un servizio (verificato empiricamente)

`main.py all` (control server + voice gateway :8771 + media :8772 + **push-to-talk** con overlay/hotkey) **deve girare nella sessione utente**, NON come servizio Windows. Test empirico (`test-service-session0.ps1`, servizio NSSM usa-e-getta in sessione 0):

- ✅ Da servizio (sessione 0) le parti **server** funzionano: control server, gateway WebSocket, media server bindano e rispondono.
- ✅ Il processo **non crasha** (l'overlay tkinter viene creato senza errori).
- ❌ **Le hotkey globali NON arrivano**: un hook tastiera (`pynput`) installato in sessione 0 non riceve i tasti della sessione utente (provato premendo il tasto a mano → zero reazioni nel log). L'overlay finirebbe inoltre su un desktop invisibile.

**Conseguenza**: il PTT/overlay/audio locale richiedono la sessione utente. (Le sole parti server *potrebbero* stare in un servizio — vedi NSSM `callAPIcall-orchestrator` che espone `main.py serve` su :8770.)

### Architettura del supervisore (3 livelli, niente SPOF, nessuna finestra)

```
Task Scheduler "callAPIcall-PTT"  (atlogon + restart-on-failure ogni 1 min)
   └─ wscript.exe run-ptt-hidden.vbs   (NESSUNA finestra; attende il figlio)
        └─ powershell run-ptt.ps1       (loop while: rilancia main.py all in 3s se esce)
             └─ python main.py all       (control + gateway + media + PTT/overlay)
```

- **Invisibile**: `run-ptt-hidden.vbs` usa `WshShell.Run(cmd, 0, True)` → la PowerShell gira con finestra nascosta; wscript non ha finestra. Tutti e tre i processi hanno `MainWindowHandle = 0`. **Non c'è nessuna finestra da chiudere per errore.**
- **Auto-restart a due livelli**: il loop in `run-ptt.ps1` riavvia `main.py all` se crasha (~3s); il **Task Scheduler** riavvia l'intero supervisore se muore la PowerShell stessa, tramite un **trigger a tempo che ripete ogni 1 min** (`MSFT_TaskTimeTrigger`, `PT1M`) + `MultipleInstances=IgnoreNew`: ogni minuto prova a partire, se il supervisore è vivo il tick è ignorato, se è morto lo rilancia. **Verificato empiricamente**: ucciso il supervisore, è ripartito da solo in ~30s. Questo chiude il buco "supervisore morto = nessuno lo rimette su" della vecchia chiave Run HKCU.
  - ⚠️ **Cosa NON funziona** (testato e scartato): il solo `RestartCount`/`RestartInterval` (restart-on-failure) NON tiene vivo un processo lungo; e una ripetizione **innestata sul trigger di logon** non scatta finché non rifai il login. Per il self-heal serve un trigger a **tempo** registrato a sé.

**File**: `call-bridge/run-ptt.ps1` (loop), `call-bridge/run-ptt-hidden.vbs` (launcher invisibile), `call-bridge/install-ptt-task.ps1` (installer del task).

### Installazione (NON richiede admin — task nella sessione utente)

```powershell
# Installa il task auto-riavviante, rimuove la vecchia chiave Run HKCU e fa lo switchover:
powershell -ExecutionPolicy Bypass -File C:\Projects\callAPIcall\call-bridge\install-ptt-task.ps1

# Varianti:
#   -NoStart    installa senza fare lo switchover (partira' al prossimo logon)
#   -Uninstall  rimuove il task
```

L'installer: 1) rimuove la chiave Run `HKCU\...\Run\callAPIcall-PTT`; 2) registra il task `callAPIcall-PTT` con **due trigger** — `AtLogOn` (avvio al login) + `Once` con ripetizione `PT1M` (poll di self-heal) — più `MultipleInstances IgnoreNew`, `Hidden`, `LogonType Interactive`, `RunLevel Limited`; 3) ferma i vecchi supervisori + `main.py all` ed avvia il task, verificando il rebind di :8771.

### Gestione

```powershell
Get-ScheduledTask -TaskName callAPIcall-PTT | Select State        # Ready/Running
Start-ScheduledTask  -TaskName callAPIcall-PTT                    # avvia ora
Stop-ScheduledTask   -TaskName callAPIcall-PTT                    # ferma (loop incluso)
(Get-ScheduledTaskInfo -TaskName callAPIcall-PTT).LastTaskResult  # 267009 = in esecuzione (ok)
```

**⚠️ Doppio bind su :8770** — sia il servizio NSSM `main.py serve` sia `main.py all` (supervisore) bindano :8770. Convivono (Windows ne riporta uno a caso), ma per evitarlo si può disinstallare il servizio NSSM (`install-service.ps1 -Uninstall`, richiede admin) lasciando solo il supervisore.

## Modem GSM/GPRS USB (SIM800C) — chiamate dirette dal PC

Trasporto **alternativo** al giro Bluetooth-HFP: un modem USB **SIMCom SIM800C** (chip **CH340**, porta seriale `COM6` @115200) fa **chiamate/SMS/GPRS direttamente dal PC** via comandi AT, senza il telefono Android. Attivato dalla selezione automatica del trasporto (`call_transport`, default `auto`). Lo stesso strato AT controlla anche i moduli 4G (Quectel EC25 / SIMCom SIM7600).

### ⚠️ Limite audio del SIM800C (verificato dal firmware)
L'audio della chiamata sul SIM800C è **solo analogico** (canali `CHFA`/`CMIC`; pin MIC/SPK **non esposti** su questa scheda) e **non passa su USB**: niente scheda audio USB, niente stream PCM live sulla seriale (`CPCMREG`/`CMEDIA`/`CCMXPLAY`/`CSDVC` → ERROR). L'unica via voce è **a FILE, turn-based** (stile Shift+F1):
- TTS → AMR-NB (ffmpeg) → `AT+FSWRITE` → `AT+CMEDPLAY` nella chiamata
- voce in arrivo → `AT+CREC` su file → `AT+FSREAD` → AMR → STT

**DA VALIDARE CON UNA SIM** (non testabile senza): che `CMEDPLAY` raggiunga l'**uplink** (l'interlocutore sente) e `CREC` il **downlink** (voce remota). Per voce real-time pulita meglio un modulo **4G con USB Audio (UAC)** (EC25/SIM7600): audio come scheda audio USB → riusa la pipeline `sounddevice` esistente.

### Componenti
- `callbridge/gsm_modem.py` — driver AT (pyserial): `dial/answer/hangup`, URC `RING/+CLIP`, SMS, stato rete/SIM, file system, `play_media`(CMEDPLAY)/`record`(CREC), DTMF. CLI: `python -m callbridge.gsm_modem status|fstest|call <n>|sms <n> "<testo>"|monitor`.
- `callbridge/gsm_audio.py` — PCM↔AMR-NB via **ffmpeg** (`libopencore_amrnb`).
- `callbridge/gsm_call.py` — `GsmCallSession`: conversazione **turn-based** (TTS→CMEDPLAY / CREC→STT + cervello Hermes). CLI: `python -m callbridge.gsm_call <numero> [--brain stub|acp|http]`.
- `callbridge/transport.py` — **selezione automatica del trasporto**: `CallRouter` rileva cosa c'è e sceglie (preferenza GSM, fallback Android); detection di GSM (porta seriale che risponde all'AT + SIM registrata) e Android (app di controllo raggiungibile).

### Selezione automatica del trasporto (GSM preferito, Android fallback)
Il control server crea un `CallRouter` (se `call_transport != "off"`) che ad ogni avvio e ad ogni chiamata **ri-rileva** i trasporti e sceglie:
- **gsm** se il modem è presente **e** registrato alla rete (SIM dentro);
- altrimenti **android** se l'app di controllo è raggiungibile;
- altrimenti nessuno (errore alla chiamata).

Endpoint del control server (`:8770`):
- `POST /call {number, voice?, lang?, greeting?, transport?}` — instrada sul trasporto scelto. `transport` ("gsm"/"android") forza scavalcando l'auto-selezione.
- `POST /hangup` — riaggancia su entrambi i trasporti.
- `GET /transport[?refresh=1]` — stato del rilevamento + trasporto selezionato.

Le chiamate in **arrivo**: il GSM (se preferito/aperto) auto-risponde via URC RING se `gsm_auto_answer`; l'Android usa il watcher esistente di `CallBridge`.

### Installazione (sistema)
1. **Dipendenze Python**: `pyserial` (in `requirements.txt`). `python.exe -m pip install pyserial`.
2. **ffmpeg** nel PATH con `libopencore_amrnb` (verifica: `ffmpeg -encoders | findstr amr`).
3. **Driver CH340** (Windows lo installa da solo; altrimenti driver WCH). Il modem appare come `COM<n>` — impostarla in `gsm_port`.
4. **SIM 2G** (Micro/Nano), **PIN disattivato**. ⚠️ Il SIM800C è **solo 2G**: verificare che l'operatore abbia ancora copertura 2G.
5. **Nessuna abilitazione manuale**: con `call_transport=auto` (default) il sistema rileva e usa il modem appena è presente **con SIM registrata**; altrimenti ripiega sul telefono Android. La porta si autorileva se cambia (CH340/risposta AT). Per forzare: `call_transport=gsm|android`.

### Config (config.json / env `CALLBRIDGE_*`)
| Parametro | Default | Descrizione |
|---|---|---|
| `call_transport` | `auto` | `auto` (preferisce GSM, fallback Android) \| `gsm` \| `android` \| `off` |
| `gsm_port` / `gsm_baud` | `COM6` / `115200` | porta seriale del modem (autorilevata se non risponde) |
| `gsm_record_window_s` | `8.0` | finestra di registrazione per turno (niente VAD live) |
| `gsm_answer_wait_s` | `6.0` | attesa risposta dopo `ATD` |
| `gsm_auto_answer` | `true` | risponde da solo alle chiamate in arrivo |
| `gsm_tts_file` | `C:\tts.amr` | file TTS sulla flash del modulo (la registrazione CREC va in `C:\REC\<id>.DVI`) |
| `gsm_record_id` / `gsm_play_volume` | `1` / `80` | id CREC / volume CMEDPLAY |

### Test rapido
1. `python -m callbridge.gsm_modem status` → segnale, `sim_inserted`, `registered`.
2. `python -m callbridge.gsm_modem fstest` → verifica file system (senza SIM).
3. Con SIM registrata: `python -m callbridge.gsm_call <numero> --brain acp` → conversazione turn-based (qui si validano CMEDPLAY/CREC).

## Configurazione — Parametri modificabili

La configurazione è in `config.json` (nella root del progetto) e può essere sovrascritta da variabili d'ambiente `CALLBRIDGE_*`.

### Parametri audio/Push-to-talk

| Parametro | Default | Descrizione |
|-----------|---------|-------------|
| `ptt_turn_pause_s` | `1.5` | Pausa di silenzio (s) che chiude il turno parlato in half-duplex. Gli spezzoni STT separati da meno di questo tempo vengono uniti in un solo enunciato. |
| `ptt_post_tts_pause_s` | `1.0` | Pausa post-TTS (s): dopo che il TTS ha finito, il microfono resta **MUTO** per questo tempo. Aspetta che l'eco fisico del TTS si spenga completamente dalle casse prima di riattivare il mic. |
| `ptt_listen_warmup_s` | `0.8` | Warmup di ascolto (s): dopo la pausa post-TTS, il mic viene riattivato (audio va allo STT per calibrazione rumore) ma il **brain scarta** gli enunciati per questo tempo. Previene che eco residua o rumore di fondo venga processato come enunciato. Il primo enunciato valido viene accettato solo dopo questo periodo. |
| `ptt_listen_warmup_s` | `0.8` | Warmup di ascolto (s): dopo la pausa post-TTS, il mic viene riattivato (audio va allo STT per calibrazione rumore) ma il **brain scarta** gli enunciati per questo tempo. Previene che eco residua o rumore di fondo venga processato come enunciato. |
| `ptt_input_device` | `null` | Device audio input per PTT (null = default OS) |
| `ptt_output_device` | `null` | Device audio output per PTT (null = default OS) |
| `sample_rate` | `16000` | Sample rate audio (16k mSBC wideband, fallback 8k) |
| `block_ms` | `100` | Dimensione blocco audio in ms |

### Parametri Hermes/brain

| Parametro | Default | Descrizione |
|-----------|---------|-------------|
| `hermes_base_url` | `http://127.0.0.1:8780` | URL del phone server Hermes |
| `hermes_mode` | `"http"` | `"stub"` = no-op locale, `"http"` = HermesClient |
| `acp_enabled` | `false` | Abilita agente completo via ACP (WSL) |
| `acp_init_timeout_s` | `240.0` | Timeout avvio `hermes acp` |
| `acp_response_timeout_s` | `300.0` | Tetto attesa risposta |

### Parametri barge-in

| Parametro | Default | Descrizione |
|-----------|---------|-------------|
| `barge_in_enabled` | `true` | Abilita interruzione TTS se l'interlocutore parla |
| `barge_in_energy_threshold` | `0.02` | Energia minima RMS (audio float32) per considerare "voce" |

### Parametri telefono/Handy

| Parametro | Default | Descrizione |
|-----------|---------|-------------|
| `phone_host` | `192.168.1.50` | IP telefono Android sulla LAN |
| `phone_port` | `8080` | Porta app Android |
| `handy_host` | `127.0.0.1` | Host Handy STT/TTS |
| `handy_port` | `8720` | Porta API Handy |
| `control_port` | `8770` | Porta control server orchestrator |
| `default_voice` | `"im_nicola"` | Voce TTS di default (Kokoro) |
| `default_lang` | `"it"` | Lingua di default |

## Hotkey — Tre modalità di conversazione

Il sistema supporta tre hotkey globali per attivare la conversazione vocale:

### Shift+F1 — Half-duplex (agente completo, casse)

- **Modalità**: Half-duplex turn-based
- **Brain**: Agente Hermes completo via ACP (tool, azioni, ricerche web)
- **Uso**: Con le casse (speaker). Il microfono è muto mentre il TTS parla per evitare eco.
- **Flusso**: Premi Shift+F1 → parla → rilascia → silenzio `ptt_turn_pause_s` → Hermes elabora → TTS risponde → pausa `ptt_post_tts_pause_s` → riprende ascolto
- **Config**: `push_to_talk_hotkey: "shift+f1"`, `half_duplex=True`

### Shift+F2 — Full-duplex (agente completo, cuffie)

- **Modalità**: Full-duplex con barge-in
- **Brain**: Agente Hermes completo via ACP (tool, azioni, ricerche web)
- **Uso**: Con le cuffie. Il microfono è sempre attivo; puoi interrompere il TTS parlando sopra.
- **Flusso**: Premi Shift+F2 → conversazione continua → l'altro può interrompere in qualsiasi momento
- **Config**: `push_to_talk_hotkey_fullduplex: "shift+f2"`, `half_duplex=False`

### Shift+F3 — Modello limitato (phone server)

- **Modalità**: Half-duplex o full-duplex
- **Brain**: Phone server LLM (`hermes_phone_server.py` su porta 8780) — modello singolo, tool-calling
- **Uso**: Simulazione chiamate telefoniche con risposte rapide e ricerche web automatiche
- **Config**: `push_to_talk_hotkey_limited: "shift+f3"`, brain = HermesClient HTTP

## Phone Server (hermes_phone_server.py)

Server HTTP su `0.0.0.0:8780` che riceve le richieste dall'orchestrator e genera risposte in streaming SSE usando il modello LLM via OpenAI-compatible API.

### Dipendenze phone server

```bash
pip install flask openai pyyaml ddgs
```

**⚠️ `ddgs` sostituisce `duckduckgo-search`** — il vecchio pacchetto è deprecato e restituisce 0 risultati silenziosamente. Il template ha fallback compatibile con entrambi.

### 3 Strategie di Tool-Calling

Il phone server usa un sistema a **3 strategie** (in ordine di tentativo) per dare al modello accesso a dati esterni in tempo reale:

#### Strategia 1: Tool-calling nativo OpenAI

Per modelli che supportano `tools=` + `tool_choice=` nell'API (es. glm-5.1 via Z.AI). Il modello riceve le tool definitions, decide se chiamarli, il server esegue i tools e invia i risultati come `role: "tool"`, poi il modello genera la risposta finale.

**Chain**: `client.chat.completions.create(tools=TOOL_DEFINITIONS, tool_choice="auto")` → `tool_calls` → `_execute_tool()` → seconda chiamata con risultati → risposta finale.

#### Strategia 1.5: Text-based [TOOL_REQUEST] parsing

Per modelli locali (es. qwen3.5 su LM Studio) che **non supportano tool-calling nativo** ma generano testo con formato `[TOOL_REQUEST]{...}[END_TOOL_REQUEST]`. Il server raccoglie il testo, intercetta i blocchi, esegue i tools, e fa una seconda chiamata con i risultati.

#### Strategia 2: Pre-search injection forzata (fallback)

Se entrambe le strategie sopra falliscono:
1. `_needs_search(text)` decide se cercare (aggressivo: tutto tranne saluti puri)
2. Risultati iniettati nel system prompt con istruzione forte

### Tools disponibili

- **`web_search`** — Ricerca web DuckDuckGo via `ddgs`, max 5 risultati, timeout 8s
- **`get_exchange_rate`** — Tassi di cambio in tempo reale da `open.er-api.com` (free)
- **`get_crypto_price`** — Prezzi crypto da `api.coingecko.com` (free)

### Configurazione LLM — Risoluzione dinamica

Il server risolve automaticamente modello/provider/api_key da `~/.hermes/config.yaml` tramite `_get_active_client()`. **La risoluzione avviene ad ogni richiesta** — se l'utente cambia modello nel config, il phone server segue senza restart.

**Chain di risoluzione** (in ordine):
1. **Env vars** `LLM_MODEL`, `LLM_BASE_URL`, `LLM_API_KEY` (se tutte e 3 presenti)
2. **`~/.hermes/config.yaml`** → `_resolve_hermes_config()` legge `model.default` + `model.provider`
3. **`fallback_providers`** nel config
4. **Fallback generico** → Z.AI glm-5.1

**⚠️ GLM reasoning models**: disabilita automaticamente il thinking con `extra_body={"thinking": {"type": "disabled"}}` quando il modello contiene "glm" nel nome.

**Riferimento dettagliato**: `references/tool_calling_strategies.md` — implementazione completa delle 3 strategie, tools disponibili, libreria ddgs, risoluzione dinamica modello, ordinamento post-TTS.

### Avvio del phone server

**Produzione (systemd, raccomandato)**:
```bash
# Il servizio gira come systemd --user, con Restart=always
systemctl --user status hermes-phone     # verifica stato
systemctl --user restart hermes-phone    # restart dopo modifiche codice
journalctl --user -u hermes-phone -f     # log live
```

Il servizio è abilitato al boot e parte automaticamente tramite `hermes-gateway-monitor.sh` (lo stesso wrapper NSSM che gestisce il gateway). Se crasha, riparte dopo 3s.

**Manuale (per testing)**:
```bash
# Da WSL:
/home/ataini/.hermes/hermes-agent/venv/bin/python3 ~/.hermes/skills/media/phone-calls/templates/hermes_phone_server.py --host 0.0.0.0 --port 8780

# Da Windows:
python C:\Projects\callAPIcall\call-bridge\hermes_phone_server.py --host 0.0.0.0 --port 8780
```

### systemd service: hermes-phone.service

Il servizio gira in WSL come `systemd --user` unit, modellato su `hermes-gateway.service`:

```ini
[Unit]
Description=callAPIcall Phone Server (:8780)
After=hermes-gateway.service

[Service]
Type=simple
ExecStart=<venv>/bin/python3 <skill>/templates/hermes_phone_server.py --host 0.0.0.0 --port 8780
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
```

**Boot chain**: `Windows boot` → `NSSM hermes-gateway-monitor` → `systemctl --user start hermes-gateway` + `systemctl --user start hermes-phone` → entrambi up.

Il file `.service` è in `~/.config/systemd/user/hermes-phone.service` e copiato in `scripts/hermes-phone.service` del progetto Windows per distribuzione.

### LM Studio Auto-Start

Se il phone server punta a LM Studio (`172.18.160.1:1234`) e non risponde, avviarlo automaticamente con:
```bash
~/.hermes/scripts/lmstudio_auto_start.sh "<model-id>"
```
NON aspettare che l'utente lo chieda — farlo proattivamente quando un health check o utterance fallisce con connection refused verso LM Studio.

### glm-5.1 content/reasoning_content fallback

glm-5.1 (Z.AI) può mettere il testo in `reasoning_content` invece di `content`, anche con `thinking: disabled`. Il phone server usa la funzione helper `_delta_text(chunk)` in TUTTI i punti streaming e `getattr(msg, "reasoning_content", None)` come fallback nelle risposte non-streaming. Questo previene il problema "risposta vuota / voce muta".

## Server HTTP dell'agente (0.0.0.0:8780)

Il server è in ascolto su `0.0.0.0:8780` e implementa:

- `/health` (GET) — Liveness probe
- `/incoming-call` (POST) — Notifica chiamata in arrivo
- `/outgoing-call` (POST) — Notifica chiamata in uscita
- `/utterance` (POST) — Conversazione (SSE streaming)
- `/call-ended` (POST) — Fine chiamata

## Regole SSE per /utterance

- Ogni chunk: `data: {"chunk":"..."}\n\n` (flush immediato)
- Fine: `data: {"done":true}\n\n`
- Errore: `data: {"error":"..."}\n\n`
- **Cambio voce/lingua**: `data: {"voice_change":{"voice":"af_heart","lang":"en-us"}}\n\n`
- Streaming token-per-token per latenza minima TTS

### Voice Change automatico (lang detection)

Quando l'utente cambia lingua durante la chiamata:
1. `_detect_language()` rileva la lingua dal testo tramite euristiche
2. Se supportata da Kokoro e diversa dalla sessione corrente → evento SSE `voice_change`
3. `streaming.py _brain` chiama `tts.configure(voice=..., lang=...)`
4. I chunk successivi vengono sintetizzati con la nuova voce

**Lingue supportate**: it, en, fr, es, pt, ja, cmn, hi
**Lingue NON supportate** (nessuna voce Kokoro): hu, de, ru, ar, ko, nl, pl, tr, cs, sv, fi

## Chiamate in uscita (callctl.py)

```bash
python3 /mnt/c/Projects/callAPIcall/skill/callctl.py status
python3 /mnt/c/Projects/callAPIcall/skill/callctl.py models
python3 /mnt/c/Projects/callAPIcall/skill/callctl.py call +39333xxxxxxx --voice if_sara --lang it
python3 /mnt/c/Projects/callAPIcall/skill/callctl.py hangup
```

## Verifica operativa

```bash
curl -s http://127.0.0.1:8780/health    # → {"status":"ok","model":"<modello>","sessions":0}
```

Per testare una conversazione completa:
```bash
curl -s -X POST http://127.0.0.1:8780/incoming-call \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-001","number":"+393331234567","voice":"if_sara","lang":"it"}'

curl -s -N -X POST http://127.0.0.1:8780/utterance \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-001","text":"Ciao, chi sei?","direction":"INCOMING"}'

curl -s -X POST http://127.0.0.1:8780/call-ended \
  -H "Content-Type: application/json" \
  -d '{"session_id":"test-001"}'
```

## WSL ↔ Windows Networking (CRITICAL)

| Componente | Host | Bind | Accessibile da |
|---|---|---|---|
| Hermes Phone Server | WSL | `0.0.0.0:8780` | ✅ Windows (`127.0.0.1:8780`) + WSL |
| Orchestrator | Windows | `127.0.0.1:8770` | ✅ Windows ONLY — ❌ NOT from WSL |

**L'orchestrator fa bind su `127.0.0.1:8770` (Windows loopback).** Da WSL, `127.0.0.1` punta al loopback di WSL, NON a Windows.

### Regola: callctl.py DEVE girare su Windows Python

```bash
# ✅ CORRETTO — via PowerShell + Windows Python
/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command \
  "& 'C:\Users\atain\AppData\Local\Programs\Python\Python312\python.exe' \
     'C:\Projects\callAPIcall\skill\callctl.py' status"

# ❌ SBAGLIATO — callctl.py da WSL → connection refused su 127.0.0.1:8770
python3 /mnt/c/Projects/callAPIcall/skill/callctl.py status
```

### Prerequisiti Windows Python

```bash
/mnt/c/Users/atain/AppData/Local/Programs/Python/Python312/python.exe -m pip install \
  sounddevice numpy requests websocket-client flask soxr pynput pyserial
```

### Telefono Android

Il telefono deve essere **acceso, connesso al WiFi** (`192.168.1.50` di default), e l'app callAPIcall deve essere attiva. Se `ping 192.168.1.50` fallisce, il telefono è offline.

## Modifica file callbridge: usare SEMPRE patch, MAI write_file

I file in `callbridge/` (Windows) hanno codice complesso con molte dipendenze. Usare `patch` (old_string/new_string) per modifiche chirurgiche. **NON usare `write_file`** — rischia di sovrascrivere sezioni non visibili nel context.

## Config orchestrator

```json
{ "hermes_mode": "http", "hermes_base_url": "http://127.0.0.1:8780" }
```

## Restart Procedure (CRITICAL)

Quando si modifica codice nel call-bridge, l'orchestratore e il PTT **devono essere riavviati** per caricare le modifiche. Il Python su Windows usa `.pyc` cache.

### Restart Orchestratore + PTT (via NSSM service)

1. Scrivi uno script .ps1 in `/tmp/` (NON usare inline PowerShell da WSL — l'escaping di `$` e `'` si rompe)
2. Lo script: kill PID servizio → wait 4s → pulisci `__pycache__` → `nssm start`
3. Esegui con `powershell.exe -ExecutionPolicy Bypass -File "$(wslpath -w /tmp/script.ps1)"`

Verifica che il PTT sia attivo nel log: `tail serve.log` → `callbridge.ptt INFO Push-to-talk attivo ...shift+f1/shift+f2...`

**⚠️ NON avviare `main.py ptt` standalone** — il PTT è integrato in `main.py serve` (via `control_server.py`). Un processo ptt standalone conflitta con le hotkey già registrate dal `serve`.

## Kokoro TTS come Provider Hermes

Il TTS Kokoro (voce `im_nicola`/`if_sara`, italiano) è integrato come **command TTS provider** nativo di Hermes.

### Architettura

```
Hermes text_to_speech tool
  → command provider "kokoro" in config.yaml
    → bash wrapper (WSL) → wslpath -w (path translation)
      → Windows Python → kokoro_tts.py
        → WebSocket ws://127.0.0.1:8720/tts/stream (Handy)
          → PCM float32 24kHz → WAV → Hermes → OGG → Telegram
```

### Config YAML

```yaml
tts:
  provider: kokoro
  providers:
    kokoro:
      type: command
      command: '/home/ataini/.hermes/scripts/kokoro_tts.sh {input_path} {output_path}'
      output_format: wav
      voice_compatible: true
      timeout: 30
```

### Voci Kokoro disponibili

Voce principale: `im_nicola` (italiano, maschile). Fallback: `if_sara` (femminile). 54 voci in 9 lingue.

**Mappa lingua → voce** (definita in `LANG_VOICE_MAP` nel phone server):

- it → im_nicola (it)
- en → af_heart (en-us), en-gb → bf_emma (en-gb)
- fr → ff_siwis (fr-fr)
- es → ef_dora (es)
- pt/pt-br → pf_dora (pt-br)
- ja → jf_alpha (ja)
- cmn → zf_xiaoxiao (cmn)
- hi → hf_alpha (hi)

**⚠️ Ungherese NON supportato** — Kokoro v1.0 non ha voci ungheresi.

### Handy (TTS/STT)

Handy è un'applicazione desktop (`C:\Users\atain\AppData\Handy\handy.exe`) avviata allo startup. Fornisce:
- **STT**: WebSocket su `ws://127.0.0.1:8720/stt/stream` (modello Whisper `large`)
- **TTS**: WebSocket su `ws://127.0.0.1:8720/tts/stream` (Kokoro)

Per caricare i modelli: `callctl.py prepare` (dopo reboot dell'orchestrator).

## LM Studio Auto-Start (CRITICAL)

Se il phone server usa un modello locale (qwen3.5) su LM Studio, **LM Studio deve essere attivo e il modello caricato** prima che qualsiasi richiesta venga fatta. Senza questo, il phone server va in timeout (60s) e la voce resta muta.

### Pre-flight check

Il phone server **NON** controlla LM Studio da solo. L'agente Hermes deve assicurarsi che LM Studio sia su prima di usare modelli locali.

**Script**: `~/.hermes/scripts/lmstudio_auto_start.sh <model-id>`

```bash
# Verifica e avvia se necessario:
~/.hermes/scripts/lmstudio_auto_start.sh "qwen3.5-35b-a3b-uncensored-hauhaucs-aggressive"
```

**Comportamento**:
1. Se LM Studio risponde su `http://172.18.160.1:1234/v1/models` → verifica modello caricato
2. Se modello non caricato → `lms load <model-id> -y --gpu max`
3. Se LM Studio non risponde → avvia app, aspetta max 60s, poi carica modello

### Systemd service — hermes-phone.service

Il phone server gira come **servizio systemd --user** permanente con `Restart=always`:

- **Service file**: `~/.config/systemd/user/hermes-phone.service`
- **Binario**: `/home/ataini/.hermes/hermes-agent/venv/bin/python3`
- **Script**: `~/.hermes/skills/media/phone-calls/templates/hermes_phone_server.py --host 0.0.0.0 --port 8780`
- **Restart**: always, 3s delay, max 120s backoff
- **Boot**: `After=hermes-gateway.service`, avviato dal monitor NSSM

### Boot chain

```
Windows boot → NSSM hermes-gateway-monitor.sh
  → systemctl --user start hermes-gateway
  → systemctl --user start hermes-phone    ← AGGIUNTO
```

Il monitor script (`~/hermes-gateway-monitor.sh`) avvia ENTRAMBI i servizi. In cleanup (stop) ferma entrambi.

### Installazione servizio (nuovi sistemi)

```bash
mkdir -p ~/.config/systemd/user/
cp scripts/hermes-phone.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable hermes-phone.service
systemctl --user start hermes-phone.service

# Verificare:
systemctl --user status hermes-phone.service
curl http://127.0.0.1:8780/health
```

### LM Studio giù → Phone server mute

Se il `config.yaml` ha `model.provider: custom:lmstudio` e LM Studio non risponde:
1. Avviare: `~/.hermes/scripts/lmstudio_auto_start.sh "<model-id>"`
2. Riavviare: `systemctl --user restart hermes-phone`
3. Verificare: `curl http://127.0.0.1:8780/health`

## Pitfalls

1. **Server era in /tmp/ — ORA RISOLTO** — Il phone server gira come servizio systemd `hermes-phone.service` con `Restart=always`. Se il servizio è down: `systemctl --user restart hermes-phone`.
2. **GLM reasoning models → content vuoto** — Il server disabilita il thinking automaticamente quando il modello contiene "glm". Inoltre `_delta_text()` fa fallback su `reasoning_content` se `content` è vuoto (previene voce muta).
3. **API key mancante** — Legge da `~/.hermes/.env` (`GLM_API_KEY`, `OPENAI_API_KEY`).
4. **NON usare `text_to_speech` per risposte vocali** — L'audio lo genera l'orchestratore (Handy/Kokoro).
5. **API key nel file** — non committare. Per produzione, usare env var.
6. **WSL → orchestrator = IMPOSSIBILE** — callctl.py deve girare su Windows Python.
7. **SSE flush** — Flask non flusheggia automaticamente. Il server usa `Response(generator())`.
8. **Max tokens 300** — sufficiente per risposte telefoniche brevi.
9. **Phone app offline** — se il telefono non è raggiungibile, le chiamate falliscono silenziosamente.
10. **Skill duplicata** — esiste sia `~/.hermes/skills/phone-calls/` (symlink) sia `~/.hermes/skills/media/phone-calls/` (skill registrata). Usare `media/phone-calls`.
11. **Handy TTS non caricato** — dopo reboot, eseguire `callctl.py prepare` prima di usare TTS.
12. **LM Studio VRAM piena** — verificare con `~/.hermes/scripts/lmstudio_model.sh status` prima di avviare. Se non risponde, avviare con `~/.hermes/scripts/lmstudio_auto_start.sh "<model-id>"`.
13. **Config vs TUI model switch** — Il phone server risolve il modello leggendo `~/.hermes/config.yaml` ad ogni richiesta via `_get_active_client()`. Se l'utente cambia modello dal TUI senza aggiornare il config, il phone server userà ancora il modello nel file. Per cambiare a runtime: aggiornare `config.yaml` oppure usare env vars `LLM_MODEL`/`LLM_BASE_URL`/`LLM_API_KEY`.
14. **qwen3.5 su LM Studio non supporta tool-calling nativo** — Genera `[TOOL_REQUEST]...[END_TOOL_REQUEST]` come testo (Strategia 1.5).
15. **ddgs vs duckduckgo-search** — Installare `ddgs`: la versione vecchia restituisce 0 risultati silenziosamente.
16. **Voice change = 3 file must be in sync** — phone server → hermes_client → streaming.py. Dopo modifiche, riavviare SEMPRE il processo.
17. **PTT è dentro `main.py serve`, NON standalone** — Due processi = hotkey morte.
18. **Clear __pycache__ after code changes** — Dopo modifiche `.py` via WSL, cancellare la cache.
19. **NSSM StopPending zombie** — Usare script .ps1 per kill PID, NON `nssm restart`.
20. **NSSM service name = `callAPIcall-orchestrator`** — NON usare `workdir=/mnt/c/Users/atain` con terminal().
21. **TTS self-interruption via echo (CRITICAL)** — Dopo che il TTS finisce, il buffer audio di sounddevice sta ancora suonando. Se `_processing` viene clearato troppo presto, il mic captava l'eco → STT genera enunciato spurio → Hermes elabora su nulla. Soluzione: il sistema a 4 fasi con `_listening` event + `ptt_listen_warmup_s`. Vedere "4-Phase Post-TTS Audio Flow" sopra. Sintomi: l'agente risponde a frasi mai dette, o elabora subito dopo aver parlato senza input.
22. **`_tts_active` ≠ audio reale** — `_tts_active` si basa sulla coda interna `tts.audio`, non sull'audio effettivamente uscito dalle casse. C'è un gap di 200-500ms tra "ultimo write" e "suono fisico". Per questo serve la FASE 2 (mute pause) dopo che `_wait_tts_finished` ritorna.
23. **WSL ↔ Windows sync OBBLIGATORIO** — Dopo ogni modifica, copiare SEMPRE il file sia sullo skill WSL (`~/.hermes/skills/media/phone-calls/templates/`) sia sul progetto Windows (`/mnt/c/Projects/callAPIcall/call-bridge/`). Usare `diff` per verificare. Entrambe le copie devono essere identiche. La versione Windows è quella distribuibile.
24. **LM Studio down = phone server timeout** — Se il modello è su LM Studio e non risponde, il phone server va in timeout dopo 60s. Verificare con `curl 172.18.160.1:1234/v1/models` e avviare con `~/.hermes/scripts/lmstudio_auto_start.sh` se necessario. NON aspettare che l'utente lo chieda.
