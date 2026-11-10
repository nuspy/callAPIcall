@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64 -vcvars_ver=14.44
where cl
set "_CL_=/std:c++17 /DWIN32_LEAN_AND_MEAN"
set "CL="
set "MMCV_WITH_OPS=1"
set "DISTUTILS_USE_SDK=1"
set "FORCE_CUDA=1"
set "NVCC_PREPEND_FLAGS=-allow-unsupported-compiler -std=c++17 -DWIN32_LEAN_AND_MEAN -Xcompiler /Zc:preprocessor"
set "TORCH_CUDA_ARCH_LIST=12.0"
set "CUDA_HOME=C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v13.1"
set "MAX_JOBS=16"
set "PATH=C:\Users\atain\scoop\apps\ninja\current;%PATH%"
cd /d C:\Projects\callAPIcall\avatar
musetalk-venv\Scripts\python.exe -m pip uninstall -y mmcv-lite mmcv
musetalk-venv\Scripts\python.exe -m pip install C:\TEMP\mmcv-src\mmcv-2.0.1 --no-build-isolation 2>&1
