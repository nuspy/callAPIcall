"""Test Kokoro TTS via Handy — synthesize text and save as WAV."""
import json
import wave
import struct
import numpy as np
from websocket import WebSocketApp
import threading
import time

TEXT = "Ciao Andrea! Sono il tuo agente telefonico callAPIcall, con la voce di Sara. Il sistema è completamente operativo e pronto a fare e ricevere chiamate reali!"
VOICE = "if_sara"
LANG = "it"
OUTPUT = r"C:\Projects\callAPIcall\test_tts.wav"
WS_URL = "ws://127.0.0.1:8720/tts/stream"

audio_segments = []
ready_event = threading.Event()
done_event = threading.Event()

def on_open(ws):
    print("WS connected")

def on_message(ws, message):
    if isinstance(message, (bytes, bytearray)):
        samples = np.frombuffer(message, dtype="<f4").copy()
        audio_segments.append(samples)
        print(f"  Got audio segment: {len(samples)} samples")
    else:
        msg = json.loads(message)
        mtype = msg.get("type")
        print(f"  WS msg: {mtype}")
        if mtype == "ready":
            ready_event.set()
        elif mtype == "audio_end":
            # Check if this is the last one
            pass

def on_error(ws, error):
    print(f"WS error: {error}")

def on_close(ws, code, reason):
    print(f"WS closed: {code} {reason}")
    done_event.set()

ws = WebSocketApp(WS_URL, on_open=on_open, on_message=on_message,
                  on_error=on_error, on_close=on_close)

t = threading.Thread(target=ws.run_forever, daemon=True)
t.start()

print("Waiting for ready...")
if not ready_event.wait(5):
    print("TIMEOUT waiting for ready")
    exit(1)

print("Configuring voice...")
ws.send(json.dumps({"type": "config", "voice": VOICE, "lang": LANG, "speed": 1.0}))
time.sleep(0.5)

print(f"Sending text: {TEXT[:50]}...")
ws.send(json.dumps({"type": "text", "chunk": TEXT}))
ws.send(json.dumps({"type": "flush"}))
time.sleep(0.5)
ws.send(json.dumps({"type": "end"}))

print("Waiting for synthesis...")
done_event.wait(10)

# Save as WAV
if audio_segments:
    all_audio = np.concatenate(audio_segments)
    # Normalize to int16
    audio_int16 = np.clip(all_audio * 32767, -32768, 32767).astype(np.int16)
    
    with wave.open(OUTPUT, 'w') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(24000)
        f.writeframes(audio_int16.tobytes())
    
    duration = len(all_audio) / 24000
    print(f"\n✅ Saved {OUTPUT}")
    print(f"   Duration: {duration:.1f}s")
    print(f"   Samples: {len(all_audio)}")
    print(f"   Rate: 24000 Hz")
else:
    print("❌ No audio received!")

ws.close()
