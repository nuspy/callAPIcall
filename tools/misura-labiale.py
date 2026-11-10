"""Quanto costa davvero avviare il labiale, e quanto di quel costo è MuseTalk (fase 0b)

Nei commenti del repo il preambolo del labiale vale ~2,5 s per battuta
(`text_sanitize.py:90-95`). Nei log ne compaiono 6,4 · 6,9 · 6,5 · 6,1 · 12,0.
La differenza non è accademica: quel numero governa `chunk_policy.min_caratteri()`
per tutta la sessione, e a 12 s produce battute da 385 caratteri — ventidue
secondi di parlato che non si possono interrompere.

Il tempo si scompone in due parti che si correggono in modi opposti:

    POST /avatar/lipsync ──► scrittura WAV + HTTP + attesa in speak_q ──► MuseTalk
    └─────────────── misurato qui ──────────────┘   └─ "battuta pronta in X" ─┘
                                                      (loggato dal worker)

Se il grosso è MuseTalk si interviene sul worker (BATCH_SIZE, risoluzione,
pre-riscaldamento); se è la catena attorno si interviene sul gateway (niente
WAV su disco, niente HTTP per segmento, coda più corta). Sono lavori diversi.

**Ogni campione porta con sé lo stato della VRAM**, perché su questa macchina i
tempi dipendono da quanto è piena la memoria della GPU: quando il driver sfratta
pagine nella memoria condivisa, ogni accesso passa dal bus PCIe e i tempi
raddoppiano o peggio. Una misura senza quel contesto è un numero che non si può
confrontare con nessun altro.

    python tools/misura-labiale.py --giri 6
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import statistics
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

RADICE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RADICE / "call-bridge"))

from callbridge.config import Config  # noqa: E402

LOG = RADICE / "call-bridge" / "ptt.log"
#: Il worker logga la riga quando il prebuffer e' pronto e la bocca puo' partire.
_PRONTA = re.compile(r"battuta pronta in ([0-9.]+)s")
#: LUID della 5090 nei contatori di Windows (si ricava da `Get-Counter`).
_PS_VRAM = (
    "$d=0;$s=0;"
    "(Get-Counter '\\GPU Process Memory(*)\\Dedicated Usage' -EA SilentlyContinue)"
    ".CounterSamples | Where-Object { $_.InstanceName -match 'pid_%d\\b' } |"
    " ForEach-Object { $d += $_.CookedValue };"
    "(Get-Counter '\\GPU Process Memory(*)\\Shared Usage' -EA SilentlyContinue)"
    ".CounterSamples | Where-Object { $_.InstanceName -match 'pid_%d\\b' } |"
    " ForEach-Object { $s += $_.CookedValue };"
    "'{0};{1}' -f [math]::Round($d/1MB), [math]::Round($s/1MB)"
)


def _vram_totale() -> tuple[int, int]:
    out = subprocess.run(
        ["nvidia-smi", "--query-gpu=memory.used,memory.total",
         "--format=csv,noheader,nounits"],
        capture_output=True, text=True, timeout=30).stdout.strip()
    a, b = (x.strip() for x in out.split(","))
    return int(a), int(b)


def _pid_worker() -> int:
    ps = ("(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
          "Where-Object { $_.CommandLine -match 'avatar_worker' } | "
          "Sort-Object CreationDate | Select-Object -Last 1).ProcessId")
    out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                         capture_output=True, text=True, timeout=60).stdout.strip()
    return int(out) if out.isdigit() else 0


def _vram_worker(pid: int) -> tuple[int, int]:
    """(dedicata, shared) in MB del processo. Shared > 0 = pagine sfrattate."""
    if not pid:
        return (0, 0)
    out = subprocess.run(
        ["powershell", "-NoProfile", "-Command", _PS_VRAM % (pid, pid)],
        capture_output=True, text=True, timeout=90).stdout.strip()
    try:
        d, s = out.split(";")
        return int(float(d)), int(float(s))
    except Exception:  # noqa: BLE001
        return (0, 0)


def _righe_log() -> int:
    try:
        with open(LOG, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def _pronta_dopo(riga0: int) -> float | None:
    """Il 'battuta pronta in X' loggato dal worker dopo la riga indicata."""
    try:
        with open(LOG, encoding="utf-8", errors="replace") as f:
            righe = f.readlines()[riga0:]
    except OSError:
        return None
    for r in reversed(righe):
        m = _PRONTA.search(r)
        if m:
            return float(m.group(1))
    return None


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--giri", type=int, default=6)
    ap.add_argument("--pausa", type=float, default=4.0,
                    help="secondi fra una battuta e l'altra")
    args = ap.parse_args()

    cfg = Config.load()
    base = f"http://127.0.0.1:{cfg.control_port}"
    wav = sorted(glob.glob(os.path.join(os.environ.get("TEMP", "."),
                                        "avatar_say_*.wav")))
    if not wav:
        print("  nessun WAV di prova in %TEMP% (avatar_say_*.wav)")
        return 1
    try:
        with urllib.request.urlopen(f"{base}/avatar/state", timeout=20) as r:
            stato = json.loads(r.read())
    except Exception as e:  # noqa: BLE001
        print(f"  control server non raggiungibile: {e}")
        return 1
    if not stato.get("running"):
        print(f"  avatar non attivo: {stato}")
        return 1

    pid = _pid_worker()
    print(f"  persona: {stato.get('persona')}   worker PID: {pid or '?'}")
    print(f"  {'':>4} {'POST':>8} {'MuseTalk':>9} {'attorno':>8} "
          f"{'VRAM':>12} {'worker ded/shared':>18}")

    posts, interni, attorno, sfrattati = [], [], [], 0
    for giro in range(args.giri):
        f = wav[giro % len(wav)]
        riga0 = _righe_log()
        usata, tot = _vram_totale()
        d, s = _vram_worker(pid)
        corpo = json.dumps({"wav": f, "mute": True, "attendi_avvio": True,
                            "attesa_max_s": 20.0}).encode()
        req = urllib.request.Request(f"{base}/avatar/lipsync", corpo,
                                     {"Content-Type": "application/json"},
                                     method="POST")
        t0 = time.perf_counter()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                r.read()
        except Exception as e:  # noqa: BLE001
            print(f"  {giro:>4} FALLITA: {type(e).__name__}: {e}")
            time.sleep(args.pausa)
            continue
        post_s = time.perf_counter() - t0
        time.sleep(0.6)                       # il log del worker arriva via stderr
        interno = _pronta_dopo(riga0)
        posts.append(post_s)
        if interno is not None:
            interni.append(interno)
            attorno.append(post_s - interno)
        if s > 100:
            sfrattati += 1
        print(f"  {giro:>4} {post_s:>7.2f}s "
              f"{(f'{interno:.2f}s' if interno is not None else '   —'):>9} "
              f"{(f'{post_s - interno:.2f}s' if interno is not None else '   —'):>8} "
              f"{f'{usata}/{tot}':>12} {f'{d}/{s} MB':>18}")
        time.sleep(args.pausa)

    if not posts:
        print("\n  nessuna misura riuscita")
        return 1
    print(f"\n  POST (quello che vede il gateway): mediana {statistics.median(posts):.2f}s"
          f"   min {min(posts):.2f}  max {max(posts):.2f}")
    if interni:
        print(f"  MuseTalk (dentro il worker):       mediana {statistics.median(interni):.2f}s"
              f"   min {min(interni):.2f}  max {max(interni):.2f}")
        print(f"  la catena attorno (WAV+HTTP+coda):  mediana {statistics.median(attorno):.2f}s")
        quota = 100 * statistics.median(interni) / statistics.median(posts)
        print(f"\n  -> {quota:.0f}% del tempo e' MuseTalk, "
              f"{100 - quota:.0f}% e' la catena attorno")
    if sfrattati:
        print(f"  ATTENZIONE: in {sfrattati}/{len(posts)} campioni il worker aveva "
              "pagine in memoria condivisa (VRAM satura): quei tempi sono gonfiati")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
