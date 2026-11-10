#!/usr/bin/env python3
"""STT wrapper per Hermes: file audio -> testo, via callAPIcall /transcribe.

Usage:
  python transcribe.py <audio_file>     # stampa il testo trascritto su stdout

L'endpoint http://127.0.0.1:8720/transcribe e' servito dal motore NATIVO del
bridge callAPIcall (whisper in-process) — non serve alcuna app esterna.
Accetta WAV/FLAC/OGG/MP3 (decodifica via soundfile lato server).

Env:
  CALLBRIDGE_STT_URL   (default http://127.0.0.1:8720/transcribe)

Requirements: requests
"""
import os
import sys

try:
    import requests
except ImportError:
    print("transcribe.py richiede 'requests' (pip install requests)", file=sys.stderr)
    sys.exit(1)

if len(sys.argv) < 2:
    print("Usage: transcribe.py <audio_file>", file=sys.stderr)
    sys.exit(1)

path = sys.argv[1]
url = os.environ.get("CALLBRIDGE_STT_URL", "http://127.0.0.1:8720/transcribe")

if not os.path.isfile(path):
    print(f"File non trovato: {path}", file=sys.stderr)
    sys.exit(1)

try:
    with open(path, "rb") as f:
        resp = requests.post(url, files={"file": (os.path.basename(path), f)},
                             timeout=180)
    resp.raise_for_status()
    text = (resp.json() or {}).get("text", "")
except Exception as e:  # noqa: BLE001
    print(f"transcribe error: {e}", file=sys.stderr)
    sys.exit(1)

print(text)
