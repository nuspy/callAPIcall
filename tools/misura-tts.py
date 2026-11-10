"""Quanto è veloce il TTS rispetto al tempo reale? (fase 0a)

Il repo contiene due affermazioni opposte e inconciliabili:

    chunk_policy.py:50   _R_TTS = 4.0      "misurata: ~4x su XTTS caldo"
    ptt.py:335           "XTTS va a 0,86x realtime, cioe' piu' piano di
                          quanto l'avatar parli"

Non è una curiosità: da questo numero dipende se la conversazione full-duplex
continua è possibile. Tutta l'idea poggia sul fatto che la generazione corra
più veloce del parlato, perché è quel vantaggio che lascia il tempo di
riscrivere una risposta prima che venga pronunciata. Se il rapporto è sotto 1,
non c'è niente da riscrivere.

Misura il rapporto `durata dell'audio prodotto / tempo impiegato a produrlo`
su frasi di lunghezza crescente, a freddo e a caldo, sul motore realmente
caricato (`GET /models/status` dice quale). Non tocca niente: usa
`POST /tts/test`, che esiste già e restituisce `duration_ms`.

    python tools/misura-tts.py
    python tools/misura-tts.py --giri 5 --voce "Chandra MacFarland"
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.config import Config  # noqa: E402

#: Frasi di lunghezza crescente. Sono italiane e sensate di proposito: un
#: lorem ipsum o una stringa ripetuta darebbe tempi diversi, perché il TTS
#: lavora sulla fonetica e sulla prosodia, non sui caratteri.
FRASI = [
    ("40", "Certo, dimmi pure cosa ti serve adesso."),
    ("80", "Ho controllato il calendario di domani e mi sembra che tu abbia "
           "due riunioni."),
    ("160", "Ho controllato il calendario di domani: hai due riunioni, una la "
            "mattina presto e l'altra subito dopo pranzo, quindi conviene "
            "tenere libero il pomeriggio per il resto."),
    ("320", "Ho controllato il calendario di domani e la situazione è questa: "
            "hai due riunioni, una la mattina presto e l'altra subito dopo "
            "pranzo, quindi conviene tenere libero il pomeriggio per il "
            "lavoro che avevi rimandato. Se vuoi posso spostare la seconda "
            "più avanti, così resta un blocco unico di tempo tranquillo "
            "invece di due spezzoni corti."),
]


def sintetizza(base: str, testo: str, voce: str, lang: str) -> tuple[float, float]:
    """Ritorna (durata dell'audio in secondi, tempo impiegato in secondi)."""
    corpo = {"text": testo, "lang": lang}
    if voce:
        corpo["voice"] = voce
    req = urllib.request.Request(f"{base}/tts/test", json.dumps(corpo).encode(),
                                 {"Content-Type": "application/json"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=300) as r:
        d = json.loads(r.read())
    dt = time.perf_counter() - t0
    return (d.get("duration_ms") or 0) / 1000.0, dt


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--giri", type=int, default=3, help="ripetizioni a caldo")
    ap.add_argument("--voce", default="", help="vuoto = quella predefinita")
    ap.add_argument("--lang", default="it")
    args = ap.parse_args()

    cfg = Config.load()
    base = f"http://127.0.0.1:{cfg.handy_compat_port}"
    try:
        with urllib.request.urlopen(f"{base}/models/status", timeout=20) as r:
            stato = json.loads(r.read())
    except urllib.error.URLError as e:
        print(f"  motori non raggiungibili su {base}: {e}")
        return 1
    motore = (stato.get("tts") or {}).get("current_model")
    print(f"  motore TTS: {motore}   (voce: {args.voce or 'predefinita'})")
    print(f"  {'':>6} {'caratteri':>9} {'audio':>8} {'sintesi':>8} {'rapporto':>9}")

    tutti: list[float] = []
    for etichetta, testo in FRASI:
        rapporti = []
        for giro in range(args.giri + 1):          # il giro 0 è a freddo
            try:
                audio_s, sintesi_s = sintetizza(base, testo, args.voce, args.lang)
            except Exception as e:                 # noqa: BLE001
                print(f"  {etichetta:>6} FALLITA: {type(e).__name__}: {e}")
                break
            if not audio_s or not sintesi_s:
                continue
            r = audio_s / sintesi_s
            freddo = " (a freddo)" if giro == 0 else ""
            print(f"  {etichetta:>6} {len(testo):>9} {audio_s:>7.2f}s "
                  f"{sintesi_s:>7.2f}s {r:>8.2f}x{freddo}")
            if giro > 0:                           # il freddo non entra nella media
                rapporti.append(r)
        if rapporti:
            tutti.extend(rapporti)
            print(f"  {'':>6} {'':>9} {'':>8} {'mediana':>8} "
                  f"{statistics.median(rapporti):>8.2f}x")

    if not tutti:
        print("\n  nessuna misura riuscita")
        return 1
    r = statistics.median(tutti)
    print(f"\n  RAPPORTO MEDIANO A CALDO: {r:.2f}x il tempo reale")
    print(f"  (in chunk_policy.py c'e' scritto _R_TTS = 4.0)")
    if r >= 1.5:
        print("  -> il vantaggio temporale c'e': la riscrittura della risposta")
        print("     e' possibile, profondita' di sintesi 1.")
    elif r > 1.0:
        print("  -> vantaggio sottile: profondita' di sintesi 2, anticipo piu'")
        print("     alto, INTEGRA solo quando la coda e' davvero lunga.")
    else:
        print("  -> NESSUN vantaggio: la sintesi non sta dietro al parlato.")
        print("     INTEGRA non e' realizzabile; restano barge-in pulito,")
        print("     ducking e cancellazione d'eco (vedi Rischi, punto 1).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
