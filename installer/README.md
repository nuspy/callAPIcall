# Installer callAPIcall

## 📦 Pacchetto distribuibile: `callAPIcall-Setup-<versione>.exe`

Per installare su una macchina che **non ha il repo**. Si costruisce dalla radice:

```powershell
.\build-installer.ps1                 # -> dist\callAPIcall-Setup-0.1.0.exe (~183 MB; ~3 MB senza la wheel GGUF)
.\build-installer.ps1 -Version 0.2.0
.\build-installer.ps1 -SkipGui        # riusa l'exe del Control Center già compilato
```

L'installer è **thin**: contiene il codice (~12 MB), non le dipendenze.
L'unica eccezione è la wheel Windows di `qwentts-cpp-python` (~180 MB, runtime
GGUF del motore Qwen3-TTS):
- upstream non la pubblica, e noi non la pubblichiamo altrove;
- si costruisce con `tools\qwentts-cpp-win\build-wheel.ps1`;
- `build-installer.ps1` la include da `tools\qwentts-cpp-win\dist`, se c'è;
- il motore si installa con la casella opzionale "Motore voce Qwen3-TTS"
  (`setup.ps1 -Qwen3Tts`).

Sulla macchina di destinazione l'installer fa il resto chiamando `setup.ps1`:

| entra nel setup.exe | si scarica all'installazione |
|---|---|
| Control Center (exe), bridge, script, VAD | Python 3.10 se manca |
| skill Hermes, `setup.ps1`, `fetch_models.py` | venv + dipendenze, **torch scelto in base alla GPU trovata** |
| | modelli voce/trascrizione (~800 MB) |

Le due cose pesanti stanno fuori per ragioni diverse, non solo di peso: **torch**
va scelto sulla macchina di destinazione (la wheel CUDA giusta si sa solo lì), e
i **modelli** stanno in `%LOCALAPPDATA%\callAPIcall\models`, fuori
dall'installazione, così un aggiornamento da 3 MB non ne impone il riscaricamento.

Installazione **per-utente** in `%LOCALAPPDATA%\Programs\callAPIcall`: niente UAC,
coerente con bridge e Control Center che girano nella sessione utente (hotkey,
audio e overlay in sessione 0 non esistono). Componenti spuntabili: dipendenze,
modelli, avvio automatico, skill Hermes (quest'ultima spenta di default, perché
tocca la configurazione di un altro programma).

Se il provisioning fallisce — quasi sempre rete — i file restano installati e si
ritenta con `installer\setup.ps1`. La disinstallazione **non** cancella i modelli
senza chiedere.

Modelli, separatamente:

```powershell
python call-bridge\fetch_models.py                     # tutto (~800 MB)
python call-bridge\fetch_models.py --only diarization
python call-bridge\fetch_models.py --whisper large-v3  # trascrizione migliore (~2,9 GB)
```

---

## ⭐ Provisioning da repo: `setup.ps1`

Dal **MonolitOne** i motori STT/TTS sono **nativi** (Handy eliminato). `setup.ps1`
fa TUTTO il provisioning in un colpo, **incluso il lato Hermes**:

1. venv Python del bridge + `requirements.txt`
2. `torch` (CUDA o CPU) — backend di whisper
3. modelli: **Kokoro** (TTS) scaricati + **whisper** (STT) pre-caricato
4. `config.json`: backend nativo + server compat su :8720
5. **Hermes**: deploy delle skill (`hermes-skills/` → `%LOCALAPPDATA%\hermes\skills`)
   + `model.default` in `config.yaml` (l'agente `acp` usa quello, **ignora `-m`**)
6. autostart: task del bridge + Control Center

```powershell
# installazione completa (GPU auto-rilevata)
powershell -ExecutionPolicy Bypass -File installer\setup.ps1

# GPU con CUDA specifica (la macchina dev usa cu130)
powershell -ExecutionPolicy Bypass -File installer\setup.ps1 -TorchIndex https://download.pytorch.org/whl/cu130

# solo CPU, senza autostart
powershell -ExecutionPolicy Bypass -File installer\setup.ps1 -Cpu -SkipAutostart
```
Idempotente: rilanciarlo aggiorna solo ciò che manca. Flag: `-Cpu`, `-TorchIndex`,
`-HermesModel`, `-SkipDeps`, `-SkipModels`, `-SkipSkills`, `-SkipAutostart`.

Porte aperte dal bridge: **:8770** (control), **:8720** (STT/TTS nativo, usato anche
da Hermes via la skill `kokoro_tts.py`/`transcribe.py`), **:8771** (gateway app).

---

## `install.ps1` — gestore autostart (legacy/avanzato)

> ⚠️ Il componente `handy` qui sotto è **obsoleto** in MonolitOne (Handy è stato
> eliminato). `setup.ps1` sopra usa i sotto-script `install-ptt-task.ps1` e
> `gui\install-autostart.ps1` per l'autostart; usa `install.ps1` solo se ti serve
> il controllo fine dei singoli task.

Registra i componenti di callAPIcall come **Scheduled Task** che partono al
logon dell'utente e si **riavviano in caso di caduta**.

## Perche' Scheduled Task e non Windows Service

I componenti hanno bisogno della **sessione utente**:
- l'audio Bluetooth HFP e' visibile solo nella sessione interattiva;
- la hotkey push-to-talk (`pynput`) richiede una sessione utente;
- mic/casse di default dell'OS appartengono alla sessione utente.

Un Windows Service in sessione SYSTEM non vede nulla di tutto questo. Gli
Scheduled Task con trigger "al logon" eseguono nella sessione dell'utente
loggato — esattamente quello che serve.

## Componenti gestiti

| Chiave | Cosa | Porta | Eseguibile cercato |
|--------|------|-------|--------------------|
| `handy` | Motore STT/TTS di Handy | 8720 | `handy.exe` (Program Files o `Handy-API\src-tauri\target\release`) |
| `callbridge` | Orchestratore + control server + push-to-talk | 8770 | `call-bridge\.venv\Scripts\pythonw.exe` (o pythonw di sistema) |
| `hermes` | Server agente di riferimento (stub) | 8780 | come sopra |

## Uso

Apri PowerShell **nella cartella `installer/`**.

### Menu interattivo
```powershell
.\install.ps1
```
Mostra una tabella con lo stato di ciascun componente (eseguibile trovato?
porta in ascolto? task gia' registrato?) e accetta:

- `1,2`           — installa quei componenti
- `all`           — installa tutto
- `u 1,2` / `u all` — disinstalla
- `s 1` / `s all`   — avvia subito (oltre alla registrazione del task)
- `l`             — ricarica lo stato
- `q`             — esci

### Non interattivo
```powershell
.\install.ps1 -Install callbridge,hermes
.\install.ps1 -Install all
.\install.ps1 -Uninstall hermes
.\install.ps1 -Uninstall all
.\install.ps1 -List
```

## Convivenza con installazioni esistenti

L'installer **non sovrascrive e non tocca** nulla al di fuori della propria
cartella `\callAPIcall\` del Task Scheduler — a meno che tu non glielo chieda
esplicitamente (vedi sotto). Non modifica task fuori da `\callAPIcall\`, non
disinstalla niente da Program Files, non tocca registro o Windows Services
salvo richiesta esplicita.

### Caso speciale Handy (`Find-HandyInstallation` + `Replace-HandyBinary`)

Se selezioni `[1] Handy` e l'installer trova un Handy **gia' presente** in
una di queste forme:

| Tipo | Cos'e' |
|------|--------|
| `Service` | servizio Windows nativo o NSSM-wrappato (`handy.exe` o NSSM con Parameters.Application = handy.exe) |
| `Task` | scheduled task esterno (al di fuori di `\callAPIcall\`) che esegue handy.exe |
| `RegistryRun` | voce autostart in `HKCU/HKLM\...\Run\<nome>` (e' il modo Tauri di default) |
| `Process` | processo `handy.exe` in esecuzione senza alcun autostart riconoscibile |

l'installer **non crea un task duplicato**. Invece ti chiede:

```
[INFO] Handy gia' installato:
       tipo     : <Service|Task|RegistryRun|Process> - <descrizione>
       binario  : C:\path\to\current\handy.exe
       nuovo    : C:\Projects\Handy-API\src-tauri\target\release\handy.exe

Sostituire l'eseguibile mantenendo l'installazione esistente? [y/N]
```

- **No (default)** -> nulla viene modificato.
- **Si** -> `Replace-HandyBinary` esegue:
  1. SHA256 compare: se l'exe e' gia' identico, salta.
  2. backup del binario corrente in `handy.exe.bak`
  3. stop del meccanismo esistente (servizio: `Stop-Service`; task: `Stop-ScheduledTask`; altri: `Stop-Process` dei processi handy)
  4. copia del nuovo binario al posto del vecchio
  5. restart con lo stesso meccanismo (servizio: `Start-Service`; task: `Start-ScheduledTask`; altri: `Start-Process handy --start-hidden --no-tray`)

**Niente task `\callAPIcall\Handy` viene registrato**: l'autostart originario
(servizio / task esterno / Registry Run) resta l'unica autorita'.

Servono privilegi di Amministratore solo se il meccanismo lo richiede
(Service o HKLM); per HKCU\Run e processi utente bastano i tuoi permessi
normali.

### Altri componenti (call-bridge, hermes)

Per gli altri due componenti, se la porta e' gia' in ascolto ma nessun nostro
task e' registrato, l'installer mostra un warning piu' generico (potrebbe
essere un'altra istanza lanciata a mano) e chiede conferma prima di creare
un task duplicato — di solito vuoi rispondere "n".

Per bypassare gli avvisi in batch:
```powershell
.\install.ps1 -Install all -Force
```

## Pip install automatico

Quando registri un componente, l'installer installa anche le sue dipendenze
Python nel python di sistema (o nel venv del call-bridge se esiste):

| Componente | Pip deps |
|------------|----------|
| `handy`      | `kokoro-onnx`, `numpy` (per l'helper TTS) |
| `callbridge` | tutto da `call-bridge\requirements.txt` |
| `hermes`     | `flask` |

Se `python.exe` non si trova, lo step viene saltato con un warning (i task
restano comunque registrati).

I **modelli Kokoro** invece sono gestiti dalla GUI di Handy (Settings ->
Models) come Whisper/Parakeet — l'installer non li scarica.

## Cosa fa esattamente `Install-Component`

Registra un task in `\callAPIcall\<NomeComponente>` con:

| Impostazione | Valore |
|--------------|--------|
| Trigger | At LogOn dell'utente corrente |
| Action | l'eseguibile + i suoi argomenti, working directory impostata |
| Restart on failure | fino a 999 volte, intervallo 1 minuto |
| Execution time limit | **nessuno** (servizio long-running) |
| Multiple instances | `IgnoreNew` (uno solo per volta) |
| On battery | parte/continua comunque |
| Principal | utente corrente, LogonType **Interactive**, RunLevel Limited |

**Non serve admin** (`RunLevel Limited`): il task gira come l'utente, con i
suoi permessi e nella sua sessione. Questo e' fondamentale per accedere ai
device audio.

## Verifica e gestione

```powershell
# Elenco dei task registrati dall'installer
schtasks /Query /TN "\callAPIcall\" /FO LIST

# Stato dettagliato
.\install.ps1 -List

# Avvia/ferma manualmente
schtasks /Run /TN "\callAPIcall\CallBridge"
schtasks /End /TN "\callAPIcall\CallBridge"

# Apri la GUI (cartella callAPIcall)
taskschd.msc
```

## Log

I task lanciano direttamente gli eseguibili (`pythonw.exe`, `handy.exe`) senza
console: l'output di `print` e' perso. Per ottenere log su file:
- **call-bridge / hermes**: configura il logging nel codice (es. in
  `main.py` aggiungi `FileHandler` quando viene impostata l'env var
  `CALLBRIDGE_LOG_FILE`).
- **Handy**: gira come app Tauri, fai riferimento al suo logging integrato.
- **Task Scheduler** registra l'esito di ogni esecuzione ("Last Run Result"):
  `0x0` = OK, codici non-zero indicano crash. Visibile in `taskschd.msc`.

## Disinstallazione

```powershell
.\install.ps1 -Uninstall all
```
Rimuove i task. Non disinstalla i programmi, non tocca i file.
