# callAPIcall

Suite di **assistenza vocale e telefonica AI** su PC Windows: l'agente
**Hermes** (nativo su Windows) conduce conversazioni a voce con te, telefonate cellulari
reali con terzi, e ti assiste nelle videocall — anche con un **avatar video**
che parla al posto tuo con una **voce clonata**, su una webcam virtuale.

## Cosa fa

| Funzione | Come si attiva |
|---|---|
| **Conversazione a voce con l'agente** (half-duplex casse / full-duplex cuffie con barge-in) | hotkey Shift+F1 / Shift+F2, sezione *Sessione* della GUI, o app Android via Tailscale |
| **Telefonate cellulari reali** condotte dall'agente (in/out) | sezione *Chiamate* della GUI o API; trasporto auto: modem GSM USB o telefono Android via Bluetooth HFP |
| **Copilota videocall**: ascolta l'interlocutore e suggerisce risposte; opzionalmente risponde a voce/video | Shift+F4 o GUI; finestra invisibile alla condivisione schermo |
| **Voice cloning** zero-shot (5-15 s di campione) | GUI di Handy o Control Center → *Voci* |
| **Avatar video** con labiale sincronizzato (lipsync) sulla webcam virtuale | Control Center → *Identità* / *Studio*; nel copilota via config |
| **Control Center**: GUI desktop per tutto quanto sopra + test guidati | tray, parte all'accesso |

## Architettura

```
                        ┌────────────────────────────────────────────────────┐
 RICEVENTE ─ cellulare ─┤ TELEFONO Android (solo comandi chiamata, dialer)   │
                        └───────────────┬────────────────────────────────────┘
                              Bluetooth HFP (audio)        ┌──────────────┐
 MODEM GSM/4G USB ── seriale AT ──┐                        │ APP ANDROID  │
                                  │                        │ (Capacitor)  │
              ┌───────────────────▼────────────────────┐   └──────┬───────┘
              │ PC Windows — call-bridge (Python)      │   WS :8771 (Tailscale)
              │ • control server Flask :8770 (API GUI) │◄─────────┘
              │ • voice gateway WS :8771 + media :8772 │
              │ • hotkey PTT + overlay + copilota      │
              │ • router trasporti (GSM ⇄ Android)     │
              └───┬──────────────────┬─────────────────┘
                  │ WS/REST :8720    │ JSON-RPC stdio (ACP)
        ┌─────────▼─────────┐  ┌────▼──────────────────────┐
        │ HANDY (Rust/Tauri)│  │ HERMES agent (Windows-    │
        │ STT whisper CUDA  │  │ native, %LOCALAPPDATA%)   │
        │ TTS Kokoro/Piper/ │  │ (tool, ricerche, azioni)  │
        │ Chatterbox+cloni  │  └───────────────────────────┘
        └───────────────────┘
              ┌─────────────────────────────────────────┐
              │ AVATAR (musetalk-venv) — worker MuseTalk│
              │ lipsync GPU → pyvirtualcam →            │
              │ "OBS Virtual Camera" (solo driver, ~2MB)│
              └─────────────────────────────────────────┘
              ┌─────────────────────────────────────────┐
              │ CONTROL CENTER (Tauri 2 + React) — tray │
              │ 9 sezioni + 5 test guidati              │
              └─────────────────────────────────────────┘
```

**Vincolo chiave**: tutto l'audio (HFP, STT, TTS, telefono) vive **sull'host
Windows**, dove l'endpoint Bluetooth HFP del telefono è raggiungibile. Handy e
l'agente **Hermes nativo** girano anch'essi su Windows; si parlano via
localhost/stdio (ACP). *(In passato Hermes girava in WSL2 — che non vede i
device audio Bluetooth — da cui lo split audio-su-host; dopo il cutover nativo
il vincolo è storico.)*

## Componenti del repo

| Cartella | Cosa contiene |
|---|---|
| `call-bridge/` | Il cuore (Python): orchestratore chiamate, control server Flask (`:8770`, blueprint `api_session/api_personas/api_config/api_components/api_diag`), voice gateway WebSocket per l'app (`:8771`), push-to-talk con overlay tkinter, copilota (loopback audio), client Handy/Hermes/ACP, driver modem GSM (AT su seriale), router trasporti, client avatar. Supervisore `run-ptt.ps1` (task `callAPIcall-PTT`: logon + riavvio automatico; sentinella `ptt.stop`, valida fino al reboot). |
| `gui/` | **Control Center** (Tauri 2 + React 18 + Zustand + Tailwind 4): Sessione, Chiamate, Componenti (start/stop/restart), Test guidati, Voci (cloning), Identità, Studio (TTS+video con anteprima della camera virtuale), Handy, Impostazioni. Vive in tray; supervisore `run-control-center.ps1` + task `install-cc-task.ps1`. |
| `avatar/` | Worker video (`avatar_worker.py`, gira nel venv `musetalk-venv`): runtime **MuseTalk** per il lipsync in tempo reale, archivio identità in `persone/<nome>/` (`manifest.json`: voce + clip mp4). Output su webcam virtuale via **pyvirtualcam**. Repo MuseTalk, venv e cache NON sono in git (GB). |
| `app/` | App Android (Capacitor + React): replica Shift+F1/F2 da remoto via gateway (viva voce hold-to-talk e full-duplex), allegati immagine, media in ricezione. |
| `android-controller/` | App Android dialer predefinito (Kotlin, Telecom API): espone i comandi chiamata al call-bridge (HTTP `:8080`). |
| `drivers/obs-virtualcam/` | Filtro DirectShow "OBS Virtual Camera" **standalone** (2 DLL + regsvr32): si installa senza OBS Studio. |
| `skill/` | Skill per agenti (`callctl.py` + SKILL.md): permette a Hermes di comandare le chiamate; spec del server Hermes. |
| `setup/`, `poc/` | Setup Kokoro, script di probe HFP/telefono. |

## Meccanismi principali

- **Half vs full duplex**: in half (casse) il mic è muto durante reasoning+TTS
  (niente eco); in full (cuffie) l'ascolto è continuo e puoi interrompere
  l'agente mentre parla (**barge-in**, energy gate anti-eco).
- **Trasporto chiamate**: `call_transport: auto` preferisce il modem GSM USB
  (AT su COM; audio turn-based a file su SIM800C/A7670E) con fallback al
  telefono Android via HFP.
- **Copilota**: cattura il **loopback** (audio in uscita del PC = voce
  dell'interlocutore — la tua voce è esclusa per costruzione), STT → agente →
  finestra con contesto + N risposte; "rispondi con audio" sintetizza la
  risposta scelta (sulle casse, su un cavo virtuale, o tramite l'avatar).
- **Voice cloning** (Chatterbox Multilingual, zero-shot): campione 5-15 s →
  `POST /voices/clone` → voce selezionabile ovunque (TTS, identità avatar).
  Gli helper TTS sono processi Python a protocollo binario su stdout
  (header count+rate, campioni f32) con watchdog e warm-up al load.
- **Avatar**: per ogni clip la **prima** attivazione paga una preparazione
  (estrazione frame, landmark DWPose, latenti VAE, maschere di blending) poi
  messa in **cache su disco**; a runtime un loop di idle gira a 25 fps sulla
  camera virtuale e ogni risposta viene pre-renderizzata (~1-3 s) e riprodotta
  in sync con l'audio. Il video esce su "OBS Virtual Camera" senza OBS.
- **Resilienza**: due supervisori in sessione utente (autostart HKCU) per
  call-bridge e Control Center: rilancio entro pochi secondi su crash,
  sentinelle (`ptt.stop`, `cc.stop`) per gli stop voluti; restart del main
  dalla GUI = `exit(42)` + rilancio del supervisore.

## Librerie e tecnologie

| Area | Stack |
|---|---|
| call-bridge | Python 3.10 — Flask, websockets, sounddevice/soundfile, **soundcard** (loopback WASAPI), pynput (hotkey), tkinter (overlay/copilota), numpy, requests, pyserial (AT) |
| Handy (STT/TTS) | Rust — Tauri 2, axum, **transcribe-rs** (whisper.cpp CUDA sm_120), helper Python: **Kokoro**, **Piper**, **Chatterbox** (`chatterbox-tts`, venv dedicato) |
| Avatar | Python — **PyTorch** (CUDA), **MuseTalk** v1.5 (UNet + VAE sd-vae + Whisper encoder), **mmcv/mmdet/mmpose** (DWPose landmark), OpenCV, **pyvirtualcam** |
| Control Center | **Tauri 2** (tray, single-instance), React 18, TypeScript, Zustand, Tailwind 4, lucide-react |
| App Android | Capacitor 6, React, WebSocket + PCM16 |
| Agente | Hermes **nativo** su Windows (`%LOCALAPPDATA%\hermes`) via **ACP** (JSON-RPC su stdio) con tool/ricerche |

## Avvio rapido

Architettura **split** (l'unica supportata):

1. **Gateway headless** (servizio NSSM `callAPIcall-orchestrator`, `main.py gateway`
   su :8771/:8772): installalo con `call-bridge/install-service.ps1`. Gira anche
   in Session 0, senza hotkey/overlay.
2. **PTT + control server** in sessione utente (`main.py all --no-gateway` su
   :8770): installa il task con `call-bridge/install-ptt-task.ps1`; il supervisore
   `call-bridge/run-ptt.ps1` lo tiene vivo (auto-restart + heartbeat).
3. **GUI**: `gui/install-cc-task.ps1` registra il task `callAPIcall-ControlCenter`
   (logon + riavvio automatico) che porta su il Control Center in tray;
   chiudere = nascondere.
4. **Agente**: Hermes gira nativo su Windows (vedi `cutover-hermes-native.ps1`);
   con `acp_enabled=true` tutti i cervelli (F1/F2/F3, gateway, GSM, chiamate)
   usano l'agente ACP — il vecchio phone server HTTP :8780 non serve piu'.
5. Primo collaudo: Control Center → **Test guidati** (half-duplex,
   full-duplex, task agente, telefonata, copilota) — esito passo-passo.

> Nota: `main.py serve` in terminale e Hermes-in-WSL sono modalita' **storiche/deprecate**;
> l'installer generico `installer/install.ps1` registra un task `main.py serve`
> su :8770 che **confligge** con lo split — non usarlo per il PTT/control.

Documenti storici: [INSTALL.md](INSTALL.md) ·
[HANDY_EXTENSION.md](HANDY_EXTENSION.md) · [call-bridge/README.md](call-bridge/README.md) ·
[skill/SKILL.md](skill/SKILL.md) · [MeetsAPI.md](MeetsAPI.md) (design meeting-bot) ·
[drivers/obs-virtualcam/README.md](drivers/obs-virtualcam/README.md)

## Cosa non è in questo repository

Per scelta il repository non contiene dati personali né credenziali: `call-bridge/config.json` (parti da `config.json.example`),
le registrazioni della voce, le persone e i loro video (`avatar/persone/`), le memorie, i modelli (`call-bridge/models/`) e il file
della cache del telefono. Le cartelle `esp32-terminal/build` e `esp32-terminal/managed_components` si rigenerano con ESP-IDF.
L'indirizzo Tailscale del PC e il nome della macchina sono segnaposto da sostituire con i tuoi.
