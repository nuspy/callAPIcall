/**
 * Client del voice gateway (vedi callbridge/voice_gateway.py).
 * Un turno per volta: auth -> ready, poi per ogni turno start -> audio ->
 * (end | pausa) -> transcript/reply/audio -> done.
 */

/** "transcribe" non e' un modo del protocollo: e' interno all'app e viaggia
 *  come `hold` con `transcribe_only`. Sta qui perche' il controller lo usa
 *  come stato del turno in corso. */
export type TurnMode = "hold" | "continuous" | "transcribe";

export interface MediaMsg {
  kind: "image" | "video" | "file";
  name?: string;      // nome originale del file, quando c'e'
  url?: string;       // media già come URL
  token?: string;     // oppure token da servire dal media server
  port?: number;
  mime?: string;
}

import type { TimelineVisemi } from "./visemePlayer";

export interface GatewayHandlers {
  onTranscript?: (text: string) => void;            // cosa ha detto l'utente
  onReply?: (chunk: string) => void;                // risposta di Hermes, a pezzi
  /** La risposta e' stata riscritta: `detto` e' cio' che e' stato pronunciato
   *  davvero, e il resto va buttato. Senza questo, a schermo resterebbe la
   *  continuazione vecchia — testo che nessuno ha sentito ne' sentira'. */
  onReplyReset?: (detto: string) => void;
  /** Il gateway impone un cambio di modalità (tipicamente: troppa eco). */
  onConversazione?: (modo: "turni" | "continua", motivo: string) => void;
  /** Timeline dei visemi per il prossimo segmento audio (modo visemi). */
  onVisemi?: (tl: TimelineVisemi) => void;
  /** Conferma del motore di rendering scelto. */
  onRenderMode?: (mode: string) => void;
  onAudio?: (pcm16: ArrayBuffer, sampleRate: number) => void; // audio risposta
  /** La voce comincia DAVVERO a uscire (primo segmento sintetizzato). */
  onAudioStart?: (sampleRate: number) => void;
  /** Fine della voce: il turno smette di "parlare". */
  onAudioEnd?: () => void;
  onMedia?: (m: MediaMsg) => void;                  // immagine/video generati da Hermes
  onVideoAnswer?: (sdp: string) => void;            // risposta SDP per il video avatar
  onBrain?: (brain: "chat" | "hermes") => void;   // chi risponde, confermato
  onFileOk?: (name: string) => void;              // allegato preso in carico
  onVideoStopped?: () => void;                      // il gateway ha spento il video
  onVideoState?: (state: string, detail: string) => void;  // preparazione avatar / live
  onDone?: () => void;                              // turno/sessione finiti
  onTurnDone?: () => void;                          // duplex: fine di un turno (resta in sessione)
  onInterrupt?: () => void;                         // duplex: barge-in, scarta l'audio in coda
  onSessionStarted?: () => void;                    // duplex: sessione full-duplex avviata
  onError?: (message: string) => void;
  onStatus?: (s: "connecting" | "ready" | "closed") => void;
}

export class GatewayClient {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly token: string;
  private lastError = "";
  private handlers: GatewayHandlers = {};
  private pendingAudioRate = 24000;
  private readyResolve: (() => void) | null = null;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  setHandlers(h: GatewayHandlers) {
    this.handlers = h;
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Apre la connessione e attende auth_ok + ready. */
  connect(): Promise<void> {
    this.handlers.onStatus?.("connecting");
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      this.readyResolve = () => {
        if (!settled) { settled = true; resolve(); }
      };

      ws.onopen = () => ws.send(JSON.stringify({ type: "auth", token: this.token }));
      ws.onmessage = (ev) => this.onMessage(ev);
      ws.onerror = () => {
        if (!settled) { settled = true; reject(new Error("connessione fallita")); }
        this.handlers.onError?.("errore di connessione");
      };
      ws.onclose = () => {
        this.handlers.onStatus?.("closed");
        if (!settled) {
          settled = true;
          reject(new Error(this.lastError || "connessione chiusa"));
        }
      };
      setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("timeout connessione")); }
      }, 8000);
    });
  }

  private onMessage(ev: MessageEvent) {
    if (ev.data instanceof ArrayBuffer) {
      this.handlers.onAudio?.(ev.data, this.pendingAudioRate);
      return;
    }
    let msg: any;
    try { msg = JSON.parse(ev.data as string); } catch { return; }
    switch (msg.type) {
      case "ready":
        this.handlers.onStatus?.("ready");
        this.readyResolve?.();
        break;
      case "transcript": this.handlers.onTranscript?.(msg.text ?? ""); break;
      case "video_answer": this.handlers.onVideoAnswer?.(msg.sdp ?? ""); break;
      case "brain": this.handlers.onBrain?.(msg.brain === "hermes" ? "hermes" : "chat"); break;
      case "file_ok": this.handlers.onFileOk?.(msg.name ?? ""); break;
      case "video_stopped": this.handlers.onVideoStopped?.(); break;
      case "video_state":
        this.handlers.onVideoState?.(msg.state ?? "", msg.detail ?? "");
        break;
      case "reply": this.handlers.onReply?.(msg.chunk ?? ""); break;
      // La risposta e' stata riscritta a meta': quel che si vede a schermo da
      // qui in poi non verra' mai pronunciato. Il testo giusto e' quello che
      // l'avatar ha DAVVERO detto, e la continuazione si accoda a quello.
      case "reply_reset": this.handlers.onReplyReset?.(msg.text ?? ""); break;
      // Modo "visemi": la timeline delle forme di bocca per il segmento audio
      // che sta per arrivare. Il client anima la foto in locale.
      case "visemi": this.handlers.onVisemi?.(msg as unknown as TimelineVisemi); break;
      case "render_mode":
        this.handlers.onRenderMode?.(msg.mode ?? "musetalk");
        break;
      // Il gateway ha misurato troppa eco e torna ai turni: non e' una
      // preferenza che si puo' ignorare, e' una condizione dell'apparecchio.
      case "conversazione":
        this.handlers.onConversazione?.(
          msg.modo === "continua" ? "continua" : "turni", msg.motivo ?? "");
        break;
      case "audio_start":
        this.pendingAudioRate = msg.sample_rate ?? 24000;
        this.handlers.onAudioStart?.(this.pendingAudioRate);
        break;
      case "audio_end": this.handlers.onAudioEnd?.(); break;
      case "media": this.handlers.onMedia?.(msg as MediaMsg); break;
      case "turn_done": this.handlers.onTurnDone?.(); break;
      case "interrupt": this.handlers.onInterrupt?.(); break;
      case "session_started": this.handlers.onSessionStarted?.(); break;
      case "done": this.handlers.onDone?.(); break;
      case "error":
        // Un errore prima del ready (tipicamente "auth fallita") deve far
        // fallire la connect() con quel motivo, non con un generico "chiuso".
        this.lastError = msg.message ?? "errore";
        this.handlers.onError?.(this.lastError);
        break;
    }
  }

  /** `transcribeOnly`: il gateway restituisce la sola trascrizione e si ferma,
   *  senza far rispondere l'agente. Serve alla modalità "detta e correggi". */
  startTurn(mode: TurnMode, lang: string, voice: string, sampleRate: number,
            transcribeOnly = false) {
    // Al gateway va sempre un modo del protocollo: "transcribe" e' un'etichetta
    // interna e viaggia come "hold" con il flag.
    const proto = mode === "transcribe" ? "hold" : mode;
    this.send({ type: "start", mode: proto, lang, voice,
                sample_rate: sampleRate, transcribe_only: transcribeOnly });
  }

  sendAudio(pcm16: ArrayBuffer) {
    if (this.connected) this.ws!.send(pcm16);
  }

  /** Invia un'immagine (base64) da allegare al prossimo messaggio per Hermes. */
  /** Segnala un file GIA' caricato sul media server (POST /upload).
   *
   *  Il file non passa da questo WebSocket: in base64 costerebbe un terzo di
   *  byte in piu' e terrebbe tutto in memoria due volte, il che su un video si
   *  sente. Qui viaggia solo il percorso che l'upload ha restituito. */
  sendFile(path: string) {
    this.send({ type: "file", path });
  }

  sendImage(dataB64: string, mime: string) {
    this.send({ type: "image", data: dataB64, mime });
  }

  /** Solo modalità hold: segnala fine del turno (pulsante rilasciato). */
  /** Chiede il video dell'avatar: manda l'offerta SDP, il gateway risponde
   *  con `video_answer`. `brain`: "chat" = avatar diretto, "hermes" = agente. */
  /** Cambia CHI risponde senza toccare il flusso video.
   *
   *  La scelta viaggiava solo nell'handshake (`video_start`), quindi passare
   *  da Chat a Hermes voleva dire chiudere e riaprire la connessione: riquadro
   *  nero, nuova negoziazione ICE, primo fotogramma da riaspettare. Questo
   *  messaggio la cambia a caldo; il gateway risponde con `brain` confermando
   *  chi risponde davvero (se Hermes non e' disponibile resta quello che c'e').
   *  Vale dal turno successivo: una risposta in corso arriva intera. */
  setBrain(brain: "chat" | "hermes") {
    this.send({ type: "brain", brain });
  }

  startVideo(sdp: string, persona: string, brain: "chat" | "hermes") {
    this.send({ type: "video_start", sdp, sdp_type: "offer", persona, brain });
  }

  stopVideo() {
    this.send({ type: "video_stop" });
  }

  /** Manda un enunciato già scritto (testo corretto a mano): niente microfono. */
  sendText(text: string, lang: string, voice: string) {
    this.send({ type: "text", text, lang, voice });
  }

  endTurn() {
    this.send({ type: "end" });
  }

  /** Full-duplex (auricolare/bluetooth): apre una sessione continua. */
  startDuplex(lang: string, voice: string, sampleRate: number) {
    this.send({ type: "start", duplex: true, lang, voice, sample_rate: sampleRate });
  }

  /** Full-duplex: chiude la sessione (pulsante disattivato). */
  stopDuplex() {
    this.send({ type: "stop" });
  }

  close() {
    this.send({ type: "close" });
    this.ws?.close();
    this.ws = null;
  }

  send(obj: unknown) {
    if (this.connected) this.ws!.send(JSON.stringify(obj));
  }
}
