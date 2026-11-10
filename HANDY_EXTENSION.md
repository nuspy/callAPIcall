# Estensione di Handy — motore STT/TTS in streaming

Modifiche fatte a `C:\Projects\Handy-API` per trasformarlo nel motore
STT/TTS della "sessione di chiamata". Handy resta un motore puro: non tocca
mai il Bluetooth (l'audio lo gestisce il call-bridge).

## File aggiunti / modificati

| File | Tipo | Cosa |
|---|---|---|
| `src-tauri/src/call_stream.rs` | **nuovo** | WebSocket `/stt/stream` e `/tts/stream` |
| `src-tauri/src/tts.rs` | **nuovo** | `KokoroTts`: wrapper sull'helper Python |
| `src-tauri/resources/kokoro_tts_helper.py` | **nuovo** | helper persistente basato su `kokoro-onnx` |
| `src-tauri/src/api.rs` | modificato | `ApiState` pub + campi; rotte `/stt/stream` `/tts/stream` |
| `src-tauri/src/lib.rs` | modificato | `mod call_stream; mod tts;` + risoluzione path |
| `src-tauri/Cargo.toml` | modificato | feature `ws` aggiunta ad axum |

Stato: **compila** (`cargo check --release`, 0 warning nei file nuovi).

## Protocollo WebSocket

**`/stt/stream`** — call-bridge → Handy: PCM binario f32 LE mono 16 kHz.
Handy → call-bridge: JSON `ready` / `speech_start` / `utterance` / `error`.

**`/tts/stream`** — call-bridge → Handy: JSON `config` / `text` (chunk) /
`flush` / `end`. Handy → call-bridge: `ready`, poi per ogni frase
`audio_start` + frame binario PCM f32 + `audio_end`. Sintesi per-frase: lo
streaming parte dopo la prima frase, non a fine risposta.

## Build di Handy

LLVM 22 (scoop) rompe `whisper-rs-sys`. Compilare con libclang 18:

```powershell
python -m pip install "libclang==18.1.1"
$env:LIBCLANG_PATH = "C:\Users\atain\AppData\Local\Programs\Python\Python310\lib\site-packages\clang\native"
cd C:\Projects\Handy-API\src-tauri
cargo build --release        # oppure: bun run tauri build
```

## Setup TTS Kokoro

**Kokoro e' integrato nel ModelManager di Handy come engine di prima classe.**

1. **Dipendenze Python** (kokoro-onnx + numpy): le installa automaticamente
   l'installer (`installer/install.ps1`), oppure manualmente:
   ```
   pip install kokoro-onnx numpy
   ```
2. **Modelli Kokoro**: si scaricano dalla **UI di Handy** -> Settings ->
   Models, esattamente come Whisper/Parakeet. Le card disponibili sono:
   - `kokoro-v1.0-int8` (88 MB) — raccomandato, veloce
   - `kokoro-v1.0-fp16` (169 MB) — qualita' migliore
   - `kokoro-v1.0` (310 MB) — qualita' massima
   - `kokoro-voices` (27 MB) — file delle 26 voci (auto-scaricato con
     qualunque variante)
3. I file finiscono in `%APPDATA%\com.pais.handy\models\` (la stessa cartella
   dei modelli Whisper) — `lib.rs` punta `tts_model_dir` li'.

Voce italiana di default: `if_sara` (lingua `it`), sovrascrivibile via il
messaggio `config` sul WebSocket `/tts/stream`.

Il dropdown STT del selettore modelli filtra automaticamente i modelli
Kokoro (sono TTS, non STT).

## Note / TODO

- L'helper Python e' un processo persistente per sessione: il modello si
  carica una volta sola.
- Path nativo-Rust per Kokoro (`kokoroxide`) lasciato come ottimizzazione
  futura: per ora il subprocess Python e' piu' robusto e verificabile.
- Resta da fare: refactor del call-bridge al modello a stream, che usa
  `HandySttClient` + `HandyTtsClient` (gia' scritti in `call-bridge/callbridge/`).
