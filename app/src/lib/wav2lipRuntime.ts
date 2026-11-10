/**
 * Il runtime del modo A sul telefono: audio → avatar che parla.
 *
 * Mette insieme i pezzi validati: il mel in JS (`mel.ts`, verificato contro
 * Python), l'inferenza nativa (plugin `Wav2LipNative`, misurata) e la
 * composizione della bocca sul poster. Il mel resta in JS perché non è il
 * collo — lo è l'inferenza, sull'acceleratore — e così combacia con la
 * validazione.
 *
 * Questa prima versione lavora a TURNO: preso tutto l'audio del turno, calcola
 * il mel, genera i fotogrammi-bocca e poi riproduce audio e bocca insieme. C'è
 * una latenza pari al tempo di generazione (a ~16-20 fps, circa la durata del
 * parlato): accettabile per validare che l'avatar parli; la pipeline che
 * genera mentre riproduce è l'ottimizzazione successiva.
 */
import { Capacitor, registerPlugin } from "@capacitor/core";
import { caricaMelBasis, melspectrogram } from "./mel";

export interface FrameBocca {
  img: HTMLImageElement; // la bocca 96×96 decodificata
}

export interface RisultatoRuntime {
  bocche: FrameBocca[];
  fps: number;
  errore?: string;
}

let basis: Float32Array | null = null;

function pluginWav2Lip() {
  if (!Capacitor.isNativePlatform()) return null;
  return registerPlugin<{
    scaricaModello(o: { modelUrl: string }): Promise<{ ok: boolean; mb: number; ms: number }>;
    prepara(o: { faceUrl: string }): Promise<{ ok: boolean; msSessione: number; msVolto: number }>;
    genera(o: { mel: string; melT: number }): Promise<{ frames: number; bocche: string[] }>;
  }>("Wav2LipNative");
}

/** Carica modello e volto una volta (all'accensione dell'avatar in modo A). */
export async function preparaRuntime(
  modelUrl: string, faceUrl: string,
  onFase?: (msg: string) => void,
): Promise<boolean> {
  onFase?.("1 · avvio runtime…");
  const p = pluginWav2Lip();
  if (!p) { onFase?.("solo su app installata"); return false; }
  // Due passi separati, ognuno risolve: il feedback non dipende da eventi
  // (che nell'app non arrivavano), e si vede quale passo e' il collo.
  onFase?.("2 · scarico il modello…");
  const s = await p.scaricaModello({ modelUrl });
  onFase?.(`3 · modello ${s.mb}MB in ${(s.ms / 1000).toFixed(0)}s — preparo…`);
  const pr = await p.prepara({ faceUrl });
  onFase?.(`pronto (sessione ${(pr.msSessione / 1000).toFixed(1)}s, volto ${pr.msVolto}ms)`);
  return true;
}

function f32ToBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/**
 * Genera i fotogrammi-bocca per un turno di parlato.
 * `pcm` è float32 mono @16kHz (tutto l'audio del turno).
 */
export async function generaTurno(
  pcm: Float32Array, basisUrl: string,
): Promise<RisultatoRuntime> {
  const p = pluginWav2Lip();
  if (!p) return { bocche: [], fps: 0, errore: "solo su app installata" };
  if (!basis) basis = await caricaMelBasis(basisUrl);

  const { mel, frames } = melspectrogram(pcm, basis);
  const t0 = performance.now();
  const res = await p.genera({ mel: f32ToBase64(mel), melT: frames });
  const dt = (performance.now() - t0) / 1000;

  // decodifica le bocche jpeg base64 in <img> pronte al disegno
  const bocche = await Promise.all(res.bocche.map((b64) => new Promise<FrameBocca>((ok) => {
    const img = new Image();
    img.onload = () => ok({ img });
    img.src = `data:image/jpeg;base64,${b64}`;
  })));

  return { bocche, fps: bocche.length / Math.max(dt, 1e-3) };
}
