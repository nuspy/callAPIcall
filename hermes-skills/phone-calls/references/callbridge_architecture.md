# Call-Bridge Architecture

## Entry Points

`main.py` supports two subcommands:

| Command | Purpose | Components Launched |
|---------|---------|-------------------|
| `main.py serve` | Full orchestrator | Control server (Flask 8770) + incoming call watcher + PTT (if enabled) |
| `main.py ptt` | Standalone PTT | PTT only (WARNING: conflicts with `serve` if both running) |

## Process Architecture

```
main.py serve (PID xxxxx, Python 3.12)
├── Flask control_server on 127.0.0.1:8770
│   ├── /status, /health, /models/available, /prepare, /models/unload
│   └── Used by callctl.py CLI
├── Incoming call watcher (bridge.start_incoming_watcher)
│   └── Watches for phone calls → auto-answer → streaming session
└── PushToTalkManager (if config.push_to_talk_enabled=true)
    └── Registers global hotkeys: Shift+F1, Shift+F2, Shift+F3
```

## Critical: PTT is INSIDE serve

`control_server.py` lines 172-173:
```python
if config.push_to_talk_enabled:
    PushToTalkManager(config, bridge.hermes).start()
```

The PTT is NOT a separate service — it's a thread inside the `serve` process. Running `main.py ptt` standalone creates a SECOND `pynput` keyboard listener that conflicts with the one already registered by `serve`.

**Rule**: Only run `main.py serve`. Never run `main.py ptt` alongside it.

## Brain Types (acp_enabled=false)

When `acp_enabled=false` in `config.json`, all three hotkeys use `HermesClient` (HTTP to phone server):

| Hotkey | Brain | Brain Function |
|--------|-------|---------------|
| Shift+F1 | brain_full | Full agent (HermesClient) |
| Shift+F2 | brain_full | Full agent (HermesClient) |
| Shift+F3 | brain_limited | Limited agent (HermesClient) |

## Data Flow (PTT → LLM → TTS)

```
Shift+F1 pressed
  → PushToTalkManager._on_hotkey()
    → StreamingSession.start()
      → STT (Whisper via WebSocket 8720/STT)
        → text transcript
          → _brain() → HermesClient.respond() [or AcpAgentClient if acp_enabled]
            → HTTP POST /utterance to phone server (SSE)
              → LLM streaming (OpenAI-compatible)
                → SSE chunks: str (text) or dict (voice_change)
                  → _brain() processes:
                    - str → TTS synthesis via WebSocket 8720/TTS
                    - dict (voice_change) → tts.configure(voice, lang)
                      → Audio playback via sounddevice
```

## Config Files

| File | Location | Purpose |
|------|----------|---------|
| `config.json` | `call-bridge/` | Orchestrator config (hermes_mode, base_url, voices, PTT settings, acp_enabled) |
| `~/.hermes/config.yaml` | Hermes home | LLM model/provider config (read by phone server at startup) |
| `~/.hermes/.env` | Hermes home | API keys (GLM_API_KEY, etc.) |

## File Modification Safety

- **ALWAYS use `patch`** for callbridge files — they have complex interdependencies
- **NEVER use `write_file`** — it completely overwrites, losing code not visible in context
- After modifying `.py` files via WSL (`/mnt/c/...`), clear `__pycache__/` and restart `main.py serve`
