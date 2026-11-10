"""callctl — controlla il gateway telefonico callAPIcall.

Strumento da riga di comando per agenti (Claude, Hermes, ...): fa chiamate
cellulari reali, gestisce i modelli (lingue/voci) e legge lo stato, parlando
con l'API di controllo dell'orchestrator.

Solo libreria standard: nessuna dipendenza da installare.

Config via variabili d'ambiente:
  CALLBRIDGE_CONTROL_URL    (default http://127.0.0.1:8770)
  CALLBRIDGE_CONTROL_TOKEN  (default change-me-control-token)

Comandi:
  callctl.py status                      stato orchestrator + telefono + modelli
  callctl.py models                      voci/lingue disponibili
  callctl.py prepare [--stt-model M]     carica i modelli in VRAM (pre-warm)
  callctl.py call <numero> [--voice V] [--lang L] [--stt-model M]
                                         chiamata in uscita
  callctl.py hangup                      termina la chiamata corrente
  callctl.py unload [--component stt|tts|all]
                                         scarica i modelli dalla VRAM

Codice di uscita: 0 se la risposta HTTP e' 2xx, 1 altrimenti.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

URL = os.environ.get("CALLBRIDGE_CONTROL_URL", "http://127.0.0.1:8770").rstrip("/")
TOKEN = os.environ.get("CALLBRIDGE_CONTROL_TOKEN", "change-me-control-token")


def _request(method: str, path: str, body: dict | None = None) -> tuple[int | None, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{URL}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        # Timeout generoso: il caricamento di un modello puo' richiedere secondi.
        with urllib.request.urlopen(req, timeout=70) as resp:
            return resp.status, json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode() or "{}")
        except Exception:  # noqa: BLE001
            return e.code, {"error": e.reason}
    except urllib.error.URLError as e:
        return None, {"error": f"connessione all'orchestrator fallita: {e.reason}"}


def _emit(status: int | None, data: dict) -> int:
    print(json.dumps(data, indent=2, ensure_ascii=False))
    return 0 if status is not None and 200 <= status < 300 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Controllo del gateway telefonico callAPIcall")
    sub = parser.add_subparsers(dest="cmd", required=True)

    sub.add_parser("status", help="stato orchestrator + telefono + modelli")
    sub.add_parser("models", help="voci/lingue disponibili")

    p_prepare = sub.add_parser("prepare", help="carica i modelli in VRAM (pre-warm)")
    p_prepare.add_argument("--stt-model", help="id del modello STT (default: quello di Handy)")

    p_call = sub.add_parser("call", help="chiamata in uscita")
    p_call.add_argument("number", help="numero da chiamare, es. +39333xxxxxxx")
    p_call.add_argument("--voice", help="voce TTS (es. if_sara). Default lato orchestrator.")
    p_call.add_argument("--lang", help="lingua (es. it). Default lato orchestrator.")
    p_call.add_argument("--stt-model", help="id del modello STT")

    sub.add_parser("hangup", help="termina la chiamata corrente")

    p_unload = sub.add_parser("unload", help="scarica i modelli dalla VRAM")
    p_unload.add_argument(
        "--component", default="all", choices=["stt", "tts", "all"]
    )

    args = parser.parse_args()

    if args.cmd == "status":
        return _emit(*_request("GET", "/status"))
    if args.cmd == "models":
        return _emit(*_request("GET", "/models/available"))
    if args.cmd == "prepare":
        body: dict = {}
        if args.stt_model:
            body["stt_model"] = args.stt_model
        return _emit(*_request("POST", "/prepare", body))
    if args.cmd == "call":
        body = {"number": args.number}
        if args.voice:
            body["voice"] = args.voice
        if args.lang:
            body["lang"] = args.lang
        if args.stt_model:
            body["stt_model"] = args.stt_model
        return _emit(*_request("POST", "/call", body))
    if args.cmd == "hangup":
        return _emit(*_request("POST", "/hangup"))
    if args.cmd == "unload":
        return _emit(*_request("POST", "/models/unload", {"component": args.component}))
    return 1


if __name__ == "__main__":
    sys.exit(main())
