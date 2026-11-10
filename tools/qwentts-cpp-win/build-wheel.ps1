<#
.SYNOPSIS
    Costruisce la wheel Windows (CUDA 13) di qwentts-cpp-python, che upstream
    non pubblica.

.DESCRIPTION
    qwentts-cpp-python e' il binding ctypes del runtime C++/GGML qwentts.cpp:
    serve a faster-qwen3-tts per usare i modelli Qwen3-TTS QUANTIZZATI (GGUF
    Q8_0 / Q4_K_M), con una frazione della VRAM del percorso torch.
    Upstream pubblica wheel solo per Linux (CUDA) e macOS (Metal). qwentts.cpp
    pero' compila gia' su Windows (MSVC + CUDA), e il binding conosce i nomi
    delle .dll: qui si mette insieme il pezzo mancante.

    Passi:
      1. checkout fissati: qwentts-cpp-python $PyTag e qwentts.cpp $QwenttsRef
         (il binding rifiuta qualunque altra revisione della libreria nativa);
      2. patch_windows.py: runtime CUDA cercato nei pacchetti NVIDIA di PyPI e
         dichiarato come dipendenza della wheel (non incluso: cublasLt = 450 MB);
      3. build di qwen.dll + ggml*.dll con MSVC 14.44 (nvcc 13.1 non accetta
         il 14.51 di VS 2026) e Ninja, per le architetture $CudaArchs;
      4. wheel py3-none-win_amd64 in .\dist, versione <upstream>+$LocalTag.

    Distribuzione: la wheel si installa con pip come qualunque altra; pip
    porta da solo nvidia-cuda-runtime e nvidia-cublas. Serve un driver NVIDIA
    con supporto CUDA 13 (>= 580).

.EXAMPLE
    .\build-wheel.ps1
.EXAMPLE
    .\build-wheel.ps1 -CudaArchs "120" -Install C:\Projects\callAPIcall\tts-venvs\dia
#>
[CmdletBinding()]
param(
    [string]$PyTag = 'v0.5.0',
    [string]$QwenttsRef = '6fae92914045cd83364d2845ceaa0f7969727319',
    # Turing (RTX 20xx), A100, Ampere (RTX 30xx), Ada (RTX 40xx), Blackwell (RTX 50xx).
    [string]$CudaArchs = '75;80;86;89;120',
    [string]$MsvcToolset = '14.44',
    [string]$LocalTag = 'cu13win',
    # Python con cui compilare e impacchettare ('' = il venv dia di callAPIcall).
    [string]$Python = '',
    # Venv in cui installare e provare la wheel appena costruita ('' = nessuno).
    [string]$Install = '',
    [int]$Jobs = [Environment]::ProcessorCount
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
# $PSScriptRoot non e' disponibile nei default dei parametri su PowerShell 5.1.
if (-not $Python) {
    $Python = (Resolve-Path (Join-Path $root '..\..\tts-venvs\dia\Scripts\python.exe')).Path
}
$work = Join-Path $root 'work'
$pyDir = Join-Path $work 'qwentts-cpp-python'
$cppDir = Join-Path $work 'qwentts.cpp'
$dist = Join-Path $root 'dist'

# Avast intercetta il TLS: git/pip con truststore proprio vogliono il bundle.
$bundle = 'E:\esp\ca-bundle.pem'
if (Test-Path $bundle) {
    $env:SSL_CERT_FILE = $bundle; $env:REQUESTS_CA_BUNDLE = $bundle; $env:PIP_CERT = $bundle
}

function Invoke-Checked([string]$what, [scriptblock]$cmd) {
    # Fa fede il codice di uscita: in PowerShell 5.1 un avviso su stderr di un
    # comando nativo (git ne scrive) diventa un errore bloccante con 'Stop'
    # quando l'output e' rediretto.
    $prima = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $cmd 2>&1 | ForEach-Object { "$_" } }
    finally { $ErrorActionPreference = $prima }
    if ($LASTEXITCODE -ne 0) { throw "$what fallito (codice $LASTEXITCODE)" }
}

# --- 1. sorgenti fissati --------------------------------------------------------
if (Test-Path $work) { Remove-Item $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null
Invoke-Checked 'clone qwentts-cpp-python' {
    git clone --quiet --depth 1 --branch $PyTag https://github.com/andimarafioti/qwentts-cpp-python $pyDir }
Invoke-Checked 'init qwentts.cpp' { git init --quiet $cppDir }
Invoke-Checked 'remote qwentts.cpp' {
    git -C $cppDir remote add origin https://github.com/ServeurpersoCom/qwentts.cpp }
Invoke-Checked 'fetch qwentts.cpp' { git -C $cppDir fetch --quiet --depth 1 origin $QwenttsRef }
Invoke-Checked 'checkout qwentts.cpp' { git -C $cppDir checkout --quiet --detach FETCH_HEAD }
Invoke-Checked 'submodule qwentts.cpp' { git -C $cppDir submodule update --quiet --init --recursive }

# --- 2. patch Windows -----------------------------------------------------------
Invoke-Checked 'patch' { & $Python (Join-Path $root 'patch_windows.py') $pyDir $LocalTag }

# --- 3. build nativa ------------------------------------------------------------
$vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -property installationPath
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvarsall.bat'
$cuda = $env:CUDA_PATH
if (-not $cuda) { $cuda = (Get-ChildItem 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA' | Sort-Object Name | Select-Object -Last 1).FullName }
$nvcc = Join-Path $cuda 'bin\nvcc.exe'
Write-Host "MSVC $MsvcToolset da $vs; nvcc: $nvcc; architetture CUDA: $CudaArchs"

# Forma "--cmake-arg=-D...": separati, argparse prenderebbe "-D..." per
# un'opzione e si fermerebbe ("expected one argument").
$cmakeArgs = @(
    "`"--cmake-arg=-DCMAKE_CUDA_ARCHITECTURES=$CudaArchs`"",
    # Portabile: niente istruzioni specifiche della CPU che compila.
    '--cmake-arg=-DGGML_NATIVE=OFF'
) -join ' '
$buildLog = Join-Path $root 'build.log'
# _CL_/CL dell'utente forzano /std:c++20 anche sui .c di ggml (vedi note di
# build di Handy): si azzerano solo per questa build.
$bat = @"
@echo off
call "$vcvars" x64 -vcvars_ver=$MsvcToolset || exit /b 1
set "_CL_="
set "CL="
set "CMAKE_GENERATOR=Ninja"
set "CUDA_PATH=$cuda"
cd /d "$pyDir"
"$Python" scripts\build_native.py --source "$cppDir" --backend cuda --clean --jobs $Jobs --cuda-compiler "$nvcc" $cmakeArgs
"@
$batFile = Join-Path $work 'build.cmd'
Set-Content $batFile $bat -Encoding ASCII
Write-Host "Compilo qwentts.cpp (CUDA): richiede parecchi minuti, log in $buildLog"
cmd /c "`"$batFile`" > `"$buildLog`" 2>&1"
if ($LASTEXITCODE -ne 0) { Get-Content $buildLog -Tail 40; throw "build nativa fallita (vedi $buildLog)" }
Get-ChildItem (Join-Path $pyDir 'src\qwentts_cpp\lib') -Filter *.dll | ForEach-Object { "  {0,-20} {1,8:N0} KB" -f $_.Name, ($_.Length / 1KB) }

# --- 4. wheel -------------------------------------------------------------------
New-Item -ItemType Directory -Force $dist | Out-Null
Invoke-Checked 'pip wheel' { & $Python -m pip wheel $pyDir --no-deps -w $dist }
$wheel = Get-ChildItem $dist -Filter "qwentts_cpp_python-*$LocalTag*win_amd64.whl" | Sort-Object LastWriteTime | Select-Object -Last 1
Write-Host ("Wheel: {0} ({1:N1} MB)" -f $wheel.FullName, ($wheel.Length / 1MB)) -ForegroundColor Green

if ($Install) {
    $venvPy = Join-Path $Install 'Scripts\python.exe'
    Invoke-Checked 'installazione' { & $venvPy -m pip install --force-reinstall --no-deps $wheel.FullName }
    Invoke-Checked 'runtime CUDA' { & $venvPy -m pip install "nvidia-cuda-runtime>=13,<14" "nvidia-cublas>=13,<14" }
    Invoke-Checked 'prova' { & $venvPy -c "from qwentts_cpp import QwenLibrary; print('qwentts.cpp', QwenLibrary().version())" }
}
