import { Capacitor } from "@capacitor/core";
import { Preferences } from "@capacitor/preferences";
import type { AudioOutputMode } from "./audioOutput";

export interface AppSettings {
  /** URL del voice gateway, es. ws://100.x.y.z:8771 (IP Tailscale del PC). */
  gatewayUrl: string;
  /** Token condiviso (gateway_auth_token lato backend). */
  token: string;
  /** Lingua di default per STT/TTS. */
  lang: string;
  /** Voce TTS (es. im_nicola, if_sara, af_heart...). */
  voice: string;
  /** Uscita audio: dove esce la voce. NON decide come si conversa — i due
   *  assi erano confusi, e il vivavoce si trovava a turni per forza. */
  output: AudioOutputMode;
  /** Come si conversa: "turni" (si parla a turno, premendo) oppure "continua"
   *  (ci si parla sopra, il sistema decide cosa farne). Sono due, non tre: il
   *  vivavoce e' un percorso audio, non un modo di conversare. */
  conversazione: "turni" | "continua";
  /** Come si renderizza l'avatar: "musetalk" (video generato dal PC),
   *  "visemi" (la foto animata sul dispositivo sui tempi che manda il PC),
   *  "wav2lip" (lipsync neurale sul dispositivo — quando sarà pronto). */
  renderMode: "musetalk" | "visemi" | "wav2lip";
  /** Avatar da mostrare nel video (nome persona lato bridge). "" = quello già
   *  caricato sul PC. */
  persona: string;
  /** Versione dello schema salvato. Serve a distinguere una SCELTA dell'utente
   *  da un default di ieri: senza, il primo salvataggio congela per sempre i
   *  default del momento, e un default cambiato dopo non raggiunge mai chi ha
   *  già usato l'app. È esattamente quel che è successo con `conversazione`:
   *  salvata come "turni" quando quello era il default, e rimasta "turni"
   *  anche dopo che la conversazione continua è diventata il modo normale. */
  v?: number;
}

const KEY = "callapicall.settings";

export const DEFAULT_SETTINGS: AppSettings = {
  // IP Tailscale del PC che ospita Handy + il voice gateway (forexgpt-rtx5090).
  gatewayUrl: "ws://127.0.0.1:8771",
  token: "change-me-control-token",
  lang: "it",
  voice: "im_nicola",
  output: "speaker",
  // Continua, non a turni: ora che c'è la cancellazione d'eco e che le frasi
  // sovrapposte vengono classificate invece di troncare la risposta, tenere
  // premuto un pulsante per parlare non serve più — si apre la conversazione
  // e si chiude, come una telefonata. Se l'eco è troppa il gateway torna ai
  // turni da solo e lo dice, quindi il default prudente non è più necessario.
  conversazione: "continua",
  // Default: il PC genera il video, com'è oggi. "visemi" alleggerisce il PC e
  // rende sul dispositivo; l'utente lo sceglie nelle impostazioni.
  renderMode: "musetalk",
  persona: "",
};

/** L'indirizzo del gateway dedotto da DOVE è stata servita questa pagina.
 *
 *  Nell'app installata il gateway è un indirizzo fisso, scritto nelle
 *  impostazioni. Nel browser no: la pagina arriva già da un server che sa
 *  parlare col bridge, e quel server è l'unico che il browser vede di sicuro —
 *  attraverso la tailnet, la LAN o il reverse proxy di casa, a seconda di come
 *  ci si è arrivati. Dedurlo invece di chiederlo toglie di mezzo l'errore più
 *  probabile: aprire la pagina da fuori e trovarla configurata su un indirizzo
 *  interno che da lì non esiste.
 *
 *  Sopra HTTPS diventa `wss://` per forza: un browser rifiuta un WebSocket in
 *  chiaro aperto da una pagina sicura, e lo rifiuta in silenzio. */
export function gatewayDaOrigine(): string | null {
  if (typeof window === "undefined" || Capacitor.isNativePlatform()) return null;
  const { protocol, hostname, pathname } = window.location;
  if (!hostname) return null;
  if (protocol === "https:") {
    // Il WebSocket sta ACCANTO alla pagina, non a un percorso fisso: la
    // stessa build viene servita sotto `/myAi/` dal bridge e alla radice da un
    // proxy con un dominio suo, e in quel caso un `/myAi/ws` cablato
    // punterebbe a un percorso che quel proxy non conosce.
    const dir = pathname.replace(/[^/]*$/, "");      // .../  (via il file)
    return `wss://${hostname}${dir}ws`;
  }
  // In chiaro si va dritti alla porta del gateway: è il caso della tailnet e
  // della LAN, dove non c'è nessun proxy in mezzo.
  return `ws://${hostname}:8771`;
}

/** Versione corrente dello schema. Si alza quando un default cambia in modo
 *  che deve raggiungere anche chi ha già delle impostazioni salvate. */
const VERSIONE = 2;

export async function loadSettings(): Promise<AppSettings> {
  const dedotto = gatewayDaOrigine();
  const base = dedotto ? { ...DEFAULT_SETTINGS, gatewayUrl: dedotto }
                       : { ...DEFAULT_SETTINGS };
  const { value } = await Preferences.get({ key: KEY });
  if (!value) return base;
  let salvato: Partial<AppSettings> = {};
  try {
    salvato = JSON.parse(value);
  } catch {
    return base;
  }
  const unione = { ...base, ...salvato };
  if ((salvato.v ?? 0) < VERSIONE) {
    // Migrazione: i campi che erano solo un default vecchio tornano al nuovo.
    // `conversazione` è il caso per cui questa versione esiste — chi ha usato
    // l'app quando il push-to-talk era il default se lo ritrovava addosso —
    // mentre l'indirizzo del gateway, nel browser, lo sa dire meglio l'origine
    // della pagina di quanto lo sapesse il valore scritto mesi fa.
    unione.conversazione = DEFAULT_SETTINGS.conversazione;
    if (dedotto) unione.gatewayUrl = dedotto;
    unione.v = VERSIONE;
    void saveSettings(unione);
  }
  return unione;
}

export async function saveSettings(s: AppSettings): Promise<void> {
  await Preferences.set({ key: KEY,
                          value: JSON.stringify({ ...s, v: VERSIONE }) });
}
