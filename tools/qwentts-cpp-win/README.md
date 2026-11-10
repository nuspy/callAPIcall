# qwentts-cpp-python per Windows (CUDA 13)

[qwentts-cpp-python](https://github.com/andimarafioti/qwentts-cpp-python) è il binding
Python di [qwentts.cpp](https://github.com/ServeurpersoCom/qwentts.cpp), il runtime
C++/GGML di Qwen3-TTS. Serve a `faster-qwen3-tts` per usare i modelli
**quantizzati GGUF** (`backend="ggml"`). Upstream pubblica le wheel solo per Linux
(CUDA) e macOS (Metal); questa cartella costruisce quella **Windows**, distribuibile.

## Perché ne vale la pena

Misure su RTX 5090, Qwen3-TTS 0.6B, voce clonata, in streaming:

| runtime | primo audio | velocità | VRAM |
|---|---|---|---|
| torch BF16 (faster-qwen3-tts) | 0,23 s | 3,7× tempo reale | ~4,2 GB |
| **GGUF Q8_0 (questa wheel)** | **0,05 s** | **~16× tempo reale** | **~2,5 GB** |

Anche il primo caricamento è più rapido: ~3 s contro ~27 s, perché non ci sono
CUDA graph da catturare.

## Build

```powershell
.\build-wheel.ps1                                  # -> dist\qwentts_cpp_python-0.5.0+cu13win-py3-none-win_amd64.whl
.\build-wheel.ps1 -CudaArchs "120"                 # solo RTX 50xx: build più rapida
.\build-wheel.ps1 -Install ..\..\tts-venvs\dia     # costruisce, installa e prova
```

Requisiti di build:
- **Visual Studio 2026** con il toolset **MSVC 14.44**: nvcc 13.1 rifiuta il 14.51.
- **CUDA Toolkit 13.x**.
- **Ninja e CMake.**
- **Git.**

Revisioni fissate:
- binding `v0.5.0`;
- qwentts.cpp `6fae929`. Il binding rifiuta qualunque altra revisione della
  libreria nativa.

Architetture CUDA: `75;80;86;89;120`, cioè dalle RTX 20xx alle RTX 50xx, più l'A100.

## Cosa cambia rispetto a upstream (`patch_windows.py`)

1. **Runtime CUDA esterno.** Il runtime CUDA non è nella wheel: `cublasLt64_13.dll`
   da sola pesa 450 MB. È dichiarato come dipendenza (`nvidia-cuda-runtime`,
   `nvidia-cublas` da PyPI, i pacchetti ufficiali NVIDIA), e il binding aggiunge
   `site-packages\nvidia\cu13\bin\x86_64` alla ricerca delle DLL. In ripiego usa
   `%CUDA_PATH%\bin`.
2. **`ggml-cuda.dll` precaricata** su win32, come le altre DLL ggml.
3. **Versione locale `+cu13win`**, per non confonderla con le wheel ufficiali.

## Distribuzione

La wheel pesa ~180 MB: contiene `qwen.dll` e `ggml-cuda.dll` compilata per 5
architetture. Si installa con pip come qualunque altra, e pip porta da solo il
runtime CUDA. Sulla macchina di destinazione serve un **driver NVIDIA con
supporto CUDA 13 (≥ 580)**.

Per il motore Qwen3-TTS completo di callAPIcall c'è
`tools\tts-engines\setup-qwen3tts.ps1 -Wheel <file o URL>`.

Licenze:
- **qwentts.cpp e il binding:** MIT;
- **cudart e cuBLAS:** non sono nella wheel, li installa pip dai pacchetti NVIDIA.
