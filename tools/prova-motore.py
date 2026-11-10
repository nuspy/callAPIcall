"""Il motore consegna a tempo reale, o spinge tutto fuori come prima?

È la proprietà su cui poggia la conversazione continua: se l'audio esce appena
è pronto, dopo pochi secondi è già tutto nelle mani del client e non si può più
né abbassare il volume né tagliare a un confine pulito. Se invece esce a tempo,
resta in casa tutto ciò che non è ancora stato pronunciato.

Si misura senza gateway e senza microfono: si collega il motore al TTS vero e
si guarda *quando* arrivano le consegne rispetto alla durata dell'audio che
portano. Con la consegna a tempo i due valori procedono insieme; con la spinta
il secondo schizza avanti.

Poi si interrompe a metà e si verifica la cosa che oggi non funziona: che dopo
il taglio non esca più niente della risposta abbandonata.

    python tools/prova-motore.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.config import Config  # noqa: E402
from callbridge.duplex_engine import MotoreDuplex  # noqa: E402
from callbridge.tts_client import HandyTtsClient  # noqa: E402

TESTO = ("Questa è la prima frase della prova, abbastanza lunga da restare sola. "
         "Questa è la seconda frase, anch'essa piuttosto lunga e distinta. "
         "E questa è la terza frase, che continua il ragionamento. "
         "Questa è la quarta, e serve solo ad allungare la risposta. "
         "E questa è la quinta e ultima frase del blocco di prova.")


def main() -> int:
    cfg = Config.load()
    tts = None
    for tentativo in range(4):
        tts = HandyTtsClient(cfg.handy_tts_url())
        try:
            tts.start()
            break
        except TimeoutError:
            print(f"  motori non pronti (tentativo {tentativo + 1})")
            try:
                tts.close()
            except Exception:  # noqa: BLE001
                pass
            tts = None
            time.sleep(8)
    if tts is None:
        print("  TTS non raggiungibile")
        return 1
    time.sleep(1)
    while not tts.audio.empty():
        tts.audio.get_nowait()
    tts.configure("Chandra MacFarland", "it", 1.0, "xtts")

    consegne: list[tuple[float, float]] = []      # (istante, secondi di audio)
    t0 = time.monotonic()

    def consegna(pcm, rate):
        consegne.append((time.monotonic() - t0, len(pcm) / max(rate, 1)))

    motore = MotoreDuplex(tts, consegna)
    motore.avvia()
    motore.dillo(TESTO)
    motore.fine_risposta()

    print("  tempo   audio consegnato   differenza")
    prossima_stampa = 2.0
    fine = time.monotonic() + 26
    while time.monotonic() < fine:
        time.sleep(0.2)
        trascorso = time.monotonic() - t0
        if trascorso >= prossima_stampa:
            tot = sum(d for _, d in consegne)
            print(f"  {trascorso:5.1f}s {tot:12.1f}s {tot - trascorso:+12.1f}s"
                  f"   {motore.stato()}")
            prossima_stampa += 4.0
        if motore.consegnati_s > 12.0:
            break

    tot = sum(d for _, d in consegne)
    trascorso = time.monotonic() - t0
    print(f"\n  consegnati {tot:.1f}s di audio in {trascorso:.1f}s di orologio")
    if tot > trascorso + 3.0:
        print("  -> l'audio esce PIU' IN FRETTA del tempo reale: e' la spinta,")
        print("     non la consegna a tempo. Qualcosa non va.")
    else:
        print(f"  -> consegna a tempo: lo scarto e' {tot - trascorso:+.1f}s, "
              "cioe' l'anticipo voluto.")
        print(f"     anticipo ancora in casa: {motore.copione.anticipo_s():.1f}s "
              "di parlato gia' pronto e non consegnato")

    print("\n  --- interruzione a meta' ---")
    prima = sum(d for _, d in consegne)
    scartate = motore.taglia(anche_in_corso=True)
    print(f"  battute abbandonate: {len(scartate)}")
    print(f"  detto fin qui: {motore.copione.detto()[:70]!r}")
    time.sleep(2.0)
    dopo = sum(d for _, d in consegne) - prima
    print(f"  audio uscito NEI 2s DOPO il taglio: {dopo:.2f}s "
          + ("(ok: niente)" if dopo < 0.05 else "<- PROBLEMA: continua a uscire"))
    motore.ferma()
    tts.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
