# Voice Change Protocol — Automatic Language Detection

## Problem

When a user switches language mid-call (e.g., Italian → English), the LLM text changes language but the TTS voice stays the same (e.g., Italian `if_sara` speaking English with Italian pronunciation = incomprehensible).

## Solution

A 3-component SSE protocol that detects language change and switches TTS voice at runtime.

## Architecture

```
User speaks English
  → STT transcribes: "Hello, can you help me?"
    → Phone server: _detect_language() → "en"
      → Session lang was "it" → different → emit SSE {"voice_change": {"voice":"af_heart","lang":"en-us"}}
        → HermesClient.respond() yields dict (not str)
          → streaming.py _brain: isinstance(text_chunk, dict) → tts.configure(voice="af_heart", lang="en-us")
            → Subsequent chunks synthesized with English voice
```

## Files Modified

| File | Change |
|------|--------|
| `templates/hermes_phone_server.py` | Added `_detect_language()`, `LANG_VOICE_MAP`, `LANG_DETECT_INSTRUCTION`. `llm_respond()` yields JSON `voice_change` event before text chunks when language changes. |
| `callbridge/hermes_client.py` | `respond()` return type changed to `Iterator[str | dict]`. Yields dict for `voice_change` SSE events. |
| `callbridge/streaming.py` | `_brain()` checks `isinstance(text_chunk, dict)` and calls `tts.configure(voice, lang)` on voice_change events. |

## SSE Event Format

```
data: {"voice_change": {"voice": "af_heart", "lang": "en-us"}}

data: {"chunk": "Hello!"}

data: {"done": true}
```

The `voice_change` event is emitted BEFORE any text chunks for that turn.

## Language Detection

`_detect_language()` uses simple heuristics:
- CJK/Hiragana/Katakana/Devanagari character detection for ja/cmn/hi
- Common word sets for Latin-script languages (it, en, fr, es, pt)
- Minimum 2 matching words required to trigger detection
- Returns `None` for unsupported languages (hu, de, etc.) → no voice change

## Language → Voice Map

| Lang | Voice | TTS lang code |
|------|-------|---------------|
| it | if_sara | it |
| en | af_heart | en-us |
| en-gb | bf_emma | en-gb |
| fr | ff_siwis | fr-fr |
| es | ef_dora | es |
| pt | pf_dora | pt-br |
| ja | jf_alpha | ja |
| cmn | zf_xiaoxiao | cmn |
| hi | hf_alpha | hi |

## Limitations

- Hungarian (hu), German (de), and many others have NO Kokoro voice → no automatic switch possible
- Detection is heuristic-based, not a full NLP model — may miss on short or ambiguous phrases
- Voice change only applies per-turn (detected from user text, not from LLM response)
