/**
 * Copia i file .wasm/.mjs di onnxruntime-web in public/ort, da dove l'app li
 * serve a runtime (ort.env.wasm.wasmPaths). Non si committano: sono asset
 * rigenerabili da node_modules, come i binari di una dipendenza. Invocato
 * prima di ogni build.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const src = path.join(app, "node_modules/onnxruntime-web/dist");
const dst = path.join(app, "public/ort");
fs.mkdirSync(dst, { recursive: true });
const files = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];
for (const f of files) {
  const s = path.join(src, f);
  if (fs.existsSync(s)) fs.copyFileSync(s, path.join(dst, f));
  else console.warn(`copy-ort: manca ${f}`);
}
console.log(`copy-ort: ${files.length} file in public/ort`);
