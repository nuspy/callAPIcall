# Installazione di callAPIcall

> ⚠️ **Documento storico.** Alcune sezioni operative (avvio via `python main.py serve`
> in terminale, hotkey `ctrl+space`, Hermes-in-WSL) sono **superate**. Per il deploy
> attuale segui l'**architettura split** descritta nel [README — Avvio rapido](README.md#avvio-rapido):
> gateway headless NSSM (`install-service.ps1`, `main.py gateway`) + PTT in sessione
> utente (`install-ptt-task.ps1`, `main.py all --no-gateway`) + Hermes nativo/ACP
> (`cutover-hermes-native.ps1`). Le hotkey reali sono `shift+f1/f2/f3/f4`.

Guida end-to-end: dai prerequisiti del PC all'avvio dell'agente telefonico.

Tutto gira su questo PC (Windows 11) tranne l'app Android che gira sul
telefono gateway (Samsung S25 Ultra).

> **Sequenza ad alto livello**
> `Handy` → `modelli STT/TTS` → `app Android (dialer predefinito)` →
> `pairing Bluetooth` → `call-bridge` → `server agente (Hermes)` →
> `skill (Claude / Hermes)` → `avvio` → `primo test`

---

## 0. Prerequisiti sul PC (Windows 11)

Necessari **una volta sola**.

| Strumento | Cosa | Note |
|-----------|------|------|
| **Rust** (rustup) | toolchain per Handy | https://rustup.rs |
| **Bun** | dipendenze frontend Handy | https://bun.sh |
| **MSVC Build Tools** | compilatore C++ (whisper.cpp, ecc.) | Visual Studio 2022 Build Tools, workload "Desktop development with C++" |
| **CMake** | richiesto da whisper-rs-sys | `winget install Kitware.CMake` |
| **Vulkan SDK** | accelerazione GPU di Handy | https://vulkan.lunarg.com |
| **Python 3.10+** | call-bridge, setup, helper TTS | gia' presente |
| **LLVM/libclang** | bindgen di whisper-rs-sys | **vedi sezione 1.1**: non LLVM 22, usa libclang 18 |
| **Android Studio** | build dell'app Android | https://developer.android.com/studio |

Controllo rapido:
```powershell
rustc --version    # 1.85+ ok
bun --version
cmake --version
python --version
```

---

## 1. Handy (motore STT/TTS)

### 1.1 Fix libclang (importante)
Su questo PC `LLVM 22` rompe `whisper-rs-sys`. Si usa una libclang piu' vecchia,
isolata, via pip — **non si tocca l'LLVM di sistema**.

```powershell
python -m pip install "libclang==18.1.1"
```

La DLL finisce in
`C:\Users\<user>\AppData\Local\Programs\Python\Python310\lib\site-packages\clang\native\libclang.dll`.

Per ogni shell in cui compilerai Handy:
```powershell
$env:LIBCLANG_PATH = "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python310\lib\site-packages\clang\native"
```
*(Per renderlo permanente: aggiungilo alle env utente di Windows.)*

### 1.2 Modello VAD (richiesto per `/stt/stream`)

```powershell
mkdir C:\Projects\Handy-API\src-tauri\resources\models -Force
Invoke-WebRequest https://blob.handy.computer/silero_vad_v4.onnx `
  -OutFile C:\Projects\Handy-API\src-tauri\resources\models\silero_vad_v4.onnx
```

### 1.3 Modelli Kokoro (TTS) e dipendenze Python dell'helper

Dal repo callAPIcall:
```powershell
cd C:\Projects\callAPIcall
python setup\setup_kokoro.py --all --variant int8
```
Installa `kokoro-onnx` + `numpy` nel `python` di sistema (quello che Handy
invochera') e scarica `kokoro-v1.0.int8.onnx` (~88 MB) + `voices-v1.0.bin` (~27 MB)
in `Handy-API/src-tauri/resources/models/`.

Verifica:
```powershell
python setup\setup_kokoro.py --check
```
Deve dire "PRONTO".

### 1.4 Modello STT (Whisper o Parakeet)

Handy gestisce i propri modelli STT separatamente. Al primo avvio della UI di
Handy, scegli e scarica un modello (Settings → Models). Per l'italiano un buon
default e' **Parakeet V3** (auto-detect lingua, CPU). In alternativa,
installazione manuale: vedi la sezione "Manual Model Installation" del README
di Handy.

Posizione: `%APPDATA%\com.pais.handy\models\`.

### 1.5 Build Handy

```powershell
cd C:\Projects\Handy-API
bun install
$env:LIBCLANG_PATH = "C:\Users\$env:USERNAME\AppData\Local\Programs\Python\Python310\lib\site-packages\clang\native"
bun run tauri build         # produzione (msi/exe in src-tauri/target/release/bundle)
# oppure: bun run tauri dev    # modalita' sviluppo con hot reload
```

Verifica rapida del solo crate (senza UI):
```powershell
cd C:\Projects\Handy-API\src-tauri
cargo check --release --lib
```

Dettagli sull'estensione fatta: [HANDY_EXTENSION.md](HANDY_EXTENSION.md).

---

## 2. App Android di controllo

### 2.1 Build

```powershell
# Aprire C:\Projects\callAPIcall\android-controller in Android Studio
# Run -> Build -> Build APK(s)
# Output: android-controller\app\build\outputs\apk\debug\app-debug.apk
```

In alternativa da CLI:
```powershell
cd C:\Projects\callAPIcall\android-controller
gradle wrapper                         # una tantum (richiede Gradle installato)
.\gradlew assembleDebug
```

### 2.2 Installazione sul telefono gateway

```powershell
adb install -r android-controller\app\build\outputs\apk\debug\app-debug.apk
```

### 2.3 Configurazione sul telefono

1. Apri **Call API Controller**
2. Tocca **Concedi permessi** → accetta tutto (chiamate, stato, notifiche)
3. Tocca **Imposta come telefono predefinito** → conferma la richiesta di sistema
4. Tocca **Avvia servizio** → il banner mostra `http://<ip-telefono>:8080`
5. Annota l'IP del telefono — ti servira' nel `config.json` del call-bridge

Dettagli: [android-controller/README.md](android-controller/README.md).

---

## 3. Pairing Bluetooth telefono ↔ PC

L'audio della chiamata passa da qui — il PC fa da auricolare vivavoce HFP.

1. Sul telefono: Impostazioni → Bluetooth → accoppia il PC
2. Sul PC: Impostazioni → Dispositivi → Bluetooth → conferma il pairing
3. Verifica gli endpoint audio HFP rilevati:
   ```powershell
   cd C:\Projects\callAPIcall\poc
   python hfp_audio_probe.py list
   ```
   Le righe marcate `>>>` sono gli endpoint del telefono target.

> Il **test reale** dell'audio richiede una chiamata in corso instradata al
> PC — si fa quando tutto e' su (sezione 8).

---

## 4. Call-bridge (l'orchestratore)

### 4.1 Setup

```powershell
cd C:\Projects\callAPIcall\call-bridge
python -m venv .venv
.\.venv\Scripts\activate
pip install -r requirements.txt
copy config.json.example config.json
```

### 4.2 Configurazione (`config.json`)

Modifica almeno questi campi:

```json
{
  "phone_host": "192.168.1.50",          // IP del telefono (vedi 2.3 punto 5)
  "phone_port": 8080,
  "auth_token": "<token-condiviso-con-android>",

  "handy_host": "127.0.0.1",
  "handy_port": 8720,

  "control_host": "127.0.0.1",
  "control_port": 8770,
  "control_auth_token": "<token-condiviso-con-skill/agente>",

  "default_voice": "if_sara",
  "default_lang": "it",

  "push_to_talk_hotkey": "ctrl+space",

  "hermes_base_url": "http://127.0.0.1:8780",
  "hermes_mode": "stub"                  // metti "http" quando il server agente e' su
}
```

**`auth_token`** deve combaciare con `ControlService.AUTH_TOKEN` nell'app
Android (oggi `"change-me-shared-token"` — cambialo in entrambi).

**`control_auth_token`** deve essere noto a chi chiama l'orchestrator
(skill `callctl.py` e Hermes).

### 4.3 Smoke test

```powershell
python main.py devices        # vede l'endpoint HFP del telefono
python main.py ping           # vede l'app Android sul telefono
```

Dettagli: [call-bridge/README.md](call-bridge/README.md).

---

## 5. Server agente (Hermes o altro)

L'orchestrator ha bisogno di un agente come **server** per generare le risposte.
La spec degli endpoint e di cosa fare e' in
[skill/SKILL.md](skill/SKILL.md) (Parte 2).

### 5.1 Quick start con il server di riferimento
Stub funzionante (eco simulato in streaming), utile per i primi test:

```powershell
pip install flask
python C:\Projects\callAPIcall\skill\hermes_server.py
# bind 127.0.0.1:8780
```

Quando il server e' su, nel `config.json` del call-bridge metti
`"hermes_mode": "http"` (puoi farlo anche dopo aver gia' avviato il
call-bridge in modalita' stub).

### 5.2 Integrazione vera (Hermes Agent)
Implementa i 5 endpoint descritti in `skill/SKILL.md` dentro Hermes (es. come
platform adapter del gateway) sostituendo lo stub `RESPOND_FN` con la
generazione streaming del tuo LLM.

---

## 6. Skill per gli agenti

La cartella `skill/` contiene:
- `SKILL.md` — la skill stessa (front-matter + istruzioni)
- `callctl.py` — strumento da riga di comando per l'agente
- `hermes_server.py` — implementazione di riferimento del server lato agente

### Installazione per Claude Code
```powershell
mkdir $env:USERPROFILE\.claude\skills\phone-calls -Force
Copy-Item C:\Projects\callAPIcall\skill\* $env:USERPROFILE\.claude\skills\phone-calls\
```

### Installazione per Hermes
Copia in `hermes-agent/skills/phone-calls/` (Hermes carica le skill da li').

### Variabili d'ambiente per l'agente
```powershell
$env:CALLBRIDGE_CONTROL_URL = "http://127.0.0.1:8770"
$env:CALLBRIDGE_CONTROL_TOKEN = "<lo stesso 'control_auth_token' del call-bridge>"
```

---

## 7. Ordine di avvio

In tre terminali (l'ordine non e' critico ma questo evita warning iniziali):

1. **Handy** (motore STT/TTS)
   ```powershell
   # se hai installato il pacchetto:
   handy --start-hidden --no-tray
   # oppure in dev:
   cd C:\Projects\Handy-API
   $env:LIBCLANG_PATH = "..."
   bun run tauri dev
   ```
   API attesa su `http://127.0.0.1:8720`.

2. **Server agente** (se `hermes_mode=http`)
   ```powershell
   python C:\Projects\callAPIcall\skill\hermes_server.py
   ```
   API attesa su `http://127.0.0.1:8780`.

3. **Call-bridge** (orchestratore + control server + watcher chiamate in arrivo + push-to-talk)
   ```powershell
   cd C:\Projects\callAPIcall\call-bridge
   .\.venv\Scripts\activate
   python main.py serve
   ```
   Bind su `http://127.0.0.1:8770`. Da qui in poi tutto e' attivo.

Sul telefono assicurati che **Call API Controller** sia avviato e che l'app
sia il dialer predefinito.

---

## 8. Primo test

### 8.1 Audio HFP (con una chiamata vera — Task #1)
1. Dal telefono fai una chiamata a un secondo numero, instrada l'audio al PC.
2. Mentre la chiamata e' attiva:
   ```powershell
   cd C:\Projects\callAPIcall\poc
   python hfp_audio_probe.py probe --seconds 15
   ```
3. Il meter `DOWN` deve muoversi quando l'altro parla; l'altro deve sentire
   il tono di 440 Hz (test del verso `UP`).
4. Riaggancia.

### 8.2 Stato del sistema
```powershell
python C:\Projects\callAPIcall\skill\callctl.py status
```
Deve mostrare phone + handy + sessione (non attiva).

### 8.3 Voci disponibili
```powershell
python C:\Projects\callAPIcall\skill\callctl.py models
```

### 8.4 Pre-warm dei modelli
```powershell
python C:\Projects\callAPIcall\skill\callctl.py prepare
```
Carica STT + TTS in VRAM. Dopo 15 min di inutilizzo si scaricano da soli.

### 8.5 Chiamata in uscita end-to-end
```powershell
python C:\Projects\callAPIcall\skill\callctl.py call +39333xxxxxxx --voice if_sara --lang it
# (rispondi sul secondo numero; conversa)
python C:\Projects\callAPIcall\skill\callctl.py hangup
```

### 8.6 Chiamata in arrivo end-to-end
Chiama il numero della SIM del telefono gateway da un altro telefono.
L'orchestrator (mentre `serve` e' in esecuzione): rileva la chiamata, ricava
la lingua dal prefisso, accetta in autonomia, notifica l'agente, avvia la
sessione.

### 8.7 Push-to-talk (dialogo diretto utente ↔ Hermes)
Premi **Ctrl+Space** sul PC: parte una sessione di conversazione che usa
mic/casse di **default dell'OS** (non l'HFP). Premi di nuovo Ctrl+Space per
chiudere.

---

## Riferimenti

- [README.md](README.md) — panoramica del progetto
- [HANDY_EXTENSION.md](HANDY_EXTENSION.md) — cosa e' stato modificato in Handy
- [setup/README.md](setup/README.md) — setup Kokoro nel dettaglio
- [android-controller/README.md](android-controller/README.md) — app Android
- [call-bridge/README.md](call-bridge/README.md) — orchestratore
- [skill/SKILL.md](skill/SKILL.md) — skill per agenti (la parte 2 e' la spec del server agente)

## Calendari (auto-join riunioni)

L'auto-join legge gli eventi da Google Calendar e Outlook via OAuth con
**app registrate da te** (sola lettura):

### Google
1. [console.cloud.google.com](https://console.cloud.google.com) → progetto →
   *API e servizi* → abilita **Google Calendar API**.
2. *Credenziali* → *Crea credenziali* → **ID client OAuth** → tipo
   **App desktop**.
3. Copia client ID e secret in Impostazioni → Calendari
   (`calendar_google_client_id` / `calendar_google_client_secret`).
4. Sezione Riunioni → bottone **Google** → completa l'accesso nel browser.

⚠️ Se l'app OAuth resta in modalità "Testing", Google fa scadere il refresh
token dopo 7 giorni: pubblica l'app (anche senza verifica) per token stabili.

### Microsoft (Outlook)
1. [portal.azure.com](https://portal.azure.com) → *App registrations* →
   *New registration* (account personali e/o aziendali a scelta).
2. *Authentication* → *Add a platform* → **Mobile and desktop applications**
   → spunta il redirect `https://login.microsoftonline.com/common/oauth2/nativeclient`
   → abilita **Allow public client flows**.
3. *API permissions* → Microsoft Graph → Delegated → **Calendars.Read**.
4. Copia l'Application (client) ID in `calendar_ms_client_id`
   (tenant: `common` per account personali, o il tuo tenant aziendale).
5. Sezione Riunioni → bottone **Outlook** → inserisci il codice mostrato su
   microsoft.com/devicelogin.

I token finiscono in `call-bridge/secrets/` (fuori da git). Con un calendario
collegato, la sezione Riunioni mostra i prossimi eventi: la spunta **auto**
fa entrare il bot da solo ~1 minuto prima dell'inizio (riunioni con link
Meet/Teams/Zoom riconosciuto).
