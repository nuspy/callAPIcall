# Handy TTS Protocol & Voices

## WebSocket Endpoint

`ws://127.0.0.1:8720/tts/stream`

## Protocol

1. Connect → server sends `{"type": "ready"}`
2. Client sends `{"type": "config", "voice": "if_sara", "lang": "it", "speed": 1.0}`
3. Client sends `{"type": "text", "chunk": "text to synthesize"}`
4. Client sends `{"type": "flush"}` — forces synthesis of buffered text
5. Client sends `{"type": "end"}` — signals end of input
6. Server sends `{"type": "audio_start", "sample_rate": 24000}` before each audio segment
7. Server sends binary frame: PCM float32 LE mono at 24000 Hz
8. Server sends `{"type": "audio_end"}` after each segment

Multiple segments per utterance are normal (one per sentence/clause).

## Output Format

- **PCM float32 little-endian mono**
- **Sample rate**: 24000 Hz
- Convert to int16: `np.clip(samples * 32767, -32768, 32767).astype(np.int16)`
- WAV: 1 channel, 2 bytes/sample, 24000 Hz

## Model Files

| File | Size | Note |
|------|------|------|
| `kokoro-v1.0.onnx` | 325 MB | Modello originale (fp32) — massima qualità |
| `kokoro-v1.0.fp16.onnx` | 177 MB | Modello fp16 — buona qualità, più veloce |
| `kokoro-v1.0.int8.onnx` | 92 MB | Modello int8 — più veloce, qualità leggermente inferiore |
| `voices-v1.0.bin` | 28 MB | File voci condiviso — **contiene 54 voci** |

Posizione: `%APPDATA%\com.pais.handy\models\`

### Quale modello ONNX usare?

Tutti e tre i modelli (fp32, fp16, int8) usano lo **stesso file voices-v1.0.bin** con 54 voci. La differenza è solo qualità audio vs velocità/VRAM. Il modello ONNX non determina il numero di voci.

### Handy mostra solo 17 voci

Handy espone solo un sottoinsieme delle 54 voci disponibili nel file `voices-v1.0.bin`. Per vedere tutte le voci, interrogare `kokoro_onnx` direttamente:

```python
from kokoro_onnx import Kokoro
kokoro = Kokoro(onnx_path, voices_path)
print(sorted(kokoro.voices.files))  # → 54 voci
```

È possibile usare qualsiasi voce del file bin inviandola nel messaggio `config` del WebSocket TTS, anche se Handy non la elenca.

## Available Voices — Kokoro v1.0 (ALL 54 voices in voices-v1.0.bin)

### 🇺🇸 English US (20 voices)

| Voice | Gender |
|-------|--------|
| af_alloy | F |
| af_aoede | F |
| af_bella | F |
| af_heart | F |
| af_jessica | F |
| af_kore | F |
| af_nicole | F |
| af_nova | F |
| af_river | F |
| af_sarah | F |
| af_sky | F |
| am_adam | M |
| am_echo | M |
| am_eric | M |
| am_fenrir | M |
| am_liam | M |
| am_michael | M |
| am_onyx | M |
| am_puck | M |
| am_santa | M |

### 🇬🇧 English UK (8 voices)

| Voice | Gender |
|-------|--------|
| bf_alice | F |
| bf_emma | F |
| bf_isabella | F |
| bf_lily | F |
| bm_daniel | M |
| bm_fable | M |
| bm_george | M |
| bm_lewis | M |

### 🇫🇷 Français (1 voice)

| Voice | Gender |
|-------|--------|
| ff_siwis | F |

### 🇪🇸 Español (3 voices)

| Voice | Gender |
|-------|--------|
| ef_dora | F |
| em_alex | M |
| em_santa | M |

### 🇮🇹 Italiano (2 voices)

| Voice | Gender |
|-------|--------|
| if_sara | F |
| im_nicola | M |

### 🇧🇷 Português (3 voices)

| Voice | Gender |
|-------|--------|
| pf_dora | F |
| pm_alex | M |
| pm_santa | M |

### 🇯🇵 Nihongo (5 voices)

| Voice | Gender |
|-------|--------|
| jf_alpha | F |
| jf_gongitsune | F |
| jf_nezumi | F |
| jf_tebukuro | F |
| jm_kumo | M |

### 🇨🇳 Zhongwen (8 voices)

| Voice | Gender |
|-------|--------|
| zf_xiaobei | F |
| zf_xiaoni | F |
| zf_xiaoxiao | F |
| zf_xiaoyi | F |
| zm_yunjian | M |
| zm_yunxi | M |
| zm_yunxia | M |
| zm_yunyang | M |

### 🇮🇳 Hindi (4 voices)

| Voice | Gender |
|-------|--------|
| hf_alpha | F |
| hf_beta | F |
| hm_omega | M |
| hm_psi | M |

## Lingue NON supportate da Kokoro

- ❌ **Ungherese (hu)** — nessuna voce disponibile
- ❌ Tedesco, russo, arabo, coreano, olandese, polacco, turco, ceco, svedese, finlandese, ecc.

### Opzioni per ungherese locale

1. **Piper TTS** — modelli ungheresi disponibili, girano localmente. Si può aggiungere come secondo command provider in Hermes.
2. **Edge TTS `hu-HU-NoemiNeural`** — cloud Microsoft, gratuito, ma non locale (non "nostro").

## Model Loading

- TTS non è caricato all'avvio dell'orchestrator
- Eseguire `callctl.py prepare` per caricare modelli in VRAM
- STT (modello `large`) è sempre caricato
- TTS si carica alla prima chiamata se non fatto `prepare`
- Dopo unload TTS (`callctl.py unload --component tts`), le voci tornano 17 (Handy le ricarica dalla sua lista interna). Per usare voci extra, specificarle direttamente nel WebSocket config.
