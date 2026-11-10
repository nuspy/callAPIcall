// Profili GPU per la SIMULAZIONE dei tempi nei test guidati.
//
// compute_score = throughput AI relativo alla RTX 5090 (= 1.0), curato a mano
// da TFLOPS FP16/BF16 dense e benchmark pubblici (fonti: schede tecniche
// NVIDIA/AMD/Intel/Qualcomm/Microsoft, Wikipedia, Tom's Hardware, Puget,
// SemiAnalysis — ricerca giu 2026). E' un modello di PRIMA APPROSSIMAZIONE:
// serve a farsi un'idea ("su una 3060 questo step durerebbe ~8x"), non a
// sostituire un benchmark.
//
// vram_gb: per le NPU/APU è memoria DI SISTEMA condivisa (vedi notes).

export interface GpuProfile {
  id: string;
  vendor: "nvidia" | "amd" | "intel" | "qualcomm" | "microsoft" | "none";
  name: string;
  class: "consumer" | "datacenter" | "npu";
  vram_gb: number;
  /** Throughput AI relativo (RTX 5090 = 1.0). */
  compute_score: number;
  /** TOPS/TFLOPS dichiarati (informativo). */
  tops?: number;
  /** Banda memoria GB/s (informativo). */
  bandwidth_gbs?: number;
  notes?: string;
}

export const NO_SIMULATION_ID = "none";

export const GPU_PROFILES: GpuProfile[] = [
  { id: NO_SIMULATION_ID, vendor: "none", name: "Nessuna simulazione (GPU reale)", class: "consumer", vram_gb: 0, compute_score: 1 },

  // ---------------- NVIDIA consumer (Blackwell / Ada / Ampere / Turing) ----
  { id: "rtx5090", vendor: "nvidia", name: "GeForce RTX 5090", class: "consumer", vram_gb: 32, compute_score: 1.0, tops: 3352, bandwidth_gbs: 1792, notes: "baseline di questa macchina" },
  { id: "rtx5080", vendor: "nvidia", name: "GeForce RTX 5080", class: "consumer", vram_gb: 16, compute_score: 0.55, tops: 1801, bandwidth_gbs: 960 },
  { id: "rtx5070ti", vendor: "nvidia", name: "GeForce RTX 5070 Ti", class: "consumer", vram_gb: 16, compute_score: 0.45, tops: 1406, bandwidth_gbs: 896 },
  { id: "rtx5070", vendor: "nvidia", name: "GeForce RTX 5070", class: "consumer", vram_gb: 12, compute_score: 0.35, tops: 988, bandwidth_gbs: 672 },
  { id: "rtx5060ti16", vendor: "nvidia", name: "GeForce RTX 5060 Ti 16GB", class: "consumer", vram_gb: 16, compute_score: 0.24, tops: 759, bandwidth_gbs: 448 },
  { id: "rtx5060", vendor: "nvidia", name: "GeForce RTX 5060", class: "consumer", vram_gb: 8, compute_score: 0.19, tops: 614, bandwidth_gbs: 448 },
  { id: "rtx4090", vendor: "nvidia", name: "GeForce RTX 4090", class: "consumer", vram_gb: 24, compute_score: 0.78, tops: 1321, bandwidth_gbs: 1008 },
  { id: "rtx4080s", vendor: "nvidia", name: "GeForce RTX 4080 Super", class: "consumer", vram_gb: 16, compute_score: 0.52, tops: 836, bandwidth_gbs: 736 },
  { id: "rtx4080", vendor: "nvidia", name: "GeForce RTX 4080", class: "consumer", vram_gb: 16, compute_score: 0.50, tops: 780, bandwidth_gbs: 717 },
  { id: "rtx4070tis", vendor: "nvidia", name: "GeForce RTX 4070 Ti Super", class: "consumer", vram_gb: 16, compute_score: 0.42, tops: 706, bandwidth_gbs: 672 },
  { id: "rtx4070", vendor: "nvidia", name: "GeForce RTX 4070", class: "consumer", vram_gb: 12, compute_score: 0.30, tops: 466, bandwidth_gbs: 504 },
  { id: "rtx4060", vendor: "nvidia", name: "GeForce RTX 4060", class: "consumer", vram_gb: 8, compute_score: 0.18, tops: 242, bandwidth_gbs: 272 },
  { id: "rtx3090", vendor: "nvidia", name: "GeForce RTX 3090", class: "consumer", vram_gb: 24, compute_score: 0.45, tops: 285, bandwidth_gbs: 936 },
  { id: "rtx3080", vendor: "nvidia", name: "GeForce RTX 3080", class: "consumer", vram_gb: 10, compute_score: 0.38, tops: 238, bandwidth_gbs: 760 },
  { id: "rtx3070", vendor: "nvidia", name: "GeForce RTX 3070", class: "consumer", vram_gb: 8, compute_score: 0.26, tops: 163, bandwidth_gbs: 448 },
  { id: "rtx3060", vendor: "nvidia", name: "GeForce RTX 3060 12GB", class: "consumer", vram_gb: 12, compute_score: 0.16, tops: 102, bandwidth_gbs: 360 },
  { id: "rtx2080ti", vendor: "nvidia", name: "GeForce RTX 2080 Ti", class: "consumer", vram_gb: 11, compute_score: 0.22, tops: 114, bandwidth_gbs: 616 },
  { id: "rtx2070", vendor: "nvidia", name: "GeForce RTX 2070", class: "consumer", vram_gb: 8, compute_score: 0.13, tops: 60, bandwidth_gbs: 448 },

  // ---------------- NVIDIA datacenter / workstation ------------------------
  { id: "gb200", vendor: "nvidia", name: "GB200 (per GPU Blackwell)", class: "datacenter", vram_gb: 192, compute_score: 7.0, bandwidth_gbs: 8000, notes: "Grace Blackwell Superchip" },
  { id: "b200", vendor: "nvidia", name: "B200", class: "datacenter", vram_gb: 180, compute_score: 6.5, bandwidth_gbs: 8000 },
  { id: "h200", vendor: "nvidia", name: "H200 SXM", class: "datacenter", vram_gb: 141, compute_score: 3.3, tops: 1979, bandwidth_gbs: 4800 },
  { id: "h100", vendor: "nvidia", name: "H100 SXM", class: "datacenter", vram_gb: 80, compute_score: 3.0, tops: 1979, bandwidth_gbs: 3350 },
  { id: "a100-80", vendor: "nvidia", name: "A100 80GB", class: "datacenter", vram_gb: 80, compute_score: 1.2, tops: 624, bandwidth_gbs: 2039 },
  { id: "a100-40", vendor: "nvidia", name: "A100 40GB", class: "datacenter", vram_gb: 40, compute_score: 1.15, tops: 624, bandwidth_gbs: 1555 },
  { id: "l40s", vendor: "nvidia", name: "L40S", class: "datacenter", vram_gb: 48, compute_score: 1.1, tops: 733, bandwidth_gbs: 864 },
  { id: "l4", vendor: "nvidia", name: "L4", class: "datacenter", vram_gb: 24, compute_score: 0.35, tops: 242, bandwidth_gbs: 300 },
  { id: "v100", vendor: "nvidia", name: "V100 32GB", class: "datacenter", vram_gb: 32, compute_score: 0.5, tops: 125, bandwidth_gbs: 900 },
  { id: "dgx-spark", vendor: "nvidia", name: "DGX Spark (GB10)", class: "datacenter", vram_gb: 128, compute_score: 0.40, tops: 1000, bandwidth_gbs: 273, notes: "memoria unificata LPDDR5x: tanta capienza, banda limitata" },
  { id: "dgx-station-gb300", vendor: "nvidia", name: "DGX Station (GB300)", class: "datacenter", vram_gb: 288, compute_score: 6.8, bandwidth_gbs: 8000, notes: "desktop Grace Blackwell Ultra" },
  { id: "rtx6000ada", vendor: "nvidia", name: "RTX 6000 Ada", class: "datacenter", vram_gb: 48, compute_score: 0.72, tops: 728, bandwidth_gbs: 960 },

  // ---------------- AMD consumer (RDNA) + Instinct (CDNA) ------------------
  { id: "rx9070xt", vendor: "amd", name: "Radeon RX 9070 XT", class: "consumer", vram_gb: 16, compute_score: 0.40, tops: 97, bandwidth_gbs: 640, notes: "FP16 97 TFLOPS; ecosistema ROCm/DirectML" },
  { id: "rx9070", vendor: "amd", name: "Radeon RX 9070", class: "consumer", vram_gb: 16, compute_score: 0.34, bandwidth_gbs: 640 },
  { id: "rx7900xtx", vendor: "amd", name: "Radeon RX 7900 XTX", class: "consumer", vram_gb: 24, compute_score: 0.42, tops: 123, bandwidth_gbs: 960 },
  { id: "rx7900xt", vendor: "amd", name: "Radeon RX 7900 XT", class: "consumer", vram_gb: 20, compute_score: 0.36, bandwidth_gbs: 800 },
  { id: "rx7800xt", vendor: "amd", name: "Radeon RX 7800 XT", class: "consumer", vram_gb: 16, compute_score: 0.27, bandwidth_gbs: 624 },
  { id: "rx6800xt", vendor: "amd", name: "Radeon RX 6800 XT", class: "consumer", vram_gb: 16, compute_score: 0.22, bandwidth_gbs: 512 },
  { id: "mi325x", vendor: "amd", name: "Instinct MI325X", class: "datacenter", vram_gb: 256, compute_score: 2.8, tops: 1307, bandwidth_gbs: 6000 },
  { id: "mi300x", vendor: "amd", name: "Instinct MI300X", class: "datacenter", vram_gb: 192, compute_score: 2.6, tops: 1307, bandwidth_gbs: 5300 },
  { id: "mi250x", vendor: "amd", name: "Instinct MI250X", class: "datacenter", vram_gb: 128, compute_score: 1.3, tops: 383, bandwidth_gbs: 3277 },

  // ---------------- Intel Arc + Gaudi --------------------------------------
  { id: "arc-b580", vendor: "intel", name: "Arc B580", class: "consumer", vram_gb: 12, compute_score: 0.16, tops: 233, bandwidth_gbs: 456 },
  { id: "arc-a770", vendor: "intel", name: "Arc A770 16GB", class: "consumer", vram_gb: 16, compute_score: 0.18, tops: 315, bandwidth_gbs: 560 },
  { id: "gaudi3", vendor: "intel", name: "Gaudi 3", class: "datacenter", vram_gb: 128, compute_score: 2.0, tops: 1835, bandwidth_gbs: 3700 },
  { id: "gaudi2", vendor: "intel", name: "Gaudi 2", class: "datacenter", vram_gb: 96, compute_score: 1.0, bandwidth_gbs: 2450 },

  // ---------------- Microsoft (Azure) --------------------------------------
  { id: "maia100", vendor: "microsoft", name: "Azure Maia 100", class: "datacenter", vram_gb: 64, compute_score: 2.4, tops: 800, bandwidth_gbs: 1800, notes: "BF16 ~0.8 PFLOPS, HBM2e" },

  // ---------------- NPU Copilot+ (memoria di sistema condivisa) ------------
  { id: "snapdragon-x-elite", vendor: "qualcomm", name: "Snapdragon X Elite (NPU)", class: "npu", vram_gb: 16, compute_score: 0.045, tops: 45, bandwidth_gbs: 135, notes: "Hexagon 45 TOPS, RAM condivisa" },
  { id: "snapdragon-x2-extreme", vendor: "qualcomm", name: "Snapdragon X2 Elite Extreme (NPU)", class: "npu", vram_gb: 16, compute_score: 0.08, tops: 80, bandwidth_gbs: 152, notes: "Hexagon 6, 80 TOPS" },
  { id: "lunar-lake", vendor: "intel", name: "Core Ultra (Lunar Lake, NPU)", class: "npu", vram_gb: 16, compute_score: 0.048, tops: 48, bandwidth_gbs: 136, notes: "NPU4 48 TOPS, RAM condivisa" },
  { id: "ryzen-ai-hx370", vendor: "amd", name: "Ryzen AI 9 HX 370 (NPU)", class: "npu", vram_gb: 16, compute_score: 0.05, tops: 50, bandwidth_gbs: 120, notes: "XDNA2 50 TOPS, RAM condivisa" },
  { id: "ryzen-ai-hx470", vendor: "amd", name: "Ryzen AI 9 HX 470 (NPU)", class: "npu", vram_gb: 16, compute_score: 0.055, tops: 55, bandwidth_gbs: 120 },
];

export function gpuProfileById(id: string | null | undefined): GpuProfile {
  return GPU_PROFILES.find((p) => p.id === id) ?? GPU_PROFILES[0];
}

/** Baseline: la GPU reale di questa macchina (RTX 5090). */
export const BASELINE_PROFILE_ID = "rtx5090";
