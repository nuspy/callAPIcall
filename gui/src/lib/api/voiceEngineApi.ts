// Client dei motori voce del bridge (STT/TTS) su 127.0.0.1:8720.
// Le route conservano la forma dell'API di Handy — il bridge la espone dal suo
// server handy-compat (callbridge/handy_compat.py) usando i motori NATIVI
// in-process, cosi' i consumatori esterni non hanno dovuto cambiare.
// Copre settings dei modelli TTS/STT, voci clonate e sintesi di prova.

const API_BASE = "http://127.0.0.1:8720";

export class VoiceEngineError extends Error {}

async function jsonOrThrow(res: Response): Promise<any> {
  const body = await res.json().catch(() => ({}));
  // Un errore HTTP con un campo `message` NON e' un successo: prima veniva
  // restituito come tale, poi crashava a valle (es. m.models.filter su
  // undefined) e nascondeva il messaggio d'errore reale.
  if (!res.ok) {
    throw new VoiceEngineError(body?.message ?? `HTTP ${res.status}`);
  }
  return body;
}

export const engineHealth = async (): Promise<boolean> => {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
};

// --- modelli -----------------------------------------------------------------

export interface EngineVoice {
  voice: string;
  lang: string;
  language: string;
}

export interface ModelsAvailable {
  tts: { engine: string; voices: EngineVoice[]; selected_model: string };
  stt: { loaded: boolean; current_model: string | null };
}

export const modelsAvailable = async (): Promise<ModelsAvailable> =>
  jsonOrThrow(await fetch(`${API_BASE}/models/available`));

// --- modelli TTS selezionabili (dropdown engine) -----------------------------

export interface EngineVoiceInfo {
  voice: string;
  lang: string;
  language: string;
}

export interface TtsModel {
  id: string;
  name: string;
  engine: string;
  /** Il motore puo' sintetizzare adesso (venv/helper/modelli presenti). */
  is_downloaded: boolean;
  /** Motore a voci CLONATE: le sue voci sono i riferimenti in cloned_voices. */
  is_cloning: boolean;
  /** "builtin" | "cloned" | "piper" — da dove vengono le sue voci. */
  voices_from?: string;
  /** Lingue dichiarate (ISO 639-1); vuoto = nessun vincolo. */
  langs?: string[];
  note?: string;
  /** Velocita' misurata rispetto al tempo reale (0 = ignota). */
  realtime?: number;
  /** Sa consegnare l'audio a pezzi mentre genera (streaming TTS). */
  streaming?: boolean;
  /** Qwen3-TTS: runtime GGUF quantizzato (qwentts.cpp) installato. */
  ggml?: boolean;
  /** Voci del motore, gia' incluse nel catalogo per evitare una GET per motore. */
  voices?: EngineVoiceInfo[];
}

export interface TtsModels {
  models: TtsModel[];
  selected: string;
  selected_voice: string;
  kokoro_precisions?: string[];
  kokoro_precision?: string;
}

export const listTtsModels = async (): Promise<TtsModels> =>
  jsonOrThrow(await fetch(`${API_BASE}/tts/models`));

/** Voci di UN motore. Il catalogo le porta gia' con se', ma questa serve
 *  quando si vuole solo aggiornare il secondo dropdown. */
export const listEngineVoices = async (model: string): Promise<EngineVoiceInfo[]> => {
  const body = await jsonOrThrow(
    await fetch(`${API_BASE}/tts/voices?model=${encodeURIComponent(model)}`));
  return body.voices ?? [];
};

/** Stato in memoria di un motore TTS (GET /models/status -> engines). */
export interface EngineState {
  /** "ready" = in memoria | "loading" = si sta caricando | "unloaded" | "error" */
  state: "ready" | "loading" | "unloaded" | "error";
  message: string;
  /** Secondi impiegati dall'ultimo caricamento. */
  seconds: number;
  active: boolean;
  available: boolean;
}

/** Esito dello hot swap: cosa e' uscito dalla VRAM e cosa si sta scaldando. */
export interface EngineSwap {
  selected: string;
  previous?: string;
  unloaded?: string[];
  warming?: boolean;
  message?: string;
}

export async function setTtsModel(modelId: string): Promise<EngineSwap> {
  const body = await jsonOrThrow(
    await fetch(`${API_BASE}/tts/model`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model_id: modelId }),
    }),
  );
  if (body.status !== "ok") throw new VoiceEngineError(body.message ?? "cambio engine fallito");
  return body as EngineSwap;
}

export async function setTtsVoice(voice: string): Promise<void> {
  const body = await jsonOrThrow(
    await fetch(`${API_BASE}/tts/voice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ voice }),
    }),
  );
  if (body.status !== "ok") throw new VoiceEngineError(body.message ?? "set voce fallito");
}

export interface ModelsStatus {
  /** L'unico STT: modello, device e precisione REALI del processo vivo. */
  stt: {
    loaded: boolean;
    current_model: string | null;
    state?: "stopped" | "loading" | "running" | "error" | null;
    device?: string | null;
    precision?: string | null;
  };
  tts: {
    loaded: boolean;
    current_model: string | null;
    selected_model: string;
    state?: EngineState["state"];
    message?: string;
    load_seconds?: number;
  };
  /** Stato per motore: chi occupa memoria e chi si sta caricando. */
  engines?: Record<string, EngineState>;
  idle_seconds?: number;
  idle_unload_seconds?: number;
}

export const modelsStatus = async (): Promise<ModelsStatus> =>
  jsonOrThrow(await fetch(`${API_BASE}/models/status`));

export const modelsLoad = async (opts: { stt_model?: string | null; tts?: boolean }) =>
  jsonOrThrow(
    await fetch(`${API_BASE}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );

export const modelsUnload = async (component: "stt" | "tts" | "all") =>
  jsonOrThrow(
    await fetch(`${API_BASE}/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ component }),
    }),
  );

// --- voci clonate ---------------------------------------------------------------

export interface ClonedVoice {
  name: string;
  format: string;
  size_bytes: number;
  modified: string;
}

export async function listClonedVoices(): Promise<ClonedVoice[]> {
  const body = await jsonOrThrow(await fetch(`${API_BASE}/voices/cloned`));
  return body.voices ?? [];
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    binary += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function cloneVoice(
  name: string,
  audio: Blob,
  format: "wav" | "mp3" | "flac" | "ogg",
): Promise<string[]> {
  const audio_b64 = await blobToBase64(audio);
  const body = await jsonOrThrow(
    await fetch(`${API_BASE}/voices/clone`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, audio_b64, format }),
    }),
  );
  if (body.status !== "ok") throw new VoiceEngineError(body.message ?? "clonazione fallita");
  return body.voices ?? [];
}

export async function deleteClonedVoice(name: string): Promise<string[]> {
  const body = await jsonOrThrow(
    await fetch(`${API_BASE}/voices/cloned/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),
  );
  if (body.status !== "ok") throw new VoiceEngineError(body.message ?? "cancellazione fallita");
  return body.voices ?? [];
}

// --- sintesi di prova ----------------------------------------------------------

export interface TtsTestResult {
  status: string;
  audio_b64: string;
  sample_rate: number;
  duration_ms: number;
  voice: string;
  message?: string;
}

export async function ttsTest(
  text: string,
  opts: { voice?: string; lang?: string; speed?: number; model?: string;
           engine?: string } = {},
): Promise<TtsTestResult> {
  const body = (await jsonOrThrow(
    await fetch(`${API_BASE}/tts/test`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...opts }),
    }),
  )) as TtsTestResult;
  if (body.status !== "ok") throw new VoiceEngineError(body.message ?? "sintesi fallita");
  return body;
}

export function wavUrlFromBase64(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
}
