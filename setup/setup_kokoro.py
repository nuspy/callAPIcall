"""Setup del motore TTS Kokoro per Handy.

Due funzioni:
  1. installa le dipendenze Python (kokoro-onnx, numpy) nel Python che Handy
     invochera' a runtime;
  2. scarica i modelli Kokoro scelti in
     Handy-API/src-tauri/resources/models/.

Uso:
  python setup_kokoro.py --check
      verifica cosa e' gia' installato/scaricato
  python setup_kokoro.py --install-deps [--python PYEXE]
      pip install kokoro-onnx numpy nel Python indicato (default: "python")
  python setup_kokoro.py --download [--variant full|fp16|int8]
      scarica la variante scelta del modello + voices-v1.0.bin
  python setup_kokoro.py --all [--variant int8] [--python PYEXE]
      installa le dipendenze e scarica i modelli

Note:
  - Gli URL dei modelli sono in MODEL_VARIANTS / VOICES_URL qui sotto: se la
    release upstream cambia, aggiornarli qui.
  - L'helper di Handy (kokoro_tts_helper.py) accetta qualsiasi file
    kokoro*.onnx, quindi le varianti mantengono il nome originale.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
import urllib.request
from pathlib import Path

# Release upstream dei modelli (github.com/thewh1teagle/kokoro-onnx).
_BASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"

MODEL_VARIANTS: dict[str, dict] = {
    "full": {
        "filename": "kokoro-v1.0.onnx",
        "url": f"{_BASE}/kokoro-v1.0.onnx",
        "approx_mb": 310,
        "desc": "f32, qualita' massima",
    },
    "fp16": {
        "filename": "kokoro-v1.0.fp16.onnx",
        "url": f"{_BASE}/kokoro-v1.0.fp16.onnx",
        "approx_mb": 169,
        "desc": "f16, buon compromesso qualita'/dimensione",
    },
    "int8": {
        "filename": "kokoro-v1.0.int8.onnx",
        "url": f"{_BASE}/kokoro-v1.0.int8.onnx",
        "approx_mb": 88,
        "desc": "int8, piu' leggero e veloce",
    },
}
VOICES_FILENAME = "voices-v1.0.bin"
VOICES_URL = f"{_BASE}/{VOICES_FILENAME}"


def default_models_dir() -> Path:
    """Cerca dove l'Handy in esecuzione cerca i modelli.

    Ordine di preferenza:
      1. installazione NSIS per utente:  %LOCALAPPDATA%\Handy\resources\models
      2. installazione MSI di sistema:    %ProgramFiles%\Handy\resources\models
      3. sviluppo dal repo:               <repo>/Handy-API/src-tauri/resources/models
    """
    import os

    candidates = []
    if local := os.environ.get("LOCALAPPDATA"):
        candidates.append(Path(local) / "Handy" / "resources" / "models")
    if pf := os.environ.get("ProgramFiles"):
        candidates.append(Path(pf) / "Handy" / "resources" / "models")
    # Repo dev fallback (setup/ -> callAPIcall/ -> Projects/).
    projects = Path(__file__).resolve().parents[2]
    candidates.append(projects / "Handy-API" / "src-tauri" / "resources" / "models")

    # Se una di queste cartelle esiste gia' (handy installato la-' o repo
    # popolato), preferiscila. Altrimenti, ritorna comunque la prima.
    for c in candidates:
        if c.parent.exists():
            return c
    return candidates[0]


def download(url: str, dest: Path) -> None:
    """Scarica `url` in `dest` mostrando una barra di avanzamento."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    print(f"  scarico {url}")
    print(f"       -> {dest}")

    def _hook(blocks: int, block_size: int, total: int) -> None:
        if total <= 0:
            return
        done = min(blocks * block_size, total)
        pct = done * 100 // total
        bar = "#" * (pct // 4) + "-" * (25 - pct // 4)
        sys.stdout.write(f"\r       [{bar}] {pct:3d}%  {done // 1_048_576} MB")
        sys.stdout.flush()

    try:
        urllib.request.urlretrieve(url, tmp, _hook)
    except Exception as e:  # noqa: BLE001
        if tmp.exists():
            tmp.unlink()
        raise RuntimeError(f"download fallito ({url}): {e}") from e
    print()
    tmp.replace(dest)


def cmd_install_deps(python_exe: str) -> int:
    print(f"Installo kokoro-onnx + numpy in: {python_exe}")
    result = subprocess.run(
        [python_exe, "-m", "pip", "install", "kokoro-onnx", "numpy"],
        check=False,
    )
    if result.returncode != 0:
        print("Installazione dipendenze FALLITA.")
        return result.returncode
    print("Dipendenze installate.")
    return 0


def cmd_download(variant: str, models_dir: Path) -> int:
    if variant not in MODEL_VARIANTS:
        print(f"Variante sconosciuta: {variant}. Scegli tra: {', '.join(MODEL_VARIANTS)}")
        return 1
    info = MODEL_VARIANTS[variant]
    print(f"Variante '{variant}' ({info['desc']}, ~{info['approx_mb']} MB)")
    print(f"Cartella modelli: {models_dir}")

    model_dest = models_dir / info["filename"]
    if model_dest.exists():
        print(f"  {info['filename']} gia' presente, salto.")
    else:
        download(info["url"], model_dest)

    voices_dest = models_dir / VOICES_FILENAME
    if voices_dest.exists():
        print(f"  {VOICES_FILENAME} gia' presente, salto.")
    else:
        download(VOICES_URL, voices_dest)

    print("Download completato.")
    return 0


def cmd_check(python_exe: str, models_dir: Path) -> int:
    print(f"Python target: {python_exe}")
    deps_ok = subprocess.run(
        [python_exe, "-c", "import kokoro_onnx, numpy"],
        capture_output=True,
        check=False,
    ).returncode == 0
    print(f"  kokoro-onnx + numpy: {'OK' if deps_ok else 'NON installati'}")

    print(f"Cartella modelli: {models_dir}")
    voices = models_dir / VOICES_FILENAME
    print(f"  {VOICES_FILENAME}: "
          f"{'OK (%.1f MB)' % (voices.stat().st_size / 1_048_576) if voices.exists() else 'MANCANTE'}")
    found_model = False
    for info in MODEL_VARIANTS.values():
        f = models_dir / info["filename"]
        if f.exists():
            found_model = True
            print(f"  {info['filename']}: OK ({f.stat().st_size / 1_048_576:.1f} MB)")
    if not found_model:
        print("  nessun modello kokoro*.onnx presente")

    ready = deps_ok and voices.exists() and found_model
    print(f"\nStato: {'PRONTO' if ready else 'INCOMPLETO — vedi sopra'}")
    return 0 if ready else 1


def main() -> int:
    parser = argparse.ArgumentParser(description="Setup TTS Kokoro per Handy")
    parser.add_argument("--check", action="store_true", help="verifica lo stato")
    parser.add_argument("--install-deps", action="store_true", help="pip install kokoro-onnx numpy")
    parser.add_argument("--download", action="store_true", help="scarica i modelli")
    parser.add_argument("--all", action="store_true", help="install-deps + download")
    parser.add_argument(
        "--variant",
        default="int8",
        choices=list(MODEL_VARIANTS),
        help="variante del modello da scaricare (default: int8)",
    )
    parser.add_argument(
        "--python",
        default="python",
        help='interprete Python in cui installare le dipendenze (default: "python")',
    )
    parser.add_argument(
        "--models-dir",
        default=str(default_models_dir()),
        help="cartella di destinazione dei modelli",
    )
    args = parser.parse_args()

    models_dir = Path(args.models_dir)

    if not any([args.check, args.install_deps, args.download, args.all]):
        parser.print_help()
        return 1

    rc = 0
    if args.all or args.install_deps:
        rc |= cmd_install_deps(args.python)
    if args.all or args.download:
        rc |= cmd_download(args.variant, models_dir)
    if args.check:
        rc |= cmd_check(args.python, models_dir)
    return rc


if __name__ == "__main__":
    sys.exit(main())
