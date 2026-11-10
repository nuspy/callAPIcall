/**
 * Verifica che il mel JS (src/lib/mel.ts) combaci col mel di Wav2Lip in Python.
 * I file di riferimento li genera `tools/valida-wav2lip.py`-style; qui si
 * assume che esistano in C:/TEMP/claude (mel-test-wav.pcm, mel-test-ref.bin) e
 * il basis in call-bridge/models/mel_basis.bin.
 *   node app/test/mel.mjs
 */
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os"; import path from "node:path"; import fs from "node:fs";
const app = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/,"$1"), "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "mel-"));
execSync(`node "${path.join(app,"node_modules/typescript/bin/tsc")}" "${path.join(app,"src/lib/mel.ts")}" --outDir "${out}" --module es2020 --target es2020 --moduleResolution node --lib es2020,dom`, {stdio:"inherit"});
const { melspectrogram } = await import(pathToFileURL(path.join(out,"mel.js")).href);
const rd = (p) => { const b = fs.readFileSync(p); return b; };
const wavRaw = rd("C:/TEMP/claude/mel-test-wav.pcm");
const i16 = new Int16Array(wavRaw.buffer, wavRaw.byteOffset, wavRaw.length/2);
const wav = new Float32Array(i16.length); for (let i=0;i<i16.length;i++) wav[i]=i16[i]/32768;
const basisRaw = rd(path.join(app,"..","call-bridge","models","mel_basis.bin"));
const basis = new Float32Array(basisRaw.buffer, basisRaw.byteOffset, basisRaw.length/4);
const refRaw = rd("C:/TEMP/claude/mel-test-ref.bin");
const ref = new Float32Array(refRaw.buffer, refRaw.byteOffset, refRaw.length/4);
const { mel, frames } = melspectrogram(wav, basis);
const T = ref.length/80;
// esclude gli ultimi 2 frame (padding, differiscono da librosa e irrilevanti)
let maxErr=0, sum=0, n=0;
for (let m=0;m<80;m++) for (let t=0;t<T-2;t++){ const e=Math.abs(mel[m*frames+t]-ref[m*T+t]); maxErr=Math.max(maxErr,e); sum+=e; n++; }
fs.rmSync(out,{recursive:true,force:true});
console.log(`  mel JS vs Python (esclusi 2 frame di coda): medio ${(sum/n).toFixed(4)}, max ${maxErr.toFixed(4)}`);
console.log(maxErr < 0.4 ? "  OK" : "  NO");
process.exit(maxErr<0.4?0:1);
