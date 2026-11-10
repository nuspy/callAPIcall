#!/usr/bin/env python3
"""Kokoro TTS wrapper for Hermes command TTS provider.

Called by Hermes TTS tool (via kokoro_tts.sh wrapper) with:
  python kokoro_tts.py <input_text_path> <output_audio_path>

Reads text from input file, synthesizes via the callAPIcall TTS WebSocket,
writes WAV (24kHz mono int16) to output path.

NB (MonolitOne): l'endpoint ws://127.0.0.1:8720/tts/stream NON e' piu' l'app
Handy: e' il server NATIVO del bridge callAPIcall (motore Kokoro in-process).
Nessuna app esterna da avviare.

Voce / lingua:
  - override espliciti via env CALLBRIDGE_TTS_VOICE / CALLBRIDGE_TTS_LANG /
    CALLBRIDGE_TTS_SPEED (se impostati vincono);
  - altrimenti la lingua viene RILEVATA dal testo e si sceglie una voce Kokoro
    coerente (cosi' l'audio segue la lingua del testo, non e' fisso in italiano);
  - fallback: if_sara / it.

Requirements: websocket-client, numpy
"""
import json, os, re, sys, threading, time, wave
import numpy as np
from websocket import WebSocketApp

WS_URL = os.environ.get("CALLBRIDGE_TTS_WS", "ws://127.0.0.1:8720/tts/stream")

# lingua rilevata -> (voce Kokoro, lang string per il TTS). Voci v1.0 reali.
_LANG_VOICE = {
    "it": ("if_sara", "it"), "en": ("af_heart", "en-us"), "fr": ("ff_siwis", "fr-fr"),
    "es": ("ef_dora", "es"), "pt": ("pf_dora", "pt-br"), "ja": ("jf_alpha", "ja"),
    "cmn": ("zf_xiaoxiao", "cmn"), "hi": ("hf_alpha", "hi"),
}

# parole-spia per le lingue latine (soglia >=2); CJK/Devanagari per script.
_HINTS = {
    "it": {"ciao","come","stai","grazie","bene","sono","che","non","perché","anche",
           "questo","sei","ho","ti","è","più","voglio","puoi","adesso","allora"},
    "en": {"hello","the","is","you","are","what","thank","please","good","yes","no",
           "can","want","need","this","that","with","have","will","would","and"},
    "fr": {"bonjour","merci","oui","non","comment","bien","avec","pour","que","est",
           "vous","je","suis","pas","une","dans"},
    "es": {"hola","gracias","cómo","estás","bien","por","qué","donde","puedo","quiero",
           "buenos","días","tengo","esto","ahora","una"},
    "pt": {"olá","obrigado","como","está","bem","sim","não","por","que","onde","posso",
           "quero","bom","dia","você","isso","uma"},
}


def _detect_lang(text: str) -> str:
    t = (text or "").lower()
    if len(re.findall(r"[ऀ-ॿ]", t)) >= 2:
        return "hi"
    if len(re.findall(r"[぀-ヿ]", t)) >= 2:
        return "ja"
    if len(re.findall(r"[一-鿿]", t)) >= 2:
        return "cmn"
    words = set(re.findall(r"[a-zà-ÿ]+", t))
    scores = {code: len(words & h) for code, h in _HINTS.items()}
    best = max(scores, key=scores.get) if scores else "it"
    return best if scores.get(best, 0) >= 2 else "it"


def _resolve_voice_lang(text: str):
    v_env = os.environ.get("CALLBRIDGE_TTS_VOICE")
    l_env = os.environ.get("CALLBRIDGE_TTS_LANG")
    if v_env and l_env:
        return v_env, l_env
    voice, lang = _LANG_VOICE.get(_detect_lang(text), ("if_sara", "it"))
    return (v_env or voice), (l_env or lang)


if len(sys.argv) < 3:
    print("Usage: kokoro_tts.py <input_text_path> <output_audio_path>", file=sys.stderr)
    sys.exit(1)

INPUT_PATH, OUTPUT_PATH = sys.argv[1], sys.argv[2]
with open(INPUT_PATH, "r", encoding="utf-8") as f:
    TEXT = f.read().strip()
if not TEXT:
    print("Empty input text", file=sys.stderr)
    sys.exit(1)

VOICE, LANG = _resolve_voice_lang(TEXT)
SPEED = float(os.environ.get("CALLBRIDGE_TTS_SPEED", "1.0"))
print(f"[kokoro_tts] voice={VOICE} lang={LANG} speed={SPEED}", file=sys.stderr)

# --- WebSocket TTS ---
audio_segments = []
ready_event = threading.Event()
done_event = threading.Event()


def on_message(ws, message):
    if isinstance(message, (bytes, bytearray)):
        audio_segments.append(np.frombuffer(message, dtype="<f4").copy())
    else:
        msg = json.loads(message)
        if msg.get("type") == "ready":
            ready_event.set()
        elif msg.get("type") == "error":
            print(f"TTS error: {msg.get('message')}", file=sys.stderr)


def on_error(ws, error):
    print(f"WS error: {error}", file=sys.stderr)
    done_event.set()


def on_close(ws, code, reason):
    done_event.set()


ws = WebSocketApp(WS_URL, on_message=on_message, on_error=on_error, on_close=on_close)
threading.Thread(target=ws.run_forever, daemon=True).start()

if not ready_event.wait(8):
    print("TIMEOUT waiting for TTS", file=sys.stderr)
    sys.exit(1)

ws.send(json.dumps({"type": "config", "voice": VOICE, "lang": LANG, "speed": SPEED}))
time.sleep(0.2)
ws.send(json.dumps({"type": "text", "chunk": TEXT}))
time.sleep(0.3)
ws.send(json.dumps({"type": "flush"}))
time.sleep(0.3)
ws.send(json.dumps({"type": "end"}))

done_event.wait(20)
ws.close()
time.sleep(0.5)

if audio_segments:
    all_audio = np.concatenate(audio_segments)
    audio_int16 = np.clip(all_audio * 32767, -32768, 32767).astype(np.int16)
    with wave.open(OUTPUT_PATH, "w") as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(audio_int16.tobytes())
    print(f"OK: {len(all_audio)/24000:.1f}s, {len(all_audio)} samples", file=sys.stderr)
else:
    print("No audio received", file=sys.stderr)
    sys.exit(1)
