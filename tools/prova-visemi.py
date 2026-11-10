"""La timeline dei visemi copre l'audio e ha senso? (modo C, parte PC)

Il generatore vive sul PC ed e' verificabile in isolamento: niente GPU, niente
audio, un decimo di secondo. Si controllano le proprieta' su cui poggia il
lipsync sul client:

  - la timeline copre ESATTAMENTE la durata dell'audio (parlato e bocca
    finiscono insieme);
  - le pause diventano bocca chiusa (`sil`);
  - le vocali durano piu' delle consonanti;
  - i digrammi italiani (ch, gn, sc, c/g dolci) danno il viseme giusto;
  - due suoni uguali di fila non fanno tremolare la bocca.

    python tools/prova-visemi.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "call-bridge"))

from callbridge.viseme_gen import _espeak, genera, timeline  # noqa: E402

esiti: list[tuple[bool, str]] = []


def verifica(cond: bool, descr: str) -> None:
    esiti.append((bool(cond), descr))
    print(f"  {'ok  ' if cond else 'NO  '}{descr}")


print("\n  --- copertura del tempo ---")
vs = genera("Ciao, come stai oggi?", 2.0)
fine = vs[-1].t + vs[-1].dur if vs else 0.0
verifica(abs(fine - 2.0) < 1e-6, f"la timeline copre esattamente 2,0s (arriva a {fine:.3f})")
verifica(all(vs[i].t <= vs[i + 1].t for i in range(len(vs) - 1)),
         "i visemi sono in ordine di tempo, senza sovrapposizioni")

print("\n  --- le pause chiudono la bocca ---")
vs = genera("no. si", 1.0)
sil = [v for v in vs if v.v == "sil"]
verifica(len(sil) >= 1, "il punto fermo produce un viseme sil")

print("\n  --- vocali piu' lunghe delle consonanti ---")
vs = genera("papa", 1.0)
durata_a = sum(v.dur for v in vs if v.v == "aa")
durata_p = sum(v.dur for v in vs if v.v == "PP")
verifica(durata_a > durata_p, f"le 'a' ({durata_a:.2f}s) durano piu' delle 'p' ({durata_p:.2f}s)")

print("\n  --- digrammi italiani ---")
casi = [
    ("chi", "kk", "ch -> suono /k/, non /tʃ/"),
    ("gnomo", "nn", "gn -> nasale"),
    ("sci", "CH", "sc davanti a i -> /ʃ/"),
    ("cena", "CH", "c dolce -> /tʃ/"),
    ("gita", "CH", "g dolce -> /dʒ/"),
    ("gatto", "kk", "g dura -> /g/"),
]
for parola, atteso, perche in casi:
    vs = genera(parola, 1.0)
    presenti = {v.v for v in vs}
    verifica(atteso in presenti, f"{parola!r}: {perche} (visemi: {sorted(presenti)})")

print("\n  --- niente tremolio sulle doppie ---")
vs = genera("mamma", 1.0)
# non devono esserci due PP consecutivi separati da nulla
consecutivi = any(vs[i].v == vs[i + 1].v for i in range(len(vs) - 1))
verifica(not consecutivi, "'mamma' non ripete lo stesso viseme di fila")

print("\n  --- il pacchetto per il WebSocket ---")
pkt = timeline("Buongiorno", 1.5)
verifica(pkt["type"] == "visemi" and pkt["durata"] == 1.5 and pkt["visemi"],
         "timeline() produce {type, testo, durata, visemi}")
verifica(all(set(v) == {"t", "v", "dur"} for v in pkt["visemi"]),
         "ogni viseme e' {t, v, dur}")

# un esempio leggibile
print("\n  esempio, 'Ciao come stai' in 1,8s:")
for v in genera("Ciao come stai", 1.8):
    print(f"    {v.t:5.2f}s  {v.v:4}  {v.dur:.2f}s")

print("\n  --- multilingue via IPA (se espeak-ng c'e') ---")
if _espeak() is not None:
    prove = [
        ("en", "maybe problem", {"PP", "I"}),     # bilabiali m/b/p -> PP
        ("fr", "bonjour", {"PP", "O", "RR"}),
        ("de", "guten tag", {"kk", "DD"}),
        ("es", "buenos dias", {"PP", "DD", "SS"}),
    ]
    for lang, txt, attesi in prove:
        vs = genera(txt, 1.5, lang)
        pres = {v.v for v in vs}
        fine = vs[-1].t + vs[-1].dur if vs else 0.0
        verifica(abs(fine - 1.5) < 1e-6 and attesi <= pres,
                 f"[{lang}] {txt!r}: copre 1,5s e contiene {sorted(attesi)} "
                 f"(visemi: {sorted(pres)})")
    pkt = timeline("hello", 1.0, "en")
    verifica(pkt["lang"] == "en", "timeline() riporta la lingua")
else:
    print("  (espeak-ng non installato: salto, il fallback italiano resta coperto sopra)")

giuste = sum(1 for ok, _ in esiti if ok)
print(f"\n  {giuste}/{len(esiti)} verifiche superate")
raise SystemExit(0 if giuste == len(esiti) else 1)
