"""Quanto eco toglie il cancellatore? (fase 6)

La misura di fase 0d ha fissato il numero da battere: sul PC la stanza attenua
9,3 dB e tanto basta perché lo STT trascriva la frase dell'avatar per intero, a
qualunque volume. Perché il vivavoce regga servono **almeno 25 dB di ERLE** dal
cancellatore — dentro quello che AEC3 di WebRTC sa fare (30-40 dB).

Qui si misura senza casse e senza microfono: l'eco è simulata (ritardo +
attenuazione + un filtro che imita la stanza), così il numero è ripetibile e
non dipende da dove è appoggiato il portatile. La prova col microfono vero
resta `tools/misura-eco.py`, da rifare a cancellatore acceso.

ERLE = di quanto cala l'energia dell'eco fra prima e dopo il cancellatore.

    python tools/prova-aec.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.aec_client import (BLOCCO, RATE,  # noqa: E402
                                   CancellatoreEco, misura_ritardo)

RITARDO_MS = 60
ATTENUAZIONE = 10 ** (-9.3 / 20)          # i 9,3 dB misurati nella stanza


def voce_finta(secondi: float, seme: int) -> np.ndarray:
    """Un segnale con lo spettro grossomodo della voce: armoniche + rumore."""
    rng = np.random.default_rng(seme)
    t = np.arange(int(secondi * RATE), dtype=np.float32) / RATE
    f0 = 110 + 40 * np.sin(2 * np.pi * 0.7 * t)
    x = sum((0.6 / k) * np.sin(2 * np.pi * f0 * k * t) for k in (1, 2, 3, 4))
    x = x * (0.5 + 0.5 * np.sin(2 * np.pi * 2.3 * t))      # sillabe
    x = x + 0.02 * rng.normal(size=t.size)
    return (0.35 * x / max(np.abs(x).max(), 1e-6)).astype(np.float32)


def stanza(x: np.ndarray) -> np.ndarray:
    """Come torna indietro: ritardata, attenuata, un po' sporcata."""
    d = int(RITARDO_MS * RATE / 1000)
    y = np.concatenate([np.zeros(d, dtype=np.float32), x])[:len(x)]
    # Due riflessioni: senza, l'eco sarebbe una copia esatta e il compito
    # del cancellatore sarebbe più facile di quello vero.
    for ritardo, guadagno in ((int(0.013 * RATE), 0.35), (int(0.027 * RATE), 0.2)):
        y = y + guadagno * np.concatenate(
            [np.zeros(ritardo, dtype=np.float32), y])[:len(y)]
    return (y * ATTENUAZIONE).astype(np.float32)


def db(x: np.ndarray) -> float:
    e = float(np.sqrt((np.asarray(x, dtype=np.float32) ** 2).mean()))
    return 20 * np.log10(e) if e > 1e-9 else -120.0


def main() -> int:
    aec = CancellatoreEco(ritardo_ms=RITARDO_MS)
    if not aec.avvia():
        print("  cancellatore non disponibile: manca aec-venv?")
        return 1
    time.sleep(0.5)

    lontana = voce_finta(6.0, seme=1)          # l'avatar che parla
    eco = stanza(lontana)
    ritardo = misura_ritardo(lontana, eco)
    print(f"  ritardo misurato: {ritardo} ms (vero {RITARDO_MS} ms)")
    aec.imposta_ritardo(ritardo or RITARDO_MS)

    prima, dopo = [], []
    passo = BLOCCO * 20                        # 200 ms per giro
    for i in range(0, len(lontana) - passo, passo):
        rif = lontana[i:i + passo]
        mic = eco[i:i + passo]
        aec.riferimento(rif, RATE)
        pulito = aec.pulisci(
            (np.clip(mic, -1, 1) * 32767).astype("<i2").tobytes())
        y = np.frombuffer(pulito, dtype="<i2").astype(np.float32) / 32768.0
        # I primi due secondi sono la convergenza: il filtro sta imparando la
        # stanza. Si misura quando ha finito, che è la condizione d'uso.
        if i > 2 * RATE:
            prima.append(mic)
            dopo.append(y[:len(mic)])

    if not prima:
        print("  niente da misurare")
        aec.ferma()
        return 1
    a, b = np.concatenate(prima), np.concatenate(dopo)
    erle = db(a) - db(b)
    print(f"  eco in ingresso: {db(a):6.1f} dBFS")
    print(f"  eco in uscita:   {db(b):6.1f} dBFS")
    print(f"  ERLE:            {erle:6.1f} dB   (servono >= 25)")

    # E la voce vera non deve sparire insieme all'eco: è il difetto opposto,
    # e si sente come un interlocutore che viene tagliato a metà parola.
    vicina = voce_finta(4.0, seme=7)
    passanti = []
    for i in range(0, len(vicina) - passo, passo):
        aec.riferimento(np.zeros(passo, dtype=np.float32), RATE)
        pulito = aec.pulisci(
            (np.clip(vicina[i:i + passo], -1, 1) * 32767).astype("<i2").tobytes())
        passanti.append(np.frombuffer(pulito, dtype="<i2").astype(np.float32) / 32768.0)
    v = np.concatenate(passanti)
    perdita = db(vicina[:len(v)]) - db(v)
    print(f"  perdita sulla voce vicina (niente eco): {perdita:+.1f} dB")
    aec.ferma()

    ok = erle >= 25.0 and abs(perdita) < 12.0
    print("\n  -> " + ("il vivavoce regge: l'eco scende sotto la soglia dello STT"
                       if ok else
                       "non basta: rivedere ritardo, livelli o parametri"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
