"""
Client di test per la REST API dell'app Android di controllo chiamate.

Permette di provare gli endpoint senza il call-bridge completo.

Uso:
  python test_phone_control.py <ip-telefono> health
  python test_phone_control.py <ip-telefono> status
  python test_phone_control.py <ip-telefono> call +39333xxxxxxx
  python test_phone_control.py <ip-telefono> answer
  python test_phone_control.py <ip-telefono> hangup

Il token deve combaciare con ControlService.AUTH_TOKEN nell'app Android.
"""

from __future__ import annotations

import sys
import urllib.error
import urllib.request
import json

PORT = 8080
# Deve combaciare con ControlService.AUTH_TOKEN lato Android.
AUTH_TOKEN = "change-me-shared-token"


def request(ip: str, method: str, path: str, body: dict | None = None) -> None:
    url = f"http://{ip}:{PORT}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Authorization", f"Bearer {AUTH_TOKEN}")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f"{resp.status} {resp.reason}")
            print(resp.read().decode())
    except urllib.error.HTTPError as e:
        print(f"{e.code} {e.reason}")
        print(e.read().decode())
    except urllib.error.URLError as e:
        print(f"Connessione fallita: {e.reason}")
        print("Controlla che il telefono sia raggiungibile e il servizio avviato.")


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    ip = sys.argv[1]
    cmd = sys.argv[2].lower()

    if cmd == "health":
        request(ip, "GET", "/health")
    elif cmd == "status":
        request(ip, "GET", "/status")
    elif cmd == "call":
        if len(sys.argv) < 4:
            print("Manca il numero. Uso: ... call +39333xxxxxxx")
            sys.exit(1)
        request(ip, "POST", "/call", {"number": sys.argv[3]})
    elif cmd == "answer":
        request(ip, "POST", "/answer")
    elif cmd == "hangup":
        request(ip, "POST", "/hangup")
    else:
        print(f"Comando sconosciuto: {cmd}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
