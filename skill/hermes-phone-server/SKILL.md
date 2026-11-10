---
title: hermes-phone-server
name: hermes-phone-server
description: Voice AI agent con tool-calling, model selection dinamico, VAD timing fixes via WSL + Windows NSSM service.
category: phone-calls
---

# Hermes Phone Server (WSL + Windows NSSM)

**Trigger:** Voice AI agent con tool-calling, model selection dinamico, VAD timing fixes.

## Architettura
- **NSSM service**: `callAPIcall-orchestrator` su Windows → `C:\Projects\callAPIcall\call-bridge\main.py serve`
- **WSL relay**: `wslrelay.exe` su :8780 (ascolta da Windows)
- **Phone server**: `hermes_phone_server.py` in WSL Linux (`~/.hermes/`)
- **Model**: LM Studio su WSL (`127.0.0.1:1234/v1`) o Z.AI (`glm-5.1`)

## File Sync
**Windows (distributable)**: `/mnt/c/Projects/callAPIcall/`
**WSL (skill mirror)**: `~/.hermes/`
**CRITICAL**: Qualsiasi modifica deve essere copiata manualmente tra le due posizioni. Non esiste sync automatico.

## Tool-calling Strategies
1. **Native OpenAI tool-calling** (per modelli compatibili)
2. **Text-based `[TOOL_REQUEST]` interception** per qwen3.5
3. **Pre-search injection fallback**

## Dynamic Model Resolution
Legge `~/.hermes/config.yaml` su ogni richiesta via `_get_active_client()`.

## VAD Timing Fixes (Three-Layer Defense)
1. **Layer 1**: `_last_tts_end_time` tracking per scartare utterance post-TTS
2. **Layer 2**: Audio drain delay prima di riaprire il gate
3. **Layer 3**: Energy-based VAD gate per prevenire echo-triggered false positives

## Commands
```bash
# Restart service
cmd.exe /c "net start callAPIcall-orchestrator"

# Kill Python processes (fallback se NSSM non funziona)
cmd.exe /c "taskkill /F /IM python.exe"

# Check status
cmd.exe /c "sc query callAPIcall-orchestrator"
```

## Pitfalls
- **Service slow stop**: `STOP_PENDING` può bloccarsi. Usare `taskkill /F /IM python.exe` come fallback.
- **Port mapping**: WSL service su `0.0.0.0:8780` raggiungibile da Windows come `127.0.0.1:8780`
- **Model statico**: LM Studio è fisso a qwen3.5, non dinamico
- **DuckDuckGo 0 results**: Usare `ddgs` invece di `duckduckgo_search` deprecated
