/**
 * Orchestrazione del turno/sessione vocale lato app.
 *
 * L'uscita audio scelta determina il comportamento:
 *  - VIVA VOCE (speaker): a turni (eco con l'altoparlante).
 *      HOLD     -> bufferizza mentre premi, invia al rilascio.
 *      DRAG-UP  -> turno "continuous" in streaming (fine su pausa lato backend).
 *  - AURICOLARE / BLUETOOTH: full-duplex (parla e ascolti insieme).
 *      Il pulsante ATTIVA/DISATTIVA la comunicazione (sessione continua).
 */
import { toast } from "sonner";
import { Capacitor } from "@capacitor/core";
import { Camera, CameraResultType, CameraSource } from "@capacitor/camera";
import { GatewayClient, type TurnMode, type MediaMsg } from "./gateway";
import { MicCapture, AudioPlayer } from "./audio";
import { VisemePlayer, type TimelineVisemi } from "./visemePlayer";
import { Wav2LipPlayer } from "./wav2lipPlayer";
import { setAudioOutput, clearAudioOutput, type AudioOutputMode } from "./audioOutput";
import { useChat } from "@/store/chat";
import type { AppSettings } from "./settings";

/**
 * Chiede H.264 come primo codec video.
 *
 * Non e' per la banda (VP8 misurato a 430 kbit/s, H.264 a 882) ma per il
 * DECODER: H.264 ha l'accelerazione hardware su ogni telefono Android, mentre
 * VP8 finisce spesso in software — ed e' li' che il video comincia a
 * singhiozzare, con la CPU del telefono al massimo e la batteria che si
 * scarica. Il gateway impone la stessa preferenza sulla sua risposta, cosi'
 * l'esito non dipende dall'ordine in cui i due lati elencano i codec.
 *
 * Se qualcosa non torna non si tocca nulla e si lascia decidere la
 * negoziazione: un video in VP8 e' comunque meglio di nessun video.
 */
function preferisciH264(tr: RTCRtpTransceiver): void {
  try {
    if (!tr.setCodecPreferences || !RTCRtpReceiver.getCapabilities) return;
    const tutti = RTCRtpReceiver.getCapabilities("video")?.codecs ?? [];
    const h264 = tutti.filter((c) => c.mimeType.toLowerCase() === "video/h264");
    if (!h264.length) return;
    // rtx ritrasmette i pacchetti persi: toglierlo peggiorerebbe il video
    // proprio dove serve di piu', cioe' su una rete instabile.
    const rtx = tutti.filter((c) => c.mimeType.toLowerCase() === "video/rtx");
    tr.setCodecPreferences([...h264, ...rtx]);
  } catch {
    /* preferenza non applicata: si prosegue con i codec predefiniti */
  }
}

export class VoiceController {
  private gw: GatewayClient | null = null;
  private mic = new MicCapture();
  private player = new AudioPlayer();
  /** Il lipsync a visemi (modo "visemi"): riceve le timeline e le anima sulla
   *  foto, agganciate all'orologio dell'audio. Pubblico così il componente
   *  VisemeAvatar può leggerlo. */
  readonly visemePlayer = new VisemePlayer();
  readonly wav2lipPlayer = new Wav2LipPlayer();
  /** Orologio del modo A: l'AudioContext del suo player, che riproduce da sé. */
  wav2lipClock = (): number => this.wav2lipPlayer.currentTime();
  //: Un pacchetto visemi è arrivato e aspetta l'inizio del suo audio.
  private visemiDaAncorare = false;
  private settings: AppSettings;

  private buffer: ArrayBuffer[] = [];
  private mode: TurnMode | null = null; // turni: null = hold in attesa
  private pc: RTCPeerConnection | null = null;      // video avatar (WebRTC)
  // Elemento su cui suona la voce quando arriva dentro il flusso WebRTC.
  // Non sta nel JSX: nasce qui perche' e' un dettaglio del trasporto, non
  // dell'interfaccia — e va APPESO al documento, perche' diverse WebView
  // Android non riproducono un MediaStream da un elemento staccato dal DOM.
  private audioEl: HTMLAudioElement | null = null;
  private videoEl: HTMLVideoElement | null = null;
  private videoAnswer: ((sdp: string) => void) | null = null;
  // Registrazione in corso (viva voce) e comunicazione aperta (auricolare).
  // Sono accessori, non campi: ogni assegnazione in giro per la classe deve
  // aggiornare `audioActive` nello store, e affidarsi al ricordarselo a mano
  // in otto punti diversi significa dimenticarsene in uno.
  private _capturing = false;
  private _duplexActive = false;

  private get capturing(): boolean { return this._capturing; }
  private set capturing(v: boolean) { this._capturing = v; this.segnalaAudio(); }
  private get duplexActive(): boolean { return this._duplexActive; }
  private set duplexActive(v: boolean) { this._duplexActive = v; this.segnalaAudio(); }

  /** Pubblica nello store se l'audio è attivo, in una delle due modalità. */
  private segnalaAudio(): void {
    useChat.getState().setAudioActive(this._capturing || this._duplexActive);
  }
  private assistantId: string | null = null;

  constructor(settings: AppSettings) {
    this.settings = settings;
  }

  updateSettings(s: AppSettings) {
    this.settings = s;
  }

  /** Il gateway ha imposto una modalità: l'interfaccia deve dirlo e salvarla. */
  onConversazioneImposta: ((modo: "turni" | "continua", motivo: string) => void) | null = null;

  get output(): AudioOutputMode {
    return this.settings.output;
  }

  /** Cambia l'uscita audio (routing nativo). Da chiamare prima di parlare. */
  async applyOutput(): Promise<void> {
    await setAudioOutput(this.settings.output);
  }

  /** L'orologio dell'audio, per il componente che disegna la bocca. */
  audioClock = (): number => this.player.currentTime();

  /** Dichiara al gateway come il client renderizza l'avatar. Da chiamare a
   *  connessione pronta e a ogni cambio nelle impostazioni. */
  declareRenderMode(): void {
    this.gw?.send({ type: "render_mode", mode: this.settings.renderMode });
  }

  private async ensureConnected(): Promise<void> {
    if (this.gw?.connected) return;
    // Ogni segmento che comincia a suonare ancora, se in attesa, la timeline
    // visemi corrispondente — allo stesso istante dell'orologio audio.
    this.player.onSegmentStart = (t0) => {
      if (this.visemiDaAncorare) {
        this.visemePlayer.ancora(t0);
        this.visemiDaAncorare = false;
      }
      this.visemePlayer.pota(t0);
    };
    const token = await this.risolviToken();
    this.gw = new GatewayClient(this.settings.gatewayUrl, token);
    this.gw.setHandlers({
      onStatus: (s) => useChat.getState().setConnected(s === "ready"),
      onVideoAnswer: (sdp) => { this.videoAnswer?.(sdp); this.videoAnswer = null; },
      onVideoState: (state, detail) => {
        // La preparazione dell'avatar dura minuti la prima volta per clip: la
        // connessione è già aperta, ma i fotogrammi arrivano solo alla fine.
        useChat.getState().setVideoState(
          state === "live" ? "" : detail || "preparo l'avatar…");
      },
      onTranscript: (text) => {
        const st = useChat.getState();
        if (this.assistantId) { st.finishAssistant(this.assistantId); this.assistantId = null; }
        // "detta e correggi": il testo non entra in conversazione, va nella
        // barra di modifica — l'agente non ha ancora visto nulla.
        if (this.mode === "transcribe") {
          st.setDraft(text || "");
          st.setPhase("idle");
          this.mode = null;
          return;
        }
        if (text) st.addUser(text);
        st.setPhase("reasoning");
      },
      onReply: (chunk) => {
        const st = useChat.getState();
        if (!this.assistantId) this.assistantId = st.startAssistant();
        st.appendAssistant(this.assistantId, chunk);
        // NON si passa a "speaking" qui: questo e' il TESTO che arriva dal
        // cervello, mentre la voce esce dopo il TTS — secondi piu' tardi. Il
        // pulsante diventava viola con l'avatar ancora muto e fermo: e' la
        // desincronizzazione fra colore, audio e labiale. Si resta in
        // "reasoning" finche' il primo segmento audio non parte davvero.
      },
      // L'avatar ha cambiato idea a meta' frase: a schermo deve restare solo
      // cio' che ha davvero pronunciato, perche' il resto non uscira' mai.
      onReplyReset: (detto) => {
        const st = useChat.getState();
        if (!this.assistantId) this.assistantId = st.startAssistant();
        st.setAssistant(this.assistantId, detto);
      },
      // Il gateway ha misurato troppa eco: la conversazione continua non
      // regge su questo apparecchio, e si torna ai turni. Non e' una
      // preferenza da negoziare — chi decide e' la misura.
      onConversazione: (modo, motivo) => {
        this.settings = { ...this.settings, conversazione: modo };
        if (modo === "turni" && this.duplexActive) void this.stopDuplex();
        this.onConversazioneImposta?.(modo, motivo);
      },
      onVisemi: (tl: TimelineVisemi) => {
        this.visemePlayer.accoda(tl);
        this.visemiDaAncorare = true;   // il prossimo segmento audio è il suo
      },
      onAudio: (pcm, rate) => {
        // Modo A (Wav2Lip on-device): il suo player genera le bocche e riproduce
        // lui l'audio, sincronizzati. Solo nell'app installata (serve il plugin
        // nativo); altrove, e negli altri modi, l'audio va al player normale.
        if (this.settings.renderMode === "wav2lip" && Capacitor.isNativePlatform()) {
          this.wav2lipPlayer.configura(
            `${this.mediaBase()}/models/wav2lip.onnx`,
            this.faceUrl(),
            `${this.mediaBase()}/models/mel_basis.bin`);
          this.wav2lipPlayer.accoda(pcm, rate);
        } else {
          this.player.enqueue(pcm, rate);
        }
      },
      // La voce comincia adesso: da qui il pulsante e' "parla", in tempo
      // con l'audio riprodotto e col labiale dell'avatar.
      // Chi risponde DAVVERO, secondo il gateway: se Hermes non e'
      // disponibile resta la chat, e l'interruttore deve dirlo invece di
      // mostrare una scelta che non e' stata applicata.
      onBrain: (b) => this.onBrainConfirmed?.(b),
      onFileOk: (nome) =>
        toast.success(`${nome} — ora parla o scrivi per mandarlo`),
      onAudioStart: () => useChat.getState().setPhase("speaking"),
      onAudioEnd: () => {
        const st = useChat.getState();
        if (st.phase === "speaking") {
          st.setPhase(this.duplexActive ? "listening" : "idle");
        }
      },
      onMedia: (m) =>
        useChat.getState().addMedia("assistant",
          { kind: m.kind, url: this.mediaUrl(m), name: m.name }),
      onTurnDone: () => {
        const st = useChat.getState();
        if (this.assistantId) { st.finishAssistant(this.assistantId); this.assistantId = null; }
        st.setPhase(this.duplexActive ? "listening" : "idle");
      },
      onInterrupt: () => {
        this.player.stop();
        this.wav2lipPlayer.reset();
        const st = useChat.getState();
        if (this.assistantId) { st.finishAssistant(this.assistantId); this.assistantId = null; }
        st.setPhase("listening");
      },
      onSessionStarted: () => useChat.getState().setPhase("listening"),
      onDone: () => {
        const st = useChat.getState();
        if (this.assistantId) { st.finishAssistant(this.assistantId); this.assistantId = null; }
        this.player.reset();
        this.wav2lipPlayer.reset();
        st.setPhase("idle");
      },
      onError: (m) => {
        useChat.getState().setPhase(this.duplexActive ? "listening" : "idle");
        toast.error(m);
      },
    });
    await this.gw.connect();
    // A connessione pronta, si dice al gateway come renderizziamo l'avatar.
    this.declareRenderMode();
  }

  // ===== VIVA VOCE: a turni (hold / drag-up) =====================

  async onPressStart(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.applyOutput();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return;
    }
    this.buffer = [];
    this.mode = null;
    this.assistantId = null;
    this.capturing = true;
    useChat.getState().setPhase("listening");
    await this.mic.start((pcm) => {
      if (this.mode === "continuous") this.gw?.sendAudio(pcm);
      else this.buffer.push(pcm);
    });
  }

  /** Il turno in corso diventa "detta e correggi": al rilascio si chiede solo
   *  la trascrizione, che l'app mostra in un campo di testo modificabile. */
  lockTranscribe(): void {
    if (!this.capturing) return;
    this.mode = "transcribe";
  }

  /** Accende il video dell'avatar. `brain`: "chat" = avatar diretto (veloce),
   *  "hermes" = agente completo (con strumenti, più lento).
   *
   *  L'app fa l'OFFERTA: crea una peer connection in sola ricezione, manda
   *  l'SDP al gateway e ne applica la risposta. Il video arriva come traccia
   *  remota, che viene appesa all'elemento <video> registrato con
   *  `bindVideo`. */
  async startVideo(brain: "chat" | "hermes"): Promise<boolean> {
    try {
      await this.ensureConnected();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return false;
    }
    this.stopVideo();
    const pc = new RTCPeerConnection({
      // Rete locale/Tailscale: i candidati host bastano, niente STUN pubblico
      // (che aggiungerebbe solo attesa a una connessione che non esce fuori).
      iceServers: [],
    });
    this.pc = pc;
    const tr = pc.addTransceiver("video", { direction: "recvonly" });
    preferisciH264(tr);
    // Audio nello STESSO flusso del video: la sincronia col labiale la fa il
    // telefono, sui timestamp RTP e i rapporti RTCP, invece di dipendere da
    // quando i frame PCM escono dal WebSocket. Il gateway aggiunge la traccia
    // solo se la vede in questa offerta, quindi chiederla qui e' anche il
    // modo in cui le due parti si accordano: senza questa riga la voce
    // continua ad arrivare in PCM, come prima.
    pc.addTransceiver("audio", { direction: "recvonly" });
    pc.ontrack = (e) => {
      if (e.track.kind === "audio") {
        this.suonaTraccia(e.track);
        return;
      }
      const el = this.videoEl;
      if (el && e.streams[0]) el.srcObject = e.streams[0];
    };
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    // Si attende la fine della raccolta ICE: il canale di segnalazione manda
    // un SDP solo, senza candidati sciolti.
    await new Promise<void>((res) => {
      if (pc.iceGatheringState === "complete") return res();
      const t = setTimeout(res, 3000);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") { clearTimeout(t); res(); }
      };
    });
    const risposta = new Promise<string>((res, rej) => {
      this.videoAnswer = res;
      setTimeout(() => rej(new Error("timeout")), 30000);
    });
    this.gw?.startVideo(pc.localDescription?.sdp ?? "", this.settings.persona, brain);
    try {
      const sdp = await risposta;
      await pc.setRemoteDescription({ type: "answer", sdp });
      return true;
    } catch {
      toast.error("Video non disponibile");
      this.stopVideo();
      return false;
    }
  }

  /** Attacca la traccia audio remota a un elemento che la suoni.
   *
   *  L'elemento <video> resta `muted` di proposito: se suonasse anche lui si
   *  sentirebbe due volte quando lo stream porta entrambe le tracce. E `play()`
   *  qui non incontra il blocco dell'autoplay perche' si arriva sempre da un
   *  tocco dell'utente (il pulsante che accende il video). */
  private suonaTraccia(track: MediaStreamTrack): void {
    if (!this.audioEl) {
      const el = document.createElement("audio");
      el.autoplay = true;
      el.setAttribute("playsinline", "");
      el.style.display = "none";
      document.body.appendChild(el);
      this.audioEl = el;
    }
    this.audioEl.srcObject = new MediaStream([track]);
    this.audioEl.play().catch(() => {
      // Autoplay negato (nessun gesto recente): la voce non e' persa, il
      // gateway la manda comunque in PCM solo se la traccia non c'e'. Qui
      // invece c'e', quindi si avvisa e si riprova al tocco successivo.
      toast.error("Tocca lo schermo per attivare l'audio");
      const riprova = () => {
        this.audioEl?.play().catch(() => undefined);
        document.removeEventListener("pointerdown", riprova);
      };
      document.addEventListener("pointerdown", riprova, { once: true });
    });
  }

  /** Chiamata quando il gateway conferma chi risponde (vedi `onBrain`). */
  onBrainConfirmed: ((brain: "chat" | "hermes") => void) | null = null;

  /** Cambia CHI risponde lasciando il flusso video dov'e'.
   *
   *  Ritorna true se il messaggio e' partito: in quel caso chi chiama NON
   *  deve riaprire il video. Con il gateway non collegato ritorna false e la
   *  scelta vale alla prossima accensione, che e' l'unica cosa sensata. */
  switchBrain(brain: "chat" | "hermes"): boolean {
    if (!this.gw?.connected) return false;
    this.gw.setBrain(brain);
    return true;
  }

  stopVideo(): void {
    if (this.pc) {
      try { this.pc.close(); } catch { /* già chiusa */ }
      this.pc = null;
    }
    if (this.audioEl) this.audioEl.srcObject = null;
    if (this.videoEl) this.videoEl.srcObject = null;
    useChat.getState().setVideoState("");
    this.gw?.stopVideo();
  }

  /** L'elemento <video> su cui appendere la traccia remota. */
  bindVideo(el: HTMLVideoElement | null): void {
    this.videoEl = el;
  }

  /** Manda un enunciato scritto (o corretto) a mano: salta microfono e STT. */
  async sendTypedText(text: string): Promise<void> {
    const t = text.trim();
    if (!t) return;
    try {
      await this.ensureConnected();
      await this.applyOutput();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return;
    }
    useChat.getState().setPhase("reasoning");
    this.gw?.sendText(t, this.settings.lang, this.settings.voice);
  }

  lockContinuous(): void {
    if (this.mode === "continuous" || !this.capturing) return;
    this.mode = "continuous";
    this.gw?.startTurn("continuous", this.settings.lang, this.settings.voice, 16000);
    for (const b of this.buffer) this.gw?.sendAudio(b);
    this.buffer = [];
  }

  async onPressEnd(): Promise<void> {
    if (!this.capturing) return;
    if (this.mode === "continuous") {
      await this.waitDoneThenStop();
      return;
    }
    // HOLD: invia tutto + end, poi stop cattura. In "transcribe" il gateway
    // restituisce la sola trascrizione e non fa rispondere l'agente.
    const soloTrascrizione = this.mode === "transcribe";
    this.gw?.startTurn("hold", this.settings.lang, this.settings.voice, 16000,
                       soloTrascrizione);
    for (const b of this.buffer) this.gw?.sendAudio(b);
    this.buffer = [];
    this.gw?.endTurn();
    await this.mic.stop();
    this.capturing = false;
  }

  private async waitDoneThenStop(): Promise<void> {
    const stop = async () => { await this.mic.stop(); this.capturing = false; };
    const unsub = useChat.subscribe((s, prev) => {
      if (prev.phase !== "idle" && s.phase === "idle") { unsub(); stop(); }
    });
    setTimeout(() => { if (this.capturing) { unsub(); stop(); } }, 90000);
  }

  // ===== AURICOLARE / BLUETOOTH: full-duplex (toggle) ============

  get isDuplexActive(): boolean {
    return this.duplexActive;
  }

  /** Attiva/disattiva la comunicazione full-duplex. Ritorna lo stato nuovo. */
  async toggleDuplex(): Promise<boolean> {
    if (this.duplexActive) {
      await this.stopDuplex();
      return false;
    }
    try {
      await this.startDuplex();
    } catch {
      return false;           // il perché l'ha già detto startDuplex
    }
    return this.duplexActive;
  }

  private async startDuplex(): Promise<void> {
    try {
      await this.ensureConnected();
      await this.applyOutput();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return;
    }
    this.assistantId = null;
    this.duplexActive = true;
    useChat.getState().setPhase("listening");
    this.gw?.startDuplex(this.settings.lang, this.settings.voice, 16000);
    try {
      await this.mic.start((pcm) => this.gw?.sendAudio(pcm)); // streaming continuo
    } catch (e) {
      // Il microfono è l'unica cosa indispensabile: senza, la sessione resta
      // "in ascolto" per sempre senza ascoltare niente — sullo schermo non
      // cambia nulla e l'avatar tace. Meglio chiuderla e dire perché.
      this.duplexActive = false;
      this.gw?.stopDuplex();
      useChat.getState().setPhase("idle");
      toast.error(e instanceof Error ? e.message : "Microfono non disponibile",
                  { duration: 8000 });
      throw e;
    }
  }

  private async stopDuplex(): Promise<void> {
    this.duplexActive = false;
    this.gw?.stopDuplex();
    await this.mic.stop();
    this.player.stop();
    useChat.getState().setPhase("idle");
    await clearAudioOutput();
  }

  // ===== MEDIA (immagini/video) =================================

  private mediaHost(): string {
    try {
      return new URL(this.settings.gatewayUrl.replace(/^ws/, "http")).hostname;
    } catch {
      return "127.0.0.1";
    }
  }

  /** Costruisce l'URL scaricabile del media (dal token+porta o URL diretto). */
  /** Il token del gateway. Se nelle impostazioni ce n'è uno vero, vince
   *  quello. Altrimenti — il caso normale, perché nessuno vuole incollare un
   *  segreto a mano — si chiede al media server, che sta sulla stessa origine
   *  della pagina (web) o sullo stesso host del gateway (app installata). È
   *  lo stesso posto da cui è arrivata la pagina, quindi non aggiunge
   *  superficie: se è pubblico, davanti c'è la basic-auth del proxy. */
  private async risolviToken(): Promise<string> {
    const t = (this.settings.token || "").trim();
    if (t && t !== "change-me-control-token") return t;
    try {
      const base = this.mediaBase();
      // `same-origin`, non `include`: nell'app installata il fetch è
      // cross-origin (la WebView è su localhost, il gateway su un altro host)
      // e il media server risponde con `Access-Control-Allow-Origin: *`, che
      // il browser rifiuta insieme a credenziali esplicite. In tailnet non
      // servono credenziali; nel caso web same-origin passano lo stesso.
      const r = await fetch(`${base}/token`, { credentials: "same-origin" });
      if (r.ok) {
        const d = await r.json();
        if (d?.token) return d.token as string;
      }
    } catch { /* rete assente: si prova col token configurato, quale che sia */ }
    return t;
  }

  /** L'origine del media server: la pagina stessa nel browser, l'host del
   *  gateway (porta 8772) nell'app installata. */
  private mediaBase(): string {
    // Il discrimine è "app installata o browser", NON il protocollo: con
    // `androidScheme: "http"` la WebView di Capacitor serve la pagina da
    // `http://localhost`, quindi guardare `window.location.protocol` faceva
    // cercare il token su localhost — la WebView stessa, non il gateway — e la
    // connessione falliva con "token di default rifiutato". Nell'app installata
    // il media server è sull'host del gateway, porta 8772.
    if (Capacitor.isNativePlatform()) {
      return `http://${this.mediaHost()}:8772`;
    }
    // Servita da web: il media server è la stessa origine (dietro lo stesso
    // proxy). Un percorso relativo resta valido sia sotto /myAi/ sia alla
    // radice di un dominio dedicato.
    return window.location.href.replace(/[^/]*$/, "").replace(/\/$/, "");
  }

  /** Immagine fissa dell'avatar, servita dal media server.
   *
   *  Si mostra quando il video è acceso ma l'audio no: l'avatar non ha nulla
   *  da dire, e un flusso WebRTC aperto per una faccia immobile consumerebbe
   *  encoder, rete e batteria del telefono senza mostrare niente di più. */
  posterUrl(): string {
    const persona = encodeURIComponent(this.settings.persona || "");
    return `${this.mediaBase()}/poster/${persona}`;
  }

  /** Posizione della bocca sul poster (modo visemi). Passa dal media server, che
   *  gira /personas al control: un solo origin, funziona anche via https. Se la
   *  persona è "quella attiva sul PC" (nome ignoto) o l'asset manca, il renderer
   *  cade sulla stima di default. */
  mouthboxUrl(): string {
    const persona = encodeURIComponent(this.settings.persona || "");
    return `${this.mediaBase()}/personas/${persona}/mouthbox`;
  }

  /** Volto ritagliato 96×96 (modo A). Via media server (proxa al control). */
  faceUrl(): string {
    const persona = encodeURIComponent(this.settings.persona || "");
    return `${this.mediaBase()}/personas/${persona}/wav2lip/face`;
  }

  /** Box del volto (modo A): come reincollare la bocca generata sul poster. */
  boxUrl(): string {
    const persona = encodeURIComponent(this.settings.persona || "");
    return `${this.mediaBase()}/personas/${persona}/wav2lip/box`;
  }

  /** Base per le API (media server, che proxa il control): relativa sul web,
   *  esplicita nell'app installata. La usano le schermate di gestione avatar. */
  apiBase(): string {
    return this.mediaBase();
  }

  mediaUrl(m: MediaMsg): string {
    if (m.url) return m.url;
    return `http://${this.mediaHost()}:${m.port ?? 8772}/media/${m.token}`;
  }

  /** Allega un file qualunque al prossimo messaggio.
   *
   *  Il file sale con un POST sul media server, non sul WebSocket: in base64
   *  costerebbe un terzo di byte in piu' e terrebbe tutto in memoria due
   *  volte. Al gateway arriva solo il percorso, che lui accetta soltanto se
   *  sta nella cartella degli allegati.
   *
   *  All'agente si passa il PERCORSO, non il contenuto: ha gli strumenti per
   *  leggere un file, e riversare un PDF nel prompt lo riempirebbe di testo
   *  che nessuno ha chiesto. */
  async attachFile(file: File): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return;
    }
    const url = `http://${this.mediaHost()}:8772/upload`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          // Il nome puo' avere accenti e spazi: in un'intestazione HTTP
          // devono essere percent-encoded, altrimenti la richiesta parte
          // malformata (e su alcune WebView non parte affatto).
          "X-Nome-File": encodeURIComponent(file.name),
        },
        body: file,
      });
      if (!res.ok) throw new Error(String(res.status));
      const r = (await res.json()) as { path: string; name: string };
      this.gw?.sendFile(r.path);
      useChat.getState().addMedia("user", {
        kind: "file", url, name: r.name,
      });
    } catch (e) {
      toast.error("Allegato non inviato");
      console.warn("upload fallito", e);
    }
  }

  /** Scatta/sceglie un'immagine e l'allega al prossimo messaggio per Hermes. */
  async attachImage(): Promise<void> {
    try {
      await this.ensureConnected();
    } catch (e) {
      toast.error(e instanceof Error ? `Connessione fallita: ${e.message}` : "Connessione fallita");
      return;
    }
    try {
      const photo = await Camera.getPhoto({
        quality: 80,
        resultType: CameraResultType.Base64,
        source: CameraSource.Prompt, // chiede: fotocamera o galleria
      });
      if (!photo.base64String) return;
      const mime = `image/${photo.format || "jpeg"}`;
      this.gw?.sendImage(photo.base64String, mime);
      useChat.getState().addMedia("user", {
        kind: "image",
        url: `data:${mime};base64,${photo.base64String}`,
      });
      toast.success("Immagine allegata — ora parla per inviarla a Hermes");
    } catch {
      /* utente ha annullato la selezione */
    }
  }

  async cancel(): Promise<void> {
    await this.mic.stop();
    this.capturing = false;
    if (this.duplexActive) { this.gw?.stopDuplex(); this.duplexActive = false; }
    this.player.stop();
    useChat.getState().setPhase("idle");
  }
}
