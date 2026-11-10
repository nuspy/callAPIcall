import React, { useCallback, useEffect, useState } from "react";
import { Cpu, Download, Mic2, RefreshCw, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import {
  type EngineState,
  type ModelsAvailable,
  type ModelsStatus,
  type TtsModel,
  engineHealth,
  modelsAvailable,
  modelsLoad,
  modelsStatus,
  modelsUnload,
} from "@/lib/api/voiceEngineApi";
import {
  type EngineRuntime,
  getConfig,
  getEngineCatalog,
  getEnginesStatus,
  reloadStt,
  getPersonas,
  putConfig,
} from "@/lib/api/bridgeApi";
import { Select } from "../ui/Select";
import { useStatusStore } from "@/stores/statusStore";

/** Modelli Whisper selezionabili, dal piu' leggero al piu' accurato.
 *  I pesi si scaricano da soli al primo uso del modello scelto. */
/* VRAM MISURATA su questa macchina, con i pesi in MEZZA PRECISIONE (fp16):
   i valori sono la meta' di quelli storici, perche' whisper.load_model carica
   in fp32 e ora il modello viene convertito (medium: 2915 -> 1468 MB).
   Attenzione al controsenso sulla velocita': large-v3 e' anche il piu' VELOCE
   in tempo d'orologio (5,3x realtime contro 3,8x di small), perche' i modelli
   piccoli allucinano su frasi corte e generano testo inutile — small ha
   prodotto "Sottotitoli e revisione a cura di QTSS" su un "Grazie.". Scendere
   di taglia conviene per liberare VRAM, non per andare piu' veloce. */
/** Varianti note di Qwen3-TTS compatibili col runtime torch (stesso formato
 *  dei modelli ufficiali). Le quantizzate GGUF si scelgono col backend: il
 *  runtime le scarica da Serveurperso/Qwen3-TTS-GGUF per la taglia scelta. */
const QWEN3_VARIANTI = [
  { famiglia: "Base", repo: "Qwen/Qwen3-TTS-12Hz-0.6B-Base", nota: "ufficiale 0.6B" },
  { famiglia: "Base", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-Base", nota: "ufficiale 1.7B" },
  { famiglia: "CustomVoice", repo: "Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice", nota: "ufficiale 0.6B" },
  { famiglia: "CustomVoice", repo: "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", nota: "ufficiale 1.7B, istruzioni di stile" },
] as const;

/** Campi di config mostrati nelle schede Qwen3-TTS e Streaming. */
const QWEN_FIELDS = [
  "qwen3tts_size", "qwen3tts_clone_model", "qwen3tts_preset_model",
  "qwen3tts_backend", "qwen3tts_quant",
  "tts_streaming", "tts_stream_margin_s",
] as const;

const STT_MODELS = [
  { id: "tiny", label: "tiny — ~0,2 GB, impreciso sull'italiano" },
  { id: "base", label: "base — ~0,3 GB, impreciso sull'italiano" },
  { id: "small", label: "small — ~0,5 GB, molti errori sulle frasi brevi" },
  { id: "medium", label: "medium — 1,5 GB, buon compromesso" },
  { id: "large-v3-turbo", label: "large-v3-turbo — ~1,6 GB, quasi large" },
  { id: "large-v3", label: "large-v3 — 3,0 GB, il piu' accurato" },
];

export const VoiceEngineSection: React.FC = () => {
  const { t } = useTranslation();
  // Componenti sospesi (Sospendi): il server dei motori voce e' fermo apposta.
  const sospeso = useStatusStore((s) => s.components?.main?.suspended) === true;
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [available, setAvailable] = useState<ModelsAvailable | null>(null);
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Esito positivo di un'azione (es. «Ricaricato solo lo STT...»).
  const [notice, setNotice] = useState<string | null>(null);
  // Il motore TTS NON si sceglie piu' qui: lo decide l'avatar attivo, tramite
  // la voce salvata nella sua identita'. Qui si mostra soltanto quale ne
  // risulta, perche' avere due posti da cui scegliere il motore (questa
  // sezione e Identita') portava a combinazioni incoerenti — una voce XTTS
  // con Kokoro come motore di sistema non era nemmeno pronunciabile.
  const [catalogo, setCatalogo] = useState<TtsModel[]>([]);
  const [avatarPersona, setAvatarPersona] = useState("");
  const [avatarVoce, setAvatarVoce] = useState<{ engine?: string; voice?: string }>({});
  // Modello Whisper in uso: cambiarlo scarica il precedente dalla memoria.
  const [sttModel, setSttModel] = useState("");
  // Switch device dei motori: STT/TTS e ogni motore del catalogo su GPU o CPU.
  const [dev, setDev] = useState<Record<string, string>>({});
  // Precisione dell'STT (campo stt_compute_type, valore grezzo della config).
  const [sttCompute, setSttCompute] = useState("auto");
  // Dove girano davvero i motori (GET /engines/status), aggiornato a intervalli:
  // il caricamento è pigro, quindi lo stato cambia al primo uso dopo una modifica.
  const [runtime, setRuntime] = useState<Record<string, EngineRuntime> | null>(null);
  // Qwen3-TTS e streaming: valori come stringhe, riallineati alla risposta.
  const [qwen, setQwen] = useState<Record<string, string>>({});

  const setQwenField = (key: string, val: string | number | boolean) => {
    const prev = qwen[key];
    setQwen((q) => ({ ...q, [key]: String(val) }));
    putConfig({ [key]: val })
      .then((res) => {
        if (res.rejected?.[key] || !(res.applied ?? []).includes(key)) {
          setQwen((q) => ({ ...q, [key]: prev }));
          setError(t("voiceEngine.device.saveRejected", {
            defaultValue: "Impostazione non applicata: {{motivo}}",
            motivo: res.rejected?.[key] ?? key,
          }));
        }
      })
      .catch((e) => {
        setQwen((q) => ({ ...q, [key]: prev }));
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  // Dove girano DAVVERO i motori (GET /engines/status).
  const leggiRuntime = useCallback(() => {
    getEnginesStatus().then(setRuntime).catch(() => setRuntime(null));
  }, []);

  // Il selettore deve mostrare ciò che è DAVVERO salvato: prima si aggiornava
  // subito e, se la PUT falliva (o il campo veniva rifiutato), il valore restava
  // a schermo mentre config.json ne conservava un altro — si finiva convinti di
  // essere su GPU con il motore su CPU. Ora si riallinea sempre alla risposta.
  const setDevField = (key: string, val: string) => {
    const prev = dev[key];
    setDev((d) => ({ ...d, [key]: val }));
    putConfig({ [key]: val })
      .then((res) => {
        const rifiutato = res.rejected?.[key];
        // Il bridge ha gia' avviato la ricarica del componente attivo: lo si
        // legge subito, cosi' compare "carico…" senza aspettare il giro dei 5 s.
        refresh();
        leggiRuntime();
        if (rifiutato || !(res.applied ?? []).includes(key)) {
          setDev((d) => ({ ...d, [key]: prev }));
          setError(
            t("voiceEngine.device.saveRejected", {
              defaultValue: "Impostazione non applicata: {{motivo}}",
              motivo: rifiutato ?? key,
            }),
          );
        }
      })
      .catch((e) => {
        setDev((d) => ({ ...d, [key]: prev }));   // niente valore fantasma
        setError(e instanceof Error ? e.message : String(e));
      });
  };

  const refresh = useCallback(async () => {
    const ok = await engineHealth();
    setReachable(ok);
    if (!ok) return;
    try {
      setAvailable(await modelsAvailable());
      setStatus(await modelsStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    getConfig()
      .then((c) => {
        const persona = String(c.config.avatar_persona || "");
        setAvatarPersona(persona);
        setSttModel(String(c.config.stt_model || ""));
        setSttCompute(String(c.config.stt_compute_type || "auto"));
        if (persona) {
          getPersonas()
            .then((r) => {
              const p = (r.personas ?? []).find((x) => x.name === persona);
              setAvatarVoce(p?.voice ?? {});
            })
            .catch(() => {});
        }
        // Si legge OGNI campo *_device/*_gpu_memory presente in config: cosi'
        // un motore nuovo compare da solo, senza toccare questa lista.
        const d: Record<string, string> = {};
        for (const [k, v] of Object.entries(c.config)) {
          if (/_(device|gpu_memory)$/.test(k)) d[k] = String(v ?? "");
        }
        setDev(d);
        const q: Record<string, string> = {};
        for (const k of QWEN_FIELDS) {
          if (k in c.config) q[k] = String(c.config[k] ?? "");
        }
        setQwen(q);
      })
      .catch(() => {});
    // L'elenco dei motori lo da' il BRIDGE, non il server voci :8720: cosi' c'e'
    // anche da sospeso e i selettori GPU/CPU restano usabili.
    getEngineCatalog()
      .then((m) => {
        setCatalogo(m.models ?? []);
      })
      .catch(() => {});
  }, []);

  const nomeMotore = (id: string) => catalogo.find((m) => m.id === id)?.name ?? id;
  // Runtime GGUF di Qwen3-TTS installato (wheel qwentts-cpp-python).
  const qwenGgml = !!catalogo.find((m) => m.id === "qwen3tts")?.ggml;

  /** Cambia il modello Whisper: salva, e il bridge RICARICA subito l'unico STT
   *  sul nuovo modello (reset_engines -> reconfigure). Qui si legge lo stato
   *  reale: "carico…" finche' il processo non e' pronto. */
  const changeSttModel = async (id: string) => {
    const prev = sttModel;
    setSttModel(id);
    setBusy("stt-model");
    setError(null);
    try {
      const res = await putConfig({ stt_model: id });
      if (!(res.applied ?? []).includes("stt_model")) {
        setSttModel(prev);
        setError(t("voiceEngine.stt.rejected", {
          defaultValue: "Modello non applicato: {{motivo}}",
          motivo: res.rejected?.stt_model ?? id,
        }));
        return;
      }
      await refresh();
      leggiRuntime();
    } catch (e) {
      setSttModel(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /** Cambia la precisione dell'STT (float16/float32): salva e il bridge
   *  ricarica subito. Sono le sole due con un percorso reale. */
  const changeSttPrecision = async (valore: string) => {
    const prev = sttCompute;
    setSttCompute(valore);
    setBusy("stt-precision");
    setError(null);
    try {
      const res = await putConfig({ stt_compute_type: valore });
      if (!(res.applied ?? []).includes("stt_compute_type")) {
        setSttCompute(prev);
        setError(t("voiceEngine.device.saveRejected", {
          defaultValue: "Impostazione non applicata: {{motivo}}",
          motivo: res.rejected?.stt_compute_type ?? "stt_compute_type",
        }));
        return;
      }
      await refresh();
      leggiRuntime();
    } catch (e) {
      setSttCompute(prev);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  // Dove girano DAVVERO i motori. Va richiesto di continuo perché il modello si
  // carica pigramente: dopo un cambio device lo stato resta "non caricato"
  // finché non arriva il primo utilizzo.
  useEffect(() => {
    leggiRuntime();
    const timer = setInterval(leggiRuntime, 5000);
    return () => clearInterval(timer);
  }, [leggiRuntime]);

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // «Load models» da sospeso: il server voci e' spento apposta, quindi passa dal
  // bridge e ricarica SOLO lo STT (gli altri componenti restano sospesi).
  const ricaricaSoloStt = async () => {
    const r = await reloadStt();
    const rt = r.stt;
    const dettagli = [
      rt.model ?? "?",
      rt.running_on === "cuda" ? "GPU (CUDA)" : "CPU",
      rt.precision,
    ].filter(Boolean).join(" · ");
    setNotice(t("voiceEngine.vram.sttReloaded", {
      defaultValue: "Ricaricato solo lo STT: {{dettagli}}. Gli altri componenti restano sospesi.",
      dettagli,
    }));
    leggiRuntime();
  };

  // --- STT: valori derivati ---------------------------------------------------
  // Device voluto dalla config (cpu/cuda). Su CPU l'unica precisione e' float32.
  const sttCpu = (dev["stt_device"] ?? "cuda") === "cpu";
  // Precisione EFFETTIVA di una config grezza. Stessa regola del bridge
  // (engines/whisper_stt.py: _compute_vuole_half): "float32"/"fp32" => float32;
  // "auto", vuoto o un valore con "16" => float16; il resto (es. "int8") => float32.
  const sttPrecisione = (() => {
    if (sttCpu) return "float32";
    const v = sttCompute.toLowerCase();
    if (v.includes("float32") || v.includes("fp32")) return "float32";
    return v.includes("16") || v === "auto" || v === "" ? "float16" : "float32";
  })();
  const sttRt = runtime?.stt;
  const sttCarica = sttRt?.state === "loading";
  const sttReale = sttRt?.loaded
    ? [
        sttRt.model ?? sttModel,
        sttRt.running_on === "cuda" ? "GPU (CUDA)" : "CPU",
        sttRt.precision,
      ].filter(Boolean).join(" · ")
    : t("voiceEngine.stt.none", { defaultValue: "nessuno" });

  return (
    <div className="max-w-3xl w-full mx-auto space-y-5">
      <div>
        <h1 className="text-xl font-semibold mb-2">{t("voiceEngine.title")}</h1>
        <p className="text-sm text-text/60">{t("voiceEngine.subtitle")}</p>
      </div>

      {reachable === false && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-400">
          {sospeso
            ? t("voiceEngine.suspended", { defaultValue: "componenti sospesi: premi Riprendi" })
            : t("voiceEngine.engineDown")}
        </div>
      )}

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Mic2 width={16} height={16} className="text-logo-primary" />
          <div className="flex-1">
            <h2 className="text-sm font-medium">{t("voiceEngine.defaultVoice.title")}</h2>
            <p className="text-xs text-text/60">{t("voiceEngine.defaultVoice.desc")}</p>
          </div>
        </div>
        {/* Sola lettura: il motore e la voce vengono dall'identita' dell'avatar
            attivo. Si cambiano di la', non qui. */}
        {avatarPersona ? (
          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-text/60">
                {t("voiceEngine.fromAvatar.persona", { defaultValue: "Avatar attivo" })}
              </span>
              <span className="font-medium">{avatarPersona}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text/60">
                {t("voiceEngine.fromAvatar.voice", { defaultValue: "Voce" })}
              </span>
              <span className="font-medium">{avatarVoce.voice || "—"}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-text/60">
                {t("voiceEngine.fromAvatar.engine", { defaultValue: "Motore TTS" })}
              </span>
              <span className="font-medium">
                {avatarVoce.engine ? nomeMotore(avatarVoce.engine) : "—"}
              </span>
            </div>
          </div>
        ) : (
          <p className="text-xs text-amber-400">
            {t("voiceEngine.fromAvatar.none", {
              defaultValue:
                "Nessun avatar attivo: il motore verra' dedotto dalla voce richiesta.",
            })}
          </p>
        )}
        <p className="text-xs text-text/40">
          {t("voiceEngine.fromAvatar.hint", {
            defaultValue:
              "Motore e voce si scelgono in Identita', sull'avatar. Resta caldo un solo motore per volta.",
          })}
        </p>
      </div>

      {/* Switch device dei motori: GPU o CPU, uno per motore. */}
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Cpu width={16} height={16} className="text-logo-primary" />
          <h2 className="text-sm font-medium">
            {t("voiceEngine.device.title", { defaultValue: "Elaborazione motori (GPU / CPU)" })}
          </h2>
        </div>
        {/* Righe generate: STT + un motore TTS per ciascuno di quelli presenti
            nel catalogo. Prima erano quattro voci cablate, e i motori aggiunti
            dopo (XTTS, CosyVoice, Orpheus, Dia) non comparivano affatto.
            Kokoro usa il campo storico tts_device.
            La riga si mostra anche se `dev` non ha ancora il campo (bridge da
            riavviare): prima veniva filtrata via e il motore risultava
            semplicemente assente, senza spiegazione. Se il bridge non conosce
            il campo, il salvataggio lo dice esplicitamente. */}
        {[
          { k: "stt", label: t("voiceEngine.device.stt", { defaultValue: "STT Whisper (trascrizione)" }), engine: "" },
          ...catalogo
            .filter((m) => m.is_downloaded && m.id !== "kokoro")
            .map((m) => ({ k: m.id, label: `TTS ${m.name}`, engine: m.id })),
          { k: "tts", label: t("voiceEngine.device.tts", { defaultValue: "TTS Kokoro (sintesi)" }), engine: "kokoro" },
        ].map(({ k, label, engine }) => (
          <div key={k} className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text/60 w-36 shrink-0">{label}</span>
            <select
              aria-label={label}
              className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1 text-sm min-h-[44px]"
              value={dev[`${k}_device`] ?? (k === "tts" ? "cpu" : "cuda")}
              onChange={(e) => setDevField(`${k}_device`, e.target.value)}
            >
              <option value="cuda">GPU (CUDA)</option>
              <option value="cpu">CPU</option>
            </select>
            {/* Niente più scelta "VRAM shared/dedicata": "shared" non era una
                gestione della memoria, era "esegui su CPU" con un altro nome —
                serviva da ripiego quando la GPU non partiva, e da quando i
                motori girano in subprocess quel problema non c'è più. Chi vuole
                la CPU la sceglie qui sopra, dove ci si aspetta di trovarla. */}
            {/* Occupazione memoria del singolo motore TTS: con lo hot swap solo
                uno per volta resta caricato, e questo badge dice quale. */}
            {sospeso && k !== "stt" && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                {t("voiceEngine.device.suspended", { defaultValue: "sospeso" })}
              </span>
            )}
            {!sospeso && engine && status?.engines?.[engine] && (() => {
              const st = status.engines[engine] as EngineState;
              if (st.state === "loading") {
                return (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                    {t("voiceEngine.device.loading", { defaultValue: "carico…" })}
                  </span>
                );
              }
              if (st.state === "ready") {
                return (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-400">
                    {t("voiceEngine.device.inMemory", { defaultValue: "in memoria" })}
                    {st.seconds ? ` (${st.seconds.toFixed(1)} s)` : ""}
                  </span>
                );
              }
              if (st.state === "error") {
                return (
                  <span
                    className="text-[11px] px-1.5 py-0.5 rounded bg-red-500/20 text-red-400 truncate max-w-[16rem]"
                    title={st.message}
                  >
                    {t("voiceEngine.device.loadFailed", { defaultValue: "errore di caricamento" })}
                  </span>
                );
              }
              return (
                <span className="text-[11px] px-1.5 py-0.5 rounded bg-mid-gray/20 text-text/50">
                  {t("voiceEngine.device.notLoaded", { defaultValue: "non caricato" })}
                </span>
              );
            })()}
            {/* Stato REALE del device: i selettori dicono l'intenzione, questo
                dice dove il modello è caricato ADESSO. Se divergono, il badge
                lo segnala invece di lasciarlo scoprire dal log. */}
            {(k === "stt" || (k === "tts" && !sospeso)) && runtime?.[k] && (() => {
              const rt = runtime[k];
              const atteso = rt.would_load_on;
              const reale = rt.running_on;
              const divergente = rt.loaded && reale !== atteso;
              if (rt.state === "loading") {
                return (
                  <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                    {t("voiceEngine.device.loading", { defaultValue: "carico…" })}
                  </span>
                );
              }
              return (
                <span
                  className={`text-[11px] px-1.5 py-0.5 rounded ${
                    !rt.loaded
                      ? "bg-mid-gray/20 text-text/50"
                      : divergente
                        ? "bg-amber-500/20 text-amber-400"
                        : reale === "cuda"
                          ? "bg-green-500/20 text-green-400"
                          : "bg-mid-gray/20 text-text/60"
                  }`}
                  title={`configurato: ${rt.configured}${rt.file ? ` — file: ${rt.file}` : ""}${rt.model ? ` — modello: ${rt.model}` : ""}`}
                >
                  {!rt.loaded
                    ? t("voiceEngine.device.notLoaded", { defaultValue: "non caricato" })
                    : t("voiceEngine.device.runningOn", {
                        defaultValue: "in esecuzione su {{dev}}",
                        dev: String(reale).toUpperCase(),
                      }) + (k === "stt" && rt.precision ? ` · ${rt.precision}` : "")}
                  {divergente && " ⚠"}
                </span>
              );
            })()}
          </div>
        ))}

        {/* L'UNICO STT (sessioni voce + dettatura): modello e precisione. Il
            device lo decide la riga "STT Whisper" qui sopra. Cambiare uno dei
            tre ricarica SUBITO il modello sul nuovo valore. */}
        <div className="space-y-3 border-t border-mid-gray/10 pt-3">
          <div>
            <h3 className="text-sm font-medium">
              {t("voiceEngine.stt.title", { defaultValue: "Modello di trascrizione (STT)" })}
            </h3>
            <p className="text-xs text-text/60">
              {t("voiceEngine.stt.desc", {
                defaultValue:
                  "Piu' grande = piu' accurato e piu' VRAM. Vale per le sessioni voce e per la dettatura (Alt+Spazio).",
              })}
            </p>
          </div>
          <Select
            id="stt-model"
            ariaLabel={t("voiceEngine.stt.title", { defaultValue: "Modello di trascrizione (STT)" })}
            value={sttModel}
            onChange={changeSttModel}
            disabled={busy === "stt-model" || sttCarica}
            className="w-full min-h-[44px]"
            options={[
              // Un modello configurato a mano e fuori lista resta selezionabile,
              // altrimenti il dropdown mostrerebbe un valore che non e' il suo.
              ...(sttModel && !STT_MODELS.some((m) => m.id === sttModel)
                ? [{ value: sttModel, label: sttModel }]
                : []),
              ...STT_MODELS.map((m) => ({ value: m.id, label: m.label })),
            ]}
          />
          {/* Precisione: solo valori con un percorso reale. GPU: float16 (pesi
              dimezzati) o float32. CPU: i pesi sono sempre float32, quindi
              l'unica voce e' quella. "int8" non e' offerto: non ha percorso. */}
          <div className="flex items-center gap-3 flex-wrap">
            <label htmlFor="stt-precision" className="text-xs text-text/60 w-36 shrink-0">
              {t("voiceEngine.stt.precisionLabel", { defaultValue: "Precisione STT" })}
            </label>
            <Select
              id="stt-precision"
              value={sttPrecisione}
              onChange={changeSttPrecision}
              disabled={sttCpu || busy === "stt-precision" || sttCarica}
              className="min-h-[44px]"
              options={
                sttCpu
                  ? [{ value: "float32", label: t("voiceEngine.stt.prec32", { defaultValue: "float32 — precisione piena" }) }]
                  : [
                      { value: "float16", label: t("voiceEngine.stt.prec16", { defaultValue: "float16 — pesi dimezzati" }) },
                      { value: "float32", label: t("voiceEngine.stt.prec32gpu", { defaultValue: "float32 — precisione piena, pesi doppi" }) },
                    ]
              }
            />
          </div>
          {sttCpu && (
            <p className="text-xs text-text/50">
              {t("voiceEngine.stt.cpuNote", {
                defaultValue: "Su CPU l'STT usa sempre float32: e' l'unica precisione disponibile.",
              })}
            </p>
          )}
          {/* Cosa e' DAVVERO in memoria adesso (stato reale del processo). */}
          <p className="text-xs text-text/50" aria-live="polite">
            {sttCarica
              ? t("voiceEngine.stt.loading", { defaultValue: "carico…" })
              : t("voiceEngine.stt.current", {
                  defaultValue: "In memoria: {{modello}}",
                  modello: sttReale,
                })}
          </p>
          <p className="text-xs text-text/40">
            {t("voiceEngine.stt.reloadNote", {
              defaultValue: "Cambiando modello, device o precisione l'STT si ricarica subito.",
            })}
          </p>
        </div>

        {sospeso && (
          <p className="text-xs text-amber-300/90">
            {t("voiceEngine.device.suspendedNote", {
              defaultValue:
                "Componenti sospesi: le modifiche si salvano e valgono al «Riprendi».",
            })}
          </p>
        )}
        <p className="text-xs text-text/40">
          {t("voiceEngine.device.note2", {
            defaultValue: "Dove gira ogni motore: GPU CUDA (onnxruntime-gpu) o CPU. Le modifiche si applicano a caldo, con la ricarica del modello al prossimo uso.",
          })}
        </p>
      </div>


      {/* Qwen3-TTS: taglia dei modelli ufficiali e varianti compatibili. Un
          solo helper serve sia le voci clonate (modello Base) sia le 9 voci
          preimpostate (modello CustomVoice): sceglie il modello dalla voce. */}
      {catalogo.some((m) => m.id === "qwen3tts") && (
        <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Mic2 width={16} height={16} className="text-logo-primary" />
            <div className="flex-1">
              <h2 className="text-sm font-medium">
                {t("voiceEngine.qwen3.title", { defaultValue: "Qwen3-TTS: modello" })}
              </h2>
              <p className="text-xs text-text/60">
                {t("voiceEngine.qwen3.desc", {
                  defaultValue:
                    "Clonazione della voce e 9 voci preimpostate, con streaming. Cambiare taglia o precisione riavvia il motore e, se è quello attivo, lo prepara subito: la prima volta scarica il modello (0.6B: ~2 GB in GGUF, ~5 GB in BF16; 1.7B: circa il doppio) in %LOCALAPPDATA%\\callAPIcall\\models. Finché scarica, qui sopra resta «carico…».",
                })}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text/60 w-36 shrink-0">
              {t("voiceEngine.qwen3.size", { defaultValue: "Taglia" })}
            </span>
            <select
              className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1 text-sm min-h-[36px]"
              value={qwen.qwen3tts_size || "0.6B"}
              onChange={(e) => setQwenField("qwen3tts_size", e.target.value)}
            >
              <option value="0.6B">0.6B — veloce, ~4 GB di VRAM</option>
              <option value="1.7B">1.7B — più qualità, istruzioni di stile, ~7 GB</option>
            </select>
          </div>
          {/* Backend: torch (pesi BF16) o GGUF quantizzati via qwentts.cpp.
              Un'unica scelta per la GUI, due campi in config. */}
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs text-text/60 w-36 shrink-0">
              {t("voiceEngine.qwen3.backend", { defaultValue: "Precisione / runtime" })}
            </span>
            <select
              className="bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1 text-sm min-h-[36px]"
              value={
                (qwen.qwen3tts_backend || "auto") === "ggml"
                  ? `ggml:${qwen.qwen3tts_quant || "Q8_0"}`
                  : (qwen.qwen3tts_backend || "auto")
              }
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith("ggml:")) {
                  setQwenField("qwen3tts_quant", v.slice(5));
                  setQwenField("qwen3tts_backend", "ggml");
                } else {
                  setQwenField("qwen3tts_backend", v);
                }
              }}
            >
              <option value="auto">
                Automatico — GGUF Q8_0 se installato, altrimenti BF16
              </option>
              <option value="torch">BF16 (torch) — qualità piena, ~4 GB per 0.6B</option>
              <option value="ggml:Q8_0" disabled={!qwenGgml}>
                GGUF Q8_0 — ~16× tempo reale, ~2,5 GB{!qwenGgml ? " (non installato)" : ""}
              </option>
              <option value="ggml:Q4_K_M" disabled={!qwenGgml}>
                GGUF Q4_K_M — la più leggera{!qwenGgml ? " (non installato)" : ""}
              </option>
            </select>
          </div>
          {([
            ["qwen3tts_clone_model", t("voiceEngine.qwen3.cloneModel", { defaultValue: "Variante voci clonate" }), "Base"],
            ["qwen3tts_preset_model", t("voiceEngine.qwen3.presetModel", { defaultValue: "Variante voci preimpostate" }), "CustomVoice"],
          ] as const).map(([campo, label, famiglia]) => (
            <div key={campo} className="flex items-center gap-3 flex-wrap">
              <span className="text-xs text-text/60 w-36 shrink-0">{label}</span>
              <input
                className="flex-1 min-w-[14rem] bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1 text-sm min-h-[36px]"
                list={`qwen3-varianti-${famiglia}`}
                placeholder={`Qwen/Qwen3-TTS-12Hz-${qwen.qwen3tts_size || "0.6B"}-${famiglia} (ufficiale)`}
                defaultValue={qwen[campo] ?? ""}
                key={`${campo}-${qwen[campo] ?? ""}`}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v !== (qwen[campo] ?? "")) setQwenField(campo, v);
                }}
              />
              <datalist id={`qwen3-varianti-${famiglia}`}>
                {QWEN3_VARIANTI.filter((x) => x.famiglia === famiglia).map((x) => (
                  <option key={x.repo} value={x.repo}>{x.nota}</option>
                ))}
              </datalist>
            </div>
          ))}
          <p className="text-xs text-text/40">
            {t("voiceEngine.qwen3.variantsNote", {
              defaultValue:
                "Vuoto = modello ufficiale della taglia scelta. Una variante è un repo Hugging Face o una cartella locale con lo stesso formato (fine-tune, versioni di altri autori) e usa sempre il runtime BF16: le versioni GGUF esistono solo per i modelli ufficiali e si scelgono qui sopra.",
            })}
          </p>
        </div>
      )}

      {/* Streaming TTS: vale per tutti i motori che lo sanno fare. */}
      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Cpu width={16} height={16} className="text-logo-primary" />
          <h2 className="text-sm font-medium flex-1">
            {t("voiceEngine.streaming.title", { defaultValue: "Streaming della voce" })}
          </h2>
          <label className="flex items-center gap-2 text-sm min-h-[36px] cursor-pointer">
            <input
              type="checkbox"
              className="w-4 h-4"
              checked={qwen.tts_streaming !== "false"}
              onChange={(e) => setQwenField("tts_streaming", e.target.checked)}
            />
            {t("voiceEngine.streaming.enabled", { defaultValue: "attivo" })}
          </label>
        </div>
        <p className="text-xs text-text/60">
          {t("voiceEngine.streaming.desc", {
            defaultValue:
              "La voce parte mentre il motore sta ancora generando la frase, invece di aspettarla tutta. Si usa solo quando servirebbe aspettare (la prima frase, o una sintesi rimasta indietro). Abbassamento del volume quando parli e microfono muto in half-duplex funzionano come sempre.",
          })}
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-xs text-text/60 w-36 shrink-0">
            {t("voiceEngine.streaming.margin", { defaultValue: "Margine (secondi)" })}
          </span>
          <input
            type="number"
            min={0}
            max={30}
            step={0.5}
            className="w-24 bg-mid-gray/10 border border-mid-gray/30 rounded px-2 py-1 text-sm min-h-[36px]"
            defaultValue={qwen.tts_stream_margin_s || "2"}
            key={`margine-${qwen.tts_stream_margin_s ?? ""}`}
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && String(v) !== qwen.tts_stream_margin_s)
                setQwenField("tts_stream_margin_s", v);
            }}
          />
          <span className="text-xs text-text/40">
            {t("voiceEngine.streaming.marginHint", {
              defaultValue: "si va a pezzi se l'audio già pronto è meno di questo",
            })}
          </span>
        </div>
        <p className="text-xs text-text/40">
          {t("voiceEngine.streaming.engines", {
            defaultValue: "Motori con streaming: {{lista}}",
            lista: catalogo.filter((m) => m.streaming).map((m) => m.name).join(", ") || "—",
          })}
        </p>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Cpu width={16} height={16} className="text-logo-primary" />
          <h2 className="text-sm font-medium">{t("voiceEngine.vram.title")}</h2>
          <Button
            variant="secondary"
            size="sm"
            className="ms-auto"
            onClick={() => act("refresh", refresh)}
            disabled={busy !== null || !reachable}
          >
            <RefreshCw
              width={13}
              height={13}
              className={busy === "refresh" ? "animate-spin" : ""}
            />
          </Button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded border border-mid-gray/20 p-3">
            <p className="text-xs text-text/50 mb-1">{t("voiceEngine.vram.sttLabel")}</p>
            <p className="font-medium">
              {status?.stt?.state === "loading"
                ? t("voiceEngine.device.loading", { defaultValue: "carico…" })
                : status?.stt?.loaded
                  ? t("voiceEngine.vram.loaded", {
                      model: [
                        status.stt.current_model ?? "",
                        status.stt.device === "cuda" ? "GPU (CUDA)" : status.stt.device ? "CPU" : "",
                        status.stt.precision ?? "",
                      ].filter(Boolean).join(" · "),
                    })
                  : t("voiceEngine.vram.notLoaded")}
            </p>
          </div>
          <div className="rounded border border-mid-gray/20 p-3">
            <p className="text-xs text-text/50 mb-1">{t("voiceEngine.vram.ttsLabel")}</p>
            <p className="font-medium">
              {status?.tts?.loaded
                ? t("voiceEngine.vram.loaded", { model: status?.tts?.current_model ?? "" })
                : t("voiceEngine.vram.notLoaded")}
            </p>
            <p className="text-xs text-text/40">
              {t("voiceEngine.vram.ttsSelected", { model: status?.tts?.selected_model ?? "?" })}
            </p>
          </div>
        </div>
        {/* Chi occupa memoria adesso. Con lo hot swap è uno solo: se ne compare
            più d'uno vuol dire che qualcosa non è stato scaricato. */}
        {status?.engines && (() => {
          const inMemoria = Object.entries(status.engines)
            .filter(([, s]) => s.state === "ready" || s.state === "loading")
            .map(([id, s]) => (s.state === "loading" ? `${nomeMotore(id)}…` : nomeMotore(id)));
          return (
            <p className="text-xs text-text/50">
              {inMemoria.length
                ? t("voiceEngine.vram.engines", {
                    defaultValue: "Motori TTS in memoria: {{lista}}",
                    lista: inMemoria.join(", "),
                  })
                : t("voiceEngine.vram.noEngines", {
                    defaultValue: "Nessun motore TTS in memoria",
                  })}
            </p>
          );
        })()}
        <p className="text-xs text-text/40">
          {t("voiceEngine.vram.hotSwapNote", {
            defaultValue:
              "Cambiando motore qui sopra il precedente viene scaricato dalla VRAM e il nuovo caricato subito: resta caldo un motore solo.",
          })}
        </p>

        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => act("load", sospeso ? ricaricaSoloStt : () => modelsLoad({ tts: true }))}
            disabled={busy !== null || (!reachable && !sospeso)}
          >
            <span className="flex items-center gap-1.5">
              <Download width={13} height={13} />
              {busy === "load" ? t("voiceEngine.vram.loading") : t("voiceEngine.vram.load")}
            </span>
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() => act("unload", () => modelsUnload("all"))}
            disabled={busy !== null || !reachable}
          >
            <span className="flex items-center gap-1.5">
              <Trash2 width={13} height={13} />
              {t("voiceEngine.vram.unload")}
            </span>
          </Button>
        </div>
      </div>

      <div className="rounded-lg border border-mid-gray/20 p-4 space-y-2">
        <h2 className="text-sm font-medium">
          {t("voiceEngine.voices.title")}{" "}
          <span className="text-text/50 font-normal">
            {t("voiceEngine.voices.engine", {
              engine: available?.tts?.engine ?? "?",
              model: available?.tts?.selected_model ?? "?",
            })}
          </span>
        </h2>
        {available?.tts?.voices?.length ? (
          <div className="flex flex-wrap gap-1.5">
            {available.tts.voices.map((v) => (
              <span
                key={v.voice}
                className="text-xs px-2 py-0.5 rounded-full bg-mid-gray/15"
                title={v.language}
              >
                {v.voice}{" "}
                <span className="text-text/40">({v.lang})</span>
              </span>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text/50">{t("voiceEngine.voices.none")}</p>
        )}
      </div>

      {notice && (
        <p className="text-sm text-green-400" role="status" aria-live="polite">{notice}</p>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
};
