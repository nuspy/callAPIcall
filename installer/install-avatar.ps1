#requires -Version 5.1
<#
  install-avatar.ps1 — installa il runtime dell'avatar video (MuseTalk).

  E' il pezzo che mancava all'installer: `setup.ps1` non nominava l'avatar, e
  su una macchina nuova mancavano il clone di MuseTalk, il suo venv dedicato, i
  pesi (~4 GB) e mmcv compilato. La procedura era solo documentata a mano in
  `avatar\SETUP-VENV.md`.

  Il CODICE di MuseTalk e' vendorizzato in avatar\MuseTalk e viaggia col
  repository (MIT, (c) Tencent Music Entertainment Group; il LICENSE originale
  e' conservato li'). Serve perche' lo abbiamo modificato: da clone esterno le
  nostre modifiche sarebbero sparite a ogni reinstallazione. I PESI (~7 GB) no:
  quelli si scaricano dalle fonti ufficiali, e il pacchetto resta leggero.
  Fuori anche assets/ e data/, i materiali di esempio, che a differenza del
  codice sono "non-commercial research purposes only".

  Cosa fa, in ordine:
    1. verifica che il codice MuseTalk vendorizzato ci sia
    2. crea avatar\musetalk-venv (Python 3.10)
    3. installa torch (stessa wheel CUDA del bridge) + requirements di MuseTalk
    4. scarica i pesi con lo script ufficiale del repo
    5. compila mmcv 2.0.1 con gli ops CUDA (serve a DWPose; non esiste wheel)

  Il passo 5 e' quello fragile: vuole Visual Studio con toolset MSVC 14.44 e il
  CUDA Toolkit. Se fallisce lo dice e prosegue: tutto il resto di callAPIcall
  funziona lo stesso, solo l'avatar video resta indisponibile.

  Uso:
    powershell -ExecutionPolicy Bypass -File install-avatar.ps1
    ... -SkipWeights     salta il download dei pesi (~4 GB)
    ... -SkipMmcv        salta la compilazione di mmcv
    ... -TorchIndex <url>  wheel torch da usare (default: cu124)
#>
param(
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu124',
    [string]$HfEndpoint = '',       # vuoto = endpoint HuggingFace ufficiale
    [switch]$SkipWeights,
    [switch]$SkipMmcv
)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$AvatarDir = Join-Path $RepoRoot 'avatar'
$MuseDir   = Join-Path $AvatarDir 'MuseTalk'
$VenvDir   = Join-Path $AvatarDir 'musetalk-venv'
$VenvPy    = Join-Path $VenvDir 'Scripts\python.exe'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }

Write-Host "=== callAPIcall — runtime avatar (MuseTalk) ===" -ForegroundColor Magenta

# --- 1. codice MuseTalk ------------------------------------------------------
# NON si clona piu' da upstream. Il codice e' VENDORIZZATO in questo repository
# (avatar\MuseTalk, vedi VENDORED.md): due motivi, entrambi appresi a caro
# prezzo. Le nostre modifiche a MuseTalk erano invisibili al nostro git e
# sarebbero sparite alla prima reinstallazione; e `git clone --depth 1` senza
# commit fissato dava a ogni macchina il master del giorno, quindi due
# installazioni a settimane di distanza non erano la stessa cosa.
#
# Qui resta solo la verifica che il codice ci sia: se manca, il pacchetto di
# installazione e' incompleto e non c'e' nulla da scaricare che lo rimedi.
Step 1 "Codice MuseTalk (vendorizzato)"
$sentinella = Join-Path $MuseDir 'musetalk\utils\blending.py'
if (Test-Path $sentinella) {
    Ok "presente in $MuseDir (MIT, (c) Tencent Music Entertainment Group)"
} else {
    throw "codice MuseTalk non trovato in $MuseDir. E' parte del repository callAPIcall e va distribuito insieme: se stai installando da un archivio, quell'archivio e' incompleto."
}

# --- 2. venv dedicato --------------------------------------------------------
# Separato da quello del bridge: MuseTalk fissa versioni di numpy/opencv/
# transformers che con il resto del progetto litigano.
Step 2 "venv dedicato (Python 3.10)"
if (Test-Path $VenvPy) {
    Ok "venv gia' presente"
} else {
    $py310 = $null
    foreach ($c in @('py -3.10', 'python3.10', 'python')) {
        $exe, $arg = $c.Split(' ', 2)
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) { continue }
        $v = & $exe $arg -c "import sys;print('%d.%d'%sys.version_info[:2])" 2>$null
        if ($v -eq '3.10') { $py310 = $c; break }
    }
    if (-not $py310) {
        throw "Python 3.10 non trovato. MuseTalk (mmpose/mmcv) non supporta 3.11+: installa 3.10 e rilancia."
    }
    Ok "uso $py310"
    $exe, $arg = $py310.Split(' ', 2)
    & $exe $arg -m venv $VenvDir
    if (-not (Test-Path $VenvPy)) { throw "creazione del venv fallita" }
    Ok "creato $VenvDir"
}
& $VenvPy -m pip install -q --upgrade pip setuptools wheel
Ok "pip aggiornato"

# --- 3. torch + dipendenze ---------------------------------------------------
Step 3 "torch e dipendenze di MuseTalk"
$tok = & $VenvPy -c "import torch;print(torch.cuda.is_available())" 2>$null
if ($tok -eq 'True') {
    Ok "torch gia' presente (cuda disponibile)"
} else {
    Ok "installo torch da $TorchIndex (qualche minuto)..."
    & $VenvPy -m pip install -q torch torchvision torchaudio --index-url $TorchIndex
    $tok = & $VenvPy -c "import torch;print(torch.cuda.is_available())" 2>$null
    if ($tok -ne 'True') { Warn "torch installato ma CUDA non disponibile: l'avatar girera' su CPU (lentissimo)" }
    else { Ok "torch installato, CUDA disponibile" }
}
$req = Join-Path $MuseDir 'requirements.txt'
if (Test-Path $req) {
    Ok "installo i requirements di MuseTalk ..."
    & $VenvPy -m pip install -q -r $req
    Ok "requirements installati"
} else { Warn "requirements.txt di MuseTalk non trovato" }
# Servono al worker, non a MuseTalk: webcam virtuale e audio.
& $VenvPy -m pip install -q pyvirtualcam sounddevice
Ok "pyvirtualcam + sounddevice (sink video/audio del worker)"

# --- 4. pesi -----------------------------------------------------------------
Step 4 "Pesi dei modelli (~4 GB)"
if ($SkipWeights) {
    Warn "saltati (-SkipWeights)"
} elseif (Test-Path (Join-Path $MuseDir 'models\musetalkV15\unet.pth')) {
    Ok "gia' scaricati"
} else {
    & $VenvPy -m pip install -q -U "huggingface_hub[hf_xet]"
    # Lo script del repo punta a un mirror; qui si usa l'endpoint ufficiale
    # salvo indicazione contraria, cosi' la provenienza dei pesi e' quella
    # dichiarata dagli autori.
    if ($HfEndpoint) { $env:HF_ENDPOINT = $HfEndpoint; Ok "endpoint HF: $HfEndpoint" }
    $dl = Join-Path $MuseDir 'download_weights.bat'
    if (-not (Test-Path $dl)) { throw "download_weights.bat non trovato nel repo MuseTalk" }
    Push-Location $MuseDir
    try {
        $env:PATH = "$VenvDir\Scripts;$env:PATH"   # hf/pip del venv, non di sistema
        & cmd /c $dl
    } finally { Pop-Location }
    if (Test-Path (Join-Path $MuseDir 'models\musetalkV15\unet.pth')) { Ok "pesi scaricati" }
    else { Warn "download incompleto: rilancia, oppure segui avatar\SETUP-VENV.md" }
}

# --- 5. mmcv con ops CUDA ----------------------------------------------------
# DWPose passa da mmpose/mmdet, che vogliono mmcv>=2.0.0rc4,<2.1.0 CON gli ops
# compilati: `mmcv-lite` non basta (manca mmcv._ext) e wheel per torch recenti
# non ne esistono. Va compilato, e serve il toolset MSVC 14.44 esatto: con il
# piu' recente `cudafe++` di nvcc crasha.
Step 5 "mmcv 2.0.1 (ops CUDA, per DWPose)"
$haveExt = & $VenvPy -c "import importlib.util;print(importlib.util.find_spec('mmcv._ext') is not None)" 2>$null
if ($SkipMmcv) {
    Warn "saltato (-SkipMmcv)"
} elseif ($haveExt -eq 'True') {
    Ok "mmcv con ops gia' installato"
} else {
    $vcvars = Get-ChildItem 'C:\Program Files\Microsoft Visual Studio', 'C:\Program Files (x86)\Microsoft Visual Studio' `
        -Recurse -Filter 'vcvarsall.bat' -ErrorAction SilentlyContinue | Select-Object -First 1
    $cuda = $env:CUDA_HOME
    if (-not $cuda) {
        $cuda = (Get-ChildItem 'C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA' -Directory -ErrorAction SilentlyContinue |
                 Sort-Object Name -Descending | Select-Object -First 1).FullName
    }
    if (-not $vcvars -or -not $cuda) {
        Warn "Visual Studio (vcvarsall.bat) o CUDA Toolkit non trovati: salto mmcv."
        Warn "L'avatar non partira' finche' non lo compili: vedi avatar\SETUP-VENV.md"
    } else {
        Ok "vcvarsall: $($vcvars.FullName)"
        Ok "CUDA_HOME: $cuda"
        # Architettura della GPU presente, invece di un valore cablato.
        $arch = '8.6'
        try {
            $cc = (nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>$null | Select-Object -First 1)
            if ($cc) { $arch = $cc.Trim() }
        } catch {}
        Ok "TORCH_CUDA_ARCH_LIST=$arch"
        $src = Join-Path $env:TEMP 'mmcv-src'
        New-Item -ItemType Directory -Force -Path $src | Out-Null
        & $VenvPy -m pip download mmcv==2.0.1 --no-binary :all: --no-deps -d $src
        $tar = Get-ChildItem $src -Filter 'mmcv-2.0.1.tar.gz' -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $tar) { Warn "sorgente di mmcv non scaricato: salto"; }
        else {
            tar -xzf $tar.FullName -C $src
            $dir = Join-Path $src 'mmcv-2.0.1'
            # Patch nota: script.h trascina header che con nvcc+MSVC esplodono
            # in C2872 ('std' ambiguo). Vedi avatar\SETUP-VENV.md.
            foreach ($f in @('mmcv\ops\csrc\common\cuda\spconv\spconv_utils.h',
                             'mmcv\ops\csrc\pytorch\cuda\spconv_ops_cuda.cu',
                             'mmcv\ops\csrc\pytorch\cuda\sparse_pool_ops_cuda.cu')) {
                $fp = Join-Path $dir $f
                if (Test-Path $fp) {
                    (Get-Content $fp -Raw).Replace('#include <torch/script.h>', '#include <torch/types.h>') |
                        Set-Content $fp -Encoding UTF8
                }
            }
            Ok "sorgente patchato, compilo (puo' richiedere 20-40 minuti)..."
            $bat = Join-Path $env:TEMP 'cb-build-mmcv.bat'
            @"
@echo off
call "$($vcvars.FullName)" x64 -vcvars_ver=14.44
set "_CL_=/std:c++17 /DWIN32_LEAN_AND_MEAN"
set "CL="
set "MMCV_WITH_OPS=1"
set "DISTUTILS_USE_SDK=1"
set "FORCE_CUDA=1"
set "NVCC_PREPEND_FLAGS=-allow-unsupported-compiler -std=c++17 -DWIN32_LEAN_AND_MEAN -Xcompiler /Zc:preprocessor"
set "TORCH_CUDA_ARCH_LIST=$arch"
set "CUDA_HOME=$cuda"
set "MAX_JOBS=%NUMBER_OF_PROCESSORS%"
"$VenvPy" -m pip uninstall -y mmcv-lite mmcv
"$VenvPy" -m pip install "$dir" --no-build-isolation
"@ | Set-Content $bat -Encoding ASCII
            & cmd /c $bat
            $haveExt = & $VenvPy -c "import importlib.util;print(importlib.util.find_spec('mmcv._ext') is not None)" 2>$null
            if ($haveExt -eq 'True') { Ok "mmcv compilato e installato" }
            else { Warn "compilazione di mmcv fallita: l'avatar video non partira'. Vedi avatar\SETUP-VENV.md" }
        }
    }
}

# --- esito -------------------------------------------------------------------
Write-Host "`n=== Esito ===" -ForegroundColor Magenta
$pronti = @{
    'repo MuseTalk' = Test-Path (Join-Path $MuseDir 'musetalk')
    'venv'          = Test-Path $VenvPy
    'pesi UNet'     = Test-Path (Join-Path $MuseDir 'models\musetalkV15\unet.pth')
    'mmcv ops'      = ($haveExt -eq 'True')
}
foreach ($k in $pronti.Keys) {
    if ($pronti[$k]) { Ok "$k : ok" } else { Warn "$k : MANCANTE" }
}
if ($pronti.Values -notcontains $false) {
    Write-Host "`nAvatar pronto. Crea un'identita' dalla GUI (Identita') e scegli un clip." -ForegroundColor Green
} else {
    Write-Host "`nAvatar NON completo: il resto di callAPIcall funziona comunque." -ForegroundColor Yellow
}
