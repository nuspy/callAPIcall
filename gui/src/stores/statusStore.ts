// Store dello stato live: polla il control server con backoff quando e' giu'.
// - sessione voce: 500 ms (la pill di fase deve essere reattiva)
// - componenti:    5 s   (health di handy/hermes/gateway/avatar)
// Quando il control server non risponde, lo stato diventa "unreachable" e la
// GUI offre l'avvio via supervisore (comandi Tauri, vedi bridgeApi fallback).

import { create } from "zustand";
import {
  type ComponentsStatus,
  type SessionState,
  getComponentsStatus,
  getCopilotState,
  getSessionState,
} from "@/lib/api/bridgeApi";

interface StatusStore {
  bridgeReachable: boolean;
  session: SessionState | null;
  copilot: { enabled: boolean; active: boolean } | null;
  components: ComponentsStatus | null;
  lastError: string | null;
  startPolling: () => void;
  stopPolling: () => void;
  refreshComponents: () => Promise<void>;
}

let sessionTimer: ReturnType<typeof setInterval> | null = null;
let componentsTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
let sessionInFlight = false;

export const useStatusStore = create<StatusStore>((set, get) => ({
  bridgeReachable: false,
  session: null,
  copilot: null,
  components: null,
  lastError: null,

  startPolling: () => {
    if (sessionTimer) return; // gia' attivo
    const pollSession = async () => {
      // Backoff: se il bridge e' giu' non martelliamo ogni 500ms.
      if (consecutiveFailures > 3 && Date.now() % 5000 > 600) return;
      // Anti-overlap: con backend lento (due await, timeout fino a 4s) i tick a
      // 500ms si accavallerebbero e una risposta vecchia potrebbe sovrascrivere
      // una piu' nuova (fase di sessione che "torna indietro").
      if (sessionInFlight) return;
      sessionInFlight = true;
      try {
        const session = await getSessionState();
        const copilot = await getCopilotState().catch(() => null);
        consecutiveFailures = 0;
        set({ bridgeReachable: true, session, copilot, lastError: null });
      } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures > 2) {
          set({
            bridgeReachable: false,
            session: null,
            lastError: e instanceof Error ? e.message : String(e),
          });
        }
      } finally {
        sessionInFlight = false;
      }
    };
    const pollComponents = () => get().refreshComponents();
    sessionTimer = setInterval(pollSession, 500);
    componentsTimer = setInterval(pollComponents, 5000);
    pollSession();
    pollComponents();
  },

  stopPolling: () => {
    if (sessionTimer) clearInterval(sessionTimer);
    if (componentsTimer) clearInterval(componentsTimer);
    sessionTimer = null;
    componentsTimer = null;
  },

  refreshComponents: async () => {
    try {
      const components = await getComponentsStatus();
      set({ components, bridgeReachable: true });
    } catch {
      set({ components: null });
    }
  },
}));
