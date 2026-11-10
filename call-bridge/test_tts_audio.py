"""Test end-to-end: Hermes -> Handy TTS -> casse di Windows.

Carica il TTS in Handy, chiede a Hermes una frase, la sintetizza via
/tts/stream e la riproduce sul device audio di default del sistema.
"""
from __future__ import annotations

import queue
import sys
import time

import numpy as np
import requests
import sounddevice as sd

sys.path.insert(0, r"C:\Projects\callAPIcall\call-bridge")
from callbridge.config import Config
from callbridge.hermes_client import HermesClient
from callbridge.tts_client import HandyTtsClient


def main() -> int:
    cfg = Config.load()
    print(f"Handy={cfg.handy_base_url()}  Hermes={cfg.hermes_base_url}  "
          f"voce={cfg.default_voice} lang={cfg.default_lang}")

    # 1) Carica il TTS (Kokoro/Piper a seconda di selected_tts_model in Handy).
    print("Carico il TTS in Handy...")
    r = requests.post(cfg.handy_base_url() + "/models/load",
                      json={"tts": True}, timeout=180)
    print("  /models/load ->", r.json())

    # 2) Chiedi a Hermes una frase.
    hermes = HermesClient(cfg)
    sid = "tts-audio-test"
    hermes.notify_outgoing(sid, "(test audio)", cfg.default_voice, cfg.default_lang)
    print("Chiedo a Hermes una frase...")
    text = "".join(
        hermes.respond(sid,
                       "Genera una breve frase di saluto in italiano per testare l'audio.",
                       "OUTGOING")
    ).strip()
    hermes.call_ended(sid)
    if text:
        print("  Hermes:", repr(text))
    else:
        text = "Ciao! Questo è un test di generazione audio dal sistema callAPIcall."
        print("  Hermes ha risposto vuoto -> uso testo di fallback:", repr(text))

    # 3) Sintesi via Handy /tts/stream.
    tts = HandyTtsClient(cfg.handy_tts_url())
    tts.start()
    tts.configure(voice=cfg.default_voice, lang=cfg.default_lang)
    tts.send_text(text)
    tts.end()

    # 4) Raccogli i segmenti finche' arrivano. Termina dopo ~3s di silenzio
    #    DALL'ULTIMO segmento (cosi' non taglia le frasi successive, che
    #    arrivano una alla volta man mano che vengono sintetizzate).
    segs: list[np.ndarray] = []
    sr = 24000
    last = time.time()
    while time.time() - last < 3.0:
        try:
            seg = tts.audio.get(timeout=0.5)
            segs.append(seg.samples)
            sr = seg.sample_rate
            last = time.time()
        except queue.Empty:
            continue  # nessun segmento adesso: aspetta ancora (finestra 3s)
    tts.close()

    if not segs:
        print("ERRORE: nessun audio ricevuto dal TTS.")
        return 1
    audio = np.concatenate(segs)
    dur = len(audio) / sr
    print(f"Audio ricevuto: {len(audio)} campioni @ {sr} Hz ({dur:.1f}s). Riproduco...")

    # 5) Riproduci sul device di default di Windows.
    sd.play(audio, sr)
    sd.wait()
    print("Fatto.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
