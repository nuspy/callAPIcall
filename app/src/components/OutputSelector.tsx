import { Ear, Volume2, Bluetooth } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { AudioOutputMode } from "@/lib/audioOutput";

const OPTIONS: { mode: AudioOutputMode; icon: typeof Ear; key: string }[] = [
  { mode: "earpiece", icon: Ear, key: "outEarpiece" },
  { mode: "speaker", icon: Volume2, key: "outSpeaker" },
  { mode: "bluetooth", icon: Bluetooth, key: "outBluetooth" },
];

export function OutputSelector({
  value,
  onChange,
}: {
  value: AudioOutputMode;
  onChange: (m: AudioOutputMode) => void;
}) {
  const { t } = useTranslation();
  return (
    // In alto nella barra dei comandi: solo icone, senza etichette. Il nome
    // dell'uscita audio si legge nel titolo accessibile, e lo stato si vede dal
    // colore — tre parole in fila mangiavano larghezza alla riga.
    <div className="flex gap-1">
      {OPTIONS.map(({ mode, icon: Icon, key }) => (
        <button
          key={mode}
          onClick={() => onChange(mode)}
          title={t(key)}
          aria-label={t(key)}
          aria-pressed={value === mode}
          className={`flex items-center justify-center w-9 h-9 rounded-lg transition-colors ${
            value === mode ? "bg-accent text-white" : "bg-panel text-slate-400"
          }`}
        >
          <Icon size={20} />
        </button>
      ))}
    </div>
  );
}
