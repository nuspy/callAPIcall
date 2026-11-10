/**
 * Mel spectrogram di Wav2Lip, in TypeScript.
 *
 * Wav2Lip vuole il suo mel esatto (16 kHz, n_fft 800, hop 200, finestra Hann
 * periodica, 80 bande 55-7600 Hz, poi dB e normalizzazione simmetrica a ±4):
 * sbagliarlo dà una bocca che si muove ma fuori sincrono. Le formule sono
 * quelle di `audio.py` di Wav2Lip, verificate contro la validazione Python
 * (`tools/valida-wav2lip.py`) che ha prodotto un lipsync corretto.
 *
 * Il filterbank (80×401) non si ricalcola qui: è quello di librosa, servito
 * come `mel_basis.bin` dal bridge, così combacia al bit con Python. La STFT usa
 * una DFT diretta sui soli 401 bin reali — non è la parte calda (il mel si
 * calcola una volta per segmento audio, non per fotogramma), e una DFT è
 * corretta senza le insidie di una FFT a dimensione non-potenza-di-due.
 */

const SR = 16000;
const N_FFT = 800;
const HOP = 200;
const N_BIN = N_FFT / 2 + 1; // 401
const N_MELS = 80;
const PREEMPH = 0.97;
const REF_DB = 20;
const MIN_DB = -100;
const MAX_ABS = 4;

// Tabelle DFT precalcolate: cos/sin per ogni (bin, campione). ~640k float,
// costruite una volta.
let COS: Float32Array | null = null;
let SIN: Float32Array | null = null;
function tabelle(): void {
  if (COS) return;
  COS = new Float32Array(N_BIN * N_FFT);
  SIN = new Float32Array(N_BIN * N_FFT);
  for (let k = 0; k < N_BIN; k++) {
    for (let n = 0; n < N_FFT; n++) {
      const a = (-2 * Math.PI * k * n) / N_FFT;
      COS[k * N_FFT + n] = Math.cos(a);
      SIN[k * N_FFT + n] = Math.sin(a);
    }
  }
}

// Finestra di Hann periodica (fftbins=True di scipy/librosa).
let HANN: Float32Array | null = null;
function hann(): Float32Array {
  if (HANN) return HANN;
  HANN = new Float32Array(N_FFT);
  for (let n = 0; n < N_FFT; n++) HANN[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / N_FFT);
  return HANN;
}

/** Carica il filterbank servito dal bridge (una volta). */
export async function caricaMelBasis(url: string): Promise<Float32Array> {
  const buf = await (await fetch(url)).arrayBuffer();
  return new Float32Array(buf); // 80*401, riga per mel
}

/**
 * Da PCM float32 mono @16kHz al mel di Wav2Lip: matrice [80 x T], appiattita
 * riga-per-riga (mel 0 prima), pronta a essere affettata in finestre da 16.
 */
export function melspectrogram(wav: Float32Array, basis: Float32Array): {
  mel: Float32Array; frames: number;
} {
  tabelle();
  const w = hann();

  // preemphasis: y[n] - 0.97 y[n-1]
  const pe = new Float32Array(wav.length);
  pe[0] = wav[0];
  for (let n = 1; n < wav.length; n++) pe[n] = wav[n] - PREEMPH * wav[n - 1];

  // STFT centrata: reflect pad di N_FFT/2 su entrambi i lati (come librosa).
  const pad = N_FFT / 2;
  const x = new Float32Array(pe.length + 2 * pad);
  for (let i = 0; i < pad; i++) x[i] = pe[pad - i];
  x.set(pe, pad);
  for (let i = 0; i < pad; i++) x[pad + pe.length + i] = pe[pe.length - 2 - i];

  const frames = 1 + Math.floor((x.length - N_FFT) / HOP);
  const mel = new Float32Array(N_MELS * frames);

  const mag = new Float32Array(N_BIN);
  const framebuf = new Float32Array(N_FFT);
  for (let t = 0; t < frames; t++) {
    const off = t * HOP;
    for (let n = 0; n < N_FFT; n++) framebuf[n] = x[off + n] * w[n];
    // |STFT|: DFT sui 401 bin reali
    for (let k = 0; k < N_BIN; k++) {
      let re = 0, im = 0;
      const base = k * N_FFT;
      for (let n = 0; n < N_FFT; n++) {
        const v = framebuf[n];
        re += v * COS![base + n];
        im += v * SIN![base + n];
      }
      mag[k] = Math.sqrt(re * re + im * im);
    }
    // mel = basis · |STFT|, poi dB e normalizzazione simmetrica
    for (let m = 0; m < N_MELS; m++) {
      let s = 0;
      const brow = m * N_BIN;
      for (let k = 0; k < N_BIN; k++) s += basis[brow + k] * mag[k];
      let db = 20 * Math.log10(Math.max(1e-5, s)) - REF_DB;
      db = ((2 * MAX_ABS) * ((db - MIN_DB) / -MIN_DB)) - MAX_ABS;
      mel[m * frames + t] = Math.min(MAX_ABS, Math.max(-MAX_ABS, db));
    }
  }
  return { mel, frames };
}
