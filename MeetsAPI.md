# MeetsAPI — Meeting-bot LOCALE (equivalente Recall.ai)

Documento di design per `callbridge/meetbot`: una libreria **interamente locale** che
fa entrare un bot nelle riunioni online, ne cattura l'audio, lo trascrive, suggerisce/parla
tramite Hermes, e salva trascrizione + riepilogo — **senza alcun servizio cloud**.

---

## 1. Cosa fa Recall.ai (riferimento da replicare)

Recall.ai è un servizio cloud che, via API, manda un *bot* dentro le riunioni di
**Zoom / Google Meet / Microsoft Teams / Webex / Slack huddles / GoTo**. Tecniche usate:

- **Bot a browser headless** (Puppeteer/Playwright): Chromium renderizza il web client,
  display virtuale, **sink/source audio virtuali** (PulseAudio) per catturare l'audio e
  iniettare un microfono.
- **SDK nativi** (Zoom/Teams) per audio per-partecipante.

Capacità: **audio real-time** (mixato o per-partecipante, PCM su WebSocket), **video**,
**trascrizione**, **diarizzazione** (chi parla), **Output Media** (il bot può *parlare/mostrare*
dentro la call), **registrazioni/artefatti**, **auto-join da calendario**, orchestrazione in
container scalabili.

## 2. Obiettivo locale e vincoli

Replicare quelle funzioni **in locale**, riusando lo stack già presente nel progetto
(Handy STT/TTS, Hermes via ACP, pipeline + UI del copilota). Requisiti:

| Aspetto | Decisione |
|---|---|
| Piattaforme | **Meet, Teams, Zoom, Telegram** + altre (Webex/Slack/GoTo) ad adapter |
| Ruolo bot | **Selezionabile**: silenzioso (alimenta il copilota) e/o **parlante** (legge le risposte di Hermes nella call) |
| Trigger | **Link manuale** + **auto-join da Google Calendar** |
| Cattura | **Audio + trascrizione** con **nome speaker** (best-effort) + **contenuto completo** + **riepilogo salvato localmente** |
| Cloud | **Nessuno** — tutto sul PC dell'utente |

**Decisioni architetturali chiave**
- **Audio isolato per-bot → WSL2 Ubuntu + PulseAudio (WSLg)**, come fa Recall: per ogni bot
  `module-null-sink` dedicati + Chromium con `PULSE_SINK` proprio. Niente dirottamento
  dell'audio host, multi-bot possibile, e il **microfono virtuale del bot** (necessario al
  ruolo parlante) è gestibile in modo pulito — cosa che su Windows non è possibile (un solo
  cavo virtuale, nessun input per-processo). La **Fase 1** gira però su Windows con il
  loopback `soundcard` (già implementato in `copilot.py`) per validare subito join + STT: il
  codice del joiner e degli adapter è identico, cambia solo il backend di `audio.py`.
- **Joiner in Playwright Python** (`pip install playwright` + `playwright install chromium`):
  una sola lingua col resto dello stack. (Node + Playwright è già installato e resta fallback.)

## 3. Architettura audio (backend WSL, per-bot)

```
WSL2 Ubuntu (WSLg: PulseAudio + display)
  ┌──────────────────────────────────────────────────────────────┐
  │ Chromium (Playwright Python)   PULSE_SINK=bot1_spk            │
  │    mic-in ◄ bot1_mic.monitor        spk-out ► bot1_spk        │
  └─────┬──────────────────────────────────────────┬─────────────┘
        │ iniezione TTS                             │ cattura call
  pacat ┘                                bot1_spk.monitor ─► parec
        ▲ float32→s16le                            │ s16le→float32 16k
  HandyTtsClient.audio   ◄── ws://<win>:8720 ──►   HandySttClient.utterances ─► brain loop
  (Handy gira su Windows, raggiungibile da WSL via rete mirrored)        │
                                         Hermes (ACP/WSL) → UI copilota / TTS (se parlante)
```

- **Isolamento**: 1 bot = coppia `botN_spk` / `botN_mic` + un Chromium col proprio `PULSE_SINK`.
  N bot = N coppie, nessuna interferenza.
- **Cattura** (voci dei partecipanti → STT): `parec` legge `botN_spk.monitor` → resample 16k →
  `HandySttClient.send_audio()`.
- **Iniezione** (TTS del bot → call): segmenti di `HandyTtsClient.audio` → resample → `pacat`
  verso `botN_mic`; il web client seleziona `botN_mic.monitor` come microfono.

**Backend Windows (solo Fase 1)**: Chromium sull'host → device di default → `soundcard`
loopback → STT; TTS → `sounddevice` sul cavo "Intelligo VAC" scelto come microfono dal web
client (riuso `copilot.py::_speak_worker` + `copilot_tts_output_device`).

## 4. Struttura del package

```
callbridge/meetbot/
  __init__.py
  bot.py            # MeetBotSession: join → cattura → STT → Hermes → [parla] → leave
  api.py            # blueprint Flask (start/stop/status), montato sul control_server
  audio.py          # backend audio per-bot: WindowsLoopbackAudio | PulseAudioBot
  transcribe.py     # TranscriptStore + diarizzazione (merge STT ↔ active-speaker)
  summary.py        # riepilogo finale via Hermes + salvataggio artefatti
  calendar_watch.py # poll Google Calendar → schedule del join
  adapters/
    __init__.py     # routing via matches(url)
    base.py         # MeetingAdapter (ABC) + JoinResult / SpeakerInfo
    meet.py         # Google Meet
    teams.py        # Microsoft Teams (web)
    zoom.py         # Zoom (web client)
    telegram.py     # userbot MTProto + pytgcalls (niente browser)
  artifacts/        # runtime: una cartella per riunione
```

## 5. Interfaccia adapter (`adapters/base.py`)

```python
@dataclass
class SpeakerInfo:
    name: str | None          # nome DOM dell'active speaker (None se ignoto)
    confidence: float = 0.0

@dataclass
class JoinResult:
    ok: bool
    state: str                # "in_call" | "waiting_admit" | "denied" | "error"
    detail: str = ""

class MeetingAdapter(ABC):
    name: str                 # "meet" | "teams" | "zoom"
    @staticmethod
    @abstractmethod
    def matches(url: str) -> bool: ...                       # routing per dominio
    @abstractmethod
    async def join(self, page, display_name: str, mic: bool, cam: bool) -> JoinResult: ...
    @abstractmethod
    async def is_in_call(self, page) -> bool: ...            # rileva "sei dentro"
    @abstractmethod
    async def active_speaker(self, page) -> SpeakerInfo: ... # scraping indicatore parlante
    @abstractmethod
    async def leave(self, page) -> None: ...
    async def send_chat(self, page, text: str) -> None: ...  # opz. (annuncio consenso)
    async def participants(self, page) -> list[str]: ...     # opz.
```

I selettori DOM per piattaforma sono centralizzati (aria-label IT/EN) per riparazioni rapide.
`telegram.py` non usa `page`: implementa `join_call(chat_id)` / `leave()` via Telethon +
pytgcalls (PCM diretto in/out), con la stessa logica ma percorso separato in `bot.py`.

## 6. Orchestratore di sessione (`bot.py`)

```python
class MeetBotSession:
    def __init__(self, cfg, brain, audio_backend, adapter, ui_post=None, speaking=False): ...
    def start(self): ...   # launch Chromium → adapter.join → thread cattura/brain/[speak]/poll
    def stop(self): ...    # leave + chiudi STT/TTS + flush artefatti + summary
```

Thread (modellati su `CopilotSession`):
- `meetbot-capture`: audio backend → resample 16k → `HandySttClient.send_audio`.
- `meetbot-brain`: `stt.utterances` → coalesce → `AcpAgentClient.respond(text, preamble=...)` →
  UI copilota (`overlay.post`) e/o `TranscriptStore.add`.
- `meetbot-speak` (se `speaking`): risposta scelta/auto → `HandyTtsClient` → microfono del bot;
  **turn-taking/barge-in** su `stt.speech_events` + `barge_in_energy_threshold` (si zittisce se
  un umano parla).
- `meetbot-speaker-poll`: ~300 ms `adapter.active_speaker(page)` → timeline nomi per la diarizzazione.

## 7. API di controllo (montata sul control_server, :8770, auth Bearer)

| Metodo | Endpoint | Body / Note |
|---|---|---|
| POST | `/meetbot/join` | `{ "url": "...", "speaking": false, "display_name": "Hermes Bot" }` → avvia un bot, ritorna `{session_id, state}` |
| POST | `/meetbot/leave` | `{ "session_id": "..." }` → il bot esce e produce gli artefatti |
| GET | `/meetbot/status` | `?session_id=...` → `{state, in_call, speaking, participants, last_utterance}` |
| GET | `/meetbot/list` | elenco sessioni attive |
| POST | `/meetbot/speak` | `{ "session_id": "...", "text": "..." }` → fa dire un testo al bot (modalità parlante) |

Registry delle sessioni in `api.py` (id → `MeetBotSession`).

## 8. Config (`callbridge/config.py`, campi `meetbot_*`, auto-caricati da JSON/env)

`meetbot_enabled`, `meetbot_backend` (`"wsl"|"windows"`), `meetbot_display_name="Hermes Bot"`,
`meetbot_speaking_default=False`, `meetbot_announce=True`,
`meetbot_announce_text="Assistente AI presente per trascrizione."`,
`meetbot_artifacts_dir`, `meetbot_calendar_poll_s`, `meetbot_wsl_distro="Ubuntu"`,
`meetbot_tts_output_device` (Windows).

## 9. Roadmap a fasi (ognuna con criterio "fatto")

1. **Skeleton — Meet, link manuale, solo ascolto → copilota (backend Windows).**
   File: `meetbot/{__init__,bot,audio(WindowsLoopbackAudio),api}.py`, `adapters/{base,meet}.py`,
   wiring in `control_server.py` + `config.py`.
   *Fatto*: link Meet → Chromium entra (nome, mic/cam off, "Chiedi di partecipare", admit) →
   log `STT -> ...` → la finestra Copilota mostra CONTESTO/RISPOSTE.
2. **Backend WSL + ruolo parlante.** `audio.py::PulseAudioBot` (null-sink/source, parec/pacat),
   `bot.py` (thread speak + turn-taking + annuncio consenso), config `meetbot_backend/announce`.
   *Fatto*: il bot annuncia la presenza, legge una risposta di Hermes nel mic virtuale, si zittisce
   se un umano parla.
3. **Teams + Zoom.** `adapters/{teams,zoom}.py` + routing. *Fatto*: stesso E2E su Teams web e Zoom web.
4. **Auto-join Google Calendar.** `calendar_watch.py` + thread in `main.py`. Approccio locale:
   `AcpAgentClient` (Hermes ha la MCP Calendar) → poll eventi con link → `threading.Timer` →
   `MeetBotSession.start`; fallback Google API locale (OAuth su file). *Fatto*: evento con link Meet
   → il bot entra da solo all'orario.
5. **Telegram.** `adapters/telegram.py` + branch in `bot.py`. Deps `telethon` + `py-tgcalls`.
   *Fatto*: il bot entra in un group call, trascrive e (opz.) parla.
6. **Diarizzazione + registrazione + riepilogo.** `transcribe.py` (merge utterance↔active_speaker
   per timestamp), `summary.py` (Hermes), registrazione `ffmpeg` del `*_spk.monitor`.
   *Fatto*: `artifacts/<meeting>/` con `transcript.jsonl` (speaker+testo), `recording.ogg`, `summary.md`.

## 10. Riuso dal codice esistente (path)

- `callbridge/stt_client.py::HandySttClient` (`send_audio`, `.utterances`, `.speech_events`) e
  `callbridge/tts_client.py::HandyTtsClient` (`configure/send_text/flush`, `.audio`) → **riuso diretto**.
- `callbridge/copilot.py` → modello per `audio.py` Windows (`_capture`), iniezione TTS
  (`_speak_worker` + `copilot_tts_output_device`), loop cervello (`_brain_loop`/`_coalesce`),
  UI suggerimenti (`CopilotWindow`/`CopilotController`, `copilot_hide_from_capture`).
- `callbridge/audio_hfp.py::resample`; `callbridge/acp_client.py::AcpAgentClient.respond(text, preamble=...)`
  + `main.py::_build_brains` (cervello/riepilogo/calendario).
- `callbridge/control_server.py::create_app` (montare il blueprint, auth Bearer);
  `main.py::_cmd_all` (avviare il watcher calendario); `callbridge/media.py` (servire artefatti);
  `callbridge/config.py::Config` (campi `meetbot_*`).

## 11. Dipendenze e setup

- `requirements.txt`: `playwright>=1.49` (poi `python -m playwright install chromium`).
  Fase 5: `telethon`, `py-tgcalls`. Fase 4 (fallback): `google-api-python-client`, `google-auth-oauthlib`.
- WSL Ubuntu (Fase 2+): `sudo apt install pulseaudio-utils` (parec/pacat/pactl), verificare WSLg
  PulseAudio (`pactl info`), `playwright install-deps`. Handy raggiungibile da WSL via rete mirrored.
- **Nessun servizio cloud.**

## 12. Rischi, legalità, mitigazioni

- **ToS / anti-bot** (Meet/Teams/Zoom vietano l'automazione non autorizzata): profilo Chromium
  realistico, nome bot esplicito, niente bypass di captcha; è uso personale/consensuale → mitiga
  ma non elimina. Selettori in un solo file per riparazioni rapide.
- **Consenso legale (registrazione/trascrizione)**: in UE (GDPR) e in molti stati USA serve
  informare/consenso. **Annuncio obbligatorio** all'ingresso (TTS + chat), `meetbot_announce`
  default ON; consenso registrato nel log.
- **Gate "admit"**: stato `waiting_admit`, timeout/retry; per i ricorrenti far entrare l'host.
- **Fragilità DOM**: adapter isolati, healthcheck `is_in_call`, screenshot on-error negli artefatti.
- **Diarizzazione best-effort**: l'active-speaker DOM è impreciso → fallback "Speaker N"; non
  bloccare mai la trascrizione se manca il nome.
- **Isolamento/concorrenza**: 1 bot su Windows (rischio dirottamento audio) → WSL canonico dalla
  Fase 2; limitare i TTS concorrenti per il carico GPU di Handy.

## 13. Verifica end-to-end (v1)

1. `pip install playwright && python -m playwright install chromium`; Handy su :8720; brain ACP
   o `hermes_mode=stub`.
2. `python main.py all` (monta `meetbot/api.py` su :8770).
3. Crea una Meet di test da un altro account, copia il link.
4. `POST /meetbot/join {"url":"...","speaking":false}` (Bearer control token) → Chromium entra
   (nome "Hermes Bot", mic/cam off, "Chiedi di partecipare"); ammetti il bot dall'host.
5. Parla nella Meet → log `STT -> ...` + finestra Copilota con CONTESTO/RISPOSTE.
   `POST /meetbot/leave` → il bot esce.

**Successo v1** = join automatico + admit superato + enunciati STT nel log + suggerimenti
copilota visibili.
