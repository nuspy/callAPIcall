import { useState } from "react";
import { misuraWav2Lip, misuraNativa, type RisultatoBench } from "@/lib/wav2lipBench";

/**
 * Schermata di misura del modo A: fa girare Wav2Lip sul dispositivo e dice se
 * regge i 25 fps. Serve a decidere se vale la pena integrare il modo A, prima
 * di costruirlo. Si apre dalle impostazioni.
 */
export function Wav2LipBench({ onClose, modelUrl }: { onClose: () => void; modelUrl: string }) {
  const [inCorso, setInCorso] = useState(false);
  const [righe, setRighe] = useState<string[]>([]);
  const [ris, setRis] = useState<RisultatoBench | null>(null);

  const avvia = async () => {
    setInCorso(true);
    setRis(null);
    setRighe([]);
    const log = (s: string) => setRighe((x) => [...x, s]);
    // Sull'app installata si misura la via NATIVA (NNAPI/NPU): è quella che
    // conta, la WebView non arriva all'acceleratore. Nel browser, o se il
    // plugin manca, si ripiega sulla misura web (WebGPU/WASM).
    const nativa = await misuraNativa(modelUrl, log);
    const r = nativa ?? await misuraWav2Lip(modelUrl, log);
    setRis(r);
    setInCorso(false);
  };

  const verdetto = (r: RisultatoBench) => {
    if (r.errore) return { t: "Non misurabile", c: "text-amber-400" };
    const fps = Math.max(r.fps, r.fpsBatch);
    if (fps >= 25) return { t: "Regge il tempo reale (≥25 fps)", c: "text-emerald-400" };
    if (fps >= 12) return { t: "Al limite: ok per frasi brevi, non fluido", c: "text-amber-400" };
    return { t: "Non regge il tempo reale", c: "text-red-400" };
  };

  return (
    <div className="fixed inset-0 z-[60] bg-black/70 flex items-end sm:items-center justify-center p-3"
      onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-panel p-4 space-y-3"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Misura Wav2Lip (modo A)</h2>
          <button onClick={onClose} className="text-slate-400 px-2">✕</button>
        </div>
        <p className="text-[13px] text-slate-400 leading-snug">
          Fa girare il modello di lipsync sul dispositivo e misura quanti
          fotogrammi al secondo riesce a generare. Serve a decidere se il modo
          A (avatar neurale sul telefono) è sostenibile qui.
        </p>

        <button
          onClick={avvia}
          disabled={inCorso}
          className="w-full rounded-lg bg-accent text-white py-2.5 font-medium disabled:opacity-50"
        >
          {inCorso ? "Misuro…" : "Avvia la misura"}
        </button>

        {righe.length > 0 && (
          <div className="text-[12px] font-mono text-slate-400 bg-black/30 rounded-lg p-2 max-h-28 overflow-auto">
            {righe.map((r, i) => <div key={i}>{r}</div>)}
          </div>
        )}

        {ris && (
          <div className="space-y-2">
            <div className={`text-sm font-semibold ${verdetto(ris).c}`}>
              {verdetto(ris).t}
            </div>
            {ris.errore ? (
              <div className="text-[13px] text-slate-400">{ris.errore}</div>
            ) : (
              <table className="w-full text-[13px] text-slate-300">
                <tbody>
                  <tr><td className="text-slate-500">Motore</td><td className="text-right font-mono">{ris.provider}</td></tr>
                  <tr><td className="text-slate-500">Un fotogramma</td><td className="text-right font-mono">{ris.msPerFrame.toFixed(1)} ms · {ris.fps.toFixed(0)} fps</td></tr>
                  <tr><td className="text-slate-500">In blocco (×{ris.batch})</td><td className="text-right font-mono">{ris.msPerFrameBatch.toFixed(1)} ms · {ris.fpsBatch.toFixed(0)} fps</td></tr>
                  <tr><td className="text-slate-500">Caricamento</td><td className="text-right font-mono">{ris.caricamentoS.toFixed(1)} s</td></tr>
                </tbody>
              </table>
            )}
            <p className="text-[11px] text-slate-500">
              A 25 fps un fotogramma deve stare sotto i 40 ms. Il blocco
              ammortizza l'overhead: se lì regge, il modo A conviene processando
              a piccoli gruppi.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
