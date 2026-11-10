"""Riscrivere il seguito senza aprire un buco: la regola del doppio copione (fase 5)

Quando l'utente dice qualcosa che riguarda ciò che l'avatar sta per dire, il
motore taglia il futuro e chiede al cervello di riscriverlo. Fra il taglio e
l'arrivo della sostituzione passa del tempo, e in quel tempo la bocca deve
avere qualcosa da dire: un avatar che si ferma di colpo a metà discorso non
sembra pensieroso, sembra rotto.

Per questo il tagliato non si butta ma va in riserva. Qui si verifica che la
rete funzioni davvero, e che non funzioni troppo: quando la continuazione
arriva, deve essere lei a parlare.

Niente GPU: il TTS è finto e produce toni di durata nota, così i buchi si
misurano sul PCM consegnato invece di dedurli.

    python tools/prova-riscrittura.py
"""
from __future__ import annotations

import queue
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.duplex_engine import MotoreDuplex, Stato  # noqa: E402

RATE = 24000
esiti: list[tuple[bool, str]] = []


def verifica(condizione: bool, descrizione: str) -> None:
    esiti.append((bool(condizione), descrizione))
    print(f"  {'ok  ' if condizione else 'NO  '}{descrizione}")


@dataclass
class SegmentoFinto:
    samples: np.ndarray
    sample_rate: int
    testo: str
    generation: int = 0


class TtsFinto:
    def __init__(self) -> None:
        self.audio: queue.Queue = queue.Queue()
        self.generation = 0

    def battuta(self, testo: str, secondi: float, hz: float = 220.0) -> None:
        t = np.arange(int(secondi * RATE), dtype=np.float32) / RATE
        x = (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)
        self.audio.put(SegmentoFinto(x, RATE, testo, self.generation))

    def send_text(self, testo: str) -> None:  # noqa: ARG002
        pass

    def flush(self) -> None:
        pass

    def abort(self) -> None:
        self.generation += 1


def main() -> int:
    tts = TtsFinto()
    consegne: list[tuple[float, int]] = []          # (istante, campioni)
    motore = MotoreDuplex(
        tts, consegna=lambda pcm, rate: consegne.append(
            (time.monotonic(), len(pcm))), anticipo_s=0.2)
    motore.avvia()
    for i in range(1, 5):
        tts.battuta(f"frase numero {i} della risposta iniziale", 2.0)
    motore.dillo("risposta iniziale")

    time.sleep(2.6)                                  # dentro la seconda frase
    prima = motore.copione.anticipo_s()
    scartate = motore.riscrivi()
    print(f"\n  tagliato con {prima:.1f}s di anticipo in casa, "
          f"{len(scartate)} battute in riserva")
    verifica(len(scartate) >= 2, "si abbandonano le battute non cominciate")
    verifica(any(b.stato is Stato.IN_CORSO for b in motore.copione._battute),
             "la frase in corso si lascia finire: non si tronca a metà parola")
    verifica(len(motore.copione.riserva) == len(scartate),
             "il tagliato va in riserva, non nel nulla")

    # La continuazione TARDA apposta: è il caso che la riserva esiste per
    # coprire. Due secondi bastano a superare la frase in corso e a far
    # ripescare la prima di riserva — il tempo tipico di una riscrittura
    # breve. (Con un'attesa molto più lunga la riserva ne consuma due, tre:
    # è il comportamento voluto, non un difetto, ma qui si vuole misurare il
    # passaggio di consegne, non la capienza della rete.)
    t_taglio = time.monotonic()
    time.sleep(2.2)
    ripescate = sum(1 for b in motore.copione._battute
                    if b.stato in (Stato.IN_CORSO, Stato.DETTA)
                    and b.gen == motore.copione.gen)
    verifica(ripescate >= 1, "mentre si aspetta, la bocca riprende dalla riserva")

    # Il buco più lungo fra due consegne successive dopo il taglio.
    dopo = [(t, n) for t, n in consegne if t >= t_taglio]
    buco = 0.0
    for (t1, n1), (t2, _) in zip(dopo, dopo[1:]):
        atteso = n1 / RATE
        buco = max(buco, (t2 - t1) - atteso)
    print(f"  buco massimo fra due consegne: {buco*1000:.0f} ms")
    verifica(buco < 0.3, "nessun silenzio oltre 300 ms nella giunzione")

    # Ora arriva la sostituzione.
    for i in (1, 2):
        tts.battuta(f"seguito riscritto numero {i}", 1.5, hz=330.0)
    motore.dillo("seguito riscritto")
    time.sleep(3.0)
    motore.fine_risposta()
    time.sleep(0.5)
    detto = motore.copione.detto()
    motore.ferma()

    print(f"\n  detto: {detto[:110]!r}")
    verifica("seguito riscritto" in detto, "la continuazione viene pronunciata")
    verifica("frase numero 4" not in detto,
             "e appena c'è la sostituzione la riserva non si tocca più")

    giuste = sum(1 for ok, _ in esiti if ok)
    print(f"\n  {giuste}/{len(esiti)} verifiche superate")
    return 0 if giuste == len(esiti) else 1


if __name__ == "__main__":
    raise SystemExit(main())
