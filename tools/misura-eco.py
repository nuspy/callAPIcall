"""Quanto si risente l'avatar dal proprio microfono, e quante frasi si inventa (fase 0d)

Prerequisito del vivavoce full-duplex: l'eco della voce dell'avatar deve
scendere sotto la soglia oltre la quale lo STT la trascrive. Oggi sul PC non
c'è nessuna cancellazione d'eco — `audio_hfp.py` apre un `sd.InputStream`
grezzo — e le difese sono tutte a valle: un cancello di energia e un filtro
testuale che confronta le parole con quelle appena dette. Sono toppe, e il
commento in `voice_gateway.py:113-119` racconta come ci si è arrivati: *"lo STT
lo trascrive e il barge-in scatta su se stesso"*.

Questa è la misura contro cui giudicare qualunque AEC si aggiunga dopo. Suona
un WAV dalle casse, registra dal microfono e misura due cose:

  ERL   (Echo Return Loss): di quanti decibel la stanza attenua ciò che esce
        prima che rientri. Più è alto, meno lavoro deve fare il cancellatore.
  frasi fantasma: quante volte lo STT, sentendo solo l'avatar, produce un
        enunciato — che è il modo in cui il difetto si manifesta davvero.

Tre livelli, perché il problema compare col volume. Non tocca il volume di
sistema: attenua il segnale digitale, il che è equivalente per questa misura.

    python tools/misura-eco.py
    python tools/misura-eco.py --livelli 0.25 0.5 1.0
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import time
import urllib.request
import wave
from pathlib import Path

import numpy as np
import sounddevice as sd

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.config import Config  # noqa: E402

RATE = 16000


def leggi_wav(p: str) -> tuple[np.ndarray, int]:
    with wave.open(p) as w:
        n, sr = w.getnframes(), w.getframerate()
        x = np.frombuffer(w.readframes(n), dtype="<i2").astype(np.float32) / 32768.0
    if w.getnchannels() > 1:
        x = x.reshape(-1, w.getnchannels()).mean(axis=1)
    return x, sr


def rms(x: np.ndarray) -> float:
    return float(np.sqrt((x ** 2).mean())) if x.size else 0.0


def trascrivi(base: str, x: np.ndarray, sr: int) -> str:
    """Manda la registrazione allo STT del bridge e ritorna il testo."""
    import io as _io
    buf = _io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    dati = buf.getvalue()
    confine = "----eco"
    corpo = (f"--{confine}\r\nContent-Disposition: form-data; name=\"file\"; "
             f"filename=\"eco.wav\"\r\nContent-Type: audio/wav\r\n\r\n").encode()
    corpo += dati + f"\r\n--{confine}--\r\n".encode()
    req = urllib.request.Request(
        f"{base}/transcribe", corpo,
        {"Content-Type": f"multipart/form-data; boundary={confine}"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return (json.loads(r.read()).get("text") or "").strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--livelli", type=float, nargs="+", default=[0.25, 0.5, 1.0])
    ap.add_argument("--wav", default="", help="vuoto = un avatar_say_*.wav da %TEMP%")
    args = ap.parse_args()

    p = args.wav or (sorted(glob.glob(os.path.join(
        os.environ.get("TEMP", "."), "avatar_say_*.wav"))) or [""])[0]
    if not p or not os.path.isfile(p):
        print("  nessun WAV da riprodurre (passa --wav)")
        return 1
    x, sr = leggi_wav(p)
    cfg = Config.load()
    base = f"http://127.0.0.1:{cfg.handy_compat_port}"

    di, do = sd.default.device
    disp = sd.query_devices()
    print(f"  riproduco: {os.path.basename(p)}  ({len(x)/sr:.1f}s)")
    print(f"  uscita:   {disp[do]['name'] if isinstance(do, int) else do}")
    print(f"  ingresso: {disp[di]['name'] if isinstance(di, int) else di}")
    print("\n  ATTENZIONE: l'audio esce dalle casse. Resta in silenzio durante la prova.\n")
    print(f"  {'livello':>8} {'rif dBFS':>9} {'eco dBFS':>9} {'ERL dB':>8}  frase fantasma")

    for livello in args.livelli:
        suono = np.clip(x * livello, -1, 1)
        catturato: list[np.ndarray] = []

        def _in(indata, frames, t, status):  # noqa: ANN001, ARG001
            catturato.append(indata[:, 0].copy())

        with sd.InputStream(samplerate=RATE, channels=1, dtype="float32",
                            callback=_in):
            time.sleep(0.4)                       # rumore di fondo prima
            sd.play(suono, sr, blocking=True)
            time.sleep(0.4)
        eco = np.concatenate(catturato) if catturato else np.zeros(0, np.float32)
        r_rif, r_eco = rms(suono), rms(eco)
        db = lambda v: 20 * np.log10(v) if v > 1e-9 else -120.0  # noqa: E731
        erl = db(r_rif) - db(r_eco)
        testo = ""
        try:
            testo = trascrivi(base, eco, RATE)
        except Exception as e:  # noqa: BLE001
            testo = f"(STT non raggiungibile: {type(e).__name__})"
        print(f"  {livello:>8.2f} {db(r_rif):>9.1f} {db(r_eco):>9.1f} {erl:>8.1f}  "
              f"{testo[:46]!r}")
        time.sleep(1.0)

    print("\n  Come si legge: ERL alto = la stanza attenua molto e il cancellatore")
    print("  ha vita facile. Una frase fantasma non vuota significa che a quel")
    print("  volume l'avatar si interromperebbe da solo, oggi.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
