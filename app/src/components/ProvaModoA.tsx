import { useEffect, useRef, useState } from "react";
import { preparaRuntime, generaTurno, type FrameBocca } from "@/lib/wav2lipRuntime";

/**
 * Prova del runtime modo A: prende un audio di test, genera l'avatar che parla
 * (Wav2Lip on-device) e lo riproduce. Serve a vedere dal vivo, in isolamento,
 * che il pipeline validato sul PC funzioni sul telefono, prima di legarlo al
 * flusso conversazionale.
 *
 * Compone così: il poster sul canvas, e sopra — nella posizione del volto — la
 * bocca (in realtà il volto rigenerato 96×96) che cambia a ogni fotogramma, al
 * ritmo dell'orologio dell'audio. È lo stesso incollaggio della validazione
 * Python.
 */
export function ProvaModoA({ apiBase, persona, onClose }: {
  apiBase: string; persona: string; onClose: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stato, setStato] = useState("");
  const [inCorso, setInCorso] = useState(false);

  const p = encodeURIComponent(persona);
  const modelUrl = `${apiBase}/models/wav2lip.onnx`;   // fp32: qualita', non int8
  const basisUrl = `${apiBase}/models/mel_basis.bin`;
  const audioUrl = `${apiBase}/models/prova-voce.wav`;
  const faceUrl = `${apiBase}/personas/${p}/wav2lip/face`;
  const posterUrl = `${apiBase}/poster/${p}`;
  const boxUrl = `${apiBase}/personas/${p}/wav2lip/box`;

  const avvia = async () => {
    setInCorso(true);
    try {
      setStato("▶ v3.4 — premi avvio");
      const ok = await preparaRuntime(modelUrl, faceUrl, (msg) => setStato(msg));
      if (!ok) { setStato("il runtime nativo è disponibile solo nell'app installata"); return; }

      setStato("scarico audio e poster…");
      const [wavBuf, box, poster] = await Promise.all([
        fetch(audioUrl).then((r) => r.arrayBuffer()),
        fetch(boxUrl).then((r) => r.json()),
        caricaImg(posterUrl),
      ]);

      // WAV -> float32 @16k (il file di prova è già 16 kHz mono)
      const dv = new DataView(wavBuf);
      const dataOff = 44; // header WAV standard
      const n = (wavBuf.byteLength - dataOff) / 2;
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(dataOff + i * 2, true) / 32768;

      setStato("genero i fotogrammi (Wav2Lip)…");
      const res = await generaTurno(pcm, basisUrl);
      if (res.errore) { setStato("errore: " + res.errore); return; }
      setStato(`${res.bocche.length} fotogrammi a ${res.fps.toFixed(0)} fps di generazione. Riproduco…`);

      // canvas al formato del poster
      const cv = canvasRef.current!;
      cv.width = poster.naturalWidth; cv.height = poster.naturalHeight;
      const ctx = cv.getContext("2d")!;

      // riproduce l'audio e mostra le bocche sincronizzate col suo orologio
      await riproduci(res.bocche, poster, box, ctx, wavBuf);
      setStato("fatto.");
    } catch (e) {
      setStato("errore: " + (e instanceof Error ? e.message : String(e)));
    } finally {
      setInCorso(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/80 flex items-center justify-center p-3"
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-bg p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Prova modo A (Wav2Lip)</h2>
          <button onClick={onClose} className="text-slate-400 px-2">✕</button>
        </div>
        <canvas ref={canvasRef} className="w-full rounded-xl bg-black" />
        {stato && <div className="text-[13px] text-slate-400 bg-black/30 rounded-lg p-2">{stato}</div>}
        <button onClick={avvia} disabled={inCorso}
          className="w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-50">
          {inCorso ? "…" : "Genera e riproduci"}
        </button>
      </div>
    </div>
  );
}

function caricaImg(url: string): Promise<HTMLImageElement> {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => ok(img);
    img.onerror = ko;
    img.src = url;
  });
}

interface Box {
  inv?: number[];                 // [A,B,E,C,D,F]: mappa il volto 96x96 -> poster
  mouth?: { x: number; y: number; w: number; h: number };
  x: number; y: number; w: number; h: number;   // bbox assiale (fallback)
}

async function riproduci(
  bocche: FrameBocca[], poster: HTMLImageElement, box: Box,
  ctx: CanvasRenderingContext2D, wavBuf: ArrayBuffer,
): Promise<void> {
  const actx = new AudioContext();
  const audioBuf = await actx.decodeAudioData(wavBuf.slice(0));
  const src = actx.createBufferSource();
  src.buffer = audioBuf; src.connect(actx.destination);

  // Composizione: `inv` porta il volto 96x96 generato ai pixel del poster,
  // rotazione compresa (testa inclinata). Si ridisegna la sola regione `mouth`,
  // clippata, così il resto del viso resta l'originale. Fallback assiale se il
  // box è del vecchio formato.
  const inv = box.inv ?? [box.w / 96, 0, box.x, 0, box.h / 96, box.y];
  const m = box.mouth ?? { x: 14, y: 48, w: 68, h: 44 };
  const [A, B, E, C, D, F] = inv;

  const durata = audioBuf.duration;
  const fps = bocche.length / durata; // i fotogrammi coprono tutto il turno
  const t0 = actx.currentTime + 0.1;
  src.start(t0);

  return new Promise((fine) => {
    const tick = () => {
      const t = actx.currentTime - t0;
      if (t >= durata) { fine(); return; }
      const i = Math.min(bocche.length - 1, Math.max(0, Math.floor(t * fps)));
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(poster, 0, 0);
      ctx.save();
      ctx.setTransform(A, C, B, D, E, F);   // x'=A·x+B·y+E, y'=C·x+D·y+F
      ctx.beginPath();
      ctx.rect(m.x, m.y, m.w, m.h);
      ctx.clip();
      ctx.drawImage(bocche[i].img, 0, 0);   // 96x96, mappato e clippato alla bocca
      ctx.restore();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
