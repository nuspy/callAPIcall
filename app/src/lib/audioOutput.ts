import { registerPlugin } from "@capacitor/core";

export type AudioOutputMode = "speaker" | "earpiece" | "bluetooth";

interface AudioOutputPlugin {
  setOutput(options: { mode: AudioOutputMode }): Promise<{ ok: boolean; mode: string }>;
  clear(): Promise<void>;
}

const AudioOutput = registerPlugin<AudioOutputPlugin>("AudioOutput");

/** Instrada l'uscita audio sul dispositivo scelto (no-op su web). */
export async function setAudioOutput(mode: AudioOutputMode): Promise<void> {
  try {
    await AudioOutput.setOutput({ mode });
  } catch {
    /* web/dev o plugin assente: ignora */
  }
}

export async function clearAudioOutput(): Promise<void> {
  try {
    await AudioOutput.clear();
  } catch {
    /* ignora */
  }
}

// `isDuplex` non c'e' piu'. Derivava il modo di conversare dall'uscita audio —
// duplex solo in cuffia o Bluetooth — perche' a vivavoce l'avatar si risentiva
// dal microfono e si interrompeva da solo. Quella era una toppa al posto della
// cancellazione d'eco: ora il vivavoce gira in MODE_IN_COMMUNICATION, che
// ingaggia l'AEC di piattaforma, e la voce arriva sulla traccia WebRTC, che e'
// l'unico percorso che Chrome sorveglia. Come si conversa lo sceglie l'utente
// (`settings.conversazione`), non l'altoparlante che sta usando.
