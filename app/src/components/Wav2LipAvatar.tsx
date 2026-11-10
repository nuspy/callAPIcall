import { useEffect, useRef, useState } from "react";
import type { Wav2LipPlayer } from "@/lib/wav2lipPlayer";

/**
 * L'avatar del modo A (Wav2Lip) durante la conversazione: la foto della persona
 * con la bocca rigenerata da Wav2Lip incollata sul volto, sull'orologio
 * dell'audio del `Wav2LipPlayer`. È lo stesso incollaggio della «Prova A» e
 * della validazione: la matrice `inv` del box porta il volto 96×96 ai pixel del
 * poster (rotazione compresa) e si ridisegna la sola regione `mouth`, clippata.
 *
 * Quando per l'istante corrente non c'è una bocca pronta (runtime non ancora
 * caricato, o generazione in corso), si mostra il poster fermo: la voce intanto
 * suona lo stesso.
 */
interface Box {
  inv?: number[];
  mouth?: { x: number; y: number; w: number; h: number };
  x: number; y: number; w: number; h: number;
}

export function Wav2LipAvatar({ player, clock, posterUrl, boxUrl, visible }: {
  player: Wav2LipPlayer;
  clock: () => number;
  posterUrl: string;
  boxUrl: string;
  visible: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const boxRef = useRef<Box | null>(null);
  const [pronto, setPronto] = useState(false);

  useEffect(() => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { imgRef.current = img; setPronto(true); };
    img.src = posterUrl;
    fetch(boxUrl).then((r) => (r.ok ? r.json() : null)).then((b) => { boxRef.current = b; }).catch(() => {});
  }, [posterUrl, boxUrl]);

  useEffect(() => {
    if (!pronto || !visible) return;
    let raf = 0;
    const cv = canvasRef.current!;
    const img = imgRef.current!;
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext("2d")!;

    const tick = () => {
      const t = clock();
      player.pota(t);
      const bocca = player.boccaA(t);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(img, 0, 0);
      const box = boxRef.current;
      if (bocca && box) {
        const inv = box.inv ?? [box.w / 96, 0, box.x, 0, box.h / 96, box.y];
        const m = box.mouth ?? { x: 14, y: 48, w: 68, h: 44 };
        const [A, B, E, C, D, F] = inv;
        ctx.save();
        ctx.setTransform(A, C, B, D, E, F);
        ctx.beginPath(); ctx.rect(m.x, m.y, m.w, m.h); ctx.clip();
        ctx.drawImage(bocca.img, 0, 0);
        ctx.restore();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [pronto, visible, player, clock]);

  return <canvas ref={canvasRef} className="w-full h-full object-contain" style={{ transform: "translateZ(0)" }} />;
}
