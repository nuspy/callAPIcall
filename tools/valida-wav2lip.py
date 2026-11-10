"""Il modello Wav2Lip scaricato produce un lipsync corretto? (validazione modo A, sul PC)

Prima di portare Wav2Lip sul telefono — giorni di lavoro — si verifica QUI che
il modello e il formato degli input siano giusti: poster + audio veri ->
un video con la bocca che si muove sul parlato. Se funziona, il modo A e'
validato e vale l'integrazione mobile; se il formato e' sbagliato, lo si
scopre adesso, non dopo.

Il pezzo delicato e' il mel spectrogram: Wav2Lip usa parametri suoi (16 kHz,
n_fft 800, hop 200, 80 bande, normalizzazione simmetrica a +-4). Sbagliarli
da' un output plausibile ma desincronizzato. Sono replicati da `audio.py` di
Wav2Lip, che e' l'unico riferimento che conta.

    python tools/valida-wav2lip.py --audio call-bridge/turni/<uno>.wav
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

import cv2
import numpy as np

# --- mel spectrogram, parametri e formule di Wav2Lip (audio.py) --------------
SR = 16000
N_FFT = 800
HOP = 200
WIN = 800
N_MELS = 80
FMIN, FMAX = 55, 7600
PREEMPH = 0.97
REF_DB = 20
MIN_DB = -100
MAX_ABS = 4.0
FPS = 25
MEL_STEP = 16


def _preemphasis(x):
    from scipy.signal import lfilter
    return lfilter([1, -PREEMPH], [1], x)


def _mel_basis():
    import librosa
    return librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS,
                               fmin=FMIN, fmax=FMAX)


def melspectrogram(wav):
    import librosa
    D = librosa.stft(y=_preemphasis(wav), n_fft=N_FFT, hop_length=HOP,
                     win_length=WIN)
    S = np.dot(_mel_basis(), np.abs(D))
    S = 20 * np.log10(np.maximum(1e-5, S)) - REF_DB          # amp->db
    # normalizzazione simmetrica a [-MAX_ABS, MAX_ABS]
    S = np.clip((2 * MAX_ABS) * ((S - MIN_DB) / (-MIN_DB)) - MAX_ABS,
                -MAX_ABS, MAX_ABS)
    return S                                                  # (80, T)


def rileva_volto(img):
    """bbox (x1,y1,x2,y2) del volto, allargata come fa Wav2Lip (padding).

    OpenCV Haar cascade: basta per un ritratto frontale, ed è già in cv2 senza
    dipendenze. Su un avatar reale (foto guidata dal wizard) il volto è frontale
    e ben illuminato, il caso più facile per Haar.
    """
    import os
    h, w = img.shape[:2]
    casc = cv2.CascadeClassifier(
        os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    facce = casc.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5,
                                  minSize=(80, 80))
    if len(facce) == 0:
        raise SystemExit("  nessun volto nel poster")
    x, y, fw, fh = max(facce, key=lambda f: f[2] * f[3])     # il più grande
    x1, y1, x2, y2 = x, y, x + fw, y + fh
    # padding: Wav2Lip prende un box più ampio (mento e fronte)
    py = int(0.35 * fh)
    px = int(0.12 * fw)
    return (max(0, x1 - px), max(0, y1 - py),
            min(w, x2 + px), min(h, y2 + py))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--poster", default="avatar/persone/Andrea_Taini/poster.jpg")
    ap.add_argument("--audio", default="call-bridge/turni/stt-000009-0185cs.wav")
    ap.add_argument("--modello", default="call-bridge/models/wav2lip.onnx")
    ap.add_argument("--out", default="C:/TEMP/claude/wav2lip-prova.mp4")
    args = ap.parse_args()

    import librosa
    import onnxruntime as ort

    img = cv2.imread(args.poster)
    if img is None:
        raise SystemExit(f"  poster non letto: {args.poster}")
    x1, y1, x2, y2 = rileva_volto(img)
    volto = img[y1:y2, x1:x2]
    face = cv2.resize(volto, (96, 96))
    print(f"  volto: bbox ({x1},{y1})-({x2},{y2}) -> 96x96")

    wav, _ = librosa.load(args.audio, sr=SR)
    mel = melspectrogram(wav)
    n_frames = int(len(wav) / SR * FPS)
    print(f"  audio {len(wav)/SR:.1f}s -> {n_frames} frame, mel {mel.shape}")

    sess = ort.InferenceSession(args.modello, providers=["CPUExecutionProvider"])

    ref = face.astype(np.float32) / 255.0                    # BGR, [0,1]
    masked = ref.copy()
    masked[96 // 2:] = 0                                      # meta' inferiore

    tmp = Path(args.out).with_suffix(".noaudio.mp4")
    vw = cv2.VideoWriter(str(tmp), cv2.VideoWriter_fourcc(*"mp4v"), FPS,
                         (x2 - x1, y2 - y1))
    mult = float(N_MELS) / FPS                                # ~3.2 mel/frame
    for i in range(n_frames):
        s = int(i * mult)
        chunk = mel[:, s:s + MEL_STEP]
        if chunk.shape[1] < MEL_STEP:
            chunk = mel[:, -MEL_STEP:]
        mel_in = chunk[np.newaxis, np.newaxis, :, :].astype(np.float32)
        vid_in = np.concatenate([masked, ref], axis=2)       # HWC, 6 canali
        vid_in = np.transpose(vid_in, (2, 0, 1))[np.newaxis].astype(np.float32)
        out = sess.run(None, {"mel": mel_in, "vid": vid_in})[0]
        gen = np.transpose(out[0], (1, 2, 0))                 # 96x96x3, [0,1]
        gen = np.clip(gen * 255, 0, 255).astype(np.uint8)
        faccia_gen = cv2.resize(gen, (x2 - x1, y2 - y1))
        vw.write(faccia_gen)
    vw.release()

    # riunisce l'audio col video (se ffmpeg c'e')
    try:
        subprocess.run(["ffmpeg", "-y", "-i", str(tmp), "-i", args.audio,
                        "-c:v", "libx264", "-c:a", "aac", "-shortest", args.out],
                       capture_output=True, timeout=120, check=True)
        tmp.unlink(missing_ok=True)
        print(f"  video con audio: {args.out}")
    except Exception:
        print(f"  video (senza audio): {tmp}")
    print("  Guarda il video: la bocca deve muoversi in sincrono col parlato.")
    print("  Se la bocca si muove ma e' sfasata, il mel e' sbagliato.")
    print("  Se e' immobile o storpiata, il formato input e' sbagliato.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
