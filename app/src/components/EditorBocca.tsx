import { useEffect, useRef, useState } from "react";

/**
 * Editor manuale della bocca: sul poster dell'avatar si segnano i due angoli
 * della bocca (col mouse sul PC, o a tocco su mobile). Da quei due punti il
 * bridge ricava centro, larghezza e inclinazione e rigenera gli asset del modo
 * A — è il modo scelto perché il rilevamento automatico sbagliava troppo.
 *
 * Da qui si può anche CAMBIARE FOTO tenendo il resto dell'avatar (voce, nome,
 * memoria): dopo il cambio si risegnano i due angoli sulla nuova foto.
 *
 * Layout a tre fasce (testa / foto scorrevole / pulsanti fissi in fondo): i
 * comandi restano sempre visibili anche con una foto verticale molto alta —
 * prima "Salva" finiva sotto il bordo dello schermo.
 */
export function EditorBocca({ apiBase, persona, onClose, onSalvato }: {
  apiBase: string; persona: string; onClose: () => void; onSalvato?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const [punti, setPunti] = useState<[number, number][]>([]);   // coord del POSTER
  const [stato, setStato] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [posterVer, setPosterVer] = useState(0);                // cache-bust dopo cambio foto
  const [dim, setDim] = useState<{ w: number; h: number } | null>(null);  // per l'aspect-ratio

  const p = encodeURIComponent(persona);
  const posterUrl = `${apiBase}/poster/${p}`;
  const boccaUrl = `${apiBase}/personas/${p}/wav2lip/bocca`;
  const boxUrl = `${apiBase}/personas/${p}/wav2lip/box`;
  const nuovoPosterUrl = `${apiBase}/personas/${p}/poster`;

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgRef.current = img; setDim({ w: img.naturalWidth, h: img.naturalHeight }); disegna(punti); };
    img.onerror = () => setStato("poster non caricato");
    img.src = posterVer ? `${posterUrl}?v=${posterVer}` : posterUrl;
    // ripesca i punti già segnati, per correggerli invece di ripartire da zero
    if (posterVer === 0) {
      fetch(boxUrl).then((r) => (r.ok ? r.json() : null)).then((b) => {
        if (b?.bocca?.p1 && b?.bocca?.p2) setPunti([b.bocca.p1, b.bocca.p2]);
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persona, posterVer]);

  useEffect(() => { disegna(punti); }, [punti]);

  function disegna(pts: [number, number][]) {
    const img = imgRef.current, cv = canvasRef.current;
    if (!img || !cv) return;
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d")!;
    ctx.drawImage(img, 0, 0);
    const r = Math.max(7, img.naturalWidth / 110);
    if (pts.length === 2) {
      ctx.strokeStyle = "#22d3ee"; ctx.lineWidth = Math.max(2, img.naturalWidth / 350);
      ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke();
    }
    pts.forEach(([x, y], i) => {
      ctx.fillStyle = i === 0 ? "#38bdf8" : "#f472b6";
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "#0008"; ctx.lineWidth = 2; ctx.stroke();
    });
  }

  function click(e: React.PointerEvent<HTMLCanvasElement>) {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * cv.width;
    const y = ((e.clientY - rect.top) / rect.height) * cv.height;
    setPunti((p) => (p.length >= 2 ? [[x, y]] : [...p, [x, y]]));
    setStato("");
  }

  async function salva() {
    if (punti.length < 2) return;
    setSalvando(true);
    try {
      const r = await fetch(boccaUrl, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ p1: punti[0], p2: punti[1] }),
      });
      if (!r.ok) throw new Error(`${r.status}`);
      setStato("bocca salvata ✓ — verificala con «Prova A»");
      onSalvato?.();
    } catch (e) {
      setStato("errore: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSalvando(false);
    }
  }

  async function cambiaFoto(file: File) {
    setSalvando(true);
    setStato("carico la nuova foto…");
    try {
      const fd = new FormData();
      fd.append("file", file, file.name || "foto.jpg");
      const r = await fetch(nuovoPosterUrl, { method: "POST", body: fd });
      if (!r.ok) throw new Error(`${r.status}`);
      setPunti([]);                       // nuova foto: si risegna la bocca
      setPosterVer((v) => v + 1);
      setStato("foto cambiata — ora risegna i due angoli della bocca");
      onSalvato?.();
    } catch (e) {
      setStato("errore: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setSalvando(false);
    }
  }

  const passo = punti.length === 0 ? "Segna l'angolo SINISTRO della bocca"
    : punti.length === 1 ? "Ora l'angolo DESTRO"
    : "Fatto — salva, oppure clicca di nuovo per rifare";

  return (
    <div className="fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-3"
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-bg p-4 flex flex-col max-h-[92vh]"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between shrink-0">
          <h2 className="text-base font-semibold">Bocca di {persona}</h2>
          <button onClick={onClose} className="text-slate-400 px-2">✕</button>
        </div>
        <p className="text-[13px] text-slate-400 shrink-0 py-1">{passo}
          <span className="text-slate-500"> · {punti.length}/2</span>
        </p>
        {/* la foto scorre; i pulsanti sotto restano sempre visibili. L'aspect-ratio
            esplicito garantisce che il canvas non venga distorto dai vincoli di
            dimensione: senza, i due max avrebbero potuto stirarlo e falsare la
            posizione dei clic. */}
        <div className="flex-1 min-h-0 overflow-auto flex items-start justify-center">
          <canvas ref={canvasRef} onPointerDown={click}
            style={dim ? { aspectRatio: `${dim.w} / ${dim.h}`, maxHeight: "52vh", maxWidth: "100%" } : undefined}
            className="block rounded-xl bg-black cursor-crosshair touch-none" />
        </div>
        {stato && <div className="text-[13px] text-emerald-400 bg-black/30 rounded-lg p-2 shrink-0 mt-2">{stato}</div>}
        <div className="flex gap-2 shrink-0 mt-2">
          <label className="rounded-lg border border-slate-700 text-slate-300 py-2.5 px-3 text-sm text-center cursor-pointer">
            Cambia foto
            <input type="file" accept="image/*" className="hidden" disabled={salvando}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) cambiaFoto(f); e.target.value = ""; }} />
          </label>
          <button onClick={salva} disabled={punti.length < 2 || salvando}
            className="flex-1 rounded-lg bg-accent text-white py-2.5 font-medium text-sm disabled:opacity-50">
            {salvando ? "…" : "Salva bocca"}
          </button>
        </div>
      </div>
    </div>
  );
}
