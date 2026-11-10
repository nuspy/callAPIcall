# 4-Phase Post-TTS Audio Flow — Implementation Detail

## Problem

In half-duplex mode (Shift+F1, casse), after the TTS finishes speaking:

1. The `_uplink` thread writes PCM to `sd.OutputStream`
2. `tts.audio` queue empties → `_tts_active.clear()` (after 0.5s timeout)
3. `_wait_tts_finished()` sees quiet for 0.6-1.0s → returns
4. **BUT** the sounddevice buffer is still playing the last 100-500ms of audio
5. The mic picks up this residual echo from the speakers
6. The STT transcribes it as a spurious utterance
7. Hermes processes it → the agent "responds to nothing"

## Root Cause: `_tts_active` ≠ Real Audio Output

`_tts_active` is based on the **internal queue** (`tts.audio`), not on the **actual audio leaving the speakers**. There's a 200-500ms gap between "last write to sounddevice" and "sound physically coming out of the speakers" (OS audio buffer + DAC latency).

## Solution: 3 Events, 4 Phases

### Events

| Event | Purpose |
|-------|---------|
| `_processing` | Turn in progress. When SET: mic is completely muted (downlink skips audio). |
| `_listening` | Brain accepts utterances. When CLEAR: brain discards utterances even if mic is active. |
| `_tts_active` | TTS is producing audio (set by uplink, cleared on queue timeout). |

### Phase Flow

```
                    _processing  _listening  _tts_active
                    ----------  ----------  -----------
IDLE (initial)     CLEAR        SET         CLEAR
User speaks        CLEAR        SET         CLEAR
  → _processing.set()
  → _listening.clear()
Reasoning           SET         CLEAR       CLEAR
TTS speaks         SET         CLEAR       SET
  → _wait_tts_finished() [quiet=1.0s]
FASE 1 complete    SET         CLEAR       CLEAR
  → sleep(ptt_post_tts_pause_s=1.0)
FASE 2 complete    SET         CLEAR       CLEAR
  → drain stt.utterances
  → _processing.clear()
Warmup             CLEAR        CLEAR       CLEAR
  → sleep(ptt_listen_warmup_s=0.8)
  → drain stt.utterances
  → _listening.set()
FASE 4: IDLE       CLEAR        SET         CLEAR ← ready for next input
```

### Key Timing Parameters

| Parameter | Default | Where | Effect |
|-----------|---------|-------|--------|
| `quiet` | 1.0s | `_wait_tts_finished()` param | How long the TTS queue must be empty before declaring "done" |
| `ptt_post_tts_pause_s` | 1.0s | `config.py` / `config.json` | Mic stays MUTE after TTS done (let echo die) |
| `ptt_listen_warmup_s` | 0.8s | `config.py` / `config.json` | Mic ON but brain ignores (STT calibrates on real noise) |

**Total protection**: ~2.8s from last TTS chunk to first accepted utterance.

### Downlink Logic (audio → STT)

```python
if self.half_duplex:
    if self._processing.is_set():
        continue  # Phase 1-2: mic completely muted
    # Phase 3-4: mic active, audio goes to STT
    # (brain decides whether to accept based on _listening)
```

### Brain Logic (utterance → Hermes)

```python
# At top of brain loop, before processing:
if self.half_duplex and not self._listening.is_set():
    log.debug("Brain: enunciato scartato (non in ascolto)")
    continue  # Discard utterances during warmup
```

## Diagnosis: How to Tell if Echo is the Problem

Symptoms:
- Agent responds immediately after finishing its own speech, without user saying anything
- STT logs show utterances that are fragments of what the TTS just said
- Happens consistently with casse/speakers, NOT with cuffie/headphones

Fix: Increase `ptt_post_tts_pause_s` (try 1.5s) and/or `ptt_listen_warmup_s` (try 1.2s).
