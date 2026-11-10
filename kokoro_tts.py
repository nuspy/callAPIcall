#!/usr/bin/env python3
"""Kokoro TTS wrapper for Hermes command TTS provider.

Called by Hermes TTS tool with:
  python kokoro_tts.py <input_text_path> <output_audio_path>

Reads text from input file, synthesizes via Handy Kokoro TTS WebSocket,
writes WAV to output path.
"""
import json, wave, sys, time, threading
import numpy as np
from websocket import WebSocketApp

# --- Config ---
WS_URL = "ws://127.0.0.1:8720/tts/stream"
VOICE = "if_sara"
LANG = "it"
SPEED = 1.0

# --- Args ---
if len(sys.argv) < 3:
    print("Usage: kokoro_tts.py <input_text_path> <output_audio_path>", file=sys.stderr)
    sys.exit(1)

INPUT_PATH = sys.argv[1]
OUTPUT_PATH = sys.argv[2]

# Read input text
with open(INPUT_PATH, "r", encoding="utf-8") as f:
    TEXT = f.read().strip()

if not TEXT:
    print("Empty input text", file=sys.stderr)
    sys.exit(1)

# --- WebSocket TTS ---
audio_segments = []
ready_event = threading.Event()
done_event = threading.Event()
synth_count = 0

def on_open(ws):
    pass

def on_message(ws, message):
    global synth_count
    if isinstance(message, (bytes, bytearray)):
        samples = np.frombuffer(message, dtype="<f4").copy()
        audio_segments.append(samples)
        synth_count += 1
    else:
        msg = json.loads(message)
        mtype = msg.get("type")
        if mtype == "ready":
            ready_event.set()
        elif mtype == "error":
            print(f"TTS error: {msg.get('message')}", file=sys.stderr)

def on_error(ws, error):
    print(f"WS error: {error}", file=sys.stderr)
    done_event.set()

def on_close(ws, code, reason):
    done_event.set()

ws = WebSocketApp(WS_URL, on_open=on_open, on_message=on_message,
                  on_error=on_error, on_close=on_close)
t = threading.Thread(target=ws.run_forever, daemon=True)
t.start()

if not ready_event.wait(8):
    print("TIMEOUT waiting for Handy TTS", file=sys.stderr)
    sys.exit(1)

# Configure and send
ws.send(json.dumps({"type": "config", "voice": VOICE, "lang": LANG, "speed": SPEED}))
time.sleep(0.2)
ws.send(json.dumps({"type": "text", "chunk": TEXT}))
time.sleep(0.3)
ws.send(json.dumps({"type": "flush"}))
time.sleep(0.3)
ws.send(json.dumps({"type": "end"}))

# Wait for synthesis
done_event.wait(20)
ws.close()
time.sleep(0.5)

# Write output WAV
if audio_segments:
    all_audio = np.concatenate(audio_segments)
    audio_int16 = np.clip(all_audio * 32767, -32768, 32767).astype(np.int16)
    with wave.open(OUTPUT_PATH, 'w') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(audio_int16.tobytes())
    duration = len(all_audio) / 24000
    print(f"OK: {duration:.1f}s, {len(all_audio)} samples", file=sys.stderr)
else:
    print("No audio received", file=sys.stderr)
    sys.exit(1)
