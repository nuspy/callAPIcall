// Client del registro provider LLM (blueprint api_llm.py).
//
// Le credenziali NON tornano mai dal bridge: di una chiave si sa solo se c'è
// (`has_key`), e di un OAuth se è collegato e con quale account.

import { req } from "./bridgeApi";

export interface LlmProvider {
  id: string;
  type: string;
  name: string;
  /** Etichetta del TIPO (es. "Google Gemini"), non del singolo provider. */
  label: string;
  base_url: string;
  model: string;
  /** modello che VETTORIZZA (RAG): campo separato da `model`, che conversa */
  embed_model?: string;
  has_key: boolean;
  oauth_account: string;
  oauth_connected: boolean;
  local: boolean;
  /** "none" | "api_key" | "oauth" | "either" | "cli" */
  auth: string;
  note: string;
  /** false = provider "CLI ufficiale": secondi di latenza, non usabile per la
   *  conversazione vocale (misurato: Claude ~6s, Codex ~14s a risposta). */
  realtime?: boolean;
  /** comando del CLI, per i provider a sottoscrizione */
  command?: string;
}

export interface LlmType {
  type: string;
  label: string;
  auth: string;
  local: boolean;
  base_url: string;
  note: string;
  realtime?: boolean;
}

export interface LlmRegistry {
  providers: LlmProvider[];
  /** consumatore -> id provider (es. {chat: "lmstudio"}) */
  assignments: Record<string, string>;
  types: LlmType[];
  consumers: string[];
}

export interface LlmModel {
  id: string;
  label: string;
  /** solo provider locali: il modello è GIÀ in memoria */
  loaded?: boolean;
  size_bytes?: number;
  quant?: string;
  /** "llm" | "vlm" | "embeddings": distingue chi conversa da chi vettorizza */
  kind?: string;
}

export const getLlmRegistry = () =>
  req<LlmRegistry>("GET", "/llm/providers", undefined, 20000);

export const addLlmProvider = (p: Partial<LlmProvider> & { type: string }) =>
  req<LlmRegistry>("POST", "/llm/providers", p, 20000);

export const updateLlmProvider = (
  id: string,
  campi: Partial<Pick<LlmProvider, "name" | "base_url" | "model" | "embed_model">>
    & { api_key?: string },
) => req<LlmRegistry>("PUT", `/llm/providers/${encodeURIComponent(id)}`, campi, 20000);

export const removeLlmProvider = (id: string) =>
  req<LlmRegistry>("DELETE", `/llm/providers/${encodeURIComponent(id)}`, undefined, 20000);

/** `refresh` salta la cache di 5 minuti dei provider remoti. */
export const getLlmModels = (id: string, refresh = false) =>
  req<{ models: LlmModel[]; error?: string }>(
    "GET",
    `/llm/providers/${encodeURIComponent(id)}/models${refresh ? "?refresh=1" : ""}`,
    undefined,
    60000,
  );

export const testLlmProvider = (id: string) =>
  req<{ ok: boolean; models?: number; sample?: string[]; error?: string }>(
    "POST", `/llm/providers/${encodeURIComponent(id)}/test`, {}, 60000);

export const assignLlmProvider = (consumer: string, provider: string | null) =>
  req<LlmRegistry>("POST", "/llm/assign", { consumer, provider }, 20000);
