// Client del server wikibridge (Flask, default 127.0.0.1:8775) — la LLM
// Wiki per progetti del repo separato C:\Projects\wikibridge. Stesso
// pattern di bridgeApi.req(): timeout leggibili, BridgeError.
//
// Il server NON ha un autostart: viene avviato ON-DEMAND da qui (comando
// Tauri start_wikibridge) la prima volta che una chiamata lo trova giù.

import { invoke } from "@tauri-apps/api/core";
import { BridgeError, req } from "./bridgeApi";

const BASE = "http://127.0.0.1:8775";

// --- sessione utente (wikibridge multi-utente) ------------------------------
// La sessione la tiene il backend call-bridge, unica per l'app: la GUI ne
// riceve token e chiave applicazione e li allega alle chiamate dirette a
// wikibridge. Solo in memoria: mai in localStorage.

export interface KnowledgeSession {
  reachable: boolean;
  multi_user: boolean;
  login?: "password" | "sso" | null;
  logged_in: boolean;
  sso_pending?: boolean;
  sso_error?: string | null;
  display_name?: string;
  roles?: string[];
  admin?: boolean;
  clearance?: string;
  token?: string;
  app_key?: string;
}

let sessionToken = "";
let appKey = "";
let multiUser = false;
const expiredListeners = new Set<() => void>();

function applySession(s: KnowledgeSession): KnowledgeSession {
  multiUser = s.multi_user;
  sessionToken = s.logged_in ? s.token || "" : "";
  appKey = s.app_key || "";
  return s;
}

/** La sezione viene avvisata quando wikibridge rifiuta la sessione (401). */
export function onKnowledgeSessionExpired(fn: () => void): () => void {
  expiredListeners.add(fn);
  return () => expiredListeners.delete(fn);
}

export const getKnowledgeSession = () =>
  req<KnowledgeSession>("GET", "/knowledge/session", undefined, 10000).then(applySession);
export const knowledgeLogin = (username: string, password: string) =>
  req<KnowledgeSession>("POST", "/knowledge/login", { username, password }, 20000).then(
    (s) => applySession({ ...s, reachable: true }),
  );
export const knowledgeLoginSso = () =>
  req<{ sso_pending: boolean; started: boolean }>("POST", "/knowledge/login", { sso: true });
export const knowledgeLogout = () =>
  req("POST", "/knowledge/logout", {}).finally(() => {
    sessionToken = "";
  });

function authHeaders(): Record<string, string> {
  return {
    ...(appKey ? { "X-Wikibridge-Key": appKey } : {}),
    ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
  };
}

async function pingHealth(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE}/health`, { signal: ctrl.signal, headers: authHeaders() });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

// Un solo tentativo di avvio per volta (le sezioni montano in parallelo).
let starting: Promise<boolean> | null = null;

/** Avvia il server wikibridge se è giù e attende che risponda (max ~10s). */
export async function ensureKnowledgeServer(): Promise<boolean> {
  if (await pingHealth()) return true;
  if (!starting) {
    starting = (async () => {
      try {
        await invoke<string>("start_wikibridge");
      } catch {
        return false; // wikibridge non installato su questa macchina
      }
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 800));
        if (await pingHealth()) return true;
      }
      return false;
    })().finally(() => {
      // dopo l'esito, un futuro errore può ritentare l'avvio
      setTimeout(() => (starting = null), 5000);
    });
  }
  return starting;
}

async function kreq<T>(
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 15000,
  retried = false,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const isForm = body instanceof FormData;
    const res = await fetch(`${BASE}${path}`, {
      method,
      signal: ctrl.signal,
      headers: {
        ...authHeaders(),
        ...(body !== undefined && !isForm ? { "Content-Type": "application/json" } : {}),
      },
      body:
        body === undefined
          ? undefined
          : isForm
            ? (body as FormData)
            : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 401 && multiUser) {
        sessionToken = "";
        expiredListeners.forEach((fn) => fn());
      }
      throw new BridgeError(
        res.status,
        (data as any)?.error ?? `HTTP ${res.status}`,
        data as Record<string, any>, // i 409 portano l'anteprima della modifica
      );
    }
    return data as T;
  } catch (e) {
    const connectionRefused = e instanceof TypeError; // "Failed to fetch": connessione mai stabilita
    if (
      connectionRefused &&
      multiUser &&
      (await getKnowledgeSession().catch(() => null))?.reachable
    ) {
      // wikibridge risponde al backend ma non alla webview: in multi-utente
      // accetta solo le origini elencate in cors_origins
      throw new BridgeError(
        0,
        `wikibridge rifiuta le richieste della GUI: aggiungi "${window.location.origin}" a cors_origins nella sua configurazione`,
      );
    }
    const timedOut = e instanceof DOMException && e.name === "AbortError";
    const idempotent = method === "GET" || method === "HEAD";
    // Ritenta UNA volta solo quando e' sicuro non duplicare l'effetto:
    //  - connessione rifiutata: la richiesta non e' mai partita -> safe anche
    //    per i POST, dopo aver avviato il server on-demand;
    //  - timeout: SOLO metodi idempotenti. Un POST /imports|/ingest|/projects
    //    potrebbe essere gia' stato ricevuto ed eseguito: ritentarlo creerebbe
    //    un job/progetto duplicato.
    const canRetry =
      !retried && (connectionRefused || (timedOut && idempotent));
    if (canRetry && (await ensureKnowledgeServer())) {
      return kreq<T>(method, path, body, timeoutMs, true);
    }
    if (connectionRefused || timedOut) {
      throw new BridgeError(
        0,
        `wikibridge non risponde (${path}) — avvio automatico fallito: controlla C:\\Projects\\wikibridge`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// --- tipi -------------------------------------------------------------------

export interface KnowledgeProject {
  slug: string;
  name: string;
  description: string;
  created: string;
  active: boolean;
}

export interface KnowledgeJob {
  running: boolean;
  kind?: string;
  phase?: string;
  pages?: number;
  max_pages?: number;
  detail?: string;
  error?: string | null;
  result?: unknown;
}

export interface ImportRecord {
  id: string;
  url: string;
  adapter: string;
  scope: string;
  depth: number;
  auth_profile: string | null;
  state: string;
  truncated: boolean;
  pages: number;
  skipped: number;
  errors: string[];
  started: string;
  finished: string | null;
  last_sync?: string;
}

export interface WikiTreeEntry {
  file: string;
  title: string;
  updated: string;
}

export type WikiTree = Record<string, WikiTreeEntry[]>;

export interface SearchHit {
  path: string;
  section: string;
  title: string;
  snippet: string;
}

export interface AuthProfile {
  name: string;
  type: string;
}

export interface SkillRuntimeStatus {
  runtime: string;
  status: string; // ok | installed | skipped | error | not_installed
  detail: string;
}

// --- API --------------------------------------------------------------------

export const knowledgeHealth = () =>
  kreq<{ ok: boolean; active_project: string; job: KnowledgeJob }>(
    "GET",
    "/health",
    undefined,
    3000,
  );

export const getKnowledgeProjects = () =>
  kreq<KnowledgeProject[]>("GET", "/projects");

/** Lista progetti SENZA avviare il server — restituisce [] se è giù.
 *  Usata dalle sezioni che mostrano il dropdown progetto come opzione
 *  accessoria (Sessione, Riunioni): non devono avviare wikibridge solo
 *  perché l'utente ha aperto la GUI. */
export async function getProjectsIfRunning(): Promise<KnowledgeProject[]> {
  if (!(await pingHealth())) return [];
  return getKnowledgeProjects();
}
export const createKnowledgeProject = (name: string, description = "") =>
  kreq<KnowledgeProject>("POST", "/projects", { name, description });
export const activateKnowledgeProject = (slug: string) =>
  kreq("POST", `/projects/${slug}/activate`, {});
export const deleteKnowledgeProject = (slug: string) =>
  kreq("DELETE", `/projects/${slug}`);

export const startImport = (body: {
  project: string;
  url: string;
  depth?: number;
  scope?: string;
  adapter?: string;
  auth_profile?: string | null;
  max_pages?: number;
  no_catalog?: boolean;
}) => kreq<{ started: boolean }>("POST", "/imports", body, 30000);

export const getImports = (project: string) =>
  kreq<{ project: string; job: KnowledgeJob; imports: ImportRecord[] }>(
    "GET",
    `/imports?project=${encodeURIComponent(project)}`,
  );
export const cancelImport = (project: string, id: string) =>
  kreq("POST", `/imports/${id}/cancel?project=${encodeURIComponent(project)}`, {});
export const syncImport = (project: string, id: string) =>
  kreq("POST", `/imports/${id}/sync?project=${encodeURIComponent(project)}`, {});

export const ingestFile = (project: string, file: File) => {
  const fd = new FormData();
  fd.append("project", project);
  fd.append("file", file, file.name);
  return kreq<{ started: boolean }>("POST", "/ingest", fd, 120000);
};
export const ingestDir = (project: string, path: string, recursive = true) =>
  kreq<{ started: boolean }>("POST", "/ingest/dir", { project, path, recursive }, 30000);

export const getWikiTree = (project: string) =>
  kreq<{ project: string; tree: WikiTree }>(
    "GET",
    `/wiki/tree?project=${encodeURIComponent(project)}`,
  );
export const getWikiPage = (project: string, path: string) =>
  kreq<{ path: string; frontmatter: Record<string, unknown>; body: string }>(
    "GET",
    `/wiki/page?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`,
  );
export const refreshWikiPage = (project: string, path: string) =>
  kreq<{ path: string; changed: boolean }>(
    "POST",
    "/wiki/refresh",
    { project, path },
    120000,
  );

export const searchKnowledge = (project: string, q: string) =>
  kreq<{ project: string; hits: SearchHit[] }>(
    "GET",
    `/search?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`,
  );

export const getKnowledgeGraph = (project: string) =>
  kreq<{ nodes: number; edges: number; html_path: string }>(
    "GET",
    `/graph?project=${encodeURIComponent(project)}`,
    undefined,
    60000,
  );

export const drainCatalog = (project: string) =>
  kreq<{ done: number; failed: string[] }>(
    "POST",
    `/catalog/drain?project=${encodeURIComponent(project)}`,
    {},
    600000,
  );

export const getSkillStatus = () =>
  kreq<{ ok: boolean; results?: SkillRuntimeStatus[]; error?: string }>(
    "GET",
    "/skill/status",
    undefined,
    120000,
  );
export const installSkill = () =>
  kreq<{ ok: boolean; results?: SkillRuntimeStatus[]; error?: string }>(
    "POST",
    "/skill/install",
    {},
    600000,
  );

// --- permessi (ACL): solo admin, wikibridge multi-utente --------------------

export type AclLevel = "public" | "internal" | "confidential" | "restricted";

export interface AclCollection {
  principals: string[];
  classification: AclLevel;
  sources: string[];
}

export interface AclPageInfo {
  path: string;
  source: string | null;
  acl_roles: string[];
  acl_source_clauses: string[][];
  acl_classification: AclLevel | null;
  collection: string | null;
}

export interface AclInfo {
  project: string;
  acl_enforcement: boolean;
  policy_version: number;
  gate: string[];
  collections: Record<string, AclCollection>;
  labels: Record<string, string>;
  levels: AclLevel[];
  known_roles: string[];
  page?: AclPageInfo;
}

/** Anteprima di una modifica: chi guadagna o perde accesso. Il server la
 *  restituisce con 409 quando la modifica allarga l'accesso. */
export interface AclPreview {
  widening: boolean;
  added_principals?: string[];
  removed_principals?: string[];
  removed_sources?: string[];
  classification?: [string | null, string];
  acl_enforcement?: [boolean, boolean];
  documents_affected: number;
  /** nomi leggibili delle persone indicate (anche quelle non ancora salvate) */
  labels?: Record<string, string>;
}

export interface KnowledgeSource {
  kind: string;
  id: string;
  target: string | string[];
  pages?: number;
  files?: number;
}

/** Principal già assegnati (ruoli e "user:<id>") + username nuovi. */
export interface PrincipalsInput {
  principals: string[];
  users: string[];
}

const q = (project: string) => `project=${encodeURIComponent(project)}`;

export const getAcl = (project: string, path?: string) =>
  kreq<AclInfo>(
    "GET",
    `/acl?${q(project)}${path ? `&path=${encodeURIComponent(path)}` : ""}`,
  );
export const getKnowledgeSources = (project: string) =>
  kreq<{ project: string; sources: KnowledgeSource[] }>("GET", `/sources?${q(project)}`);

export const setAclGate = (project: string, who: PrincipalsInput, confirm = false) =>
  kreq<{ gate: string[] }>("PUT", `/acl/gate?${q(project)}`, { ...who, confirm });
export const setAclCollection = (
  project: string,
  id: string,
  body: PrincipalsInput & { classification: AclLevel; sources: string[] },
  confirm = false,
) =>
  kreq<AclCollection>("PUT", `/acl/collections/${encodeURIComponent(id)}?${q(project)}`, {
    ...body,
    confirm,
  });
export const deleteAclCollection = (project: string, id: string, confirm = false) =>
  kreq("DELETE", `/acl/collections/${encodeURIComponent(id)}?${q(project)}`, { confirm });
export const setAclPage = (
  project: string,
  path: string,
  body: PrincipalsInput & { classification: AclLevel },
  confirm = false,
) => kreq("PUT", `/acl/page?${q(project)}`, { path, ...body, confirm });
export const setAclEnforcement = (project: string, enabled: boolean, confirm = false) =>
  kreq<{ acl_enforcement: boolean }>(
    "POST",
    `/projects/${encodeURIComponent(project)}/acl`,
    { enabled, confirm },
  );

export const getAuthProfiles = () =>
  kreq<AuthProfile[]>("GET", "/auth/profiles");
export const saveAuthProfile = (
  name: string,
  profile: Record<string, string>,
) => kreq("POST", "/auth/profiles", { name, ...profile });
export const deleteAuthProfile = (name: string) =>
  kreq("DELETE", `/auth/profiles/${encodeURIComponent(name)}`);
