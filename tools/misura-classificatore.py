"""Quanto costa classificare un'interruzione, e soprattutto: quanto costa FARLO MENTRE
l'avatar sta già parlando? (fase 0c)

Nel piano full-duplex, quando l'utente parla sopra l'avatar il sistema deve
decidere in fretta fra quattro strade — ignorare, fermarsi, accodare, integrare.
Le regole deterministiche coprono i casi ovvi a costo zero; per la zona grigia
serve una domanda breve all'LLM, con un tetto di 400 ms oltre il quale si
ripiega su ACCODA.

Il punto delicato non è la latenza a vuoto: è che LM Studio serve **una
richiesta per volta** sullo stesso modello caricato. La classificazione arriva
mentre la risposta principale sta ancora streammando, quindi deve mettersi in
fila dietro di essa. Se quella fila costa più di 400 ms, il ripiego diventa la
norma e la parte intelligente del sistema non scatta mai — e la conclusione
sarebbe spostare il classificatore altrove (vLLM col batching, o un modello
piccolo a parte).

Per questo si misura in due condizioni, e si confrontano:

    A. modello fermo            -> il caso migliore, quello che si vede nei blog
    B. durante una generazione  -> il caso vero

Ogni misura registra lo stato della VRAM, perché su questa macchina i tempi
dipendono da quanto è piena: con pagine sfrattate nella memoria condivisa gli
stessi token costano il triplo.

    python tools/misura-classificatore.py --giri 12
"""
from __future__ import annotations

import argparse
import json
import statistics
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.config import Config  # noqa: E402

SISTEMA = ("Classifichi i turni di una conversazione parlata. "
           "Rispondi con UNA parola sola, nient'altro.")

#: Terne realistiche: cosa l'avatar ha già detto, cosa stava per dire, cosa
#: l'utente ha detto sopra. Coprono i quattro esiti.
CASI = [
    ("Allora, per preparare il caffè ti serve prima di tutto una macchina "
     "con il portafiltro.",
     "Poi vai a scegliere la miscela, che è la parte più importante.",
     "sì sì",
     "IGNORA"),
    ("Le regioni del nord che ti consiglio sono il Piemonte e la Lombardia.",
     "Il Piemonte è famoso per il tartufo bianco di Alba e per i grandi vini.",
     "aspetta, fermati un attimo",
     "FERMA"),
    ("La ricetta prevede di soffriggere la cipolla per almeno dieci minuti.",
     "Dopo aggiungi il sedano e la carota tagliati a dadini piccoli.",
     "e senza cipolla come si fa?",
     "CAMBIA"),
    ("Ti stavo dicendo che domani mattina hai la riunione con il commercialista.",
     "Poi nel pomeriggio sei libero fino alle cinque.",
     "ricordami anche di chiamare mia sorella stasera",
     "ASPETTA"),
]


def _vram() -> str:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=30).stdout.strip()
        a, b = (int(x.strip()) for x in out.split(","))
        return f"{a}/{b} MiB ({100*a//b}%)"
    except Exception:  # noqa: BLE001
        return "?"


def _prompt(detto: str, previsto: str, nuova: str) -> str:
    return (f'L\'assistente ha appena detto ad alta voce: "{detto[-200:]}"\n'
            f'Sta per dire, ma non è ancora uscito: "{previsto[:200]}"\n'
            f'L\'utente lo ha interrotto dicendo: "{nuova}"\n\n'
            "IGNORA  = non è rivolto all'assistente, o è solo un cenno di ascolto\n"
            "FERMA   = l'utente vuole che smetta e faccia altro\n"
            "ASPETTA = è una cosa nuova, ma può aspettare la fine di questa risposta\n"
            "CAMBIA  = riguarda ciò che sta per dire: va rifatto tenendone conto\n\n"
            "Una parola:")


def classifica(base: str, chiave: str, caso) -> tuple[float, str]:
    detto, previsto, nuova, _atteso = caso
    corpo = {
        "model": "local", "stream": False, "temperature": 0, "max_tokens": 4,
        "stop": ["\n"], "reasoning_effort": "none",
        "messages": [{"role": "system", "content": SISTEMA},
                     {"role": "user", "content": _prompt(detto, previsto, nuova)}],
    }
    req = urllib.request.Request(f"{base}/chat/completions",
                                 json.dumps(corpo).encode(),
                                 {"Content-Type": "application/json",
                                  "Authorization": f"Bearer {chiave}"})
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=60) as r:
        d = json.loads(r.read())
    dt = time.perf_counter() - t0
    testo = ((d.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    return dt, testo.strip().upper().split()[0] if testo.strip() else ""


def genera_di_fondo(base: str, chiave: str, stop: threading.Event) -> None:
    """Tiene occupato il modello come farebbe la risposta principale."""
    corpo = {
        "model": "local", "stream": True, "temperature": 0.8, "max_tokens": 400,
        "messages": [{"role": "user",
                      "content": "Descrivi con calma e in modo esteso come si "
                                 "prepara il pane in casa, passo per passo."}],
    }
    while not stop.is_set():
        try:
            req = urllib.request.Request(f"{base}/chat/completions",
                                         json.dumps(corpo).encode(),
                                         {"Content-Type": "application/json",
                                          "Authorization": f"Bearer {chiave}"})
            with urllib.request.urlopen(req, timeout=180) as r:
                for _ in r:
                    if stop.is_set():
                        break
        except Exception:  # noqa: BLE001 - il disturbatore non deve fermare la prova
            time.sleep(0.5)


def riepiloga(nome: str, tempi: list[float], esiti: list[tuple[str, str]]) -> None:
    if not tempi:
        print(f"  {nome}: nessuna misura")
        return
    ordinati = sorted(tempi)
    p50 = statistics.median(ordinati)
    p95 = ordinati[min(len(ordinati) - 1, int(0.95 * len(ordinati)))]
    giuste = sum(1 for atteso, avuto in esiti if avuto == atteso)
    print(f"  {nome:34} p50 {p50*1000:5.0f} ms   p95 {p95*1000:5.0f} ms   "
          f"max {max(ordinati)*1000:5.0f} ms   risposte giuste {giuste}/{len(esiti)}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--giri", type=int, default=12)
    args = ap.parse_args()

    cfg = Config.load()
    base = cfg.lmstudio_base_url.rstrip("/")
    chiave = getattr(cfg, "lmstudio_api_key", "") or "lm-studio"
    print(f"  LLM: {base}")
    print(f"  VRAM all'inizio: {_vram()}")

    # --- A. modello fermo -------------------------------------------------
    tempi_a, esiti_a = [], []
    for i in range(args.giri):
        caso = CASI[i % len(CASI)]
        try:
            dt, avuto = classifica(base, chiave, caso)
        except Exception as e:  # noqa: BLE001
            print(f"  A giro {i}: {type(e).__name__}: {e}")
            continue
        tempi_a.append(dt)
        esiti_a.append((caso[3], avuto))
    riepiloga("A. modello fermo", tempi_a, esiti_a)

    # --- B. durante una generazione --------------------------------------
    stop = threading.Event()
    t = threading.Thread(target=genera_di_fondo, args=(base, chiave, stop),
                         daemon=True)
    t.start()
    time.sleep(3)                      # lascia partire la generazione di fondo
    tempi_b, esiti_b = [], []
    for i in range(args.giri):
        caso = CASI[i % len(CASI)]
        try:
            dt, avuto = classifica(base, chiave, caso)
        except Exception as e:  # noqa: BLE001
            print(f"  B giro {i}: {type(e).__name__}: {e}")
            continue
        tempi_b.append(dt)
        esiti_b.append((caso[3], avuto))
    stop.set()
    riepiloga("B. durante una generazione", tempi_b, esiti_b)

    print(f"  VRAM alla fine:  {_vram()}")
    if tempi_b:
        p95 = sorted(tempi_b)[min(len(tempi_b) - 1, int(0.95 * len(tempi_b)))]
        print()
        if p95 <= 0.4:
            print("  -> il classificatore ibrido regge: la domanda all'LLM sta")
            print("     dentro i 400 ms anche mentre l'avatar parla.")
        else:
            print(f"  -> p95 di {p95*1000:.0f} ms oltre il tetto di 400: il ripiego")
            print("     (ACCODA) diventerebbe la norma. Serve spostare la")
            print("     classificazione su vLLM o su un modello piccolo a parte,")
            print("     oppure restare alle sole regole deterministiche.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
