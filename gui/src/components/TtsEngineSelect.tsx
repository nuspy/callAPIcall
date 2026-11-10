import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cpu, Loader2 } from "lucide-react";
import { Select } from "./ui/Select";
import {
  type EngineState,
  type TtsModel,
  listTtsModels,
  modelsStatus,
  setTtsModel,
} from "@/lib/api/voiceEngineApi";

interface Props {
  /** Etichetta a sinistra del dropdown (default: "Motore TTS"). */
  label?: string;
  className?: string;
  /** Notifica il cambio engine (es. per ricaricare anteprime). */
  onChanged?: (modelId: string) => void;
}

/**
 * Dropdown del motore TTS ATTIVO (Kokoro, Piper, Chatterbox, XTTS, CosyVoice,
 * Orpheus, Dia). Condiviso da Studio, Identità e Voci: cambia il motore lato
 * bridge via POST /tts/model — scelta persistente in config — così anteprime,
 * avatar e chiamate usano quello. Mostra solo i motori davvero utilizzabili.
 *
 * Il cambio è uno **hot swap**: il bridge scarica dalla VRAM il motore
 * precedente e scalda subito quello scelto. Il caricamento dura da pochi
 * secondi (Kokoro) a un minuto abbondante (modelli da miliardi di parametri),
 * quindi qui si mostra l'avanzamento: senza, il dropdown sembrava già pronto e
 * la prima frase arrivava con un ritardo inspiegabile.
 */
export const TtsEngineSelect: React.FC<Props> = ({ label, className, onChanged }) => {
  const { t } = useTranslation();
  const [models, setModels] = useState<TtsModel[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Stato del motore attivo + cosa è appena uscito dalla memoria.
  const [stato, setStato] = useState<EngineState | null>(null);
  const [scaricati, setScaricati] = useState<string[]>([]);
  const timer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listTtsModels();
      setModels(r.models);
      setSelected(r.selected);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Il warm-up è asincrono lato bridge: si segue con /models/status finché il
  // motore smette di essere "loading". Il polling si spegne da solo.
  const seguiCaricamento = useCallback((id: string) => {
    if (timer.current !== null) window.clearInterval(timer.current);
    const leggi = async () => {
      try {
        const s = await modelsStatus();
        const st = s.engines?.[id] ?? null;
        setStato(st);
        if (st && st.state !== "loading" && timer.current !== null) {
          window.clearInterval(timer.current);
          timer.current = null;
        }
      } catch {
        /* bridge irraggiungibile: ci riprova al giro dopo */
      }
    };
    leggi();
    timer.current = window.setInterval(leggi, 1500);
  }, []);

  // Stato iniziale + pulizia del polling allo smontaggio.
  useEffect(() => {
    if (!selected) return;
    modelsStatus()
      .then((s) => setStato(s.engines?.[selected] ?? null))
      .catch(() => {});
  }, [selected]);

  useEffect(() => () => {
    if (timer.current !== null) window.clearInterval(timer.current);
  }, []);

  const change = async (id: string) => {
    if (!id || id === selected) return;
    setBusy(true);
    setError(null);
    setScaricati([]);
    try {
      const swap = await setTtsModel(id);
      setSelected(swap.selected);
      setScaricati(swap.unloaded ?? []);
      onChanged?.(swap.selected);
      if (swap.warming) {
        setStato({ state: "loading", message: "", seconds: 0, active: true, available: true });
        seguiCaricamento(swap.selected);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const options = models
    .filter((m) => m.is_downloaded)
    .map((m) => {
      const lingue = m.langs?.length
        ? ` · ${m.langs.slice(0, 4).join("/")}${m.langs.length > 4 ? "…" : ""}` : "";
      const vel = m.realtime ? ` · ${m.realtime}×` : "";
      return { value: m.id, label: `${m.name}${lingue}${vel}` };
    });

  const nome = (id: string) => models.find((m) => m.id === id)?.name ?? id;

  return (
    <div className={`flex flex-col gap-1 ${className ?? ""}`}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 text-xs text-text/60 shrink-0">
          <Cpu width={13} height={13} />
          {label ?? t("ttsEngine.label")}
        </span>
        <Select
          value={selected}
          onChange={change}
          options={options}
          placeholder={t("ttsEngine.placeholder")}
          disabled={busy || options.length === 0}
          className="w-72"
        />
        {stato?.state === "loading" && (
          <span className="flex items-center gap-1.5 text-xs text-amber-400">
            <Loader2 width={13} height={13} className="animate-spin" />
            {t("ttsEngine.loading", {
              defaultValue: "carico {{motore}} in memoria…",
              motore: nome(selected),
            })}
          </span>
        )}
        {stato?.state === "ready" && (
          <span className="text-xs text-green-400">
            {t("ttsEngine.ready", {
              defaultValue: "in memoria{{tempo}}",
              tempo: stato.seconds ? ` (${stato.seconds.toFixed(1)} s)` : "",
            })}
          </span>
        )}
        {stato?.state === "error" && (
          <span className="text-xs text-red-400 truncate" title={stato.message}>
            {t("ttsEngine.loadFailed", { defaultValue: "caricamento fallito" })}
          </span>
        )}
      </div>
      {scaricati.length > 0 && (
        <span className="text-[11px] text-text/50">
          {t("ttsEngine.unloaded", {
            defaultValue: "liberata la memoria di: {{motori}}",
            motori: scaricati.map(nome).join(", "),
          })}
        </span>
      )}
      {stato?.state === "unloaded" && stato.message && (
        <span className="text-[11px] text-amber-400">{stato.message}</span>
      )}
      {error && <span className="text-xs text-red-400 truncate">{error}</span>}
    </div>
  );
};
