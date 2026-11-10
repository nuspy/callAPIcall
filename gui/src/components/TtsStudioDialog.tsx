import React, { useCallback, useEffect, useState } from "react";
import { Clapperboard, Square, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AudioPlayer } from "./ui/AudioPlayer";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import {
  type AvatarProgress,
  type Persona,
  avatarInterrupt,
  avatarSpeak,
  avatarStartAndWait,
  avatarStop,
  getAvatarState,
} from "@/lib/api/bridgeApi";
import { ProgressBar } from "./ui/ProgressBar";
import { type TtsModel, listTtsModels, ttsTest, wavUrlFromBase64 } from "@/lib/api/voiceEngineApi";
import { VirtualCamPreview } from "./VirtualCamPreview";
import { TtsEngineSelect } from "./TtsEngineSelect";
import { VoicePicker } from "./VoicePicker";

export const PREP_PHASE_LABEL: Record<string, string> = {
  extract: "frame extraction",
  landmark: "face landmark",
  latents: "VAE latents",
  masks: "blend masks",
};

export function formatEta(s: number): string {
  if (s < 90) return `~${Math.max(1, Math.round(s))}s`;
  return `~${Math.round(s / 60)} min`;
}

interface Props {
  /** Persona su cui si sta provando: arriva dal bottone che ha aperto il
   *  dialogo, quindi qui NON si sceglie (niente selettore di identità). */
  persona: Persona;
  onClose: () => void;
}

/**
 * Banco di prova dell'avatar di UNA persona: la si avvia, le si fa dire un
 * testo e si guarda il lip-sync, con l'anteprima solo-audio a fianco.
 *
 * Era una tab a sé ("Studio") con un proprio selettore di identità: si finiva
 * per scegliere due volte la stessa cosa, una qui e una in Persone. Ora si apre
 * dalla riga della persona e vale per quella.
 *
 * Il motore TTS scelto qui è quello ATTIVO di sistema (lo stesso di Motori
 * voce): cambiarlo NON riscrive la voce della persona, che vive nel suo
 * manifest. Le voci elencate sono quelle del motore selezionato — le altre non
 * sarebbero pronunciabili.
 */
export const TtsStudioDialog: React.FC<Props> = ({ persona, onClose }) => {
  const { t } = useTranslation();
  const [text, setText] = useState(
    "Hello! I am the avatar. This is a video synthesis test.");
  const [avatar, setAvatar] = useState<{ running: boolean; persona: string | null }>({
    running: false, persona: null,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [catalogo, setCatalogo] = useState<TtsModel[]>([]);
  const [motore, setMotore] = useState("");
  const [voce, setVoce] = useState("");
  const [lastSpeak, setLastSpeak] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [prep, setPrep] = useState<AvatarProgress | null>(null);

  useEffect(() => {
    listTtsModels()
      .then((m) => { setCatalogo(m.models ?? []); setMotore(m.selected ?? ""); })
      .catch(() => {});
  }, []);

  const refresh = useCallback(async () => {
    try { setAvatar(await getAvatarState()); } catch { /* bridge giù */ }
  }, []);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const avatarReady = avatar.running && avatar.persona === persona.name;
  const senzaClip = (persona.clip_count ?? 0) === 0;

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label); setError(null);
    try { await fn(); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(null); }
  };

  const speak = () =>
    run("speak", async () => {
      if (!avatarReady) {
        setLastSpeak(null);
        setProgress(t("studio.startingClip"));
        try {
          await avatarStartAndWait(persona.name, (s) => {
            setPrep(s.progress);
            setProgress(s.progress
              ? `Preparing: ${PREP_PHASE_LABEL[s.progress.phase] ?? s.progress.phase}...`
              : t("studio.startingClip"));
          });
        } finally { setPrep(null); setProgress(null); }
      }
      setProgress(t("studio.speaking"));
      try {
        const res = await avatarSpeak(text);
        setLastSpeak(t("studio.spokenInfo", {
          voice: res.voice ?? "?",
          dur: Math.round((res.duration_ms ?? 0) / 100) / 10,
        }));
      } finally { setProgress(null); }
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t("studio.title")}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* `bg-background`, non una classe inventata: `bg-dark-gray` non esiste
          nel tema, quindi il pannello restava trasparente e il testo si
          leggeva sopra la pagina sottostante. */}
      <div className="w-full max-w-2xl my-8 rounded-lg border border-mid-gray/30 bg-background shadow-xl p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Clapperboard width={16} height={16} className="text-logo-primary" />
          <div className="flex-1">
            <h2 className="text-sm font-medium">
              {t("studio.dialogTitle", { defaultValue: "TTS Studio — {{persona}}",
                                         persona: persona.name })}
            </h2>
            <p className="text-xs text-text/60">{t("studio.subtitle")}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close", { defaultValue: "Chiudi" })}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded hover:bg-mid-gray/20"
          >
            <X width={16} height={16} />
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {avatarReady ? (
            <Button variant="danger" size="sm" onClick={() => run("stop", avatarStop)}
                    disabled={busy !== null}>
              <span className="flex items-center gap-1">
                <Square width={12} height={12} fill="currentColor" />
                {t("studio.stopAvatar")}
              </span>
            </Button>
          ) : (
            <Button
              variant="primary-soft"
              size="sm"
              onClick={() => run("start", async () => {
                try { await avatarStartAndWait(persona.name, (s) => setPrep(s.progress)); }
                finally { setPrep(null); }
              })}
              disabled={busy !== null || senzaClip}
              title={senzaClip ? t("studio.noClip") : undefined}
            >
              <span className="flex items-center gap-1">
                <Video width={12} height={12} />
                {busy === "start" ? t("studio.startingClip") : t("studio.startAvatar")}
              </span>
            </Button>
          )}
          {avatar.running && (
            <span className="text-xs text-green-400 ms-auto">
              {t("studio.avatarActive", { persona: avatar.persona })}
            </span>
          )}
        </div>

        {/* Motore TTS attivo di sistema + le SUE voci. */}
        <TtsEngineSelect onChanged={(id) => {
          setMotore(id);
          listTtsModels().then((m) => setCatalogo(m.models ?? [])).catch(() => {});
        }} />
        <VoicePicker
          models={catalogo}
          engineLocked={motore}
          value={voce}
          onChange={(_v, _e, nome) => setVoce(nome)}
          labelVoice={t("studio.previewVoice", { defaultValue: "Voce" })}
        />

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={4}
          placeholder={t("studio.textPlaceholder")}
        />

        <div className="flex items-center gap-3 flex-wrap">
          <Button
            onClick={speak}
            disabled={busy !== null || !text.trim() || senzaClip}
            title={senzaClip ? t("studio.noClip") : undefined}
          >
            <span className="flex items-center gap-1.5">
              <Clapperboard width={14} height={14} />
              {busy === "speak" ? (progress ?? t("studio.speaking")) : t("studio.speak")}
            </span>
          </Button>
          <Button
            variant="danger-ghost"
            size="sm"
            onClick={() => avatarInterrupt().catch(() => {})}
            disabled={!avatar.running}
          >
            <span className="flex items-center gap-1">
              <Square width={12} height={12} fill="currentColor" />
              {t("studio.interrupt")}
            </span>
          </Button>
          <div className="flex items-center gap-2 flex-1 min-w-[12rem]">
            <span className="text-xs text-text/50">{t("studio.audioOnly")}</span>
            <AudioPlayer
              className="flex-1"
              resetKey={`${motore}:${voce}:${text}`}
              onLoadRequest={async () => {
                if (!text.trim()) return null;
                try {
                  const res = await ttsTest(text, {
                    voice: voce || persona.voice?.voice, engine: motore });
                  return wavUrlFromBase64(res.audio_b64);
                } catch (e) {
                  setError(e instanceof Error ? e.message : String(e));
                  return null;
                }
              }}
            />
          </div>
        </div>

        {prep && (
          <ProgressBar
            percent={prep.percent}
            label={`Preparing: ${PREP_PHASE_LABEL[prep.phase] ?? prep.phase} — ${prep.done}/${prep.total}`}
            rightLabel={prep.eta_s != null ? `ETA ${formatEta(prep.eta_s)}` : undefined}
          />
        )}
        {lastSpeak && <p className="text-xs text-green-400">{lastSpeak}</p>}
        {error && <p className="text-sm text-red-400">{error}</p>}

        <VirtualCamPreview active={avatar.running} />
      </div>
    </div>
  );
};
