import { Bot, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { VideoMode } from "./VideoButton";

/**
 * Scelta di CHI risponde: "Chat" (LLM diretto, veloce) o "Hermes" (agente
 * completo, con strumenti e skill, piu' lento al primo turno).
 *
 * Prima si sceglieva col tocco breve/lungo sul pulsante video: un gesto che
 * non si vede e che non dice mai quale dei due e' attivo. Qui e' uno switch
 * esplicito, e resta leggibile anche a video spento — cosi' si sa in anticipo
 * cosa si accendera'.
 *
 * Cambiare modalita' a video ACCESO lo riavvia sul nuovo cervello: e' la sola
 * strada, perche' la scelta viaggia nell'handshake WebRTC (`video_start`).
 */
export function BrainSwitch({
  value,
  onChange,
  disabled,
}: {
  value: "chat" | "hermes";
  onChange: (v: "chat" | "hermes") => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const OPZIONI: { id: "chat" | "hermes"; icon: typeof Zap; label: string }[] = [
    { id: "chat", icon: Zap, label: t("brainChat", { defaultValue: "Chat" }) },
    { id: "hermes", icon: Bot, label: t("brainHermes", { defaultValue: "Hermes" }) },
  ];
  return (
    <div
      className="flex items-center rounded-full bg-panel p-0.5"
      role="group"
      aria-label={t("brainSwitch", { defaultValue: "Chi risponde" })}
    >
      {OPZIONI.map(({ id, icon: Icon, label }) => {
        const attivo = value === id;
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            disabled={disabled}
            aria-pressed={attivo}
            // min-h-8 invece di un'altezza fissa: con il font ingrandito dal
            // sistema il testo cresce e il bersaglio cresce con lui, invece di
            // essere tagliato.
            className={`flex items-center gap-1 px-2.5 min-h-8 rounded-full text-xs font-medium
              transition-colors disabled:opacity-50 ${
                attivo ? "bg-accent text-white" : "text-slate-400"
              }`}
          >
            <Icon size={15} />
            {label}
          </button>
        );
      })}
    </div>
  );
}
