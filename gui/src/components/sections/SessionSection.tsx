import React, { useEffect, useState } from "react";
import { BookOpen, Brain, Clapperboard, Headphones, MessageSquareText, Mic, Phone, RotateCcw, Settings2, Square, Volume2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { Select } from "../ui/Select";
import { VirtualCamPreview } from "../VirtualCamPreview";
import { useStatusStore } from "@/stores/statusStore";
import {
  BridgeError,
  type CopilotSaveState,
  type HermesModels,
  type Persona,
  type SwapConfirm,
  copilotSaveMeeting,
  copilotToggle,
  getConfig,
  getCopilotState,
  getHermesModels,
  getPersonas,
  putConfig,
  sessionNew,
  sessionStart,
  sessionStop,
  setCopilotProject,
  setHermesModel,
} from "@/lib/api/bridgeApi";
import {
  type KnowledgeProject,
  getProjectsIfRunning,
} from "@/lib/api/knowledgeApi";

const PHASE_CLASS: Record<string, string> = {
  idle: "bg-mid-gray/20 text-text/60",
  listening: "bg-blue-500/20 text-blue-400",
  reasoning: "bg-amber-500/20 text-amber-400",
  speaking: "bg-violet-500/20 text-violet-400",
};

export const SessionSection: React.FC = () => {
  const { t } = useTranslation();
  const session = useStatusStore((s) => s.session);
  const copilot = useStatusStore((s) => s.copilot);
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [copilotProject, setCopilotProjectState] = useState("");
  const [saveState, setSaveState] = useState<CopilotSaveState>({ state: "idle" });
  // Avatar video (Ctrl+Shift+F1/F2): abilitato in config (avatar_enabled) e
  // persona da `avatar_persona` (condivisa col copilota). Il toggle sceglie se
  // avviare la sessione con avatar.
  const [avatarEnabled, setAvatarEnabled] = useState(false);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [avatarPersona, setAvatarPersona] = useState("");
  const [useAvatar, setUseAvatar] = useState(false);
  // Checkbox "Chat Avatar reasoning": enable_thinking per-richiesta al backend vLLM.
  const [avatarReasoning, setAvatarReasoning] = useState(false);
  // Modello LLM di Hermes per la sessione (dropdown a rami per provider) + nota.
  const [hermes, setHermes] = useState<HermesModels | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [modelNote, setModelNote] = useState<string | null>(null);
  // Swap in attesa di conferma (409 `confirm_required`): cosa verrebbe
  // scaricato e cosa caricato. null = nessuna richiesta pendente.
  const [swapAsk, setSwapAsk] = useState<(SwapConfirm & { model: string }) | null>(null);
  // Messaggi di inizializzazione sessione (voce/avatar e chiamata): inviati una
  // volta all'agente a inizio sessione, non pronunciati dal TTS (config
  // voice_session_init / call_session_init).
  const [voiceInit, setVoiceInit] = useState("");
  const [callInit, setCallInit] = useState("");
  const [initDirty, setInitDirty] = useState(false);
  const [initSaved, setInitSaved] = useState(false);

  useEffect(() => {
    getProjectsIfRunning().then(setProjects).catch(() => setProjects([]));
    getCopilotState()
      .then((s) => {
        setCopilotProjectState(s.project_id || "");
        if (s.save_state) setSaveState(s.save_state);
      })
      .catch(() => {});
    getConfig()
      .then((c) => {
        const enabled = Boolean(c.config.avatar_enabled);
        setAvatarEnabled(enabled);
        setAvatarPersona(String(c.config.avatar_persona || ""));
        setUseAvatar(enabled && Boolean(c.config.avatar_persona));
        setAvatarReasoning(Boolean(c.config.avatar_chat_reasoning));
        setVoiceInit(String(c.config.voice_session_init || ""));
        setCallInit(String(c.config.call_session_init || ""));
      })
      .catch(() => {});
    getPersonas().then((p) => setPersonas(p.personas)).catch(() => {});
    getHermesModels().then(setHermes).catch(() => {});
  }, []);

  // Cambio del modello dell'agente. Il bridge risponde 409 `confirm_required`
  // quando in memoria c'è già un ALTRO modello: la VRAM ne tiene uno solo, e
  // scaricarlo è una decisione dell'utente, non un effetto collaterale della
  // scelta nel menu. Con `confirm` si procede allo scambio.
  const applyModel = (model: string, confirm = false) => {
    if (!model) return;
    const prov = hermes?.providers.find((p) => p.models.includes(model))?.provider;
    setModelBusy(true);
    setModelNote(null);
    setHermesModel(model, prov, confirm)
      .then((r) => {
        setSwapAsk(null);
        setModelNote(r.note ?? null);
        setHermes((h) => (h ? { ...h, current: { model, provider: prov ?? null } } : h));
        getHermesModels().then(setHermes).catch(() => {});
      })
      .catch((err) => {
        if (err instanceof BridgeError && err.data?.code === "confirm_required") {
          setSwapAsk({ ...(err.data as SwapConfirm), model });
          return;
        }
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setModelBusy(false));
  };

  // Persistenza della persona scelta su config.avatar_persona (via PUT /config).
  const changePersona = (name: string) => {
    setAvatarPersona(name);
    putConfig({ avatar_persona: name }).catch(() => {});
  };

  // Salva i messaggi di init sessione (campi "hot": applicati subito, la
  // prossima sessione li usa senza riavviare il bridge).
  const saveInit = () =>
    run(async () => {
      await putConfig({ voice_session_init: voiceInit, call_session_init: callInit });
      setInitDirty(false);
      setInitSaved(true);
      setTimeout(() => setInitSaved(false), 2500);
    });

  useEffect(() => {
    if (saveState.state !== "saving") return;
    const timer = setInterval(async () => {
      try {
        const s = await getCopilotState();
        if (s.save_state) setSaveState(s.save_state);
      } catch { /* retry */ }
    }, 3000);
    return () => clearInterval(timer);
  }, [saveState.state]);

  const active = session?.active ?? false;
  const phase = session?.phase ?? "idle";
  const phaseCls = PHASE_CLASS[phase] ?? PHASE_CLASS.idle;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof BridgeError && e.status === 409) {
        setError(t("session.sessionAlready"));
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("session.title")}</h1>
        <p className="text-sm text-text/60">{t("session.subtitle")}</p>
      </div>

      {!bridgeReachable && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {t("session.serverDown")}
        </div>
      )}

      <div className="rounded-lg border border-mid-gray/20 p-4 flex items-center gap-4">
        <span
          className={`px-3 py-1 rounded-full text-sm font-medium ${phaseCls} ${
            phase === "reasoning" || phase === "speaking" ? "animate-pulse" : ""
          }`}
        >
          {t(`session.phase.${phase}`)}
        </span>
        {active && (
          <span className="text-sm text-text/60">
            {session?.mode === "full"
              ? t("session.mode.full")
              : session?.mode === "limited"
                ? t("session.mode.limited")
                : t("session.mode.half")}
          </span>
        )}
        {active && (
          <Button
            variant="danger"
            size="sm"
            onClick={() => run(sessionStop)}
            disabled={busy}
            className="ms-auto"
          >
            <span className="flex items-center gap-1.5">
              <Square width={12} height={12} fill="currentColor" />
              {t("session.closeSession")}
            </span>
          </Button>
        )}
      </div>

      {/* Modello LLM di Hermes per la sessione (dropdown a rami) + nuova conversazione */}
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Brain width={16} height={16} className="text-logo-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              {t("session.llm.title", { defaultValue: "Modello LLM (Hermes)" })}
            </p>
            <p className="text-xs text-text/60">
              {t("session.llm.desc", {
                defaultValue: "Modello usato da Hermes in questa sessione. Cambiarlo riavvia l'agente (~1 min).",
              })}
            </p>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              run(async () => {
                await sessionNew();
                setModelNote(t("session.llm.newDone", { defaultValue: "Nuova conversazione avviata." }));
              })
            }
            disabled={!bridgeReachable}
          >
            <span className="flex items-center gap-1.5">
              <RotateCcw width={13} height={13} />
              {t("session.llm.new", { defaultValue: "Nuova sessione" })}
            </span>
          </Button>
        </div>
        {/* Override: a checkbox spenta callAPIcall non impone piu' il modello
            all'agente (niente -m/--provider, nessuna scrittura del suo
            config.yaml) e il dropdown diventa di sola lettura. */}
        <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
          <input
            type="checkbox"
            className="accent-logo-primary"
            checked={hermes?.override ?? true}
            disabled={!bridgeReachable || modelBusy || !hermes}
            onChange={(e) => {
              const on = e.target.checked;
              setModelBusy(true);
              setModelNote(null);
              putConfig({ acp_model_override: on })
                .then(() => {
                  setHermes((h) => (h ? { ...h, override: on } : h));
                  setModelNote(
                    on
                      ? t("session.llm.overrideOn", { defaultValue: "callAPIcall imposta il modello di Hermes." })
                      : t("session.llm.overrideOff", { defaultValue: "Il modello lo decide Hermes (config.yaml)." }),
                  );
                })
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                .finally(() => setModelBusy(false));
            }}
          />
          {t("session.llm.override", { defaultValue: "Override Hermes model" })}
        </label>
        <select
          className="w-full bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm disabled:opacity-50"
          value={hermes?.current?.model ?? ""}
          disabled={!bridgeReachable || modelBusy || !hermes || !(hermes?.override ?? true)}
          onChange={(e) => applyModel(e.target.value)}
        >
          {!hermes && <option>{t("session.llm.loading", { defaultValue: "carico modelli…" })}</option>}
          {hermes?.providers.map((p) => (
            <optgroup key={p.provider} label={p.provider}>
              {/* Etichetta con quantizzazione e peso: lo stesso modello esiste in
                  più quantizzazioni, e il solo nome non basta a distinguerle. */}
              {p.models.map((m) => {
                const info = p.models_info?.find((i) => i.id === m);
                return (
                  <option key={m} value={m}>
                    {info?.label ?? m}
                    {info?.loaded
                      ? ` ● ${t("session.llm.inMemory", { defaultValue: "in memoria" })}`
                      : ""}
                  </option>
                );
              })}
            </optgroup>
          ))}
        </select>
        {/* In VRAM ci sta un modello per volta: lo scarico di quello caldo non
            avviene mai da solo, va confermato qui (o rifiutato, e resta com'è). */}
        {swapAsk && (
          <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 space-y-2">
            <p className="text-xs text-text/80">{swapAsk.reason}</p>
            <p className="text-xs text-text/60">
              {t("session.llm.swapUnload", { defaultValue: "Da scaricare" })}:{" "}
              <span className="text-text/90">{swapAsk.loaded_label || swapAsk.loaded}</span>
              <br />
              {t("session.llm.swapLoad", { defaultValue: "Da caricare" })}:{" "}
              <span className="text-text/90">{swapAsk.target_label || swapAsk.model}</span>
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="min-h-[44px] px-3 rounded bg-logo-primary/80 hover:bg-logo-primary text-sm disabled:opacity-50"
                disabled={modelBusy}
                onClick={() => applyModel(swapAsk.model, true)}
              >
                {t("session.llm.swapConfirm", { defaultValue: "Scarica e carica" })}
              </button>
              <button
                type="button"
                className="min-h-[44px] px-3 rounded border border-mid-gray/40 text-sm"
                disabled={modelBusy}
                onClick={() => {
                  setSwapAsk(null);
                  setModelNote(
                    t("session.llm.swapKept", {
                      defaultValue: "Invariato: resta in memoria il modello di prima.",
                    }),
                  );
                }}
              >
                {t("session.llm.swapCancel", { defaultValue: "Lascia com'è" })}
              </button>
            </div>
          </div>
        )}
        {modelNote && <p className="text-xs text-amber-400">{modelNote}</p>}
      </div>

      {/* Messaggi di inizializzazione sessione (voce/avatar e chiamata) */}
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Settings2 width={16} height={16} className="text-logo-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">
              {t("session.init.title", { defaultValue: "Messaggio di setup sessione" })}
            </p>
            <p className="text-xs text-text/60">
              {t("session.init.desc", {
                defaultValue:
                  "Inviato all'agente a inizio sessione (una volta, NON pronunciato dal TTS): lo avvisa del contesto e delle skill da usare.",
              })}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-text/60 flex items-center gap-1.5">
            <Volume2 width={13} height={13} />
            {t("session.init.voice", { defaultValue: "Sessione vocale / avatar (Ctrl+Shift+F1/F2)" })}
          </label>
          <textarea
            className="w-full bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm font-mono resize-y min-h-[64px]"
            rows={3}
            value={voiceInit}
            disabled={!bridgeReachable}
            onChange={(e) => { setVoiceInit(e.target.value); setInitDirty(true); }}
            placeholder={t("session.init.voicePh", {
              defaultValue: "Es. Sei in modalità vocale con avatar e TTS: usa la skill voice-mode, risposte brevi e naturali. Rispondi solo: ok.",
            })}
          />
        </div>

        <div className="space-y-1">
          <label className="text-xs text-text/60 flex items-center gap-1.5">
            <Phone width={13} height={13} />
            {t("session.init.call", { defaultValue: "Chiamata telefonica" })}
          </label>
          <textarea
            className="w-full bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm font-mono resize-y min-h-[64px]"
            rows={3}
            value={callInit}
            disabled={!bridgeReachable}
            onChange={(e) => { setCallInit(e.target.value); setInitDirty(true); }}
            placeholder={t("session.init.callPh", {
              defaultValue: "Es. Sei al telefono: usa la skill phone-calls, frasi brevi. Rispondi solo: ok.",
            })}
          />
        </div>

        <div className="flex items-center gap-3">
          <Button variant="primary-soft" size="sm" onClick={saveInit} disabled={!bridgeReachable || !initDirty || busy}>
            {t("session.init.save", { defaultValue: "Salva messaggi" })}
          </Button>
          {initSaved && (
            <span className="text-xs text-green-500">
              {t("session.init.saved", { defaultValue: "Salvato (dalla prossima sessione)." })}
            </span>
          )}
        </div>
      </div>

      {avatarEnabled && !active && (
        <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={useAvatar}
              onChange={(e) => setUseAvatar(e.target.checked)}
              className="accent-logo-primary"
            />
            <Clapperboard width={18} height={18} className="text-logo-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">{t("session.avatar.title")}</p>
              <p className="text-xs text-text/60">{t("session.avatar.desc")}</p>
            </div>
          </label>
          {useAvatar && (
            <div className="flex items-center gap-2 border-t border-mid-gray/10 pt-3">
              <span className="text-xs text-text/60 shrink-0">
                {t("session.avatar.persona")}
              </span>
              <Select
                className="flex-1"
                value={avatarPersona}
                onChange={changePersona}
                placeholder={t("session.avatar.choosePersona")}
                options={personas.map((p) => ({
                  value: p.name,
                  label: p.voice?.voice ? `${p.name} — ${p.voice.voice}` : p.name,
                }))}
                disabled={!bridgeReachable}
              />
            </div>
          )}
          {useAvatar && !avatarPersona && (
            <p className="text-xs text-amber-400">{t("session.avatar.needPersona")}</p>
          )}
          <label className="flex items-center gap-3 cursor-pointer border-t border-mid-gray/10 pt-3">
            <input
              type="checkbox"
              checked={avatarReasoning}
              onChange={(e) => {
                setAvatarReasoning(e.target.checked);
                putConfig({ avatar_chat_reasoning: e.target.checked }).catch(() => {});
              }}
              className="accent-logo-primary"
            />
            <div className="flex-1">
              <p className="text-sm font-medium">
                {t("session.avatar.reasoning", { defaultValue: "Chat Avatar reasoning" })}
              </p>
              <p className="text-xs text-text/60">
                {t("session.avatar.reasoningDesc", {
                  defaultValue:
                    "Se attivo l'avatar ragiona prima di rispondere: più lento (misurato: 23s contro 1s su LM Studio), ma indovina i problemi a più passaggi. Se spento risponde diretto, a bassa latenza: su chiacchiera e domande di fatto la qualità è la stessa. Vale per Ctrl+Shift+F4/F5 (chat avatar), non per l'agente di Ctrl+Shift+F1/F2.",
                })}
              </p>
            </div>
          </label>
        </div>
      )}

      {!active && (
        <div className="grid grid-cols-2 gap-4">
          <button
            type="button"
            onClick={() => run(() => sessionStart("half", useAvatar))}
            disabled={busy || !bridgeReachable || (useAvatar && !avatarPersona)}
            className="rounded-lg border border-mid-gray/20 p-5 text-left hover:border-logo-primary transition-colors disabled:opacity-50 cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-1 font-medium">
              <Volume2 width={18} height={18} className="text-logo-primary" />
              {t("session.halfDuplex.title")}
            </div>
            <p className="text-xs text-text/60">{t("session.halfDuplex.desc")}</p>
          </button>
          <button
            type="button"
            onClick={() => run(() => sessionStart("full", useAvatar))}
            disabled={busy || !bridgeReachable || (useAvatar && !avatarPersona)}
            className="rounded-lg border border-mid-gray/20 p-5 text-left hover:border-logo-primary transition-colors disabled:opacity-50 cursor-pointer"
          >
            <div className="flex items-center gap-2 mb-1 font-medium">
              <Headphones width={18} height={18} className="text-logo-primary" />
              {t("session.fullDuplex.title")}
            </div>
            <p className="text-xs text-text/60">{t("session.fullDuplex.desc")}</p>
          </button>
        </div>
      )}

      {active && session?.avatar && (
        <div className="space-y-2">
          <p className="text-sm font-medium flex items-center gap-2">
            <Clapperboard width={15} height={15} className="text-logo-primary" />
            {t("session.avatar.previewTitle")}
          </p>
          <VirtualCamPreview active className="max-w-md" />
        </div>
      )}

      {busy && (
        <p className="text-sm text-text/50 flex items-center gap-2">
          <Mic width={14} height={14} className="animate-pulse" />
          {t("session.loading")}
        </p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-3">
          <MessageSquareText width={18} height={18} className="text-logo-primary" />
          <div className="flex-1">
            <p className="text-sm font-medium">{t("session.copilot.title")}</p>
            <p className="text-xs text-text/60">{t("session.copilot.desc")}</p>
          </div>
          <span
            className={`text-xs px-2 py-0.5 rounded-full ${
              copilot?.active
                ? "bg-green-500/20 text-green-400"
                : "bg-mid-gray/20 text-text/60"
            }`}
          >
            {copilot?.active ? t("session.copilot.active") : t("session.copilot.inactive")}
          </span>
          <Button
            variant={copilot?.active ? "secondary" : "primary-soft"}
            size="sm"
            onClick={() => run(copilotToggle)}
            disabled={busy || !bridgeReachable || !(copilot?.enabled ?? false)}
          >
            {copilot?.active ? t("session.copilot.disable") : t("session.copilot.enable")}
          </Button>
        </div>

        <div className="flex items-center gap-2 border-t border-mid-gray/10 pt-3">
          <BookOpen width={15} height={15} className="text-text/50 shrink-0" />
          <select
            className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1.5 text-sm"
            value={copilotProject}
            onChange={(e) => {
              setCopilotProjectState(e.target.value);
              setCopilotProject(e.target.value || null).catch(() => {});
            }}
            disabled={!bridgeReachable}
          >
            <option value="">{t("session.copilot.noProject")}</option>
            {projects.map((p) => (
              <option key={p.slug} value={p.slug}>
                {t("session.copilot.project", { name: p.name })}
              </option>
            ))}
          </select>
          <Button
            variant="secondary"
            size="sm"
            disabled={
              !bridgeReachable || !copilotProject || saveState.state === "saving"
            }
            onClick={() =>
              run(async () => {
                const r = await copilotSaveMeeting(copilotProject);
                setSaveState(r.save_state);
              })
            }
          >
            {saveState.state === "saving"
              ? t("session.copilot.saving")
              : t("session.copilot.saveMeeting")}
          </Button>
          {saveState.state === "done" && saveState.wiki_path && (
            <span className="text-xs text-green-500 truncate">
              {t("session.copilot.saved", { path: saveState.wiki_path })}
            </span>
          )}
          {saveState.state === "error" && (
            <span className="text-xs text-red-400 truncate">{saveState.error}</span>
          )}
        </div>
      </div>
    </div>
  );
};
