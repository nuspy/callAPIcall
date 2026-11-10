import { Video, VideoOff } from "lucide-react";
import { useTranslation } from "react-i18next";

/** Chi risponde quando il video è acceso. */
export type VideoMode = "off" | "chat" | "hermes";

/**
 * Accensione del video dell'avatar: un tocco accende, un altro spegne.
 *
 * CHI risponde non si sceglie più qui. Prima lo decideva la durata del tocco
 * (breve = chat, lungo = Hermes): un gesto invisibile, che non diceva mai quale
 * dei due fosse attivo e che si attivava per sbaglio a chi esitava. Ora c'è uno
 * switch esplicito accanto (BrainSwitch) e questo pulsante usa la sua scelta.
 *
 * Il pulsante dichiara solo l'INTENZIONE: non apre più lui la connessione. Il
 * flusso WebRTC parte quando si attiva anche l'audio — fino ad allora si vede
 * la posa fissa dell'avatar. Ad accendere e spegnere davvero è App, che è il
 * solo punto a vedere insieme intenzione, audio e cervello scelto.
 */
export function VideoButton({
  mode,
  brain,
  onMode,
}: {
  mode: VideoMode;
  brain: "chat" | "hermes";
  onMode: (m: VideoMode) => void;
}) {
  const { t } = useTranslation();
  const acceso = mode !== "off";

  const premi = () => onMode(acceso ? "off" : brain);

  const etichetta = acceso
    ? t("videoOn", { defaultValue: "video acceso" })
    : t("videoOff", { defaultValue: "video spento" });

  return (
    <button
      // Stessa impronta delle altre icone della barra (36 px), con l'icona a
      // 27 px come le altre: qui il video è un comando fra gli altri, non più
      // il pulsante gigante che rubava spazio all'avatar.
      className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
        acceso ? "bg-accent text-white" : "bg-panel text-slate-400"
      }`}
      onClick={premi}
      aria-label={etichetta}
      aria-pressed={acceso}
      title={etichetta}
    >
      {acceso ? <Video size={20} /> : <VideoOff size={20} />}
    </button>
  );
}
