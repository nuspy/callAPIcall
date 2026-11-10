"""Banco di prova del Copione: nessun audio, nessun microfono, nessun modello.

Il Copione è la struttura su cui poggia tutta la conversazione continua, e ha
il pregio di essere verificabile in isolamento: sono battute, stati e conti sui
secondi. Provarlo qui costa un secondo e permette di iterare senza far parlare
l'avatar, cosa che invece costa minuti e dipende dallo stato della GPU.

Si controllano le proprietà che il resto del motore darà per scontate:

  - *detto* e *previsto* restano due cose distinte, sempre;
  - una battuta cominciata e interrotta a metà conta come detta, perché
    l'utente l'ha sentita;
  - il taglio non attraversa il confine di battuta se non glielo si chiede;
  - l'anticipo è il margine per cambiare idea, e deve scendere man mano che si
    consegna;
  - ciò che si taglia finisce in riserva, non nel nulla.

    python tools/prova-copione.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.duplex_engine import Copione, Stato  # noqa: E402

RATE = 24000
esiti: list[tuple[bool, str]] = []


def verifica(condizione: bool, descrizione: str) -> None:
    esiti.append((bool(condizione), descrizione))
    print(f"  {'ok  ' if condizione else 'NO  '}{descrizione}")


def audio(secondi: float) -> np.ndarray:
    return np.zeros(int(secondi * RATE), dtype=np.float32)


def copione_pronto(*durate: float) -> tuple[Copione, list]:
    c = Copione()
    c.nuova_generazione()
    battute = []
    for i, d in enumerate(durate, 1):
        b = c.aggiungi(f"frase numero {i}", c.gen)
        c.audio_pronto(b, audio(d), RATE)
        battute.append(b)
    return c, battute


print("\n  --- consegna e avanzamento ---")
c, b = copione_pronto(2.0, 3.0, 1.5)
verifica(abs(c.anticipo_s() - 6.5) < 1e-6,
         "l'anticipo parte dalla somma delle battute pronte (6,5s)")
verifica(c.detto() == "", "all'inizio non e' stato detto niente")
verifica("frase numero 1" in c.previsto(), "la prima battuta e' fra le previste")

fetta, rate, battuta = c.consegna(1.0)
verifica(len(fetta) == RATE, "si consegna esattamente un secondo di audio")
verifica(battuta.stato is Stato.IN_CORSO, "la battuta consegnata passa a in corso")
verifica(abs(c.anticipo_s() - 5.5) < 1e-6, "l'anticipo cala di quanto si e' consegnato")
verifica(c.detto() == "", "una battuta a meta' non e' ancora detta")

fetta, _, _ = c.consegna(5.0)
verifica(len(fetta) == RATE,
         "la consegna NON attraversa il confine fra due battute")
verifica("frase numero 1" in c.detto(), "finita la battuta, entra nel detto")
verifica("frase numero 1" not in c.previsto(),
         "e sparisce dal previsto: le due cose non si sovrappongono mai")

print("\n  --- taglio morbido: si lascia finire la battuta in corso ---")
c, b = copione_pronto(2.0, 3.0, 1.5)
c.consegna(0.5)                       # la prima e' in corso
scartate = c.taglia(anche_in_corso=False)
verifica(len(scartate) == 2, "si scartano le due battute non ancora cominciate")
verifica(b[0].stato is Stato.IN_CORSO, "quella in corso continua")
verifica(len(c.riserva) == 2, "le scartate finiscono in riserva, non nel nulla")

print("\n  --- taglio duro: si tronca anche quella in corso ---")
c, b = copione_pronto(2.0, 3.0)
c.consegna(0.8)
c.taglia(anche_in_corso=True)
verifica(b[0].stato is Stato.SCARTATA, "la battuta in corso viene troncata")
verifica("frase numero 1" in c.detto(),
         "ma cio' che si era sentito resta 'detto': l'utente lo ha udito")
verifica("frase numero 2" not in c.detto(),
         "mentre quella mai cominciata non e' stata detta")
verifica(c.anticipo_s() == 0.0, "dopo il taglio duro non resta anticipo")

print("\n  --- la generazione vecchia non torna a galla ---")
c, b = copione_pronto(2.0)
c.taglia(anche_in_corso=True)
nuova = c.nuova_generazione()
b2 = c.aggiungi("frase nuova", nuova)
c.audio_pronto(b2, audio(1.0), RATE)
prossima = c.prossima_da_emettere()
verifica(prossima is b2, "si emette solo la battuta della generazione corrente")
verifica("frase nuova" in c.previsto() and "frase numero 1" not in c.previsto(),
         "il previsto contiene solo la risposta nuova")

print("\n  --- detto(entro_s): serve a riconoscere l'eco recente ---")
c, b = copione_pronto(1.0, 1.0)
c.consegna(1.0)
c.consegna(1.0)
verifica(len(c.detto(entro_s=60).split()) > 0, "entro un minuto si ricorda tutto")
# Non si prova con finestra zero: su Windows `time.monotonic()` ha una
# risoluzione di ~15 ms, quindi cio' che e' appena successo cade nello stesso
# tick e "entro zero secondi" lo includerebbe. Si prova la proprieta' che
# serve davvero: una finestra stretta deve dimenticare cio' che e' vecchio.
time.sleep(0.15)
verifica(c.detto(entro_s=0.05) == "",
         "una finestra stretta dimentica cio' che e' uscito prima")
verifica(len(c.detto(entro_s=60)) > 0,
         "ma il testo resta disponibile su una finestra larga")

giuste = sum(1 for ok, _ in esiti if ok)
print(f"\n  {giuste}/{len(esiti)} verifiche superate")
raise SystemExit(0 if giuste == len(esiti) else 1)
