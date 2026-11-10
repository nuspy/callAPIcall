"""Implementazione di riferimento del server lato agente per callAPIcall.

Questo e' il **server che ogni agente** (Hermes, Claude, qualsiasi LLM
runtime) deve esporre per essere "il cervello" delle telefonate gestite da
callAPIcall. Si puo' usare in due modi:

1. **Come riferimento**: la spec autorevole degli endpoint, payload, SSE.
2. **Eseguibile**: avviarlo cosi' com'e' per testare l'integrazione end-to-end
   (la funzione `stub_respond` genera risposte echo simulando lo streaming
   token-per-token); poi sostituire `RESPOND_FN` con il vero LLM streaming.

Uso:
    pip install flask                                # unica dipendenza
    python hermes_server.py                          # bind 127.0.0.1:8780
    python hermes_server.py --host 0.0.0.0 --port 8780

Per usare un LLM vero, sostituisci `RESPOND_FN` con una funzione che ritorni
un iteratore di stringhe (chunk del testo di risposta). Firma:

    def respond(session_id: str, text: str, direction: str) -> Iterator[str]: ...

Lo streaming token-per-token e' fortemente raccomandato: l'orchestrator
inoltra ogni chunk al TTS man mano che arriva, e la voce parte appena
arriva la prima frase, senza aspettare la fine della generazione.
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from collections.abc import Iterator

from flask import Flask, Response, jsonify, request

log = logging.getLogger("hermes-server")

# Sessioni attive in memoria. In un agente vero, persisti lo storico
# delle conversazioni e qualunque contesto utile alla generazione.
SESSIONS: dict[str, dict] = {}


# ---------------------------------------------------------------------------
# Funzione di risposta (DA SOSTITUIRE col tuo LLM streaming)
# ---------------------------------------------------------------------------

def stub_respond(session_id: str, text: str, direction: str) -> Iterator[str]:
    """Stub: rimanda un'eco del testo ricevuto, a pezzi.

    Sostituisci con una chiamata al tuo LLM in modalita' streaming. Esempio:

        def respond(session_id, text, direction):
            session = SESSIONS.get(session_id, {})
            lang = session.get("lang", "it")
            system = f"Sei un agente telefonico. Rispondi in {lang}, "
            response_stream = my_llm.chat_stream(
                system=system,
                history=session.get("history", []),
                user=text,
            )
            full = ""
            for token in response_stream:
                full += token
                yield token
            session.setdefault("history", []).extend([
                {"role": "user", "content": text},
                {"role": "assistant", "content": full},
            ])
    """
    reply = f"Ho sentito: {text}. "
    for word in reply.split(" "):
        if word:
            yield word + " "
            time.sleep(0.05)  # simula la latenza del token streaming


# Punto di hook: ridefinisci a runtime con la tua funzione vera.
RESPOND_FN = stub_respond


# ---------------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------------

def create_app() -> Flask:
    app = Flask(__name__)

    # --- health ----------------------------------------------------------

    @app.get("/health")
    def health():
        return jsonify({"status": "ok"})

    # --- notifiche di chiamata ------------------------------------------

    @app.post("/incoming-call")
    def incoming_call():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id")
        if not sid:
            return jsonify({"error": "session_id missing"}), 400
        SESSIONS[sid] = {
            "direction": "INCOMING",
            "number": body.get("number", ""),
            "voice": body.get("voice", ""),
            "lang": body.get("lang", ""),
            "started_at": time.time(),
            "history": [],
        }
        log.info(
            "incoming-call session=%s from=%s lang=%s voice=%s",
            sid, body.get("number"), body.get("lang"), body.get("voice"),
        )
        # Qui l'agente puo' iniziare a "pensare" a una frase di apertura
        # nella lingua indicata, ma NON la emette ancora: arrivera' il primo
        # POST /utterance non appena l'interlocutore parla.
        return jsonify({"status": "ready"})

    @app.post("/outgoing-call")
    def outgoing_call():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id")
        if not sid:
            return jsonify({"error": "session_id missing"}), 400
        SESSIONS[sid] = {
            "direction": "OUTGOING",
            "number": body.get("number", ""),
            "voice": body.get("voice", ""),
            "lang": body.get("lang", ""),
            "started_at": time.time(),
            "history": [],
        }
        log.info(
            "outgoing-call session=%s to=%s lang=%s voice=%s",
            sid, body.get("number"), body.get("lang"), body.get("voice"),
        )
        # Per una chiamata in uscita l'agente di solito sa gia' lo scopo
        # (l'ha decisa lui via callctl): puo' preparare un'apertura.
        return jsonify({"status": "ready"})

    # --- conversazione (SSE) --------------------------------------------

    @app.post("/utterance")
    def utterance():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id", "")
        text = (body.get("text") or "").strip()
        direction = body.get("direction", "")
        if not text:
            return jsonify({"error": "text empty"}), 400
        if sid not in SESSIONS:
            log.warning("utterance per session sconosciuta: %s", sid)
            # Permissivo: si processa comunque (utile durante test ad-hoc).
            SESSIONS[sid] = {"direction": direction, "history": []}

        log.info("utterance session=%s: %s", sid, text)

        def stream() -> Iterator[bytes]:
            full = ""
            try:
                for chunk in RESPOND_FN(sid, text, direction):
                    full += chunk
                    yield _sse({"chunk": chunk})
            except Exception as e:  # noqa: BLE001
                log.error("RESPOND_FN ha sollevato: %s", e)
                yield _sse({"error": str(e)})
            # Aggiorna lo storico della sessione (utile alle risposte successive).
            sess = SESSIONS.get(sid)
            if sess is not None:
                history = sess.setdefault("history", [])
                history.append({"role": "user", "content": text})
                history.append({"role": "assistant", "content": full})
            yield _sse({"done": True})

        return Response(stream(), mimetype="text/event-stream")

    # --- fine chiamata --------------------------------------------------

    @app.post("/call-ended")
    def call_ended():
        body = request.get_json(silent=True) or {}
        sid = body.get("session_id", "")
        sess = SESSIONS.pop(sid, None)
        log.info("call-ended session=%s (%d turni)",
                 sid, len(sess.get("history", [])) // 2 if sess else 0)
        return jsonify({"status": "ok"})

    # --- debug / introspezione ------------------------------------------

    @app.get("/sessions")
    def sessions():
        # Solo per debug: in produzione filtra/disabilita.
        return jsonify(SESSIONS)

    return app


def _sse(payload: dict) -> bytes:
    """Codifica un evento Server-Sent Events."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n".encode("utf-8")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(name)-14s %(levelname)-7s %(message)s",
        datefmt="%H:%M:%S",
    )
    parser = argparse.ArgumentParser(
        description="Server di riferimento lato agente per callAPIcall"
    )
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8780)
    args = parser.parse_args()

    app = create_app()
    log.info("Hermes-side server in ascolto su http://%s:%d", args.host, args.port)
    log.info("RESPOND_FN attiva: %s (sostituire con il tuo LLM streaming)",
             RESPOND_FN.__name__)
    app.run(host=args.host, port=args.port, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
