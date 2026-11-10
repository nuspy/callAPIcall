import { create } from "zustand";

export type Role = "user" | "assistant";

export interface Media {
  // "file" e' tutto il resto: PDF, documenti, archivi. Non si prova a
  // mostrarlo — si mostra una scheda con il nome e lo si salva.
  kind: "image" | "video" | "file";
  url: string;
  name?: string;   // nome originale, quando si sa (allegati e file ricevuti)
}

export interface Message {
  id: string;
  role: Role;
  text: string;
  pending?: boolean; // risposta in streaming non ancora completa
  media?: Media;     // immagine/video allegati
}

export type Phase = "idle" | "listening" | "reasoning" | "speaking";

interface ChatState {
  messages: Message[];
  phase: Phase;
  connected: boolean;
  setPhase: (p: Phase) => void;
  /** Trascrizione in attesa di correzione ("" = nessuna). La riempie il
   *  controller in modalità "detta e correggi", la consuma la barra di testo. */
  draft: string;
  setDraft: (t: string) => void;
  /** Cosa sta facendo il video dell'avatar ("" = spento/inattivo). Serve a
   *  distinguere una preparazione lunga da un guasto: senza, davanti a un
   *  riquadro nero si crede che non funzioni. */
  videoState: string;
  setVideoState: (t: string) => void;
  /** Se la conversazione audio è in corso (duplex attivo, oppure turno in
   *  registrazione in viva voce). Lo tiene aggiornato il controller, che è
   *  l'unico a sapere di entrambe le modalità. Da questo dipende se il video
   *  dell'avatar viene davvero trasmesso o se si mostra la sola posa fissa. */
  audioActive: boolean;
  setAudioActive: (a: boolean) => void;
  setConnected: (c: boolean) => void;
  addUser: (text: string) => void;
  addMedia: (role: Role, media: Media) => void;
  startAssistant: () => string; // ritorna l'id del messaggio in streaming
  appendAssistant: (id: string, chunk: string) => void;
  /** Sostituisce il testo dell'assistente: serve quando la risposta viene
   *  riscritta a meta' e cio' che si vede non verra' mai pronunciato. */
  setAssistant: (id: string, text: string) => void;
  finishAssistant: (id: string) => void;
  clear: () => void;
}

let counter = 0;
const newId = () => `m${Date.now()}_${counter++}`;

export const useChat = create<ChatState>((set) => ({
  messages: [],
  phase: "idle",
  connected: false,
  setPhase: (p) => set({ phase: p }),
  draft: "",
  setDraft: (t) => set({ draft: t }),
  videoState: "",
  setVideoState: (t) => set({ videoState: t }),
  audioActive: false,
  setAudioActive: (a) => set({ audioActive: a }),
  setConnected: (c) => set({ connected: c }),
  addUser: (text) =>
    set((s) => ({ messages: [...s.messages, { id: newId(), role: "user", text }] })),
  addMedia: (role, media) =>
    set((s) => ({ messages: [...s.messages, { id: newId(), role, text: "", media }] })),
  startAssistant: () => {
    const id = newId();
    set((s) => ({ messages: [...s.messages, { id, role: "assistant", text: "", pending: true }] }));
    return id;
  },
  appendAssistant: (id, chunk) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text: m.text + chunk } : m)),
    })),
  setAssistant: (id, text) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, text } : m)),
    })),
  finishAssistant: (id) =>
    set((s) => ({
      messages: s.messages.map((m) => (m.id === id ? { ...m, pending: false } : m)),
    })),
  clear: () => set({ messages: [] }),
}));
