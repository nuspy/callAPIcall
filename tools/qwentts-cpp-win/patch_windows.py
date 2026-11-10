"""Patch di qwentts-cpp-python per una wheel Windows CUDA distribuibile.

Upstream pubblica solo wheel Linux (CUDA) e macOS (Metal). Il binding ctypes
gestisce gia' i nomi .dll, ma su Windows mancano due cose:

1. il runtime CUDA (cudart64_13, cublas64_13, cublasLt64_13): le wheel non lo
   includono (cublasLt da solo pesa 450 MB). Lo si dichiara come dipendenza dai
   pacchetti ufficiali NVIDIA su PyPI (`nvidia-cuda-runtime`, `nvidia-cublas`),
   che lo mettono in site-packages/nvidia/cu13/bin/x86_64: il binding deve
   aggiungere quella cartella (e, in ripiego, quella del toolkit CUDA) alla
   ricerca delle DLL prima di caricare ggml-cuda.dll;
2. ggml-cuda.dll non e' fra le dipendenze precaricate su win32.

Uso: python patch_windows.py <checkout di qwentts-cpp-python> <versione locale>
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def sostituisci(testo: str, vecchio: str, nuovo: str, dove: str) -> str:
    if testo.count(vecchio) != 1:
        raise SystemExit(f"patch non applicabile in {dove}: blocco atteso non trovato "
                         f"(upstream cambiato?): {vecchio[:60]!r}")
    return testo.replace(vecchio, nuovo)


def main() -> int:
    radice = Path(sys.argv[1])
    locale = sys.argv[2]

    binding = radice / "src" / "qwentts_cpp" / "_binding.py"
    s = binding.read_text(encoding="utf-8")
    s = sostituisci(s, '''    if sys.platform == "win32":
        return ("ggml-base.dll", "ggml-cpu.dll", "ggml.dll")''', '''    if sys.platform == "win32":
        return ("ggml-base.dll", "ggml-cpu.dll", "ggml-cuda.dll", "ggml-vulkan.dll", "ggml.dll")''',
                    "_dependency_names")
    s = sostituisci(s, '''        if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
            self._dll_dir_handle = os.add_dll_directory(lib_dir)
''', '''        if sys.platform == "win32" and hasattr(os, "add_dll_directory"):
            self._dll_dir_handle = os.add_dll_directory(lib_dir)
            # Runtime CUDA per ggml-cuda.dll: pacchetti NVIDIA di PyPI
            # (nvidia-cuda-runtime, nvidia-cublas), poi il toolkit installato.
            self._cuda_dll_handles = []
            for cuda_dir in _windows_cuda_dirs():
                try:
                    self._cuda_dll_handles.append(os.add_dll_directory(str(cuda_dir)))
                except OSError:
                    pass
''', "_load_cdll")
    s = sostituisci(s, '''def _dependency_names() -> Sequence[str]:''', '''def _windows_cuda_dirs() -> list[Path]:
    """Cartelle con cudart64_13.dll / cublas64_13.dll, in ordine di preferenza."""
    import site

    dirs: list[Path] = []
    roots = list(site.getsitepackages())
    try:
        roots.append(site.getusersitepackages())
    except Exception:  # noqa: BLE001
        pass
    for root in roots:
        nvidia = Path(root) / "nvidia"
        if nvidia.is_dir():
            dirs.extend(p.parent for p in nvidia.glob("**/cudart64_*.dll"))
            dirs.extend(p.parent for p in nvidia.glob("**/cublas64_*.dll"))
    cuda_path = os.environ.get("CUDA_PATH")
    if cuda_path:
        dirs.extend([Path(cuda_path) / "bin" / "x64", Path(cuda_path) / "bin"])
    out: list[Path] = []
    for d in dirs:
        if d.is_dir() and d not in out:
            out.append(d)
    return out


def _dependency_names() -> Sequence[str]:''', "_windows_cuda_dirs")
    binding.write_text(s, encoding="utf-8")

    # Versione locale (es. 0.5.0+cu13win) e runtime CUDA come dipendenze.
    pyproject = radice / "pyproject.toml"
    p = pyproject.read_text(encoding="utf-8")
    p = re.sub(r'^version = "([^"+]+)"', lambda m: f'version = "{m.group(1)}+{locale}"',
               p, count=1, flags=re.M)
    p = sostituisci(p, '''dependencies = [
    "numpy",
    "huggingface-hub",
]''', '''dependencies = [
    "numpy",
    "huggingface-hub",
    "nvidia-cuda-runtime>=13,<14; sys_platform == 'win32'",
    "nvidia-cublas>=13,<14; sys_platform == 'win32'",
]''', "pyproject dependencies")
    pyproject.write_text(p, encoding="utf-8")
    print("patch Windows applicata")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
