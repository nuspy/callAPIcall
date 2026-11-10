"""Si finge il client ESP32-P4 e prova la negoziazione video col gateway.

Serve a rispondere, PRIMA di scrivere una riga di firmware, a una domanda sola:
l'offerta SDP che un ESP32 sa produrre viene accettata da questo gateway, e la
risposta e' qualcosa che un decoder H.264 software sa digerire?

Il microcontrollore non puo' permettersi la SDP che genera un browser. Questa e'
scritta a mano, minimale, e contiene solo cio' che serve:

  - UNA sola m-line video, in sola ricezione. Niente `m=audio`: e' cosi' che si
    chiede al gateway di continuare a mandare la voce in PCM sul WebSocket
    invece che in Opus su una traccia WebRTC (vedi `_negozia` in
    avatar_webrtc.py: `audio_attivo` si accende solo se l'offerta ha `m=audio`).
    Per un MCU un solo percorso audio invece di due vale piu' della banda.
  - solo H.264, `packetization-mode=1`: l'unico modo che aiortc offre.
  - `a=rtcp-mux`, senza il quale aiortc RIFIUTA l'offerta (rtcpeerconnection.py).
  - `a=setup:actpass`, a cui aiortc risponde `active`: quindi il ruolo DTLS
    dell'ESP e' quello PASSIVO (server), che va saputo prima di scrivere il C.
  - `nack`, `nack pli` e `goog-remb`: sono le tre leve che il server implementa
    davvero e che sul microcontrollore valgono oro — la ritrasmissione, il
    keyframe su richiesta e il controllo del bitrate.

Non stabilisce la connessione: fingerprint e credenziali ICE sono finte, e la
verifica si ferma alla risposta. E' esattamente il punto: isola il rischio
"interoperabilita' SDP" da tutto il resto.

    python tools/esp32-sdp-probe.py            # persona corrente
    python tools/esp32-sdp-probe.py --persona la persona --salva riferimento.sdp
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from websockets.sync.client import connect  # noqa: E402

from callbridge.config import Config  # noqa: E402

#: Impronta e credenziali ICE fittizie: qui non si stabilisce nulla, si verifica
#: solo che l'offerta venga accettata e cosa risponde il gateway.
_FINTE = {
    "ufrag": "esp32test",
    "pwd": "esp32testpassword0123456789",
    "fp": ("AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:"
           "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"),
}


def offerta_esp32(ip: str = "192.168.1.99", porta: int = 50000) -> str:
    """L'offerta SDP che il firmware dovra' produrre, riga per riga."""
    return "\r\n".join([
        "v=0",
        f"o=- {int(time.time())} 1 IN IP4 {ip}",
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0",
        "a=msid-semantic: WMS",
        "m=video 9 UDP/TLS/RTP/SAVPF 102",
        "c=IN IP4 0.0.0.0",
        "a=rtcp:9 IN IP4 0.0.0.0",
        f"a=candidate:1 1 udp 2130706431 {ip} {porta} typ host",
        "a=end-of-candidates",
        f"a=ice-ufrag:{_FINTE['ufrag']}",
        f"a=ice-pwd:{_FINTE['pwd']}",
        "a=ice-options:trickle",
        f"a=fingerprint:sha-256 {_FINTE['fp']}",
        "a=setup:actpass",
        "a=mid:0",
        "a=recvonly",
        "a=rtcp-mux",
        "a=rtpmap:102 H264/90000",
        "a=rtcp-fb:102 nack",
        "a=rtcp-fb:102 nack pli",
        "a=rtcp-fb:102 goog-remb",
        "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;"
        "profile-level-id=42e01f",
        "",
    ])


def _attributi(sdp: str, chiave: str) -> list[str]:
    return [r.strip() for r in sdp.splitlines() if r.startswith(chiave)]


def esamina(risposta: str) -> list[tuple[bool, str]]:
    """Controlli sulla risposta, ognuno con il motivo per cui conta a bordo."""
    fmtp = " ".join(_attributi(risposta, "a=fmtp:"))
    rtpmap = " ".join(_attributi(risposta, "a=rtpmap:"))
    fb = " ".join(_attributi(risposta, "a=rtcp-fb:"))
    setup = " ".join(_attributi(risposta, "a=setup:"))
    return [
        ("m=video" in risposta,
         "c'e' la traccia video"),
        ("m=audio" not in risposta,
         "NESSUNA traccia audio: la voce resta in PCM sul WebSocket"),
        ("H264/90000" in rtpmap,
         "il codec e' H.264 (non VP8: sarebbe da decodificare in software senza"
         " nemmeno il profilo giusto)"),
        ("packetization-mode=1" in fmtp,
         "packetization-mode=1: servono FU-A e STAP-A nel depacketizzatore"),
        ("a=rtcp-mux" in risposta,
         "rtcp-mux accettato: una sola porta UDP invece di due"),
        ("active" in setup,
         "il gateway e' DTLS client -> l'ESP fa il SERVER (passivo)"),
        ("nack pli" in fb,
         "PLI disponibile: si puo' chiedere un keyframe dopo un errore"),
        ("goog-remb" in fb,
         "REMB disponibile: si puo' abbassare il bitrate dal device"),
        (bool(_attributi(risposta, "a=candidate:")),
         "la risposta porta gia' i candidati ICE (niente trickle da gestire)"),
        ("stun" not in risposta.lower(),
         "nessun riferimento a STUN esterni"),
    ]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--persona", default="", help="vuoto = quella attiva")
    ap.add_argument("--salva", default="", help="scrive la risposta SDP su file")
    args = ap.parse_args()

    cfg = Config.load()
    url = f"ws://{args.host}:{cfg.gateway_port}"
    token = getattr(cfg, "gateway_auth_token", "") or ""
    offerta = offerta_esp32()
    print(f"  gateway: {url}")
    print(f"  offerta: {len(offerta)} byte, "
          f"{len(offerta.splitlines())} righe, una sola m-line video")

    with connect(url, open_timeout=15, max_size=None) as ws:
        ws.send(json.dumps({"type": "auth", "token": token}))
        scadenza = time.monotonic() + 30
        while time.monotonic() < scadenza:
            m = json.loads(ws.recv(timeout=15))
            if m.get("type") == "ready":
                break
            if m.get("type") == "error":
                print(f"  il gateway rifiuta: {m.get('message')}")
                return 1
        else:
            print("  nessun 'ready' entro 30s")
            return 1

        t0 = time.monotonic()
        ws.send(json.dumps({"type": "video_start", "sdp": offerta,
                            "sdp_type": "offer", "persona": args.persona,
                            "brain": "chat"}))
        risposta = None
        scadenza = time.monotonic() + 60
        while time.monotonic() < scadenza:
            try:
                m = json.loads(ws.recv(timeout=30))
            except TimeoutError:
                break
            tipo = m.get("type")
            if tipo == "video_answer":
                risposta = m.get("sdp") or ""
                print(f"  risposta dopo {time.monotonic() - t0:.2f}s")
                break
            if tipo == "error":
                print(f"  ERRORE dal gateway: {m.get('message')}")
                return 1
            if tipo == "video_state":
                print(f"  stato: {m.get('state')} {m.get('detail') or ''}")
        if risposta is None:
            print("  nessuna video_answer: l'offerta e' stata scartata")
            return 1

        print()
        ko = 0
        for ok, motivo in esamina(risposta):
            print(f"  {'OK  ' if ok else 'NO  '}{motivo}")
            ko += 0 if ok else 1

        prof = re.search(r"profile-level-id=([0-9a-fA-F]{6})", risposta)
        if prof:
            print(f"\n  profile-level-id concordato: {prof.group(1)} "
                  "(42 = Baseline, che e' cio' che tinyH264 decodifica)")

        ws.send(json.dumps({"type": "video_stop"}))
        if args.salva:
            Path(args.salva).write_text(risposta, encoding="utf-8")
            print(f"  risposta salvata in {args.salva}")
        print(f"\n  {'tutto a posto' if ko == 0 else f'{ko} controlli falliti'}")
        return 1 if ko else 0


if __name__ == "__main__":
    raise SystemExit(main())
