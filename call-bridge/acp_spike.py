"""Spike: valida il dialogo ACP con l'agente Hermes completo (via wsl).

Lancia `hermes acp` in WSL, fa initialize -> session/new -> session/prompt e
stampa la risposta in streaming. Auto-approva permessi e declina fs/terminal.
"""
from __future__ import annotations

import json
import queue
import subprocess
import sys
import threading
import time

WSL_CMD = [
    "wsl.exe", "-d", "Ubuntu", "--", "bash", "-lc",
    "cd /home/ataini && exec /home/ataini/.hermes/hermes-agent/venv/bin/python "
    "-m hermes_cli.main acp --accept-hooks",
]
CWD_WSL = "/home/ataini"
TIMEOUT = 180.0


def main() -> int:
    proc = subprocess.Popen(
        WSL_CMD, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", bufsize=1,
    )
    inbox: "queue.Queue[dict]" = queue.Queue()

    def _stdout_reader():
        for line in proc.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                inbox.put(json.loads(line))
            except Exception:
                print("  [stdout non-JSON]", line[:200], file=sys.stderr)

    def _stderr_reader():
        for line in proc.stderr:
            print("  [stderr]", line.rstrip(), file=sys.stderr)

    threading.Thread(target=_stdout_reader, daemon=True).start()
    threading.Thread(target=_stderr_reader, daemon=True).start()

    nid = 0

    def send(method, params, msg_id=None):
        obj = {"jsonrpc": "2.0", "method": method, "params": params}
        if msg_id is not None:
            obj["id"] = msg_id
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    def reply(msg_id, result):
        proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": msg_id, "result": result}) + "\n")
        proc.stdin.flush()

    def request(method, params, collect=None):
        nonlocal nid
        nid += 1
        rid = nid
        send(method, params, msg_id=rid)
        deadline = time.monotonic() + TIMEOUT
        while time.monotonic() < deadline:
            if proc.poll() is not None:
                print("!! processo ACP terminato", file=sys.stderr)
                return None
            try:
                msg = inbox.get(timeout=0.1)
            except queue.Empty:
                continue
            mid = msg.get("id")
            method_in = msg.get("method")
            # Notifiche / richieste inverse dall'agente
            if method_in == "session/update":
                upd = (msg.get("params") or {}).get("update") or {}
                if upd.get("sessionUpdate") == "agent_message_chunk":
                    t = ((upd.get("content") or {}).get("text") or "")
                    if t and collect is not None:
                        collect.append(t)
                        print(t, end="", flush=True)
                continue
            if method_in == "session/request_permission":
                # auto-approva: scegli la prima opzione "allow*"
                opts = (msg.get("params") or {}).get("options") or []
                allow = next((o for o in opts if "allow" in str(o.get("kind", "")).lower()
                              or "allow" in str(o.get("optionId", "")).lower()), None)
                if allow:
                    reply(mid, {"outcome": {"outcome": "selected", "optionId": allow.get("optionId")}})
                else:
                    reply(mid, {"outcome": {"outcome": "cancelled"}})
                continue
            if method_in in ("fs/read_text_file", "fs/write_text_file") or (method_in or "").startswith("terminal/"):
                # Non forniamo fs/terminal lato client: l'agente usi i suoi tool.
                proc.stdin.write(json.dumps({"jsonrpc": "2.0", "id": mid,
                    "error": {"code": -32601, "message": "client non fornisce fs/terminal"}}) + "\n")
                proc.stdin.flush()
                continue
            # Risposta alla nostra richiesta
            if mid == rid:
                if "error" in msg:
                    print("\n!! errore", method, msg["error"], file=sys.stderr)
                    return None
                return msg.get("result")
        print("\n!! timeout su", method, file=sys.stderr)
        return None

    print(">> initialize ...", file=sys.stderr)
    init = request("initialize", {"protocolVersion": 1,
        "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}},
        "clientInfo": {"name": "callapicall", "version": "0.1"}})
    print("init result:", json.dumps(init)[:300] if init else init, file=sys.stderr)
    if init is None:
        return 1
    print(">> session/new ...", file=sys.stderr)
    sess = request("session/new", {"cwd": CWD_WSL, "mcpServers": []})
    sid = (sess or {}).get("sessionId")
    print("sessionId:", sid, file=sys.stderr)
    if not sid:
        return 1
    print(">> session/prompt ...\n--- RISPOSTA AGENTE ---", file=sys.stderr)
    out = []
    res = request("session/prompt", {"sessionId": sid,
        "prompt": [{"type": "text", "text": "Ciao! In una frase: chi sei e che strumenti puoi usare?"}]},
        collect=out)
    print("\n--- FINE (stopReason:", (res or {}).get("stopReason"), ") ---", file=sys.stderr)
    print("TESTO:", repr("".join(out))[:500], file=sys.stderr)
    try:
        proc.terminate()
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
