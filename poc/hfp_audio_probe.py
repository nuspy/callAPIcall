"""
PoC audio HFP — verifica del path audio Bluetooth Hands-Free.

Obiettivo: confermare che durante una chiamata cellulare reale, instradata
al PC via Bluetooth HFP, si riesca a:
  - LEGGERE il downlink (la voce dell'interlocutore) dall'endpoint di cattura
  - SCRIVERE l'uplink (far sentire un audio all'interlocutore) sull'endpoint di riproduzione

Uso:
  python hfp_audio_probe.py list
      Elenca tutti i device audio, evidenziando quelli HFP/Headset.

  python hfp_audio_probe.py probe [--seconds N] [--in IDX] [--out IDX]
      Da eseguire CON UNA CHIAMATA ATTIVA instradata al PC.
      Per N secondi: registra il downlink in downlink.wav e riproduce
      un tono di test sull'uplink. Mostra un misuratore RMS live di
      entrambe le direzioni cosi' si vede subito se l'audio scorre.

Note:
  - L'endpoint HFP su Windows compare di solito con un nome tipo
    "Headset" o "Hands-Free" e ha sia input che output.
  - Il link SCO si attiva quando si apre lo stream: e' normale che il
    device sia "silenzioso" finche' non c'e' una chiamata attiva.
"""

from __future__ import annotations

import argparse
import sys
import wave

import numpy as np
import sounddevice as sd

# Pattern che identificano un endpoint HFP generico (Hands-Free).
HFP_NAME_HINTS = ("hands-free", "headset", "hands free")
# Pattern specifici del telefono target: hanno priorita' nell'autodetect,
# cosi' non si seleziona per errore un altro dispositivo HFP (es. occhiali BT).
PHONE_NAME_HINTS = ("s25", "andrea", "ultra")
# L'A2DP NON va usato per le chiamate: e' solo riproduzione musica, niente mic.
EXCLUDE_HINTS = ("a2dp", "stereo")

SAMPLE_RATE = 16000  # HFP wideband (mSBC). Se fallisce, fallback a 8000.
CHANNELS = 1


def _is_hfp(name: str) -> bool:
    low = name.lower()
    if any(x in low for x in EXCLUDE_HINTS):
        return False
    return any(x in low for x in HFP_NAME_HINTS) or any(
        x in low for x in PHONE_NAME_HINTS
    )


def _is_target_phone(name: str) -> bool:
    """True se il device appartiene specificamente al telefono target."""
    low = name.lower()
    if any(x in low for x in EXCLUDE_HINTS):
        return False
    return any(x in low for x in PHONE_NAME_HINTS)


def cmd_list() -> None:
    """Elenca i device audio, marcando i candidati HFP con >>>."""
    devices = sd.query_devices()
    print(f"{'IDX':>4}  {'IN':>3} {'OUT':>3}  NOME")
    print("-" * 70)
    for idx, dev in enumerate(devices):
        if _is_target_phone(dev["name"]):
            mark = ">>>"  # telefono target
        elif _is_hfp(dev["name"]):
            mark = " > "  # altro endpoint HFP
        else:
            mark = "   "
        print(
            f"{mark}{idx:>2}  {dev['max_input_channels']:>3} "
            f"{dev['max_output_channels']:>3}  {dev['name']}"
        )
    print("-" * 70)
    print(">>> = telefono target (usato dall'autodetect)   > = altro endpoint HFP")
    print("Se l'autodetect sbaglia, passa gli indici con --in e --out a 'probe'.")


def _auto_pick() -> tuple[int, int]:
    """Sceglie automaticamente (input_idx, output_idx) HFP.

    Prima cerca il telefono target (PHONE_NAME_HINTS); se non lo trova,
    ripiega su un qualsiasi endpoint HFP generico.
    """
    devices = sd.query_devices()

    def _scan(match) -> tuple[int | None, int | None]:
        in_i = out_i = None
        for idx, dev in enumerate(devices):
            if not match(dev["name"]):
                continue
            if in_i is None and dev["max_input_channels"] > 0:
                in_i = idx
            if out_i is None and dev["max_output_channels"] > 0:
                out_i = idx
        return in_i, out_i

    in_idx, out_idx = _scan(_is_target_phone)
    if in_idx is None or out_idx is None:
        # Fallback: qualsiasi HFP, ma avvisa che potrebbe non essere il telefono.
        fb_in, fb_out = _scan(_is_hfp)
        in_idx = in_idx if in_idx is not None else fb_in
        out_idx = out_idx if out_idx is not None else fb_out
        if in_idx is not None and out_idx is not None:
            print("NOTA: telefono target non trovato, uso un endpoint HFP generico.")

    if in_idx is None or out_idx is None:
        raise RuntimeError(
            "Endpoint HFP non trovato automaticamente. Esegui 'list' e passa "
            "--in/--out manualmente. Assicurati che il telefono sia connesso "
            "e che l'audio della chiamata sia instradato al PC."
        )
    return in_idx, out_idx


def _rms_bar(samples: np.ndarray, width: int = 30) -> str:
    """Barra testuale del livello RMS di un blocco audio."""
    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64)))) if samples.size else 0.0
    filled = min(width, int(rms * width * 4))
    return "#" * filled + "-" * (width - filled)


def cmd_probe(seconds: int, in_idx: int | None, out_idx: int | None) -> None:
    """Registra il downlink e riproduce un tono sull'uplink, con meter live."""
    if in_idx is None or out_idx is None:
        auto_in, auto_out = _auto_pick()
        in_idx = in_idx if in_idx is not None else auto_in
        out_idx = out_idx if out_idx is not None else auto_out

    in_name = sd.query_devices(in_idx)["name"]
    out_name = sd.query_devices(out_idx)["name"]
    print(f"Downlink (cattura)    <- [{in_idx}] {in_name}")
    print(f"Uplink   (riproduz.)  -> [{out_idx}] {out_name}")

    rate = SAMPLE_RATE
    try:
        sd.check_input_settings(device=in_idx, samplerate=rate, channels=CHANNELS)
        sd.check_output_settings(device=out_idx, samplerate=rate, channels=CHANNELS)
    except Exception:
        rate = 8000  # fallback HFP narrowband (CVSD)
        print(f"16 kHz non supportato, uso {rate} Hz (HFP narrowband).")

    print(f"\nAvvio probe per {seconds}s. ASSICURATI CHE LA CHIAMATA SIA ATTIVA.")
    print("Guarda i meter: DOWNLINK deve muoversi quando l'altro parla;")
    print("chiedi all'altro se sente il tono (UPLINK).\n")

    total_frames = int(seconds * rate)
    block = int(rate * 0.1)  # blocchi da 100 ms

    # Tono di test 440 Hz da iniettare nell'uplink.
    t = np.arange(total_frames) / rate
    tone = (0.3 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

    recorded = np.zeros(total_frames, dtype=np.float32)
    pos = 0

    with sd.InputStream(device=in_idx, samplerate=rate, channels=CHANNELS,
                        dtype="float32") as istream, \
         sd.OutputStream(device=out_idx, samplerate=rate, channels=CHANNELS,
                         dtype="float32") as ostream:
        while pos < total_frames:
            n = min(block, total_frames - pos)
            indata, _ = istream.read(n)
            down = indata[:, 0]
            recorded[pos:pos + n] = down
            ostream.write(tone[pos:pos + n].reshape(-1, 1))
            pos += n
            up = tone[pos - n:pos]
            sys.stdout.write(
                f"\rDOWN [{_rms_bar(down)}]  UP [{_rms_bar(up)}]  {pos / rate:4.1f}s"
            )
            sys.stdout.flush()
    print()

    with wave.open("downlink.wav", "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes((recorded * 32767).astype(np.int16).tobytes())

    peak = float(np.max(np.abs(recorded))) if recorded.size else 0.0
    print(f"\nSalvato downlink.wav ({seconds}s @ {rate} Hz). Picco downlink: {peak:.3f}")
    if peak < 0.005:
        print("ATTENZIONE: downlink quasi silenzioso. Possibili cause:")
        print("  - la chiamata non era instradata al PC (controlla il routing audio)")
        print("  - indice device sbagliato (usa 'list' e --in)")
        print("  - il link SCO non si e' attivato")
    else:
        print("OK: il downlink contiene segnale. Riascolta downlink.wav per conferma.")


def main() -> None:
    parser = argparse.ArgumentParser(description="PoC audio HFP")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="elenca i device audio")
    p = sub.add_parser("probe", help="testa downlink+uplink con chiamata attiva")
    p.add_argument("--seconds", type=int, default=15)
    p.add_argument("--in", dest="in_idx", type=int, default=None)
    p.add_argument("--out", dest="out_idx", type=int, default=None)
    args = parser.parse_args()

    if args.cmd == "list":
        cmd_list()
    elif args.cmd == "probe":
        cmd_probe(args.seconds, args.in_idx, args.out_idx)


if __name__ == "__main__":
    main()
