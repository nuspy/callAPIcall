/**
 * Cattura microfono (PCM16 mono 16 kHz, in streaming) e riproduzione dei
 * segmenti audio TTS che arrivano dal gateway. Usa la Web Audio API (funziona
 * nella WebView Capacitor con permesso microfono).
 */

const STT_RATE = 16000;

function floatToPcm16(float32: Float32Array): ArrayBuffer {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out.buffer;
}

/**
 * Ricampionatore lineare che sopravvive ai confini dei chunk.
 *
 * Tiene la posizione frazionaria e i campioni non ancora consumati: senza,
 * ogni blocco ripartirebbe da zero e introdurrebbe un microsalto ogni 4096
 * campioni — abbastanza da sporcare il riconoscimento.
 */
class Ricampionatore {
  private pos = 0;
  private coda = new Float32Array(0);

  constructor(private readonly da: number, private readonly a: number) {}

  push(input: Float32Array): Float32Array {
    if (this.da === this.a) return input;
    const buf = new Float32Array(this.coda.length + input.length);
    buf.set(this.coda);
    buf.set(input, this.coda.length);
    const passo = this.da / this.a;
    const out: number[] = [];
    let p = this.pos;
    while (p + 1 < buf.length) {
      const i = Math.floor(p);
      const f = p - i;
      out.push(buf[i] * (1 - f) + buf[i + 1] * f);
      p += passo;
    }
    const consumati = Math.floor(p);
    this.coda = buf.slice(consumati);
    this.pos = p - consumati;
    return Float32Array.from(out);
  }
}

export class MicCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private rs: Ricampionatore | null = null;

  /** Avvia la cattura; `onChunk` riceve PCM16 LE mono @16kHz. */
  async start(onChunk: (pcm16: ArrayBuffer) => void): Promise<void> {
    // Fuori da un contesto sicuro il browser non NEGA il microfono: non
    // espone nemmeno l'API. `navigator.mediaDevices` è `undefined` su una
    // pagina `http://` che non sia localhost, e il codice qui sotto
    // fallirebbe con un "cannot read property of undefined" che non dice
    // niente a nessuno. Visto dal vivo: la sessione partiva, l'interfaccia
    // diceva "in ascolto", il gateway registrava "nessun campione audio
    // ricevuto dall'app" e l'avatar restava muto.
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        window.isSecureContext
          ? "Questo browser non espone il microfono."
          : "Il microfono richiede una connessione sicura: apri questa pagina "
            + "in https (o da localhost).",
      );
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        // Il guadagno automatico serve alla conversazione continua: è ciò che
        // tiene la voce dell'utente sopra la soglia del VAD quando parla
        // lontano dal telefono, che è la posizione normale in vivavoce.
        autoGainControl: true,
      },
    });
    // Si CHIEDE un contesto a 16 kHz, ma la WebView Android è libera di
    // ignorare la richiesta e aprirlo al rate hardware (di norma 48 kHz).
    // Se poi dichiariamo 16000 al gateway, Whisper riceve la voce rallentata
    // di 3x e trascrive sillabe ripetute ("mi senti" -> "sen sen sen").
    // Quindi: si legge il rate REALE e si ricampiona qui.
    this.ctx = new AudioContext({ sampleRate: STT_RATE });
    const reale = this.ctx.sampleRate;
    if (reale !== STT_RATE) {
      console.log(`[mic] contesto a ${reale} Hz invece di ${STT_RATE}: ricampiono`);
    }
    this.rs = new Ricampionatore(reale, STT_RATE);
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = this.ctx.createScriptProcessor(4096, 1, 1);
    this.node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      onChunk(floatToPcm16(this.rs!.push(data)));
    };
    this.source.connect(this.node);
    this.node.connect(this.ctx.destination); // necessario perché onaudioprocess parta
  }

  async stop(): Promise<void> {
    try { this.node?.disconnect(); } catch {}
    try { this.source?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { await this.ctx?.close(); } catch {}
    this.node = null; this.source = null; this.stream = null; this.ctx = null;
    this.rs = null;
  }
}

/** Riproduce in coda i segmenti PCM16 ricevuti dal gateway (24 kHz Kokoro). */
export class AudioPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private sources = new Set<AudioBufferSourceNode>();
  /** Chiamato quando un segmento comincia a suonare, con l'istante d'inizio
   *  nell'orologio dell'AudioContext. Serve al lipsync a visemi per ancorare
   *  la timeline della bocca all'audio, sullo stesso orologio. */
  onSegmentStart: ((t0: number) => void) | null = null;

  /** L'orologio dell'audio (AudioContext.currentTime), o 0 se non c'è. */
  currentTime(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // Margine di sicurezza (s) per il primo chunk / dopo un underrun: evita
  // glitch quando i frame arrivano con jitter di rete (streaming continuo).
  private static readonly LEAD = 0.12;

  enqueue(pcm16: ArrayBuffer, sampleRate: number): void {
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    if (ctx.state === "suspended") void ctx.resume();
    const i16 = new Int16Array(pcm16);
    if (i16.length === 0) return;
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, sampleRate);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const now = ctx.currentTime;
    // Se siamo rimasti senza audio (nextStart nel passato), riparti con un
    // piccolo lead; altrimenti accoda esattamente dopo l'ultimo (gapless).
    if (this.nextStart < now) this.nextStart = now + AudioPlayer.LEAD;
    src.start(this.nextStart);
    // Prima di avanzare: `this.nextStart` è l'istante in cui QUESTO segmento
    // comincia. È quello a cui va agganciata la timeline dei visemi.
    this.onSegmentStart?.(this.nextStart);
    this.nextStart += buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Interrompe subito tutto l'audio in riproduzione/coda (barge-in). */
  stop(): void {
    for (const s of this.sources) {
      try { s.stop(); } catch { /* già fermato */ }
    }
    this.sources.clear();
    this.nextStart = 0;
  }

  reset(): void {
    this.nextStart = 0;
  }
}
