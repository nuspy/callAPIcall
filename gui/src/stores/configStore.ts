// Store della configurazione del backend (GET/PUT /config del control server).
// Tiene i valori correnti + le modifiche non salvate; al salvataggio mostra
// quali campi richiedono il riavvio del main.

import { create } from "zustand";
import { getConfig, putConfig } from "@/lib/api/bridgeApi";

interface ConfigStore {
  config: Record<string, unknown> | null;
  restartRequiredFields: string[];
  pending: Record<string, unknown>;
  saving: boolean;
  lastSave: { applied: string[]; requiresRestart: string[] } | null;
  error: string | null;
  load: () => Promise<void>;
  setPending: (key: string, value: unknown) => void;
  discardPending: () => void;
  save: () => Promise<void>;
}

export const useConfigStore = create<ConfigStore>((set, get) => ({
  config: null,
  restartRequiredFields: [],
  pending: {},
  saving: false,
  lastSave: null,
  error: null,

  load: async () => {
    try {
      const res = await getConfig();
      set({
        config: res.config,
        restartRequiredFields: res.restart_required_fields,
        pending: {},
        error: null,
      });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  setPending: (key, value) => {
    const { config, pending } = get();
    const next = { ...pending };
    if (config && config[key] === value) {
      delete next[key]; // tornato al valore originale
    } else {
      next[key] = value;
    }
    set({ pending: next });
  },

  discardPending: () => set({ pending: {} }),

  save: async () => {
    const { pending } = get();
    if (Object.keys(pending).length === 0) return;
    set({ saving: true, error: null });
    try {
      const res = await putConfig(pending);
      set({
        lastSave: { applied: res.applied, requiresRestart: res.requires_restart },
      });
      await get().load(); // ricarica i valori effettivi
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ saving: false });
    }
  },
}));
