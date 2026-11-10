import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Settings as SettingsIcon, Trash2, Wifi, WifiOff, ImagePlus, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { ChatView } from "@/components/ChatView";
import { TalkButton } from "@/components/TalkButton";
import { DraftBar } from "@/components/DraftBar";
import { VideoButton, type VideoMode } from "@/components/VideoButton";
import { AvatarVideo } from "@/components/AvatarVideo";
import { VisemeAvatar } from "@/components/VisemeAvatar";
import { Wav2LipAvatar } from "@/components/Wav2LipAvatar";
import { OutputSelector } from "@/components/OutputSelector";
import { BrainSwitch } from "@/components/BrainSwitch";
import { SettingsSheet } from "@/components/SettingsSheet";
import { VoiceController } from "@/lib/controller";
import { loadSettings, saveSettings, type AppSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import type { AudioOutputMode } from "@/lib/audioOutput";
import { useChat } from "@/store/chat";

export default function App() {
  // Stato del video avatar: "off" | "chat" | "hermes".
  const { t, i18n } = useTranslation();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [videoMode, setVideoMode] = useState<VideoMode>("off");
  // Chi risponde quando si accende il video. Vive qui e non dentro il
  // pulsante video perche' lo switch e' visibile anche a video spento: si
  // sceglie prima, e l'accensione usa quello che si e' scelto.
  const [brain, setBrain] = useState<"chat" | "hermes">("chat");
  const fileRef = useRef<HTMLInputElement>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const controllerRef = useRef<VoiceController | null>(null);
  const connected = useChat((s) => s.connected);
  const clear = useChat((s) => s.clear);
  // Il video segue l'AUDIO: acceso il riquadro, il flusso parte solo quando la
  // conversazione è davvero aperta. Finché l'audio è spento si vede la posa
  // fissa dell'avatar, che è la stessa immagine da cui il video partirebbe.
  const audioActive = useChat((s) => s.audioActive);
  const [streaming, setStreaming] = useState(false);
  // Cosa sta trasmettendo ORA ("chat"/"hermes"/null), per non riaprire un
  // flusso già aperto sullo stesso cervello a ogni render.
  const inOndaRef = useRef<VideoMode | null>(null);
  // Le accensioni e gli spegnimenti si mettono in fila invece di partire in
  // parallelo: premere il pulsante mentre l'audio cambia farebbe altrimenti
  // arrivare una `stopVideo` in mezzo a una `startVideo`, lasciando una peer
  // connection viva e nessun video.
  const codaRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    loadSettings().then((s) => {
      setSettings(s);
      i18n.changeLanguage(s.lang);
      controllerRef.current = new VoiceController(s);
      controllerRef.current.applyOutput();
      setLoaded(true);
    });
  }, []);

  const onSave = async (s: AppSettings) => {
    await saveSettings(s);
    setSettings(s);
    controllerRef.current?.updateSettings(s);
    setShowSettings(false);
    toast.success("OK");
  };

  const onChangeOutput = async (mode: AudioOutputMode) => {
    await controllerRef.current?.cancel(); // ferma eventuale sessione in corso
    const s = { ...settings, output: mode };
    setSettings(s);
    await saveSettings(s);
    controllerRef.current?.updateSettings(s);
    await controllerRef.current?.applyOutput();
  };

  /** Cambio di cervello, A CALDO.
   *
   *  Prima la scelta viaggiava solo nell'handshake WebRTC, quindi a video
   *  acceso il flusso veniva chiuso e riaperto: riquadro nero, nuova
   *  negoziazione ICE e primo fotogramma da riaspettare, per cambiare solo
   *  CHI risponde. Ora si manda un messaggio al gateway e il flusso resta in
   *  piedi; `inOndaRef` viene aggiornato NELLO STESSO GIRO, altrimenti
   *  l'effetto qui sotto vedrebbe `brain` diverso da quello in onda e
   *  riaprirebbe tutto, annullando il vantaggio.
   *
   *  A video spento (o gateway non collegato) non c'e' niente da avvisare: la
   *  scelta vale alla prossima accensione, come prima. */
  const onChangeBrain = (b: "chat" | "hermes") => {
    // Si avvisa il gateway anche a VIDEO SPENTO: i turni di sola voce usano
    // lo stesso cervello, e senza questo messaggio resterebbero su quello
    // scelto all'ultima accensione del video (o sul default, se il video non
    // e' mai stato acceso).
    const partito = controllerRef.current?.switchBrain(b) ?? false;
    if (partito && inOndaRef.current) inOndaRef.current = b;
    setBrain(b);
  };

  // Accende e spegne il flusso video. Un solo punto decide, incrociando le tre
  // cose che contano: il riquadro è acceso, l'audio è attivo, e con che
  // cervello. Prima lo faceva il pulsante, che però l'audio non lo vedeva.
  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    // Nei modi renderizzati SUL DISPOSITIVO (visemi e wav2lip) l'avatar lo
    // disegna il telefono: niente WebRTC da negoziare, il flusso video del PC
    // resta spento.
    const onDevice = settings.renderMode === "visemi" || settings.renderMode === "wav2lip";
    const voluto: VideoMode | null =
      videoMode !== "off" && audioActive && !onDevice ? brain : null;
    if (voluto === inOndaRef.current) return;
    codaRef.current = codaRef.current.then(async () => {
      if (voluto === inOndaRef.current) return;   // superato mentre si attendeva
      if (inOndaRef.current) {
        c.stopVideo();
        inOndaRef.current = null;
        setStreaming(false);
      }
      if (!voluto) return;
      const ok = await c.startVideo(voluto);
      inOndaRef.current = ok ? voluto : null;
      setStreaming(ok);
      if (!ok) setVideoMode("off");             // fallito: anche il riquadro giù
    });
  }, [videoMode, audioActive, brain, loaded, settings.renderMode]);

  // Il gateway ha l'ultima parola su chi risponde: se Hermes non c'e',
  // l'interruttore torna su Chat invece di mostrare una scelta non applicata.
  useEffect(() => {
    const c = controllerRef.current;
    if (!c) return;
    c.onBrainConfirmed = (b) => setBrain(b);
    // Se il gateway misura troppa eco torna ai turni: si salva la scelta e la
    // si spiega, altrimenti l'utente vede il pulsante cambiare senza capire.
    c.onConversazioneImposta = (modo, motivo) => {
      setSettings((s) => {
        const nuovo = { ...s, conversazione: modo };
        void saveSettings(nuovo);
        return nuovo;
      });
      if (motivo) toast(motivo, { duration: 6000 });
    };
    return () => {
      c.onBrainConfirmed = null;
      c.onConversazioneImposta = null;
    };
  }, [loaded]);

  // Contesto sicuro: `isSecureContext` è vero su https e su localhost, e in
  // un'app installata (Capacitor serve da un'origine locale). Si guarda anche
  // `mediaDevices` perché è quello che manca davvero.
  const secureOk = typeof navigator !== "undefined"
    && !!navigator.mediaDevices?.getUserMedia;

  if (!loaded || !controllerRef.current) return null;

  return (
    <div className="h-full flex flex-col bg-bg">
      {/* Nel browser, fuori da una connessione sicura, il microfono NON
          esiste: non è negato, è che l'API non c'è. Senza questo avviso la
          pagina sembra funzionare — dice "in ascolto" — e non arriva un solo
          campione al gateway. Va detto appena si apre, non al primo tentativo
          di parlare. */}
      {!secureOk && (
        <div className="safe-top px-3 py-2 text-[13px] leading-snug bg-amber-900/40
                        text-amber-200 border-b border-amber-800">
          Il microfono richiede una connessione sicura. Apri questa pagina in
          <span className="font-semibold"> https</span> (lo stesso indirizzo con
          https, oppure il nome della tailnet): in http il browser non lo
          espone affatto.
        </div>
      )}
      {/* Barra comandi: al posto del titolo c'e' l'accensione del video, poi
          le uscite audio, chi risponde, e le azioni. Le icone passano da 18 a
          27 px (+50%): a 18 erano bersagli scomodi su schermo stretto. */}
      <header className="safe-top flex items-center gap-2 px-3 py-2 border-b border-slate-800">
        <VideoButton mode={videoMode} brain={brain} onMode={setVideoMode} />
        <OutputSelector value={settings.output} onChange={onChangeOutput} />
        <BrainSwitch value={brain} onChange={onChangeBrain} />
        <div className="flex items-center gap-2.5 ms-auto">
          <span className={connected ? "text-emerald-400" : "text-slate-500"} title={connected ? t("connected") : t("disconnected")}>
            {connected ? <Wifi size={27} /> : <WifiOff size={27} />}
          </span>
          <button onClick={() => controllerRef.current?.attachImage()} aria-label={t("attachImage")}><ImagePlus size={27} className="text-slate-400" /></button>
          {/* Allega un file qualunque. L'<input> e' nascosto e comandato dal
              pulsante: su Android apre il selettore di sistema, quindi vale
              anche per i documenti su Drive o sulla scheda SD, che un plugin
              di sola galleria non vedrebbe. */}
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              // Si azzera SUBITO: senza, riallegare lo stesso file non
              // scatenerebbe `change` e il secondo invio sparirebbe in silenzio.
              e.target.value = "";
              if (f) controllerRef.current?.attachFile(f);
            }}
          />
          <button onClick={() => fileRef.current?.click()} aria-label={t("attachFile", { defaultValue: "Allega file" })}><Paperclip size={27} className="text-slate-400" /></button>
          <button onClick={clear} aria-label={t("clearChat")}><Trash2 size={27} className="text-slate-400" /></button>
          <button onClick={() => setShowSettings(true)} aria-label={t("settings")}><SettingsIcon size={27} className="text-slate-400" /></button>
        </div>
      </header>

      {/* A video acceso la chat si riduce a una striscia: lo spazio serve
          all'avatar, e il testo resta comunque scorribile. */}
      <div className={videoMode === "off" ? "flex-1 min-h-0 flex" : "h-24 shrink-0 flex"}>
        <ChatView />
      </div>

      {/* Riquadro avatar: sopra i comandi, visibile solo a video acceso.
          "visemi" e "wav2lip" (modo C e A) li anima il dispositivo; negli altri
          modi arriva il video WebRTC dal PC (AvatarVideo). */}
      {controllerRef.current && (
        settings.renderMode === "visemi" ? (
          <VisemeAvatar
            player={controllerRef.current.visemePlayer}
            clock={controllerRef.current.audioClock}
            posterUrl={controllerRef.current.posterUrl()}
            mouthboxUrl={controllerRef.current.mouthboxUrl()}
            visible={videoMode !== "off"}
          />
        ) : settings.renderMode === "wav2lip" ? (
          <Wav2LipAvatar
            player={controllerRef.current.wav2lipPlayer}
            clock={controllerRef.current.wav2lipClock}
            posterUrl={controllerRef.current.posterUrl()}
            boxUrl={controllerRef.current.boxUrl()}
            visible={videoMode !== "off"}
          />
        ) : (
          <AvatarVideo
            controller={controllerRef.current}
            visible={videoMode !== "off"}
            streaming={streaming}
          />
        )
      )}

      {/* In basso resta SOLO il comando per parlare: e' la cosa che si preme
          senza guardare, e tutto lo spazio risparmiato va all'avatar. */}
      <footer className="safe-bottom px-4 pt-2 pb-3 border-t border-slate-800 flex flex-col gap-2">
        {controllerRef.current && <DraftBar controller={controllerRef.current} />}
        <TalkButton controller={controllerRef.current} output={settings.output}
                    conversazione={settings.conversazione} />
      </footer>

      {showSettings && (
        <SettingsSheet initial={settings} onClose={() => setShowSettings(false)} onSave={onSave} />
      )}
    </div>
  );
}
