import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "./ui/Select";
import { type TtsModel, listTtsModels } from "@/lib/api/voiceEngineApi";

/**
 * Selezione di una voce in DUE passi: prima il motore, poi le voci di QUEL
 * motore.
 *
 * Prima ogni sezione se le procurava a modo suo e mostrava un elenco piatto in
 * cui convivevano voci di motori diversi: con sette motori diventava
 * illeggibile, e nulla impediva di scegliere una voce che il motore attivo non
 * sa rendere. Qui il secondo dropdown mostra solo cio' che il primo puo'
 * davvero pronunciare.
 *
 * Il valore scambiato col chiamante resta la stringa `engine:voce` gia' usata
 * dal resto della GUI, cosi' le persone e le config esistenti non cambiano
 * forma. `onChange` riceve anche i due pezzi separati, per chi ne ha bisogno.
 */

export interface VoicePickerProps {
  /** Valore corrente come `engine:voce` (o solo `voce`: si deduce il motore). */
  value: string;
  onChange: (value: string, engine: string, voice: string) => void;
  disabled?: boolean;
  /**
   * Lingua della conversazione (ISO 639-1). I motori che non la dichiarano NON
   * spariscono — restano scegliibili e vengono solo segnalati: nasconderli
   * faceva sembrare mancanti dal menu motori installati e funzionanti, e la
   * lingua dichiarata è un'indicazione, non un divieto.
   */
  filterLang?: string;
  /** Etichette sopra i due dropdown; assenti = nessuna etichetta. */
  labelEngine?: string;
  labelVoice?: string;
  className?: string;
  /** Catalogo gia' caricato dal chiamante: evita una GET per ogni picker. */
  models?: TtsModel[];
  /**
   * Motore IMPOSTO dal chiamante: il dropdown dei motori sparisce e restano
   * solo le sue voci. Serve dove il motore lo decide gia' un altro comando
   * (es. il selettore del motore ATTIVO): due dropdown per la stessa cosa
   * confondono, e le voci degli altri motori non sarebbero pronunciabili.
   */
  engineLocked?: string;
}

/** Spezza `engine:voce`; senza `:` il motore e' ignoto e lo si deduce dopo. */
export function splitVoiceValue(value: string): { engine: string; voice: string } {
  const v = value ?? "";
  const i = v.indexOf(":");
  return i < 0 ? { engine: "", voice: v }
               : { engine: v.slice(0, i), voice: v.slice(i + 1) };
}

export const VoicePicker: React.FC<VoicePickerProps> = ({
  value, onChange, disabled, filterLang, labelEngine, labelVoice, className,
  models: modelsProp, engineLocked,
}) => {
  const { t } = useTranslation();
  const [models, setModels] = useState<TtsModel[]>(modelsProp ?? []);
  const [engine, setEngine] = useState("");
  const [voice, setVoice] = useState("");

  useEffect(() => {
    if (modelsProp) { setModels(modelsProp); return; }
    listTtsModels().then((m) => setModels(m.models ?? [])).catch(() => {});
  }, [modelsProp]);

  // Motori utilizzabili: tutti quelli presenti su disco.
  const disponibili = useMemo(
    () => models.filter((m) => m.is_downloaded), [models]);

  // Il motore dichiara la lingua richiesta? `langs` vuoto = nessun vincolo
  // dichiarato (Piper: dipende dai modelli installati).
  const parlaLingua = (m: TtsModel) =>
    !filterLang || !m.langs?.length ||
    m.langs.includes(filterLang.toLowerCase().split("-")[0]);

  // Allinea lo stato interno al valore che arriva da fuori. Se il motore non e'
  // indicato (voce salvata "nuda"), si prende il primo motore che ce l'ha:
  // le configurazioni esistenti continuano a mostrare la voce giusta.
  useEffect(() => {
    const { engine: e, voice: v } = splitVoiceValue(value);
    // Motore imposto: comanda lui, qualunque motore risulti dal valore salvato
    // (che puo' riferirsi a un motore non piu' attivo).
    if (engineLocked) { setEngine(engineLocked); setVoice(v); return; }
    // Vale anche con la sola parte motore ("cosyvoice:", cioe' motore di solo
    // cloning senza campioni): si tiene il MOTORE scelto invece di ripiegare
    // sul primo del catalogo, che riportava il selettore a Kokoro.
    if (e) { setEngine(e); setVoice(v); return; }
    if (!v) { setEngine((prev) => prev || disponibili[0]?.id || ""); setVoice(""); return; }
    const trovato = disponibili.find((m) => m.voices?.some((x) => x.voice === v));
    setEngine(trovato?.id ?? disponibili[0]?.id ?? "");
    setVoice(v);
  }, [value, disponibili, engineLocked]);

  const voci = useMemo(
    () => disponibili.find((m) => m.id === engine)?.voices ?? [], [disponibili, engine]);

  // Col motore imposto, cambiarlo lascia quasi sempre una voce che il nuovo
  // motore non ha: si passa alla prima sua voce e lo si comunica al chiamante,
  // altrimenti resterebbe salvata una voce che nessuno sa pronunciare.
  useEffect(() => {
    if (!engineLocked || !voci.length) return;
    if (voci.some((x) => x.voice === voice)) return;
    const prima = voci[0].voice;
    setVoice(prima);
    onChange(`${engineLocked}:${prima}`, engineLocked, prima);
    // `onChange` cambia identità a ogni render nei chiamanti: tenerlo fuori
    // dalle dipendenze evita un ciclo di aggiornamenti.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineLocked, voci, voice]);

  const cambiaMotore = (nuovo: string) => {
    setEngine(nuovo);
    // La voce corrente quasi mai esiste nel nuovo motore: si passa alla prima
    // disponibile invece di lasciare un valore che non sa pronunciare.
    const prime = disponibili.find((m) => m.id === nuovo)?.voices ?? [];
    const nuovaVoce = prime.some((x) => x.voice === voice)
      ? voice : (prime[0]?.voice ?? "");
    setVoice(nuovaVoce);
    // Anche SENZA voci si conserva il motore ("motore:"). Emettere "" faceva
    // salvare una voce VUOTA, e al giro dopo l'effetto qui sotto ripiegava sul
    // primo motore del catalogo: scegliendo un motore di solo cloning senza
    // campioni (CosyVoice, Dia, Chatterbox) il selettore tornava da solo a
    // Kokoro, e il manifest dell'identita' restava con `voice: {}`.
    onChange(`${nuovo}:${nuovaVoce}`, nuovo, nuovaVoce);
  };

  const cambiaVoce = (nuova: string) => {
    setVoice(nuova);
    onChange(`${engine}:${nuova}`, engine, nuova);
  };

  const etichettaMotore = (m: TtsModel) => {
    const lingue = m.langs?.length
      ? ` · ${m.langs.slice(0, 4).join("/")}${m.langs.length > 4 ? "…" : ""}`
      : "";
    // La velocita' e' l'informazione che decide se un motore e' usabile in una
    // conversazione dal vivo: sotto 1x l'audio arriva piu' lento del parlato.
    const vel = m.realtime ? ` · ${m.realtime}×` : "";
    const avviso = parlaLingua(m) ? "" : ` · ${t("voicePicker.noLang", {
      defaultValue: "non dichiara {{lingua}}", lingua: filterLang })}`;
    return `${m.name}${lingue}${vel}${avviso}`;
  };

  const etichettaVoce = (v: { voice: string; lang: string; language: string }) =>
    v.lang ? `${v.voice} (${v.lang})`
           : v.language === "clonata" ? `${v.voice} (${t("voicePicker.cloned",
               { defaultValue: "clonata" })})` : v.voice;

  return (
    <div className={`flex flex-col gap-2 ${className ?? ""}`}>
      {!engineLocked && (
        <div className="flex items-center gap-2 flex-wrap">
          {labelEngine && (
            <span className="text-xs text-text/60 shrink-0">{labelEngine}</span>
          )}
          <Select
            className="min-w-[13rem] flex-1"
            value={engine}
            onChange={cambiaMotore}
            disabled={disabled}
            options={disponibili.map((m) => ({ value: m.id, label: etichettaMotore(m) }))}
            placeholder={t("voicePicker.enginePh", { defaultValue: "Motore TTS" })}
          />
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        {labelVoice && (
          <span className="text-xs text-text/60 shrink-0">{labelVoice}</span>
        )}
        <Select
          className="min-w-[13rem] flex-1"
          value={voice}
          onChange={cambiaVoce}
          disabled={disabled || !voci.length}
          options={voci.map((v) => ({ value: v.voice, label: etichettaVoce(v) }))}
          placeholder={voci.length
            ? t("voicePicker.voicePh", { defaultValue: "Voce" })
            : t("voicePicker.noVoices", { defaultValue: "nessuna voce disponibile" })}
        />
      </div>
    </div>
  );
};
