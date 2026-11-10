import { useEffect, useRef, useState } from "react";
import { pathBocca } from "@/lib/visemeShapes";
import type { VisemePlayer } from "@/lib/visemePlayer";

/**
 * L'avatar renderizzato sul dispositivo (modo "visemi"): la foto della persona
 * con la bocca animata SOPRA IL VOLTO, invece di un video generato dal PC.
 *
 * La bocca sta dentro il viso, nella posizione reale della bocca (ricavata dal
 * volto rilevato in fase di creazione, servita da `/personas/<n>/mouthbox`),
 * non in un riquadro a parte: un riquadro separato faceva "faccia più bocca
 * fluttuante", che non regge. Se la posizione non è disponibile (avatar senza
 * asset), si cade su una stima centro-basso.
 *
 * La forma è ancora stilizzata: gli sprite fotorealistici andrebbero estratti
 * da un video con la bocca aperta, che gli avatar attuali non hanno. La bocca
 * disegnata, ma piazzata sul volto e proporzionata, è il miglior compromesso
 * finché quel video non c'è.
 *
 * Il ciclo è un `requestAnimationFrame` agganciato all'orologio dell'audio
 * (`clock`), lo stesso che scandisce la voce: bocca e parlato restano in fase.
 */
export function VisemeAvatar({
  player,
  clock,
  posterUrl,
  mouthboxUrl,
  visible,
}: {
  player: VisemePlayer;
  clock: () => number;
  posterUrl: string;
  /** Endpoint che dà {cx, cy, w} della bocca in frazioni del poster. */
  mouthboxUrl: string;
  visible: boolean;
}) {
  const pathRef = useRef<SVGPathElement>(null);
  // Posizione della bocca in frazioni del poster; default = stima centro-basso.
  const [box, setBox] = useState<{ cx: number; cy: number; w: number }>({
    cx: 0.5, cy: 0.66, w: 0.22,
  });

  useEffect(() => {
    let vivo = true;
    fetch(mouthboxUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (vivo && d && typeof d.cx === "number") setBox(d); })
      .catch(() => { /* niente asset: resta la stima */ });
    return () => { vivo = false; };
  }, [mouthboxUrl]);

  useEffect(() => {
    if (!visible) return;
    let vivo = true;
    const tick = () => {
      if (!vivo) return;
      const s = player.visemeAt(clock());
      if (pathRef.current) pathRef.current.setAttribute("d", pathBocca(s.v, s.verso, s.k));
      requestAnimationFrame(tick);
    };
    const h = requestAnimationFrame(tick);
    return () => { vivo = false; cancelAnimationFrame(h); };
  }, [player, clock, visible]);

  if (!visible) return null;

  // La bocca è larga `box.w` del poster; l'SVG è quadrato, alto quanto largo.
  const larghezzaPct = box.w * 100 * 1.4; // un filo più larga della bocca reale
  return (
    <div className="flex-1 min-h-0 px-3 pb-2 relative flex items-center justify-center">
      {/* Contenitore con l'immagine: la bocca si posiziona in percentuale
          RELATIVA all'immagine, quindi va ancorata all'<img>, non al riquadro
          esterno (che può avere margini diversi). */}
      <div className="relative inline-block max-h-full">
        <img src={posterUrl} alt="" className="max-h-[70vh] w-auto rounded-2xl bg-black object-contain" />
        <svg
          viewBox="0 0 100 100"
          className="absolute pointer-events-none"
          style={{
            left: `${box.cx * 100}%`,
            top: `${box.cy * 100}%`,
            width: `${larghezzaPct}%`,
            transform: "translate(-50%, -50%)",
          }}
          aria-hidden="true"
        >
          <path
            ref={pathRef}
            d={pathBocca("sil")}
            fill="rgba(90,20,25,0.92)"
            stroke="rgba(150,70,75,0.8)"
            strokeWidth={2}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </div>
  );
}
