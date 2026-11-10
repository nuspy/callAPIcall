/**
 * Verifica la logica di VisemePlayer senza browser né audio.
 *   node app/test/viseme-player.mjs
 * Compila i sorgenti TS in una cartella temporanea e li importa.
 */
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const app = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, "$1"), "..");
const out = fs.mkdtempSync(path.join(os.tmpdir(), "vplayer-"));
execSync(`node "${path.join(app, "node_modules/typescript/bin/tsc")}" `
  + `"${path.join(app, "src/lib/visemePlayer.ts")}" "${path.join(app, "src/lib/visemeShapes.ts")}" `
  + `--outDir "${out}" --module es2020 --target es2020 --moduleResolution node`, { stdio: "inherit" });
const { VisemePlayer } = await import(pathToFileURL(path.join(out, "visemePlayer.js")).href);

let ok = 0, tot = 0;
const check = (c, d) => { tot++; if (c) ok++; console.log(`  ${c ? "ok  " : "NO  "}${d}`); };
const tl = (durata, visemi) => ({ testo: "x", lang: "it", durata, visemi });

const p = new VisemePlayer();
p.accoda(tl(1.5, [{ t: 0, v: "PP", dur: 0.5 }, { t: 0.5, v: "aa", dur: 0.5 }, { t: 1.0, v: "I", dur: 0.5 }]));
check(p.visemeAt(100).v === "sil", "prima dell'ancora la bocca e' a riposo");
p.ancora(100);
check(p.visemeAt(100.0).v === "PP", "a t=0 primo viseme PP");
check(p.visemeAt(100.6).v === "aa", "a t=0.6 secondo aa");
check(p.visemeAt(101.1).v === "I", "a t=1.1 terzo I");
const s = p.visemeAt(100.48);
check(s.v === "PP" && s.verso === "aa" && s.k > 0, `fusione PP->aa (k=${s.k.toFixed(2)})`);
check(p.visemeAt(102.0).v === "sil", "dopo la fine torna a riposo");
check(p.finito(102.0) === true, "finito() vero a fine");
check(p.finito(100.5) === false, "finito() falso in corso");
const p2 = new VisemePlayer();
p2.accoda(tl(1.0, [{ t: 0, v: "O", dur: 1.0 }]));
p2.accoda(tl(1.0, [{ t: 0, v: "E", dur: 1.0 }]));
p2.ancora(200); check(p2.visemeAt(200.5).v === "O", "primo segmento -> O");
p2.ancora(201); check(p2.visemeAt(201.5).v === "E", "secondo segmento -> E");
fs.rmSync(out, { recursive: true, force: true });
console.log(`\n  ${ok}/${tot} verifiche superate`);
process.exit(ok === tot ? 0 : 1);
