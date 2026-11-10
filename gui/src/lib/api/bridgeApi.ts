// Client del control server di call-bridge (Flask, default 127.0.0.1:8770).
// Il token Bearer viene letto da call-bridge/config.json tramite il comando
// Tauri `read_bridge_config` (vedi initBridgeApi in App.tsx): niente da
// incollare a mano. I tipi rispecchiano i payload dei blueprint api_*.py.

import { invoke } from "@tauri-apps/api/core";
import type { TtsModel } from "./voiceEngineApi";

let baseUrl = "http://127.0.0.1:8770";
let authToken = "";

export interface BridgeConfigFile {
  control_host?: string;
  control_port?: number;
  control_auth_token?: string;
  [key: string]: unknown;
}

/** Legge host/porta/token dal config.json del backend (via Tauri). */
export async function initBridgeApi(): Promise<void> {
  try {
    const raw = await invoke<string>("read_bridge_config");
    const cfg = JSON.parse(raw) as BridgeConfigFile;
    const host = cfg.control_host || "127.0.0.1";
    const port = cfg.control_port || 8770;
    baseUrl = `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;
    authToken = cfg.control_auth_token || "";
  } catch (e) {
    console.error("initBridgeApi: config.json non leggibile", e);
  }
}

export class BridgeError extends Error {
  status: number;
  /** Corpo JSON della risposta d'errore: i 409 `confirm_required` ci mettono
   *  cosa verrebbe scaricato e cosa caricato, e serve per chiederlo all'utente. */
  data: Record<string, any>;
  constructor(status: number, message: string, data: Record<string, any> = {}) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** Esportata perché la usano anche i client dei blueprint separati
 *  (`llmApi`): stessa base URL, stesso token, stessa gestione errori. */
export async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 15000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new BridgeError(
        res.status,
        (data as any)?.error ?? (data as any)?.message ?? `HTTP ${res.status}`,
        (data as Record<string, any>) ?? {},
      );
    }
    return data as T;
  } catch (e) {
    // Niente piu' "signal is aborted without reason": il timeout del fetch
    // diventa un errore leggibile con percorso e durata.
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new BridgeError(
        0,
        `nessuna risposta dal backend entro ${Math.round(timeoutMs / 1000)}s (${path})`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- stato e chiamate -------------------------------------------------------

export interface BridgeStatus {
  session_active?: boolean;
  phone?: { state?: string; number?: string | null; since?: string | null };
  voice_engine?: Record<string, unknown>;
  [key: string]: unknown;
}

export const getHealth = () => req<{ status: string }>("GET", "/health", undefined, 3000);
export const getStatus = () => req<BridgeStatus>("GET", "/status", undefined, 5000);
export const prepare = (tts = true, stt_model?: string | null) =>
  req("POST", "/prepare", { tts, stt_model }, 240000);
export const placeCall = (body: {
  number: string;
  voice?: string;
  lang?: string;
  transport?: string;
  greeting?: string;
}) => req<Record<string, unknown>>("POST", "/call", body, 120000);
export const hangup = () => req("POST", "/hangup", {}, 30000);
export const getTransport = (refresh = false) =>
  req<{ selected: string | null; mode: string }>(
    "GET",
    `/transport${refresh ? "?refresh=1" : ""}`,
    undefined,
    30000,
  );
export const getModelsAvailable = () =>
  req<Record<string, any>>("GET", "/models/available", undefined, 15000);

// --- sessioni voce (≡ hotkey) ----------------------------------------------

export interface SessionState {
  active: boolean;
  mode: "half" | "full" | "limited" | null;
  phase: "idle" | "listening" | "reasoning" | "speaking";
  /** True se la sessione mostra anche l'avatar video (Ctrl+Shift+F1/F2). */
  avatar?: boolean;
}

export const sessionStart = (
  mode: "half" | "full" | "limited",
  avatar = false,
) =>
  req<{ status: string; mode: string; avatar?: boolean }>(
    "POST",
    "/session/start",
    { mode, avatar },
    240000,
  );
export const sessionStop = () => req<{ status: string }>("POST", "/session/stop", {});
export const getSessionState = () =>
  req<SessionState>("GET", "/session/state", undefined, 4000);
export const copilotToggle = () =>
  req<{ active: boolean }>("POST", "/copilot/toggle", {}, 30000);
export interface CopilotSaveState {
  state: "idle" | "saving" | "done" | "error";
  project_id?: string;
  wiki_path?: string;
  error?: string;
}
export const getCopilotState = () =>
  req<{
    enabled: boolean;
    active: boolean;
    project_id?: string | null;
    save_state?: CopilotSaveState;
  }>("GET", "/copilot/state", undefined, 4000);
/** Collega il copilota a un progetto wikibridge (conoscenza dedicata). */
export const setCopilotProject = (projectId: string | null) =>
  req<{ project_id: string | null }>("POST", "/copilot/project", {
    project_id: projectId,
  });
/** Analizza la sessione copilota e la salva come riunione nel wiki. */
export const copilotSaveMeeting = (projectId?: string, title?: string) =>
  req<{ started: boolean; save_state: CopilotSaveState }>(
    "POST",
    "/copilot/save-meeting",
    { project_id: projectId, title },
    15000,
  );

// --- LLM di Hermes (modello per sessione + nuova conversazione) -------------

/** Voce di un menu di modelli: id + quantizzazione + peso. Servono entrambi:
 *  lo stesso modello esiste in più quantizzazioni, che pesano (e occupano
 *  VRAM) in modo diverso. */
export interface ModelInfo {
  id: string;
  /** es. "IQ4_NL", "Q8_0", "AWQ-W4A16"; "" se ignota */
  quant: string;
  size_bytes: number;
  /** peso già formattato dal bridge, es. "19,3 GB" */
  size_h: string;
  params?: string;
  arch?: string;
  /** "id · quant · peso", pronta da mostrare */
  label: string;
  /** true = è questo il modello già in memoria */
  loaded?: boolean;
}
export interface HermesModels {
  providers: { provider: string; models: string[]; models_info?: ModelInfo[] }[];
  current: { model: string | null; provider: string | null; loaded?: string[] };
  /** false = checkbox "Override Hermes model" spenta: il modello lo decide
   *  Hermes e la GUI lo mostra in sola lettura. */
  override?: boolean;
}
export const getHermesModels = () =>
  req<HermesModels>("GET", "/hermes/models", undefined, 8000);

// --- stato REALE dei motori STT/TTS -----------------------------------------

export interface EngineRuntime {
  /** device+memoria da config (l'intenzione) */
  configured: string;
  /** device che verrebbe usato al prossimo caricamento */
  would_load_on: "cuda" | "cpu" | string;
  loaded: boolean;
  /** device del modello VIVO adesso; null se non caricato */
  running_on: "cuda" | "cpu" | string | null;
  file?: string | null;
  model?: string | null;
  precision?: string;
  /** Solo STT: "loading" mentre ricarica dopo un cambio di modello/device/precisione. */
  state?: "stopped" | "loading" | "running" | "error" | string;
  error?: string | null;
}
/** Elenco dei motori TTS dal BRIDGE (sempre acceso), non dal server voci :8720:
 *  si vede anche da sospeso. Niente voci. */
export const getEngineCatalog = () =>
  req<{ models: TtsModel[] }>("GET", "/engines/catalog", undefined, 8000);

/** Ricarica SOLO lo STT (rifa il processo, modello di nuovo in VRAM): e' quello che
 *  fa «Load models» da sospeso. Bloccante fino a modello pronto. */
export const reloadStt = () =>
  req<{ status: string; stt: EngineRuntime; suspended: boolean }>(
    "POST", "/components/stt/reload", {}, 180000);

export const getEnginesStatus = () =>
  req<{ stt: EngineRuntime; tts: EngineRuntime }>("GET", "/engines/status", undefined, 8000);

// --- LLM della chat avatar (F4/F5): LM Studio o vLLM -------------------------

export interface AvatarLlmBackend {
  up: boolean;
  /** false = elenco non richiesto al backend (evita di accendere LM Studio). */
  queried: boolean;
  loaded: string[];
  available: string[];
  /** `available` con quantizzazione, peso e flag `loaded` per ogni voce. */
  models?: ModelInfo[];
  chosen: string;
}
export interface AvatarLlmModels {
  selected: "lmstudio" | "vllm";
  backends: Record<"lmstudio" | "vllm", AvatarLlmBackend>;
}
/** `include`: passare "lmstudio" ACCENDE LM Studio (lo fa la sua CLI) — usarlo
 *  solo quando l'utente sceglie quel backend. */
export const getAvatarLlmModels = (include = "") =>
  req<AvatarLlmModels>(
    "GET",
    `/avatar/llm/models${include ? `?include=${encodeURIComponent(include)}` : ""}`,
    undefined,
    30000,
  );
/** Dettagli di un 409 `confirm_required`: in VRAM ci sta un modello solo, e
 *  per caricare quello scelto va scaricato quello caldo — solo se si conferma. */
export interface SwapConfirm {
  code: "confirm_required";
  loaded: string;
  loaded_label: string;
  target_label: string;
  reason: string;
}
/** `confirm: true` = scarica il modello caldo e carica quello scelto. Senza,
 *  un modello già in memoria fa rispondere 409 (vedi SwapConfirm). */
export const setHermesModel = (model: string, provider?: string, confirm = false) =>
  req<{ status: string; model: string; provider?: string; note?: string }>(
    "POST",
    "/hermes/model",
    { model, provider, confirm },
    confirm ? 330000 : 15000,
  );
/** Swap del modello della chat avatar (F4/F5). Stessa regola di conferma. */
export const swapAvatarLlmModel = (model: string, confirm = false) =>
  req<{ status: string; model: string; note?: string }>(
    "POST",
    "/avatar/llm/swap",
    { model, confirm },
    confirm ? 330000 : 15000,
  );
export const sessionNew = () =>
  req<{ status: string; reset: boolean }>("POST", "/session/new", {}, 15000);

// --- configurazione ----------------------------------------------------------

export interface BridgeConfig {
  config: Record<string, unknown>;
  restart_required_fields: string[];
}

export const getConfig = () => req<BridgeConfig>("GET", "/config");
export const putConfig = (updates: Record<string, unknown>) =>
  req<{ applied: string[]; requires_restart: string[]; rejected: Record<string, string> }>(
    "PUT",
    "/config",
    { updates },
  );

// --- componenti ---------------------------------------------------------------

export interface ComponentsStatus {
  main: {
    state: string; pid?: number; stopping?: boolean; session?: SessionState | null;
    /** "Sospendi" attivo: il riscaldamento automatico dei motori e' in pausa. */
    suspended?: boolean;
    /** Memoria del processo bridge: commit (Private Bytes) e RAM, in GiB. */
    memory?: { commit_gib?: number; ram_gib?: number };
  };
  gateway: { state: string; port?: number };
  /** Hotkey push-to-talk (sessioni, avatar, copilota): "suspended" dopo Sospendi. */
  push_to_talk?: { state: string };
  /** Watcher delle chiamate in arrivo: "suspended" dopo Sospendi (non risponde). */
  incoming_calls?: { state: string };
  /** Motori voce STT/TTS. `mode` e' sempre "native" (in-process nel bridge):
   *  non c'e' nessun processo da avviare o fermare, si riavvia il main. */
  voice_engine: {
    state: string;
    mode?: "native" | "external";
    detail?: string;
    models?: Record<string, any> | null;
  };
  hermes: { state: string; mode?: string; detail?: string | null };
  avatar_worker: {
    state: string;
    persona?: string | null;
    /** Identita' in preparazione (il worker sta caricando i modelli/clip). */
    preparing?: string | null;
    progress?: AvatarProgress | null;
    /** Motivo dell'ultimo avvio fallito (es. OOM CUDA). */
    detail?: string | null;
  };
  /** Dettatura (Alt+Spazio): sempre attiva. Usa l'UNICO STT (processo whisper
   *  condiviso con le sessioni voce) e "Sospendi" non la tocca. */
  dictation?: DictationStatus;
}

export interface DictationStatus {
  state: string;
  hotkey?: string;
  model?: string;
  device?: string | null;
  precision?: string | null;
  vram_mb?: number | null;
  pid?: number | null;
  detail?: string | null;
  /** Tempi dell'ultima dettatura: secondi di audio, ms totali, x realtime. */
  last?: { audio_s: number; stt_ms: number; total_ms: number; xrt: number } | null;
}

export const getComponentsStatus = () =>
  req<ComponentsStatus>("GET", "/components/status", undefined, 12000);
export const componentAction = (
  component: "main" | "hermes" | "gateway",
  action: "start" | "stop" | "restart",
) => req("POST", `/components/${component}/${action}`, {}, 90000);

/** Misure di "Sospendi": VRAM (nvidia-smi) e commit del bridge prima/dopo, commit
 *  (MiB) dei processi chiusi. null = misura non disponibile. */
export interface SuspendMeasures {
  vram_mb: { before: number | null; after: number | null };
  main_commit_gib: { before?: number | null; after?: number | null };
  closed_commit_mb: Record<string, number | null>;
}

/** Libera la memoria senza spegnere: chiude avatar, motori TTS e agente.
 *  Restano su STT, dettatura, push-to-talk, il modello in LM Studio e il bridge. */
export const suspendAll = () =>
  req<{ status: string; released: string[]; kept: string[];
        errors: Record<string, string>; measures?: SuspendMeasures }>(
    "POST", "/components/suspend", {}, 120000);

/** Fine della sospensione: i motori tornano a essere riscaldati. */
export const resumeAll = () =>
  req<{ status: string }>("POST", "/components/resume", {}, 30000);

// --- persone / avatar ----------------------------------------------------------

export interface Persona {
  name: string;
  voice: { engine?: string; voice?: string };
  clips: string[];
  clip_count: number;
  /** Personalità/modo di parlare — usata dalla modalità LM Studio (Ctrl+Shift+F4/F5). */
  personality?: string;
  /** Prompt di sistema aggiuntivo per la modalità LM Studio. */
  system_prompt?: string;
  /** Slug del progetto wikibridge collegato (memoria/sapere della persona). */
  knowledge_project?: string;
  /** True se la personalità è stata arricchita da documenti importati (Fase 5). */
  has_personality_docs?: boolean;
  /** Numero di chunk nell'indice RAG (sapere) della persona. */
  knowledge_chunks?: number;
}

/** Stato del job di ingest documenti→personalità/sapere (Fase 5). */
export interface PersonaIngestState {
  state: "idle" | "running" | "done" | "error";
  phase?: string;
  percent?: number;
  detail?: string;
  error?: string | null;
  result?: {
    chunks: number;
    analyzed?: number;
    relevant?: number | null;
    dropped?: number;
    rag: "semantic" | "lexical" | string;
    rag_indexed?: number;
    personality_updated: boolean;
    notes: number;
  } | null;
}

/** Patch parziale del manifest: si inviano solo i campi da aggiornare. */
export interface PersonaPatch {
  voice?: { engine?: string; voice?: string };
  personality?: string;
  system_prompt?: string;
  knowledge_project?: string;
}

export const getPersonas = () =>
  req<{ personas: Persona[] }>("GET", "/personas");
export const createPersona = (
  name: string,
  voice: { engine?: string; voice?: string },
  extra?: Omit<PersonaPatch, "voice">,
) => req("POST", "/personas", { name, voice, ...extra });
export const updatePersona = (name: string, patch: PersonaPatch) =>
  req("PUT", `/personas/${encodeURIComponent(name)}`, patch);
export const deletePersona = (name: string) =>
  req("DELETE", `/personas/${encodeURIComponent(name)}`);
export const deletePersonaClip = (name: string, clip: string) =>
  req("DELETE", `/personas/${encodeURIComponent(name)}/clips/${encodeURIComponent(clip)}`);

// --- memoria della persona ---------------------------------------------------

/** Una conversazione ricordata. `index` è la posizione nell'array salvato:
 *  cancellandone una, gli indici delle successive scalano. */
export interface MemorySession {
  index: number;
  ts: number | null;
  title: string;
  summary: string;
}
export interface PersonaMemory {
  /** ricordo DUREVOLE: sopravvive alla cancellazione delle singole sessioni */
  profile: string;
  sessions: MemorySession[];
  last_seen_ts: number | null;
  sessions_count: number;
}

export const getPersonaMemory = (name: string) =>
  req<PersonaMemory>("GET", `/personas/${encodeURIComponent(name)}/memory`);
export const setPersonaProfile = (name: string, profile: string) =>
  req<{ status: string }>(
    "PUT", `/personas/${encodeURIComponent(name)}/memory`, { profile });
export const forgetPersonaSession = (name: string, index: number) =>
  req<{ status: string; remaining: number }>(
    "DELETE", `/personas/${encodeURIComponent(name)}/memory/sessions/${index}`);
export const clearPersonaMemory = (name: string) =>
  req<{ status: string }>("DELETE", `/personas/${encodeURIComponent(name)}/memory`);

export async function uploadPersonaClip(name: string, file: File): Promise<string[]> {
  const form = new FormData();
  form.append("clip", file, file.name);
  const res = await fetch(
    `${baseUrl}/personas/${encodeURIComponent(name)}/clips`,
    {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: form,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BridgeError(res.status, (data as any)?.error ?? `HTTP ${res.status}`);
  return (data as any).clips ?? [];
}

/** Carica un documento/libro e avvia l'estrazione personalità+sapere (async). */
export async function ingestPersonaDoc(
  name: string,
  file: File,
): Promise<{ status: string; file: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  const res = await fetch(
    `${baseUrl}/personas/${encodeURIComponent(name)}/ingest`,
    {
      method: "POST",
      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      body: form,
    },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BridgeError(res.status, (data as any)?.error ?? `HTTP ${res.status}`);
  return data as { status: string; file: string };
}

export const getPersonaIngestState = (name: string) =>
  req<PersonaIngestState>(
    "GET",
    `/personas/${encodeURIComponent(name)}/ingest/state`,
    undefined,
    5000,
  );

export interface AvatarProgress {
  phase: "extract" | "landmark" | "latents" | "masks" | string;
  done: number;
  total: number;
  percent: number;
  eta_s: number | null;
}

export interface AvatarState {
  running: boolean;
  persona: string | null;
  preparing: string | null;
  progress: AvatarProgress | null;
  error: string | null;
}

/** Avvio asincrono: risponde subito ("preparing"); seguire con il polling. */
export const avatarStart = (persona: string) =>
  req<{ status: string; persona: string }>("POST", "/avatar/start", { persona }, 20000);
export const avatarStop = () => req("POST", "/avatar/stop", {});
/** Tronca la battuta in corso (l'avatar torna subito in idle). */
export const avatarInterrupt = () => req("POST", "/avatar/interrupt", {}, 8000);
export const getAvatarState = () =>
  req<AvatarState>("GET", "/avatar/state", undefined, 4000);

/**
 * Avvia l'avatar sull'identita' e attende che sia operativo, con polling.
 * `onTick` riceve lo stato a ogni giro (per aggiornare l'etichetta in GUI).
 * NESSUN timeout: la preparazione di un clip puo' superare anche i 10-30
 * minuti (dipende da lunghezza e GPU); si esce solo a successo o quando il
 * backend segnala che la preparazione e' finita male (preparing=false).
 */
export async function avatarStartAndWait(
  persona: string,
  onTick?: (state: AvatarState) => void,
): Promise<void> {
  await avatarStart(persona);
  // Se il backend muore durante la preparazione, getAvatarState() fallisce a
  // ogni giro: senza un limite il loop girerebbe per sempre (busy bloccato in
  // GUI). Si tollerano alcuni glitch transitori, poi si esce con errore.
  let consecutiveFailures = 0;
  const MAX_CONSECUTIVE_FAILURES = 10; // ~20s di backend irraggiungibile
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    const s = await getAvatarState().catch(() => null);
    if (!s) {
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        throw new BridgeError(
          0,
          "backend non raggiungibile durante la preparazione dell'avatar",
        );
      }
      continue;
    }
    consecutiveFailures = 0;
    onTick?.(s);
    if (s.running && s.persona === persona) return;
    if (!s.preparing) {
      throw new BridgeError(
        502,
        s.error ?? "preparazione avatar terminata senza esito (vedi log)",
      );
    }
  }
}
export const avatarSpeak = (text: string, voice?: string, lang?: string) =>
  req<{ status: string; duration_ms?: number; voice?: string }>(
    "POST",
    "/avatar/speak",
    { text, voice, lang },
    600000,
  );

// --- diagnostica (test guidati) -------------------------------------------------

export const diagMic = (device?: number, seconds = 1) =>
  req<{ ok: boolean; rms?: number; peak?: number; device_name?: string; error?: string }>(
    "GET",
    `/diag/mic?seconds=${seconds}${device !== undefined ? `&device=${device}` : ""}`,
    undefined,
    20000,
  );
export const diagEcho = (seconds = 3) =>
  req<{ ok: boolean; rms?: number; error?: string }>(
    "POST",
    "/diag/echo",
    { seconds },
    40000,
  );
export const diagLoopback = () =>
  req<{ ok: boolean; device_name?: string; rms?: number; error?: string }>(
    "GET",
    "/diag/loopback",
    undefined,
    20000,
  );
export const diagVoiceEngine = () =>
  req<{ ok: boolean; health?: boolean; models?: any; error?: string }>(
    "GET",
    "/diag/voice-engine",
    undefined,
    15000,
  );
export const diagHermes = () =>
  req<{ ok: boolean; state?: string; mode?: string; detail?: string }>(
    "GET",
    "/diag/hermes",
    undefined,
    15000,
  );
export const diagAcp = () =>
  req<{ ok: boolean; wsl_ok?: boolean; agent_ready?: boolean; note?: string }>(
    "GET",
    "/diag/acp",
    undefined,
    30000,
  );
export const diagTtsRoundtrip = (text?: string) =>
  req<{ ok: boolean; spoken?: string; heard?: string; match?: number; error?: string }>(
    "POST",
    "/diag/tts-roundtrip",
    { text },
    300000,
  );

// --- analisi video/audio ----------------------------------------------------------

export interface AnalysisProgress {
  phase: string;
  percent: number;
  detail: string | null;
}

export interface AnalysisItem {
  id: string;
  title: string | null;
  source_type: "file" | "url";
  source: string;
  created: string;
  duration_s?: number;
  state: "queued" | "downloading" | "extracting" | "transcribing" | "diarizing" | "analyzing" | "done" | "error" | "running";
  error?: string | null;
}

export interface AnalysisDetail extends AnalysisItem {
  progress?: AnalysisProgress;
  /** Voci distinte riconosciute dalla diarizzazione (assente = non diarizzato). */
  speakers_found?: number;
  /** "Speaker 1" -> nome dato dall'utente. Gli artifact tengono l'etichetta. */
  speaker_names?: Record<string, string>;
  analysis?: {
    summary: string;
    highlights: { title: string; summary: string }[];
    tasks: { assignee: string; task: string }[];
  };
}

/** `speakers`: voci attese (0 = le conta la diarizzazione). */
export async function analysisStartFile(
  file: File,
  title?: string,
  speakers?: number,
): Promise<string> {
  const form = new FormData();
  form.append("file", file, file.name);
  if (title) form.append("title", title);
  if (speakers) form.append("speakers", String(speakers));
  const res = await fetch(`${baseUrl}/analysis/start`, {
    method: "POST",
    headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new BridgeError(res.status, (data as any)?.error ?? `HTTP ${res.status}`);
  return (data as any).id;
}

export const analysisStartUrl = (url: string, title?: string, speakers?: number) =>
  req<{ id: string }>("POST", "/analysis/start", { url, title, speakers }, 30000);
export const getAnalysisList = () =>
  req<{ analyses: AnalysisItem[] }>("GET", "/analysis/list");
export const getAnalysis = (id: string) =>
  req<AnalysisDetail>("GET", `/analysis/${encodeURIComponent(id)}`);
export const getAnalysisTranscript = (id: string) =>
  req<{
    segments: {
      start_s: number;
      end_s: number;
      text: string;
      /** Nome da mostrare (gia' rinominato se l'utente l'ha fatto). */
      speaker?: string;
      /** Etichetta originale ("Speaker 1"): e' la chiave per rinominare. */
      speaker_label?: string;
    }[];
  }>("GET", `/analysis/${encodeURIComponent(id)}/transcript`);
export const renameAnalysisSpeakers = (id: string, names: Record<string, string>) =>
  req<{ status: string; speaker_names: Record<string, string> }>(
    "POST",
    `/analysis/${encodeURIComponent(id)}/speakers`,
    { names },
  );
export const deleteAnalysis = (id: string) =>
  req("DELETE", `/analysis/${encodeURIComponent(id)}`);

// --- meeting bot e storico riunioni ------------------------------------------------

export interface MeetbotStatus {
  state: "idle" | "joining" | "waiting_admit" | "in_call" | "leaving" | "ended" | "error";
  session_id?: string;
  url?: string;
  platform?: string;
  participants?: string[];
  transcript_tail?: { ts: string; speaker: string; text: string }[];
  error?: string | null;
}

export interface MeetingItem {
  id: string;
  title: string | null;
  created: string;
  ended?: string;
  participants: string[];
  segments?: number;
  analysis_state: "pending" | "analyzing" | "done" | "error";
}

export interface MeetingDetail extends MeetingItem {
  analysis_error?: string;
  project_id?: string | null;
  wiki_path?: string;
  analysis?: {
    summary: string;
    highlights: { title: string; summary: string }[];
    agreements?: { title: string; detail: string }[];
    tasks: { assignee: string; task: string }[];
  };
}

export const meetbotJoin = (
  url: string,
  title?: string,
  displayName?: string,
  projectId?: string,
) =>
  req<{ session_id: string; state: string }>(
    "POST",
    "/meetbot/join",
    { url, title, display_name: displayName, project_id: projectId },
    30000,
  );
/** Inserisce (o ri-inserisce) una riunione analizzata nel wiki del progetto. */
export const meetingPushWiki = (id: string, projectId?: string) =>
  req<{ wiki_path: string }>(
    "POST",
    `/meetings/${encodeURIComponent(id)}/push-wiki`,
    { project_id: projectId },
    60000,
  );
export const getMeetbotStatus = () =>
  req<MeetbotStatus>("GET", "/meetbot/status", undefined, 5000);
export const meetbotLeave = () =>
  req<{ state: string; session_id?: string }>("POST", "/meetbot/leave", {}, 15000);
export const getMeetingsList = () =>
  req<{ meetings: MeetingItem[] }>("GET", "/meetings/list");
export const getMeeting = (id: string) =>
  req<MeetingDetail>("GET", `/meetings/${encodeURIComponent(id)}`);
export const getMeetingTranscript = (id: string) =>
  req<{ segments: { ts: string; start_s: number; speaker: string; text: string }[] }>(
    "GET",
    `/meetings/${encodeURIComponent(id)}/transcript`,
  );
export const deleteMeeting = (id: string) =>
  req("DELETE", `/meetings/${encodeURIComponent(id)}`);

// --- calendari (auto-join) ---------------------------------------------------------

export interface CalendarStatus {
  google: { configured: boolean; connected: boolean; flow_error: string | null };
  microsoft: { configured: boolean; connected: boolean; flow_error: string | null };
}

export interface CalendarEvent {
  id: string;
  provider: "google" | "microsoft";
  title: string;
  start: string | null;
  end: string | null;
  organizer: string | null;
  meeting_url: string | null;
  autojoin: boolean;
}

export const getCalendarStatus = () =>
  req<CalendarStatus>("GET", "/calendar/status", undefined, 10000);
export const calendarConnect = (provider: "google" | "microsoft") =>
  req<{ status?: string; user_code?: string; verification_uri?: string; detail?: string; error?: string }>(
    "POST",
    `/calendar/${provider}/connect`,
    {},
    20000,
  );
export const calendarDisconnect = (provider: "google" | "microsoft") =>
  req("POST", `/calendar/${provider}/disconnect`, {});
export const getCalendarEvents = (days = 7) =>
  req<{ events: CalendarEvent[] }>("GET", `/calendar/events?days=${days}`, undefined, 30000);
export const setEventAutojoin = (eventId: string, enabled: boolean) =>
  req("POST", `/calendar/events/${encodeURIComponent(eventId)}/autojoin`, { enabled });

// --- GPU del sistema --------------------------------------------------------------

export interface SystemGpu {
  index: number;
  name: string;
  vram_mb: number;
}

export const getGpuList = () =>
  req<{ gpus: SystemGpu[]; source: string }>("GET", "/gpu/list", undefined, 8000);

// --- fallback locali (control server giu') ---------------------------------------

export const isPortOpen = (port: number) => invoke<boolean>("is_port_open", { port });
/** Apre un URL nel browser esterno (comando Tauri). */
export const openExternal = (url: string) => invoke<void>("open_url", { url });
export const startSupervisor = () => invoke<string>("start_supervisor");
export const clearStopSentinel = () => invoke<boolean>("clear_stop_sentinel");
/** Cold restart completo (script locale): ferma istanze vLLM e worker, libera la
 *  VRAM, chiude bridge e GUI (li rilanciano i supervisori) e riavvia i servizi.
 *  Comando Tauri, non endpoint: deve funzionare anche a bridge spento. */
export const systemRestart = () => invoke<string>("system_restart");
