"""Le regole azzeccano l'esito? Terne etichettate a mano, un secondo di orologio (fase 4a)

Le quattro strategie si scelgono su frasi brevissime e ambigue — i 349 turni
già registrati in `call-bridge/turni/` dicono che il 40% dura meno di un
secondo — quindi l'unico modo onesto di iterare sulle regole è un banco con
casi etichettati, non una prova a voce che costa minuti e dipende dalla GPU.

Ogni caso è la terna che il classificatore vede davvero: cosa l'avatar ha già
pronunciato, quanto parlato ha ancora in casa, e cosa l'utente ha detto sopra.

    python tools/banco-classificatore.py
    python tools/banco-classificatore.py --verbose    # anche i casi giusti
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.interruption_policy import Esito, classifica  # noqa: E402

DETTO = ("Allora, per preparare il caffè ti serve prima di tutto una macchina "
         "con il portafiltro, e poi una miscela che ti piaccia.")

#: (cosa dice l'utente, cosa l'avatar ha già detto, durata, anticipo, atteso)
CASI = [
    # --- cenni di ascolto: si dicono PER non interrompere -----------------
    ("sì sì", DETTO, 0.6, 3.0, Esito.IGNORA),
    ("ok", DETTO, 0.4, 3.0, Esito.IGNORA),
    ("certo", DETTO, 0.5, 3.0, Esito.IGNORA),
    ("mmh", DETTO, 0.3, 3.0, Esito.IGNORA),
    ("ho capito", DETTO, 0.8, 3.0, Esito.IGNORA),
    ("va bene", DETTO, 0.7, 0.5, Esito.IGNORA),

    # --- eco della propria voce ------------------------------------------
    ("ti serve una macchina con il portafiltro", DETTO, 2.0, 3.0, Esito.IGNORA),
    ("e poi una miscela che ti piaccia", DETTO, 1.8, 3.0, Esito.IGNORA),

    # --- rumore e frasi-fantasma -----------------------------------------
    ("", DETTO, 0.0, 3.0, Esito.IGNORA),
    ("eh", DETTO, 0.2, 3.0, Esito.IGNORA),
    ("Sottotitoli e revisione a cura di QTSS", DETTO, 2.0, 3.0, Esito.IGNORA),

    # --- l'utente vuole la parola ----------------------------------------
    ("aspetta, fermati un attimo", DETTO, 1.4, 3.0, Esito.FERMA),
    ("basta", DETTO, 0.4, 3.0, Esito.FERMA),
    ("no no aspetta", DETTO, 0.9, 3.0, Esito.FERMA),
    ("scusa un attimo", DETTO, 1.0, 3.0, Esito.FERMA),
    ("fermati", DETTO, 0.5, 0.2, Esito.FERMA),

    # --- parole di stop che stop non sono ---------------------------------
    # Tutte contengono un termine della lista, e nessuna chiede di tacere.
    ("Ciao ciao mi senti bene adesso?", DETTO, 2.2, 3.0, Esito.ACCODA),
    ("scusa il ritardo di stamattina", DETTO, 1.8, 3.0, Esito.ACCODA),
    ("senti, volevo chiederti una cosa sulla riunione", DETTO, 2.4, 3.0,
     Esito.ACCODA),
    # Ma in apertura e corto, sì.
    ("senti un attimo", DETTO, 0.9, 3.0, Esito.FERMA),
    ("scusa, aspetta", DETTO, 0.8, 3.0, Esito.FERMA),

    # --- turni nuovi, che possono aspettare la fine ------------------------
    ("ricordami anche di chiamare mia sorella stasera", DETTO, 2.2, 1.0,
     Esito.ACCODA),
    ("che ore sono?", DETTO, 0.9, 1.0, Esito.ACCODA),
    ("e domani che tempo fa?", DETTO, 1.3, 0.5, Esito.ACCODA),
    ("poi ti racconto com'è andata ieri", DETTO, 1.9, 1.0, Esito.ACCODA),

    # --- la zona grigia: riguarda cio' che sta per dire --------------------
    # Con `consenti_cambia` spento (oggi) devono cadere su ACCODA: e' il
    # ripiego dichiarato, non un errore.
    ("e senza cipolla come si fa?", DETTO, 1.7, 4.0, Esito.ACCODA),
    ("io però il caffè lo faccio con la moka", DETTO, 2.1, 4.0, Esito.ACCODA),
]

#: Gli stessi casi di zona grigia, ma con CAMBIA concesso (fase 5).
CASI_CAMBIA = [
    ("e senza cipolla come si fa?", DETTO, 1.7, 4.0, Esito.CAMBIA),
    ("io però il caffè lo faccio con la moka", DETTO, 2.1, 4.0, Esito.CAMBIA),
    # Sotto la soglia di anticipo la riscrittura arriverebbe tardi: ACCODA.
    ("e senza cipolla come si fa?", DETTO, 1.7, 1.0, Esito.ACCODA),
    # Un cenno resta un cenno anche con margine da vendere.
    ("sì sì", DETTO, 0.6, 5.0, Esito.IGNORA),
    # E uno stop resta uno stop: non si "integra" chi ti dice di tacere.
    ("aspetta un attimo", DETTO, 1.0, 5.0, Esito.FERMA),
]


def giro(casi, consenti_cambia: bool, titolo: str, verbose: bool) -> int:
    print(f"\n  --- {titolo} ---")
    matrice: dict[tuple[Esito, Esito], int] = {}
    sbagliati = 0
    for testo, detto, durata, anticipo, atteso in casi:
        avuto, perche = classifica(testo, detto=detto, durata_s=durata,
                                   anticipo_s=anticipo,
                                   consenti_cambia=consenti_cambia)
        matrice[(atteso, avuto)] = matrice.get((atteso, avuto), 0) + 1
        ok = avuto is atteso
        if not ok:
            sbagliati += 1
        if verbose or not ok:
            segno = "ok  " if ok else "NO  "
            print(f"  {segno}{testo[:38]!r:42} atteso {atteso.value:7} "
                  f"avuto {avuto.value:7} ({perche})")
    print(f"  {len(casi) - sbagliati}/{len(casi)} corretti")

    esiti = sorted({e for c in matrice for e in c}, key=lambda e: e.value)
    if sbagliati:
        print("\n       " + " ".join(f"{e.value[:6]:>7}" for e in esiti)
              + "   <- avuto")
        for a in esiti:
            riga = " ".join(f"{matrice.get((a, b), 0):>7}" for b in esiti)
            print(f"  {a.value[:5]:>5} {riga}")
    return sbagliati


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    sbagliati = giro(CASI, False, "oggi: solo regole, CAMBIA spento",
                     args.verbose)
    sbagliati += giro(CASI_CAMBIA, True, "fase 5: CAMBIA concesso",
                      args.verbose)
    if not sbagliati:
        print("\n  tutte le terne classificate come previsto")
    return 0 if sbagliati == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
