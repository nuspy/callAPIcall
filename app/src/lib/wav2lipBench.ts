/**
 * Misura se il telefono regge Wav2Lip in tempo reale.
 *
 * È la fase 1 del modo A, e viene PRIMA dell'integrazione: portare Wav2Lip
 * on-device è settimane di lavoro, e ha senso solo se il dispositivo tiene i
 * 25 fps. Questo banco lo dice con un numero, invece di scommettere.
 *
 * Gira con onnxruntime-web: prova prima WebGPU (la GPU del telefono, il caso
 * che conta), poi ripiega su WASM. Il modello è il Wav2Lip 96×96 vero, scaricato
 * dal bridge; gli input sono rumore delle dimensioni giuste — la misura riguarda
 * il COSTO dell'inferenza, non l'output. Riferimento su CPU desktop: 76 fps.
 *
 * Il modello prende `mel` [b,1,80,16] (spettro audio) e `vid` [b,6,96,96] (due
 * mezzi-volti sovrapposti) e produce `gen` [b,3,96,96] (la bocca). A 25 fps
 * servono 25 inferenze al secondo con batch 1; si misura anche un batch più
 * grande, perché Wav2Lip in pratica si processa a blocchi e il batch ammortizza
 * l'overhead per frame.
 */

export interface RisultatoBench {
  provider: string; // webgpu | wasm | ...
  msPerFrame: number; // batch 1
  fps: number;
  msPerFrameBatch: number; // per-frame nel batch grande
  fpsBatch: number;
  batch: number;
  caricamentoS: number;
  errore?: string;
}

type Ort = typeof import("onnxruntime-web");
type Tensore = import("onnxruntime-web").Tensor;

function rand(ort: Ort, dims: number[]): Tensore {
  let n = 1;
  for (const d of dims) n *= d;
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.random();
  return new ort.Tensor("float32", a, dims);
}

async function provaProvider(
  ort: Ort,
  buf: ArrayBuffer,
  ep: "webgpu" | "wasm",
  batch: number,
): Promise<{ ms1: number; msB: number }> {
  const sess = await ort.InferenceSession.create(buf, {
    executionProviders: [ep],
    graphOptimizationLevel: "all",
  });
  const uno = { mel: rand(ort, [1, 1, 80, 16]), vid: rand(ort, [1, 6, 96, 96]) };
  const molti = { mel: rand(ort, [batch, 1, 80, 16]), vid: rand(ort, [batch, 6, 96, 96]) };

  // Warm-up: la prima inferenza compila kernel e alloca, non va misurata.
  for (let i = 0; i < 3; i++) await sess.run(uno);

  const N = 20;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) await sess.run(uno);
  const ms1 = (performance.now() - t0) / N;

  const M = 5;
  t0 = performance.now();
  for (let i = 0; i < M; i++) await sess.run(molti);
  const msB = (performance.now() - t0) / M / batch;

  await sess.release();
  return { ms1, msB };
}

/** Misura NATIVA via ONNX Runtime Android (NNAPI), quando l'app è installata.
 *  È il caso che conta: usa l'acceleratore del telefono, non la WebView. */
export async function misuraNativa(
  modelUrl: string,
  onLog?: (s: string) => void,
): Promise<RisultatoBench | null> {
  const { Capacitor, registerPlugin } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform()) return null;
  onLog?.("misura nativa (NNAPI)…");
  const plugin = registerPlugin<{
    benchmark(o: { modelUrl: string; modelUrlInt8: string; frames: number }): Promise<{
      provider: string; msPerFrame: number; fps: number;
      caricamentoS: number; modelBytes: number; dettagli?: string[];
    }>;
  }>("Wav2LipNative");
  try {
    const modelUrlInt8 = modelUrl.replace(/wav2lip\.onnx$/, "wav2lip_int8.onnx");
    const r = await plugin.benchmark({ modelUrl, modelUrlInt8, frames: 20 });
    for (const d of r.dettagli ?? []) onLog?.(d);
    onLog?.(`migliore: ${r.provider} — ${r.msPerFrame.toFixed(1)} ms/frame`);
    return {
      provider: r.provider, msPerFrame: r.msPerFrame, fps: r.fps,
      msPerFrameBatch: r.msPerFrame, fpsBatch: r.fps, batch: 1,
      caricamentoS: r.caricamentoS,
    };
  } catch (e) {
    return {
      provider: "-", msPerFrame: 0, fps: 0, msPerFrameBatch: 0, fpsBatch: 0,
      batch: 0, caricamentoS: 0,
      errore: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Esegue la misura. Non lancia: gli errori finiscono in `errore`. */
export async function misuraWav2Lip(
  modelUrl: string,
  onLog?: (s: string) => void,
): Promise<RisultatoBench> {
  const log = (s: string) => onLog?.(s);
  // Caricato SOLO qui, alla misura: onnxruntime-web è grosso e non deve pesare
  // sull'avvio dell'app.
  const ort = await import("onnxruntime-web");
  // I file .wasm/.mjs di onnxruntime sono serviti da /ort/ (vedi public/ort).
  ort.env.wasm.wasmPaths = new URL("ort/", document.baseURI).href;
  ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);

  log("scarico il modello…");
  const t0 = performance.now();
  const resp = await fetch(modelUrl);
  if (!resp.ok) {
    return {
      provider: "-", msPerFrame: 0, fps: 0, msPerFrameBatch: 0, fpsBatch: 0,
      batch: 0, caricamentoS: 0, errore: `modello non scaricato (${resp.status})`,
    };
  }
  const buf = await resp.arrayBuffer();
  const caricamentoS = (performance.now() - t0) / 1000;
  log(`modello ${(buf.byteLength / 1e6).toFixed(0)}MB in ${caricamentoS.toFixed(1)}s`);

  const batch = 16;
  const ordine: ("webgpu" | "wasm")[] = ["webgpu", "wasm"];
  let ultimoErrore = "";
  for (const ep of ordine) {
    try {
      log(`provo ${ep}…`);
      const { ms1, msB } = await provaProvider(ort, buf, ep, batch);
      log(`${ep}: ${ms1.toFixed(1)} ms/frame`);
      return {
        provider: ep,
        msPerFrame: ms1,
        fps: 1000 / ms1,
        msPerFrameBatch: msB,
        fpsBatch: 1000 / msB,
        batch,
        caricamentoS,
      };
    } catch (e) {
      ultimoErrore = e instanceof Error ? e.message : String(e);
      log(`${ep} non disponibile: ${ultimoErrore.slice(0, 60)}`);
    }
  }
  return {
    provider: "-", msPerFrame: 0, fps: 0, msPerFrameBatch: 0, fpsBatch: 0,
    batch, caricamentoS, errore: ultimoErrore || "nessun provider utilizzabile",
  };
}
