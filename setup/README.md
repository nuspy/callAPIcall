# Setup

## Kokoro TTS — `setup_kokoro.py`

Prepara il motore TTS Kokoro usato da Handy:
1. installa `kokoro-onnx` + `numpy` nel Python che Handy invoca a runtime
2. scarica i modelli Kokoro in `Handy-API/src-tauri/resources/models/`

```bash
# verifica lo stato
python setup/setup_kokoro.py --check

# fa tutto: dipendenze + modelli (variante int8, la piu' leggera)
python setup/setup_kokoro.py --all --variant int8

# solo le dipendenze, in un Python specifico
python setup/setup_kokoro.py --install-deps --python C:\path\to\python.exe

# solo i modelli, scegliendo la variante
python setup/setup_kokoro.py --download --variant fp16
```

### Varianti del modello

| Variante | File | Dimensione | Note |
|----------|------|-----------|------|
| `full`   | `kokoro-v1.0.onnx`      | ~310 MB | f32, qualita' massima |
| `fp16`   | `kokoro-v1.0.fp16.onnx` | ~169 MB | f16, buon compromesso |
| `int8`   | `kokoro-v1.0.int8.onnx` | ~88 MB  | int8, piu' leggero e veloce |

`voices-v1.0.bin` (~27 MB, 26 voci) viene scaricato sempre.

L'helper di Handy accetta qualsiasi `kokoro*.onnx`: si possono tenere piu'
varianti nella stessa cartella (ne usa una sola, la prima in ordine alfabetico).

> Se la release upstream cambia, aggiornare gli URL in cima a `setup_kokoro.py`.

## Build di Handy (libclang)

LLVM 22 (scoop) rompe `whisper-rs-sys`. Vedi `../HANDY_EXTENSION.md` per il
fix con `libclang==18.1.1` via `LIBCLANG_PATH`.

Fonti modelli: [kokoro-onnx releases](https://github.com/thewh1teagle/kokoro-onnx/releases)
