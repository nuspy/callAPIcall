"""Il ducking scende quando deve, e senza gradini? (fase 3)

Abbassare la voce sembra banale finché non lo si fa su un flusso consegnato a
fette di 80 ms: il guadagno va applicato *dentro* la fetta e deve riprendere
dal valore esatto a cui la fetta precedente era arrivata. Se invece si applica
un guadagno costante per fetta, il risultato è una scala di gradini, e ogni
gradino è un clic udibile — il difetto classico di questa funzione.

Qui si misura sul PCM davvero consegnato, con un TTS finto (un'onda a
frequenza nota) perché la prova riguarda il guadagno, non la sintesi: niente
GPU, niente modelli, un secondo di orologio.

Si controllano le tre cose che si sentono:

  - la discesa dura ~120 ms e arriva a 0,25, la risalita ~250 ms;
  - fra due campioni consecutivi il guadagno non salta mai (niente clic);
  - la voce non va MAI a zero: silenzio e volume basso sono due messaggi
    diversi, e il secondo è quello che si vuole dare.

    python tools/prova-ducking.py
"""
from __future__ import annotations

import queue
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.duplex_engine import (DUCK_G, DUCK_GIU_S,  # noqa: E402
                                      DUCK_SU_S, MotoreDuplex)

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
    """Un TTS che consegna un tono continuo: l'ampiezza è nota, quindi il
    guadagno applicato si legge direttamente dal PCM che esce."""

    def __init__(self) -> None:
        self.audio: queue.Queue = queue.Queue()
        self.generation = 0

    def onda(self, secondi: float) -> None:
        t = np.arange(int(secondi * RATE), dtype=np.float32) / RATE
        x = (0.5 * np.sin(2 * np.pi * 220.0 * t)).astype(np.float32)
        self.audio.put(SegmentoFinto(x, RATE, "tono di prova"))

    def send_text(self, testo: str) -> None:  # noqa: ARG002
        pass

    def flush(self) -> None:
        pass

    def abort(self) -> None:
        self.generation += 1


def main() -> int:
    tts = TtsFinto()
    uscita: list[np.ndarray] = []
    motore = MotoreDuplex(tts, consegna=lambda pcm, rate: uscita.append(pcm.copy()),
                          anticipo_s=0.1)
    motore.avvia()
    tts.onda(6.0)
    motore.dillo("tono di prova")

    time.sleep(1.5)
    t_giu = len(np.concatenate(uscita)) if uscita else 0
    motore.abbassa()
    time.sleep(1.2)
    t_su = len(np.concatenate(uscita))
    motore.rialza()
    time.sleep(1.2)
    motore.ferma()

    pcm = np.concatenate(uscita)
    print(f"\n  consegnati {len(pcm)/RATE:.1f}s di audio\n")

    # L'inviluppo: il massimo assoluto su finestre da 5 ms. Con un tono a
    # 220 Hz ogni finestra contiene più di un periodo, quindi il massimo segue
    # il guadagno e non la fase.
    w = int(0.005 * RATE)
    inv = np.array([np.abs(pcm[i:i + w]).max()
                    for i in range(0, len(pcm) - w, w)]) / 0.5

    def quando(da: int, bersaglio: float, sotto: bool) -> float:
        """Secondi dall'indice `da` perché l'inviluppo raggiunga il bersaglio."""
        for i in range(da // w, len(inv)):
            if (inv[i] <= bersaglio) if sotto else (inv[i] >= bersaglio):
                return (i * w - da) / RATE
        return float("nan")

    discesa = quando(t_giu, DUCK_G * 1.05, sotto=True)
    risalita = quando(t_su, 0.95, sotto=False)
    print(f"  discesa a {DUCK_G}: {discesa*1000:.0f} ms (attesi ~{DUCK_GIU_S*1000:.0f})")
    print(f"  risalita a 1,0:  {risalita*1000:.0f} ms (attesi ~{DUCK_SU_S*1000:.0f})")

    verifica(discesa < DUCK_GIU_S + 0.1, "la discesa sta nel tempo voluto")
    verifica(risalita < DUCK_SU_S + 0.15, "la risalita sta nel tempo voluto")

    # Livello tenuto mentre è abbassata: si guarda il tratto centrale, lontano
    # dalle due rampe.
    piatto = inv[(t_giu + int(0.3 * RATE)) // w:(t_su - int(0.1 * RATE)) // w]
    if piatto.size:
        print(f"  livello tenuto:  {piatto.mean():.3f} "
              f"({20*np.log10(max(piatto.mean(), 1e-9)):+.1f} dB)")
        verifica(abs(piatto.mean() - DUCK_G) < 0.03,
                 "il livello abbassato è quello dichiarato")
        verifica(piatto.min() > 0.05,
                 "la voce NON va a zero: si abbassa, non si spegne")

    # Niente gradini: il guadagno, campione per campione, non può saltare più
    # di quanto la rampa più ripida preveda in un campione.
    salto_max = float(np.abs(np.diff(inv)).max()) if inv.size > 1 else 0.0
    consentito = w / (DUCK_GIU_S * RATE) * 1.6
    print(f"  salto massimo dell'inviluppo: {salto_max:.4f} "
          f"(consentito {consentito:.4f})")
    verifica(salto_max <= consentito,
             "nessun gradino: la rampa attraversa i confini di fetta")

    giuste = sum(1 for ok, _ in esiti if ok)
    print(f"\n  {giuste}/{len(esiti)} verifiche superate")
    return 0 if giuste == len(esiti) else 1


if __name__ == "__main__":
    raise SystemExit(main())
