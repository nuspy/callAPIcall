// Definizioni dei 5 test guidati. Ogni passo "auto" usa la diagnostica del
// control server (/diag/*) o gli endpoint reali; i passi "confirm" chiedono
// all'utente l'esito percepibile (audio sentito, suggerimenti visti...).

import {
  BridgeError,
  copilotToggle,
  diagAcp,
  diagVoiceEngine,
  diagLoopback,
  diagMic,
  getAvatarState,
  getCopilotState,
  getHealth,
  getSessionState,
  getStatus,
  getTransport,
  hangup,
  placeCall,
  prepare,
  sessionStart,
  sessionStop,
} from "@/lib/api/bridgeApi";
import type { TestContext, TestDefinition, TestStepResult } from "./types";

const ok = (detail?: string): TestStepResult => ({ ok: true, detail });
const fail = (detail: string): TestStepResult => ({ ok: false, detail });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- passi riusati ------------------------------------------------------------

const stepBridge = {
  id: "bridge",
  title: "Control server raggiungibile",
  description: "Verifica che il backend call-bridge risponda su :8770.",
  kind: "auto" as const,
  run: async () => {
    await getHealth();
    return ok();
  },
};

const stepVoiceEngine = {
  id: "voice-engine",
  title: "Motori voce attivi",
  description: "Verifica che i motori STT/TTS rispondano su :8720.",
  kind: "auto" as const,
  run: async () => {
    const r = await diagVoiceEngine();
    return r.ok ? ok() : fail(r.error ?? "i motori voce non rispondono");
  },
};

const stepModels = {
  id: "models",
  title: "Modelli caricati",
  description: "Chiede al bridge di caricare i modelli STT e TTS in VRAM.",
  kind: "auto" as const,
  simModels: ["whisper_large", "chatterbox"],
  run: async (ctx: TestContext) => {
    ctx.log("Caricamento modelli (può richiedere decine di secondi)...");
    await prepare(true);
    return ok("modelli pronti");
  },
};

const stepMic = {
  id: "mic",
  title: "Microfono",
  description: "PARLA ORA per ~2 secondi: misuriamo il livello del microfono.",
  kind: "auto" as const,
  run: async (ctx: TestContext) => {
    const r = await diagMic(undefined, 2);
    if (!r.ok) return fail(r.error ?? "registrazione fallita");
    ctx.log(`Mic "${r.device_name ?? "?"}": rms=${r.rms} picco=${r.peak}`);
    return (r.rms ?? 0) > 0.003
      ? ok(`livello ok (rms ${r.rms})`)
      : fail(`livello troppo basso (rms ${r.rms}): mic giusto? muto?`);
  },
};

function stepSessionStart(mode: "half" | "full") {
  return {
    id: "session-start",
    title: `Avvio sessione ${mode === "half" ? "half-duplex" : "full-duplex"}`,
    description: "Avvia la sessione voce come la hotkey.",
    kind: "auto" as const,
    run: async (): Promise<TestStepResult> => {
      try {
        await sessionStart(mode);
        return ok();
      } catch (e) {
        if (e instanceof BridgeError && e.status === 409) {
          return fail("una sessione è già attiva: chiudila e rilancia il test");
        }
        throw e;
      }
    },
  };
}

const stepPhases = {
  id: "phases",
  title: "Ciclo di conversazione",
  description:
    "FAI UNA DOMANDA all'agente (es. \"che ore sono?\"): controlliamo che lo stato passi per ascolto → ragionamento → risposta.",
  kind: "auto" as const,
  simModels: ["whisper_large", "chatterbox"],
  run: async (ctx: TestContext) => {
    const seen = new Set<string>();
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const s = await getSessionState();
      if (!s.active) return fail("la sessione si è chiusa da sola");
      if (!seen.has(s.phase)) {
        seen.add(s.phase);
        ctx.log(`fase: ${s.phase}`);
      }
      if (seen.has("reasoning") && seen.has("speaking")) {
        return ok("ciclo completo: ascolto → ragionamento → risposta");
      }
      await sleep(400);
    }
    return fail(
      `timeout: fasi viste ${[...seen].join(", ") || "nessuna"} — l'agente non ha risposto entro 2 minuti`,
    );
  },
};

const stepSessionStop = {
  id: "session-stop",
  title: "Chiusura sessione",
  description: "Chiude la sessione voce.",
  kind: "auto" as const,
  run: async () => {
    await sessionStop();
    return ok();
  },
};

// --- definizioni ----------------------------------------------------------------

export const halfDuplexTest: TestDefinition = {
  id: "half-duplex",
  title: "Half-duplex (casse)",
  description:
    "Conversazione con l'agente in modalità Shift+F1: mic muto mentre l'agente parla.",
  steps: [
    stepBridge,
    stepVoiceEngine,
    stepModels,
    stepMic,
    stepSessionStart("half"),
    stepPhases,
    {
      id: "heard",
      title: "Risposta udibile",
      description: "Conferma di aver sentito la risposta.",
      kind: "confirm",
      confirmPrompt: "Hai sentito la risposta dell'agente dalle casse?",
    },
    stepSessionStop,
  ],
};

export const fullDuplexTest: TestDefinition = {
  id: "full-duplex",
  title: "Full-duplex (cuffie)",
  description:
    "Conversazione Shift+F2 con barge-in: puoi interrompere l'agente mentre parla. Usa le CUFFIE.",
  steps: [
    stepBridge,
    stepVoiceEngine,
    stepModels,
    stepMic,
    stepSessionStart("full"),
    stepPhases,
    {
      id: "barge-in",
      title: "Barge-in",
      description:
        "Fai un'altra domanda lunga e INTERROMPI l'agente parlando mentre risponde.",
      kind: "confirm",
      confirmPrompt:
        "L'agente si è interrotto quando hai iniziato a parlare sopra la sua risposta?",
    },
    stepSessionStop,
  ],
};

export const acpTaskTest: TestDefinition = {
  id: "acp-task",
  title: "Task con l'agente (ACP)",
  description:
    "Verifica che l'agente completo (con strumenti) sia attivo e sappia eseguire un compito.",
  steps: [
    stepBridge,
    {
      id: "acp",
      title: "Agente ACP pronto",
      description: "Verifica WSL e lo stato dell'agente Hermes.",
      kind: "auto",
      run: async (ctx) => {
        const r = await diagAcp();
        ctx.log(`WSL: ${r.wsl_ok ? "ok" : "KO"} — agente: ${r.agent_ready ? "pronto" : "non avviato"}`);
        if (!r.wsl_ok) return fail("la distro WSL non risponde");
        if (!r.agent_ready) {
          return fail(r.note ?? "agente non avviato: attendi il warm-up e riprova");
        }
        return ok();
      },
    },
    stepModels,
    stepSessionStart("half"),
    {
      id: "task",
      title: "Esecuzione task",
      description:
        "CHIEDI A VOCE un compito che richiede strumenti (es. \"cerca il meteo di domani a Milano\").",
      kind: "confirm",
      confirmPrompt:
        "L'agente ha eseguito il compito (usando i suoi strumenti) e risposto sensatamente?",
    },
    stepSessionStop,
  ],
};

export const phoneCallTest: TestDefinition = {
  id: "phone-call",
  title: "Telefonata esterna",
  description:
    "Chiamata reale con l'agente al telefono, sul trasporto disponibile (GSM o Android). Usa un TUO numero come destinatario.",
  needsInput: {
    key: "number",
    label: "Numero da chiamare per il test",
    placeholder: "+39333xxxxxxx (un tuo telefono)",
  },
  steps: [
    stepBridge,
    {
      id: "transport",
      title: "Trasporto chiamate",
      description: "Ri-rileva GSM (modem) e Android (HFP).",
      kind: "auto",
      run: async (ctx) => {
        const t = await getTransport(true);
        ctx.log(`trasporto: ${t.selected ?? "nessuno"} (modalità ${t.mode})`);
        return t.selected
          ? ok(`selezionato: ${t.selected}`)
          : fail("nessun trasporto disponibile: modem spento e telefono non connesso");
      },
    },
    stepVoiceEngine,
    stepModels,
    {
      id: "dial",
      title: "Chiamata in uscita",
      description: "Compone il numero indicato.",
      kind: "auto",
      run: async (ctx) => {
        const number = ctx.input.number?.trim();
        if (!number) return fail("numero mancante");
        await placeCall({ number });
        ctx.log(`chiamata avviata verso ${number}`);
        return ok();
      },
    },
    {
      id: "active",
      title: "Chiamata attiva",
      description: "Attende che il telefono risulti in chiamata (max 45s). RISPONDI al telefono.",
      kind: "auto",
      run: async (ctx) => {
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          const s = await getStatus().catch(() => null);
          const state = s?.phone?.state;
          if (state === "OFFHOOK") return ok("chiamata in corso");
          if (state === "RINGING") ctx.log("squilla...");
          await sleep(1500);
        }
        return fail("la chiamata non è risultata attiva entro 45s");
      },
    },
    {
      id: "audio",
      title: "Audio della chiamata",
      description: "Parla al telefono e ascolta l'agente.",
      kind: "confirm",
      confirmPrompt:
        "Hai sentito l'agente al telefono e l'agente ha capito quello che hai detto?",
    },
    {
      id: "hangup",
      title: "Riaggancio",
      description: "Chiude la chiamata.",
      kind: "auto",
      run: async () => {
        await hangup();
        return ok();
      },
    },
  ],
};

export const copilotTest: TestDefinition = {
  id: "copilot",
  title: "Videocall copilot",
  description:
    "Il copilota ascolta l'interlocutore (audio in uscita del PC) e suggerisce risposte; con un'identità attiva parla tramite l'avatar.",
  steps: [
    stepBridge,
    {
      id: "loopback",
      title: "Cattura loopback",
      description: "Verifica il dispositivo di loopback (audio in uscita del PC).",
      kind: "auto",
      run: async (ctx) => {
        const r = await diagLoopback();
        if (!r.ok) return fail(r.error ?? "loopback non disponibile");
        ctx.log(`loopback su "${r.device_name}" (rms ${r.rms})`);
        return ok(`dispositivo: ${r.device_name}`);
      },
    },
    stepVoiceEngine,
    {
      id: "toggle-on",
      title: "Attivazione copilota",
      description: "Apre la finestra del copilota (come Shift+F4).",
      kind: "auto",
      run: async () => {
        const state = await getCopilotState();
        if (!state.enabled) return fail("copilota disabilitato nella config");
        if (!state.active) await copilotToggle();
        return ok();
      },
    },
    {
      id: "suggestions",
      title: "Suggerimenti",
      description:
        "RIPRODUCI un audio/video con una voce che parla (es. un video su YouTube): è il finto interlocutore.",
      kind: "confirm",
      confirmPrompt:
        "Nella finestra del copilota sono comparsi contesto e risposte suggerite?",
    },
    {
      id: "avatar",
      title: "Avatar (opzionale)",
      description: "Controlla se un'identità è attiva sull'avatar.",
      kind: "auto",
      run: async (ctx) => {
        const a = await getAvatarState();
        ctx.log(
          a.running
            ? `avatar attivo con identità "${a.persona}"`
            : "nessun avatar attivo (ok: passo facoltativo)",
        );
        return ok(a.running ? `identità ${a.persona}` : "nessun avatar (facoltativo)");
      },
    },
    {
      id: "toggle-off",
      title: "Disattivazione copilota",
      description: "Chiude la finestra del copilota.",
      kind: "auto",
      run: async () => {
        const state = await getCopilotState();
        if (state.active) await copilotToggle();
        return ok();
      },
    },
  ],
};

export const ALL_TESTS: TestDefinition[] = [
  halfDuplexTest,
  fullDuplexTest,
  acpTaskTest,
  phoneCallTest,
  copilotTest,
];
