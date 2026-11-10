/**
 * Riproduttore del modo A (Wav2Lip on-device) nel flusso di conversazione.
 *
 * A differenza del modo "visemi" — dove i fotogrammi-bocca sono forme
 * disegnate, istantanee — qui ogni fotogramma lo genera Wav2Lip, che sul
 * telefono va a ~16 fps: più lento del tempo reale (25 fps). Non si può quindi
 * mostrare la bocca "in diretta" mentre l'audio dello stesso segmento suona.
 *
 * La strategia: i segmenti audio (una frase l'uno) si mettono in coda; per ognuno
 * si generano PRIMA le bocche e POI si riproduce l'audio, così bocca e voce
 * restano in fase. Il prezzo è una latenza pari al tempo di generazione del primo
 * segmento (~1,5× la sua durata); i segmenti seguenti si generano mentre i
 * precedenti suonano.
 *
 * Invariante di sicurezza: la VOCE non deve mai mancare. Finché il runtime non è
 * pronto (modello 145 MB da scaricare la prima volta), i segmenti si riproducono
 * lisci, senza bocca; le bocche compaiono dai segmenti che arrivano dopo che il
 * runtime è pronto. Se la generazione fallisce, si riproduce comunque l'audio.
 */
import { preparaRuntime, generaTurno, type FrameBocca } from "./wav2lipRuntime";

interface SegmentoPronto {
  t0: number;              // istante di inizio nell'orologio di questo AudioContext
  dur: number;             // durata in secondi
  bocche: FrameBocca[];    // vuoto = riprodotto senza bocca
}

export class Wav2LipPlayer {
  private ctx: AudioContext | null = null;
  private nextStart = 0;
  private coda: { pcm: ArrayBuffer; rate: number }[] = [];
  private elaborando = false;
  private segmenti: SegmentoPronto[] = [];

  private modelUrl = "";
  private faceUrl = "";
  private basisUrl = "";
  private pronto = false;
  private preparando = false;
  onFase: ((msg: string) => void) | null = null;

  /** URL da cui prendere modello, volto e filterbank. Cambia con la persona. */
  configura(modelUrl: string, faceUrl: string, basisUrl: string): void {
    if (faceUrl !== this.faceUrl) { this.pronto = false; }  // volto diverso: riprepara
    this.modelUrl = modelUrl; this.faceUrl = faceUrl; this.basisUrl = basisUrl;
  }

  /** Avvia la preparazione del runtime (idempotente). */
  async prepara(): Promise<void> {
    if (this.pronto || this.preparando || !this.modelUrl || !this.faceUrl) return;
    this.preparando = true;
    try {
      this.pronto = await preparaRuntime(this.modelUrl, this.faceUrl,
        (m) => this.onFase?.(m));
    } catch {
      this.pronto = false;
    } finally {
      this.preparando = false;
      if (this.pronto) this.pompa();   // smaltisci ciò che è arrivato nel frattempo
    }
  }

  currentTime(): number { return this.ctx ? this.ctx.currentTime : 0; }

  /** Riceve un segmento audio (int16 @ `rate`) e lo mette in coda. */
  accoda(pcm16: ArrayBuffer, rate: number): void {
    this.coda.push({ pcm: pcm16, rate });
    if (!this.pronto && !this.preparando) void this.prepara();
    this.pompa();
  }

  private async pompa(): Promise<void> {
    if (this.elaborando) return;
    this.elaborando = true;
    try {
      while (this.coda.length) {
        const { pcm, rate } = this.coda.shift()!;
        let bocche: FrameBocca[] = [];
        if (this.pronto) {
          try {
            const f16 = ricampiona16k(pcm, rate);
            const res = await generaTurno(f16, this.basisUrl);
            if (!res.errore) bocche = res.bocche;
          } catch { /* la voce va comunque: bocche resta vuoto */ }
        }
        this.riproduci(pcm, rate, bocche);
      }
    } finally {
      this.elaborando = false;
    }
  }

  private riproduci(pcm16: ArrayBuffer, rate: number, bocche: FrameBocca[]): void {
    if (!this.ctx) this.ctx = new AudioContext();
    const ctx = this.ctx;
    const src16 = new Int16Array(pcm16);
    const buf = ctx.createBuffer(1, src16.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < src16.length; i++) ch[i] = src16[i] / 32768;
    const node = ctx.createBufferSource();
    node.buffer = buf; node.connect(ctx.destination);
    const now = ctx.currentTime;
    if (this.nextStart < now) this.nextStart = now + 0.05;
    const t0 = this.nextStart;
    node.start(t0);
    this.nextStart += buf.duration;
    this.segmenti.push({ t0, dur: buf.duration, bocche });
  }

  /** La bocca da mostrare all'istante `t` dell'orologio audio, o null. */
  boccaA(t: number): FrameBocca | null {
    for (const s of this.segmenti) {
      const dt = t - s.t0;
      if (dt >= 0 && dt < s.dur && s.bocche.length) {
        const i = Math.min(s.bocche.length - 1, Math.floor((dt / s.dur) * s.bocche.length));
        return s.bocche[i];
      }
    }
    return null;
  }

  pota(t: number): void {
    this.segmenti = this.segmenti.filter((s) => t < s.t0 + s.dur + 0.3);
  }

  reset(): void { this.segmenti = []; this.coda = []; this.nextStart = 0; }

  stop(): void {
    this.reset();
    try { this.ctx?.close(); } catch { /* già chiuso */ }
    this.ctx = null;
  }
}

/** PCM int16 @ `rate` → Float32 @ 16 kHz (quello che vuole il mel di Wav2Lip). */
function ricampiona16k(pcm16: ArrayBuffer, rate: number): Float32Array {
  const src = new Int16Array(pcm16);
  if (rate === 16000) {
    const f = new Float32Array(src.length);
    for (let i = 0; i < src.length; i++) f[i] = src[i] / 32768;
    return f;
  }
  const ratio = 16000 / rate;
  const n = Math.max(1, Math.floor(src.length * ratio));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const j = i / ratio;
    const j0 = Math.floor(j), j1 = Math.min(src.length - 1, j0 + 1), fr = j - j0;
    out[i] = (src[j0] * (1 - fr) + src[j1] * fr) / 32768;
  }
  return out;
}
