import React, { useCallback, useEffect, useRef, useState } from "react";
import { BookText, Brain, Clapperboard, Cpu, FileText, Play, Save, Square, Trash2, Upload, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import Badge from "../ui/Badge";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import { useStatusStore } from "@/stores/statusStore";
import {
  type AvatarLlmModels,
  type AvatarProgress,
  type Persona,
  type PersonaIngestState,
  avatarStartAndWait,
  avatarStop,
  createPersona,
  deletePersona,
  deletePersonaClip,
  getAvatarLlmModels,
  getAvatarState,
  getConfig,
  getPersonaIngestState,
  getPersonas,
  ingestPersonaDoc,
  putConfig,
  swapAvatarLlmModel,
  updatePersona,
  uploadPersonaClip,
} from "@/lib/api/bridgeApi";
import {
  type KnowledgeProject,
  createKnowledgeProject,
  getProjectsIfRunning,
} from "@/lib/api/knowledgeApi";
import { type TtsModel, listTtsModels } from "@/lib/api/voiceEngineApi";
import { VoicePicker } from "../VoicePicker";
import { VirtualCamPreview } from "../VirtualCamPreview";
import { ProgressBar } from "../ui/ProgressBar";
import { TtsEngineSelect } from "../TtsEngineSelect";
import { PREP_PHASE_LABEL, TtsStudioDialog, formatEta } from "../TtsStudioDialog";
import { PersonaMemoryDialog } from "../PersonaMemoryDialog";

const NAME_RE = /^[a-zA-Z0-9_-]+$/;
// Formati documento accettati dall'ingest (allineati a persona_ingest.SUPPORTED_EXTS).
const DOC_ACCEPT = ".pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm";

/** Identità della persona per la modalità voce LM Studio (Ctrl+Shift+F4/F5). */
interface IdentityDraft {
  personality: string;
  system_prompt: string;
  knowledge_project: string;
}

/** Config della chat avatar (sottoinsieme editabile dalla GUI).
 *  `backend` sceglie quale LLM locale risponde: LM Studio o vLLM. I campi
 *  `model`/`vllm_model` sono il modello da CARICARE quando il backend non ne ha
 *  già uno in memoria (se ce l'ha, si usa quello). */
interface LmConfig {
  enabled: boolean;
  backend: "lmstudio" | "vllm";
  base_url: string;
  model: string;
  vllm_model: string;
  vllm_manager_url: string;
  embed_model: string;
  system_prompt: string;
  compaction: number;
}

export const PersonasSection: React.FC = () => {
  const { t } = useTranslation();
  const bridgeReachable = useStatusStore((s) => s.bridgeReachable);
  const [personas, setPersonas] = useState<Persona[]>([]);
  // Catalogo dei motori TTS con le loro voci: alimenta i VoicePicker
  // (motore -> voci di quel motore) di tutte le persone.
  const [catalogo, setCatalogo] = useState<TtsModel[]>([]);
  const [projects, setProjects] = useState<KnowledgeProject[]>([]);
  const [avatar, setAvatar] = useState<{ running: boolean; persona: string | null }>({
    running: false,
    persona: null,
  });
  const [newName, setNewName] = useState("");
  const [newVoice, setNewVoice] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [prep, setPrep] = useState<AvatarProgress | null>(null);
  // Editor identità (personalità/system prompt/progetto): una persona per volta.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<IdentityDraft>({
    personality: "", system_prompt: "", knowledge_project: "",
  });
  const [savingId, setSavingId] = useState(false);
  // Card config chat avatar (null finché non è caricata da GET /config).
  const [lm, setLm] = useState<LmConfig | null>(null);
  // Modelli disponibili/caricati per backend (GET /avatar/llm/models).
  const [llm, setLlm] = useState<AvatarLlmModels | null>(null);
  // Persona di cui è aperto il TTS Studio (null = dialogo chiuso).
  const [studioPersona, setStudioPersona] = useState<string | null>(null);
  // Persona di cui è aperta la memoria.
  const [memoryPersona, setMemoryPersona] = useState<string | null>(null);
  // Swap del modello della chat avatar: solo su richiesta esplicita (scarica
  // quello caldo e carica lo scelto). null = scelto e caldo coincidono.
  const [swapBusy, setSwapBusy] = useState(false);
  const [swapNote, setSwapNote] = useState<string | null>(null);
  const [lmDirty, setLmDirty] = useState(false);
  const [lmSaved, setLmSaved] = useState(false);
  const [lmRestart, setLmRestart] = useState(false);
  // Ingest documenti -> personalità/sapere (Fase 5): un job per volta, con polling.
  const [ingestPersona, setIngestPersona] = useState<string | null>(null);
  const [ingestState, setIngestState] = useState<PersonaIngestState | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const uploadTarget = useRef<string | null>(null);
  const docUploadRef = useRef<HTMLInputElement>(null);
  const docTarget = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (!bridgeReachable) return;
    try {
      const [p, a] = await Promise.all([getPersonas(), getAvatarState()]);
      setPersonas(p.personas);
      setAvatar(a);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    // Catalogo COMPLETO: clonate (Chatterbox/ZONOS2) + Kokoro intero +
    // voci di OGNI motore, dal catalogo del bridge (GET /tts/models).
    listTtsModels().then((m) => setCatalogo(m.models ?? [])).catch(() => {});
    // Progetti wikibridge per collegare la conoscenza della persona (dropdown).
    // NON avvia il server: [] se wikibridge è giù (collegabile poi dall'editor).
    getProjectsIfRunning().then(setProjects).catch(() => setProjects([]));
  }, [bridgeReachable]);

  useEffect(() => { refresh(); }, [refresh]);

  // Config LM Studio: caricata una volta (i campi hot valgono dalla prossima
  // sessione F4/F5; enabled e le hotkey richiedono il riavvio del bridge).
  useEffect(() => {
    if (!bridgeReachable) return;
    getConfig()
      .then((c) => setLm({
        enabled: Boolean(c.config.avatar_chat_enabled ?? c.config.lmstudio_enabled),
        // Campo vuoto = scelta storica implicita (vLLM se ha un modello).
        backend:
          String(c.config.avatar_llm_backend ?? "") === "vllm" ||
          (!String(c.config.avatar_llm_backend ?? "") &&
            String(c.config.vllm_model ?? "").trim() !== "")
            ? "vllm"
            : "lmstudio",
        base_url: String(c.config.lmstudio_base_url ?? ""),
        model: String(c.config.lmstudio_model ?? ""),
        vllm_model: String(c.config.vllm_model ?? ""),
        vllm_manager_url: String(c.config.vllm_manager_url ?? ""),
        embed_model: String(c.config.lmstudio_embed_model ?? ""),
        system_prompt: String(c.config.lmstudio_system_prompt ?? ""),
        compaction: Number(c.config.lmstudio_context_compaction_tokens ?? 6000),
      }))
      .catch(() => {});
  }, [bridgeReachable]);

  // Modelli selezionabili per la chat avatar. `include` va passato SOLO quando
  // l'utente sceglie LM Studio: interrogare la sua CLI lo ACCENDE, e chi usa
  // vLLM non deve ritrovarselo avviato solo per aver aperto questa tab.
  useEffect(() => {
    if (!bridgeReachable || !lm) return;
    getAvatarLlmModels(lm.backend === "lmstudio" ? "lmstudio" : "")
      .then(setLlm)
      .catch(() => setLlm(null));
  }, [bridgeReachable, lm?.backend]);

  // Polling del job di ingest finché non termina (done/error).
  useEffect(() => {
    if (!ingestPersona) return;
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const s = await getPersonaIngestState(ingestPersona);
        if (!alive) return;
        setIngestState(s);
        if (s.state === "done" || s.state === "error" || s.state === "idle") {
          clearInterval(timer);
          if (s.state === "done") refresh();
          else if (s.state === "error") setError(s.error ?? "ingest fallito");
          // Lascia l'esito visibile qualche secondo, poi pulisci.
          setTimeout(() => {
            if (alive) { setIngestPersona(null); setIngestState(null); }
          }, 5000);
        }
      } catch { /* transitorio: ritenta al giro successivo */ }
    }, 1500);
    return () => { alive = false; clearInterval(timer); };
  }, [ingestPersona, refresh]);

  const parseVoice = (v: string) => {
    const [engine, ...rest] = v.split(":");
    return { engine, voice: rest.join(":") };
  };

  const projectOptions = projects.map((pr) => ({ value: pr.slug, label: pr.name }));

  const create = async () => {
    if (!NAME_RE.test(newName)) { setError(t("personas.new.nameInvalid")); return; }
    const name = newName;
    setCreating(true); setError(null);
    try {
      await createPersona(name, newVoice ? parseVoice(newVoice) : {});
      setNewName(""); setNewVoice(""); await refresh();
      // Best-effort (in background, non blocca): crea un progetto conoscenza
      // wikibridge omonimo e collegalo. Se wikibridge non è installato o è giù
      // si salta in silenzio — la persona resta creata e il progetto si può
      // collegare/creare dopo dall'editor "Personalità".
      createKnowledgeProject(name)
        .then((proj) => updatePersona(name, { knowledge_project: proj.slug }))
        .then(refresh)
        .catch(() => {});
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setCreating(false); }
  };

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const onClipFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const persona = uploadTarget.current;
    if (!file || !persona) return;
    if (!file.name.toLowerCase().endsWith(".mp4")) { setError(t("personas.new.mpOnly")); return; }
    await run(`clip:${persona}`, () => uploadPersonaClip(persona, file));
  };

  const onDocFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    const persona = docTarget.current;
    if (!file || !persona) return;
    setError(null);
    try {
      await ingestPersonaDoc(persona, file);
      setIngestState({ state: "running", phase: "queued", percent: 0, detail: file.name });
      setIngestPersona(persona);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  // --- editor identità -------------------------------------------------------

  const openEditor = (p: Persona) => {
    setEditing(p.name);
    setDraft({
      personality: p.personality ?? "",
      system_prompt: p.system_prompt ?? "",
      knowledge_project: p.knowledge_project ?? "",
    });
  };

  const saveIdentity = async (name: string) => {
    setSavingId(true); setError(null);
    try {
      await updatePersona(name, {
        personality: draft.personality,
        system_prompt: draft.system_prompt,
        knowledge_project: draft.knowledge_project,
      });
      setEditing(null);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setSavingId(false); }
  };

  // Crea (e avvia on-demand wikibridge) un progetto omonimo e selezionalo nel
  // draft; l'utente salva poi l'editor per persistere il collegamento.
  const createProjectForDraft = async (name: string) => {
    setError(null);
    try {
      const proj = await createKnowledgeProject(name);
      setProjects(await getProjectsIfRunning().catch(() => projects));
      setDraft((d) => ({ ...d, knowledge_project: proj.slug }));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  // --- config LM Studio ------------------------------------------------------

  const setLmField = (patch: Partial<LmConfig>) => {
    setLm((prev) => (prev ? { ...prev, ...patch } : prev));
    setLmDirty(true); setLmSaved(false);
  };

  const saveLm = async () => {
    if (!lm) return;
    setError(null);
    try {
      const res = await putConfig({
        avatar_chat_enabled: lm.enabled,
        avatar_llm_backend: lm.backend,
        lmstudio_base_url: lm.base_url,
        lmstudio_model: lm.model,
        vllm_model: lm.vllm_model,
        vllm_manager_url: lm.vllm_manager_url,
        lmstudio_embed_model: lm.embed_model,
        lmstudio_system_prompt: lm.system_prompt,
        lmstudio_context_compaction_tokens: lm.compaction,
      });
      // Il backend può RIFIUTARE singoli campi (tipo errato, chiave sconosciuta
      // perché il bridge è più vecchio della GUI): senza questo controllo si
      // mostrava "salvato" mentre su disco non era finito nulla, e la scelta
      // sembrava persistere fino al riavvio successivo.
      const rifiutati = Object.entries(res.rejected ?? {});
      if (rifiutati.length > 0) {
        setError(
          t("personas.lmstudio.saveRejected", {
            defaultValue: "Non salvato: {{campi}}",
            campi: rifiutati.map(([k, v]) => `${k} (${v})`).join(", "),
          }),
        );
        setLmSaved(false);
      } else {
        setLmSaved(true);
        setTimeout(() => setLmSaved(false), 3000);
      }
      setLmRestart((res.requires_restart?.length ?? 0) > 0);
      // Rileggi cio' che e' DAVVERO sul bridge: la card deve mostrare lo stato
      // salvato, non quello che si sperava di salvare.
      const c = await getConfig();
      setLm((prev) => (prev ? {
        ...prev,
        enabled: Boolean(c.config.avatar_chat_enabled ?? prev.enabled),
        backend: (String(c.config.avatar_llm_backend ?? prev.backend) === "vllm"
          ? "vllm" : "lmstudio"),
        base_url: String(c.config.lmstudio_base_url ?? prev.base_url),
        model: String(c.config.lmstudio_model ?? prev.model),
        vllm_model: String(c.config.vllm_model ?? prev.vllm_model),
        vllm_manager_url: String(c.config.vllm_manager_url ?? prev.vllm_manager_url),
        embed_model: String(c.config.lmstudio_embed_model ?? prev.embed_model),
        system_prompt: String(c.config.lmstudio_system_prompt ?? prev.system_prompt),
        compaction: Number(c.config.lmstudio_context_compaction_tokens ?? prev.compaction),
      } : prev));
      setLmDirty(false);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const ingestLine = (name: string) => {
    if (ingestPersona !== name || !ingestState) return null;
    const s = ingestState;
    let text = "";
    if (s.state === "running") {
      text = `${t("personas.ingest.running")} — ${s.phase ?? ""} ${Math.round(s.percent ?? 0)}%`
        + (s.detail ? ` (${s.detail})` : "");
    } else if (s.state === "done") {
      text = t("personas.ingest.done", {
        indexed: s.result?.rag_indexed ?? s.result?.chunks ?? 0,
        dropped: s.result?.dropped ?? 0,
        rag: s.result?.rag ?? "",
      });
    } else if (s.state === "error") {
      text = `${t("personas.ingest.error")}: ${s.error ?? ""}`;
    }
    return (
      <p className={`text-xs ${s.state === "error" ? "text-red-400" : "text-text/60"}`}>
        {text}
      </p>
    );
  };

  // Modello scelto ≠ modello in memoria -> lo scambio è possibile ma va chiesto.
  // Il confronto ignora la quantizzazione (`nome` vs `nome@iq4_nl`): è lo stesso
  // modello, e non ha senso proporne lo scambio con se stesso.
  const stessoModello = (a: string, b: string) =>
    a.split("@")[0].trim().toLowerCase() === b.split("@")[0].trim().toLowerCase();
  const caldiLm = llm?.backends?.lmstudio?.loaded ?? [];
  const sceltoLm = (lm?.model ?? "").trim();
  const swapCandidate =
    lm?.backend === "lmstudio" && sceltoLm && caldiLm.length > 0 &&
    !caldiLm.some((m) => stessoModello(m, sceltoLm))
      ? sceltoLm
      : null;

  return (
    <div className="max-w-3xl w-full mx-auto space-y-6">
      <input ref={uploadRef} type="file" accept=".mp4" className="hidden" onChange={onClipFile} />
      <input ref={docUploadRef} type="file" accept={DOC_ACCEPT} className="hidden" onChange={onDocFile} />
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("personas.title")}</h1>
        <p className="text-sm text-text/60">{t("personas.subtitle")}</p>
      </div>
      {!bridgeReachable && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {t("personas.serverDown")}
        </div>
      )}

      {/* Chat avatar (Ctrl+Shift+F4/F5): conversazione non agentica su un LLM
          locale, LM Studio o vLLM. L'agente Hermes non passa di qui. */}
      {lm && (
        <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
          <div>
            <h2 className="text-sm font-medium text-text/70 flex items-center gap-1.5">
              <Cpu width={14} height={14} />
              {t("personas.lmstudio.title")}
            </h2>
            <p className="text-xs text-text/50 mt-0.5">{t("personas.lmstudio.subtitle")}</p>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              className="accent-logo-primary"
              checked={lm.enabled}
              onChange={(e) => setLmField({ enabled: e.target.checked })}
            />
            {t("personas.lmstudio.enabled")}
          </label>
          {/* Scelta del backend: i campi sotto cambiano di conseguenza. */}
          <div className="space-y-1">
            <label className="text-xs text-text/60">{t("personas.lmstudio.backend")}</label>
            <div className="flex gap-4">
              {(["lmstudio", "vllm"] as const).map((b) => (
                <label key={b} className="flex items-center gap-1.5 text-sm cursor-pointer select-none">
                  <input
                    type="radio"
                    className="accent-logo-primary"
                    checked={lm.backend === b}
                    onChange={() => setLmField({ backend: b })}
                  />
                  {t(`personas.lmstudio.backend_${b}`)}
                  {llm?.backends?.[b]?.up && (
                    <span className="text-[10px] text-green-400">●</span>
                  )}
                </label>
              ))}
            </div>
            <p className="text-[11px] text-text/40">{t("personas.lmstudio.backendHint")}</p>
          </div>
          {/* Modello da caricare se il backend non ne ha già uno in memoria. */}
          <div className="space-y-1">
            <label className="text-xs text-text/60">{t("personas.lmstudio.model")}</label>
            <Select
              className="w-full"
              value={lm.backend === "vllm" ? lm.vllm_model : lm.model}
              onChange={(v) =>
                setLmField(lm.backend === "vllm" ? { vllm_model: v } : { model: v })}
              placeholder={t("personas.lmstudio.modelAuto")}
              /* Etichetta con quantizzazione e peso (dal bridge): lo stesso
                 modello esiste in più quantizzazioni, che occupano VRAM
                 diversa — col solo nome non si sa quale si sta scegliendo. */
              options={(llm?.backends?.[lm.backend]?.available ?? []).map((m) => {
                const info = llm?.backends?.[lm.backend]?.models?.find((i) => i.id === m);
                const base = info?.label ?? m;
                return {
                  value: m,
                  label: (llm?.backends?.[lm.backend]?.loaded ?? []).includes(m)
                    ? `${base} — ${t("personas.lmstudio.modelLoaded")}`
                    : base,
                };
              })}
            />
            <p className="text-[11px] text-text/40">
              {(llm?.backends?.[lm.backend]?.loaded ?? []).length > 0
                ? t("personas.lmstudio.modelInUse", {
                    model: llm?.backends?.[lm.backend]?.loaded?.[0] ?? "",
                  })
                : t("personas.lmstudio.modelWillLoad")}
            </p>
            {/* Il modello scelto è diverso da quello in memoria: si usa comunque
                quello caldo (in VRAM ce ne sta uno). Lo scambio si fa da qui,
                esplicitamente, perché comporta lo scarico dell'altro. */}
            {swapCandidate && (
              <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-3 space-y-2">
                <p className="text-[11px] text-text/70">
                  {t("personas.lmstudio.swapAsk", {
                    defaultValue:
                      "In memoria c'è {{loaded}}. Per usare quello scelto va scaricato: la VRAM ne tiene uno solo.",
                    loaded: llm?.backends?.[lm.backend]?.loaded?.[0] ?? "",
                  })}
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="min-h-[44px]"
                    disabled={swapBusy}
                    onClick={() => {
                      setSwapBusy(true);
                      setSwapNote(null);
                      swapAvatarLlmModel(swapCandidate, true)
                        .then((r) => setSwapNote(r.note ?? null))
                        .catch((e) => setSwapNote(e instanceof Error ? e.message : String(e)))
                        .then(() =>
                          getAvatarLlmModels(lm.backend).then(setLlm).catch(() => {}))
                        .finally(() => setSwapBusy(false));
                    }}
                  >
                    {swapBusy
                      ? t("personas.lmstudio.swapBusy", { defaultValue: "Scambio in corso…" })
                      : t("personas.lmstudio.swapDo", {
                          defaultValue: "Scarica quello in memoria e carica questo",
                        })}
                  </Button>
                </div>
                {swapNote && <p className="text-[11px] text-amber-400">{swapNote}</p>}
              </div>
            )}
          </div>
          {lm.backend === "lmstudio" ? (
            <div className="space-y-1">
              <label className="text-xs text-text/60">{t("personas.lmstudio.baseUrl")}</label>
              <Input
                className="w-full"
                value={lm.base_url}
                onChange={(e) => setLmField({ base_url: e.target.value })}
                placeholder="http://127.0.0.1:1234/v1"
              />
            </div>
          ) : (
            // Solo l'indirizzo del manager: VRAM, max-model-len ed eager li
            // decide lui dalle sue ricette per-modello (è il gestore di vLLM).
            <div className="space-y-1">
              <label className="text-xs text-text/60">{t("personas.lmstudio.managerUrl")}</label>
              <Input
                className="w-full"
                value={lm.vllm_manager_url}
                onChange={(e) => setLmField({ vllm_manager_url: e.target.value })}
                placeholder="http://127.0.0.1:7860"
              />
              <p className="text-[11px] text-text/40">{t("personas.lmstudio.managerHint")}</p>
            </div>
          )}
          <div className="space-y-1">
            <label className="text-xs text-text/60">{t("personas.lmstudio.embedModel")}</label>
            <Input
              className="w-full"
              value={lm.embed_model}
              onChange={(e) => setLmField({ embed_model: e.target.value })}
              placeholder={t("personas.lmstudio.embedModelPlaceholder")}
            />
            <p className="text-[11px] text-text/40">{t("personas.lmstudio.embedModelHint")}</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-text/60">{t("personas.lmstudio.systemPrompt")}</label>
            <Textarea
              variant="compact"
              className="w-full"
              value={lm.system_prompt}
              onChange={(e) => setLmField({ system_prompt: e.target.value })}
              placeholder={t("personas.lmstudio.systemPromptPlaceholder")}
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs text-text/60">{t("personas.lmstudio.compaction")}</label>
            <Input
              type="number"
              className="w-28"
              value={String(lm.compaction)}
              onChange={(e) => setLmField({ compaction: Number(e.target.value) || 0 })}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={saveLm} disabled={!lmDirty || !bridgeReachable}>
              <span className="flex items-center gap-1">
                <Save width={12} height={12} />
                {t("common.save")}
              </span>
            </Button>
            {lmSaved && <span className="text-xs text-green-400">{t("personas.lmstudio.saved")}</span>}
            {lmRestart && <span className="text-xs text-amber-400">{t("personas.lmstudio.restartHint")}</span>}
          </div>
        </div>
      )}

      {/* Engine TTS attivo (incl. ZONOS2): determina il motore con cui l'avatar
          parla per le voci clonate. */}
      <TtsEngineSelect />
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <h2 className="text-sm font-medium text-text/60 flex items-center gap-1.5">
          <UserPlus width={14} height={14} />
          {t("personas.new.title")}
        </h2>
        <div className="flex gap-2">
          <Input
            className="flex-1"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t("personas.new.namePlaceholder")}
            disabled={creating}
          />
          <VoicePicker
            models={catalogo}
            value={newVoice}
            onChange={(v) => setNewVoice(v)}
            className="w-64"
          />
          <Button onClick={create} disabled={creating || !bridgeReachable}>
            <span className="flex items-center gap-1.5">
              {t("common.create")}
            </span>
          </Button>
        </div>
        <p className="text-xs text-text/50">{t("personas.new.hint")}</p>
      </div>
      {personas.length === 0 ? (
        <p className="text-sm text-text/50">{t("personas.list.empty")}</p>
      ) : (
        personas.map((p) => {
          const isActive = avatar.running && avatar.persona === p.name;
          return (
            <div
              key={p.name}
              className={`rounded-lg border p-4 space-y-3 ${isActive ? "border-logo-primary/60 bg-logo-primary/5" : "border-mid-gray/20"}`}
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{p.name}</span>
                {p.voice?.voice && (
                  <Badge variant="secondary">{p.voice.voice} ({p.voice.engine})</Badge>
                )}
                {isActive && <Badge variant="success">{t("personas.badge.avatarActive")}</Badge>}
                <div className="ms-auto flex gap-1.5">
                  {isActive ? (
                    <Button variant="danger" size="sm" onClick={() => run(`stop:${p.name}`, avatarStop)} disabled={busy !== null}>
                      <span className="flex items-center gap-1">
                        <Square width={12} height={12} fill="currentColor" />
                        {t("personas.stopAvatar")}
                      </span>
                    </Button>
                  ) : (
                    <Button
                      variant="primary-soft"
                      size="sm"
                      onClick={() => run(`start:${p.name}`, async () => {
                        try { await avatarStartAndWait(p.name, (s) => setPrep(s.progress)); }
                        finally { setPrep(null); }
                      })}
                      disabled={busy !== null || p.clip_count === 0}
                      title={p.clip_count === 0 ? t("personas.noClip") : undefined}
                    >
                      <span className="flex items-center gap-1">
                        <Play width={12} height={12} fill="currentColor" />
                        {busy === `start:${p.name}` ? t("personas.starting") : t("personas.startAvatar")}
                      </span>
                    </Button>
                  )}
                  {/* Banco di prova dell'avatar per QUESTA persona: era la tab
                      "Studio", che chiedeva di riscegliere l'identità. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setStudioPersona(p.name)}
                    disabled={busy !== null}
                  >
                    <span className="flex items-center gap-1">
                      <Clapperboard width={13} height={13} />
                      {t("personas.studio", { defaultValue: "TTS Studio" })}
                    </span>
                  </Button>
                  {/* Memoria: profilo durevole + conversazioni ricordate. */}
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setMemoryPersona(p.name)}
                    disabled={busy !== null}
                  >
                    <span className="flex items-center gap-1">
                      <Brain width={13} height={13} />
                      {t("personas.memory", { defaultValue: "Memoria" })}
                    </span>
                  </Button>
                  <Button
                    variant="danger-ghost"
                    size="sm"
                    disabled={busy !== null || isActive}
                    onClick={() => {
                      if (window.confirm(t("personas.deleteConfirm", { name: p.name }))) {
                        run(`del:${p.name}`, () => deletePersona(p.name));
                      }
                    }}
                    aria-label={t("common.delete")}
                  >
                    <Trash2 width={14} height={14} />
                  </Button>
                </div>
              </div>
              <div className="flex items-start gap-2 text-sm">
                <span className="text-text/60 pt-1.5">{t("personas.voice")}</span>
                <VoicePicker
                  models={catalogo}
                  value={p.voice?.engine && p.voice?.voice
                    ? `${p.voice.engine}:${p.voice.voice}` : (p.voice?.voice ?? "")}
                  onChange={(v) => run(`voice:${p.name}`, () =>
                    updatePersona(p.name, { voice: v ? parseVoice(v) : {} }))}
                  disabled={busy !== null}
                  className="w-72"
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text/60">{t("personas.clips", { count: p.clip_count })}</span>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => { uploadTarget.current = p.name; uploadRef.current?.click(); }}
                  >
                    <span className="flex items-center gap-1">
                      <Upload width={12} height={12} />
                      {busy === `clip:${p.name}` ? t("personas.uploadingClip") : t("personas.addClip")}
                    </span>
                  </Button>
                </div>
                {p.clips.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {p.clips.map((c) => {
                      const fname = c.split("/").pop() ?? c;
                      return (
                        <span key={c} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-mid-gray/15">
                          {fname}
                          <button
                            type="button"
                            className="text-red-400 hover:text-red-300 cursor-pointer"
                            disabled={busy !== null}
                            onClick={() => {
                              if (window.confirm(t("personas.removeClipConfirm", { name: fname }))) {
                                run(`delclip:${p.name}`, () => deletePersonaClip(p.name, fname));
                              }
                            }}
                          >x</button>
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Identità per la modalità LM Studio (F4/F5): personalità, prompt
                  di sistema, progetto conoscenza e sapere importato (RAG). */}
              <div className="flex items-center gap-2 flex-wrap">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => (editing === p.name ? setEditing(null) : openEditor(p))}
                >
                  <span className="flex items-center gap-1">
                    <BookText width={12} height={12} />
                    {t("personas.identity.edit")}
                  </span>
                </Button>
                {p.personality && <Badge variant="secondary">{t("personas.identity.hasPersonality")}</Badge>}
                {p.has_personality_docs && <Badge variant="secondary">{t("personas.identity.docsPersonality")}</Badge>}
                {p.knowledge_project && (
                  <Badge variant="secondary">
                    {t("personas.identity.projectBadge", { project: p.knowledge_project })}
                  </Badge>
                )}
                {(p.knowledge_chunks ?? 0) > 0 && (
                  <Badge variant="secondary">
                    {t("personas.identity.knowledgeBadge", { count: p.knowledge_chunks })}
                  </Badge>
                )}
              </div>
              {ingestLine(p.name)}
              {editing === p.name && (
                <div className="rounded-lg border border-mid-gray/30 bg-mid-gray/5 p-3 space-y-3">
                  <p className="text-xs text-text/50">{t("personas.identity.hint")}</p>
                  <div className="space-y-1">
                    <label className="text-xs text-text/60">{t("personas.identity.personality")}</label>
                    <Textarea
                      className="w-full"
                      value={draft.personality}
                      onChange={(e) => setDraft((d) => ({ ...d, personality: e.target.value }))}
                      placeholder={t("personas.identity.personalityPlaceholder")}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-xs text-text/60">{t("personas.identity.systemPrompt")}</label>
                    <Textarea
                      variant="compact"
                      className="w-full"
                      value={draft.system_prompt}
                      onChange={(e) => setDraft((d) => ({ ...d, system_prompt: e.target.value }))}
                      placeholder={t("personas.identity.systemPromptPlaceholder")}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-text/60">{t("personas.identity.knowledgeProject")}</span>
                    <Select
                      value={draft.knowledge_project}
                      onChange={(v) => setDraft((d) => ({ ...d, knowledge_project: v }))}
                      placeholder={t("personas.identity.noProject")}
                      options={projectOptions}
                      className="flex-1 min-w-[12rem]"
                    />
                    {!draft.knowledge_project && (
                      <Button variant="secondary" size="sm" onClick={() => createProjectForDraft(p.name)}>
                        {t("personas.identity.createProject")}
                      </Button>
                    )}
                  </div>
                  {/* Ingest documenti/libri -> personalità + sapere RAG (Fase 5). */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-text/60">{t("personas.ingest.title")}</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={ingestPersona === p.name && ingestState?.state === "running"}
                      onClick={() => { docTarget.current = p.name; docUploadRef.current?.click(); }}
                    >
                      <span className="flex items-center gap-1">
                        <FileText width={12} height={12} />
                        {t("personas.ingest.import")}
                      </span>
                    </Button>
                  </div>
                  <p className="text-[11px] text-text/40">{t("personas.ingest.hint")}</p>
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => saveIdentity(p.name)} disabled={savingId}>
                      <span className="flex items-center gap-1">
                        <Save width={12} height={12} />
                        {savingId ? t("common.saving") : t("common.save")}
                      </span>
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => setEditing(null)} disabled={savingId}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
      {prep && (
        <ProgressBar
          percent={prep.percent}
          label={`Preparing: ${PREP_PHASE_LABEL[prep.phase] ?? prep.phase} — ${prep.done}/${prep.total}`}
          rightLabel={prep.eta_s != null ? `ETA ${formatEta(prep.eta_s)}` : undefined}
        />
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {avatar.running && <VirtualCamPreview active={avatar.running} />}

      {memoryPersona && (
        <PersonaMemoryDialog
          persona={memoryPersona}
          onClose={() => setMemoryPersona(null)}
        />
      )}

      {studioPersona && personas.find((p) => p.name === studioPersona) && (
        <TtsStudioDialog
          persona={personas.find((p) => p.name === studioPersona)!}
          onClose={() => setStudioPersona(null)}
        />
      )}
    </div>
  );
};
