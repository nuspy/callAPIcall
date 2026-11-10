// Modello di simulazione dei tempi su un'altra GPU.
//
//   stima = misurato × (score_baseline / score_target) × penalita_spill
//
// La penalita' di spill scatta quando i modelli coinvolti nello step non
// stanno nella VRAM della scheda simulata: la parte eccedente viaggia su
// PCIe/RAM e rallenta tutto (fattore empirico 4x proporzionale all'eccesso).
// Se il SINGOLO modello piu' grande non entra, lo step e' marcato non
// eseguibile (caricamento impossibile senza quantizzazione/offload estremo).

import {
  BASELINE_PROFILE_ID,
  type GpuProfile,
  NO_SIMULATION_ID,
  gpuProfileById,
} from "./gpuProfiles";

/** VRAM (GB) occupata dai modelli della suite, misurata su questa macchina. */
export const MODEL_VRAM_GB: Record<string, number> = {
  whisper_large: 3,
  chatterbox: 6,
  zonos2: 10,
  kokoro: 0.5,
  piper: 0.2,
  musetalk: 8,
};

export interface SimEstimate {
  feasible: boolean;
  estimateMs: number;
  /** Moltiplicatore applicato (informativo, es. 6.2). */
  factor: number;
  /** Motivo dell'infattibilita' o nota sullo spill. */
  note?: string;
}

export function simulate(
  measuredMs: number,
  targetId: string,
  simModels: string[] | undefined,
): SimEstimate | null {
  if (!targetId || targetId === NO_SIMULATION_ID) return null;
  const target = gpuProfileById(targetId);
  const baseline = gpuProfileById(BASELINE_PROFILE_ID);

  const models = simModels ?? [];
  const vramNeeded = models.reduce((s, m) => s + (MODEL_VRAM_GB[m] ?? 0), 0);
  const biggest = Math.max(0, ...models.map((m) => MODEL_VRAM_GB[m] ?? 0));

  if (biggest > target.vram_gb) {
    return {
      feasible: false,
      estimateMs: Infinity,
      factor: Infinity,
      note: `il modello piu' grande (${biggest} GB) non entra nella ${
        target.class === "npu" ? "RAM condivisa" : "VRAM"
      } da ${target.vram_gb} GB`,
    };
  }

  let factor = baseline.compute_score / target.compute_score;
  let note: string | undefined;
  if (vramNeeded > target.vram_gb && target.vram_gb > 0) {
    const spill = 1 + 4 * (vramNeeded / target.vram_gb - 1);
    factor *= spill;
    note = `spill in RAM: servono ${vramNeeded.toFixed(1)} GB su ${target.vram_gb} GB (×${spill.toFixed(1)})`;
  }
  return {
    feasible: true,
    estimateMs: measuredMs * factor,
    factor,
    note,
  };
}

export function formatSimMs(ms: number): string {
  if (!isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 90_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)} min`;
}

export function describeProfile(p: GpuProfile): string {
  const parts = [
    p.vram_gb ? `${p.vram_gb} GB` : null,
    p.tops ? `${p.tops} TOPS` : null,
    p.bandwidth_gbs ? `${p.bandwidth_gbs} GB/s` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}
