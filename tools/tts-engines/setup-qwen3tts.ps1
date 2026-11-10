<#
.SYNOPSIS
    Installa il motore Qwen3-TTS di callAPIcall (anche su una macchina nuova).

.DESCRIPTION
    Qwen3-TTS gira come helper del bridge nel venv `tts-venvs\dia`, condiviso
    con Dia: stesso torch CUDA 12.8 e transformers fissato a 5.15.1, l'unica
    versione che va bene a entrambi (verificato: con 5.19 lo shim di
    qwen-tts-hf cerca `config.rope_theta` e non carica).

    Lo script crea il venv se manca e installa, con le versioni verificate:
      - torch / torchaudio cu128 (supporta la RTX 50xx, sm_120);
      - faster-qwen3-tts (CUDA graphs + streaming) e transformers==5.15.1;
      - openai-whisper (trascrive una volta i riferimenti delle voci clonate);
      - OPZIONALE la wheel Windows di qwentts-cpp-python (-Wheel): abilita i
        modelli quantizzati GGUF (Q8_0: ~16x tempo reale, ~2,5 GB di VRAM).
        Upstream non la pubblica per Windows: si costruisce con
        tools\qwentts-cpp-win\build-wheel.ps1, poi si distribuisce come file
        o URL. Porta con se' il runtime CUDA 13 (pacchetti NVIDIA di PyPI) e
        richiede un driver NVIDIA >= 580.

    Infine scarica SUBITO i modelli (prefetch) nella cartella modelli dell'app,
    %LOCALAPPDATA%\callAPIcall\models\huggingface, la stessa che usa il motore:
    cosi' la prima frase non aspetta minuti di download e il motore funziona
    anche offline. Dimensioni per -Size 0.6B: ~2,1 GB con la wheel GGUF (Q8_0),
    ~4,8 GB senza (BF16); per 1.7B circa il doppio. Licenza dei modelli:
    Apache-2.0.

.PARAMETER Wheel
    Percorso o URL della wheel qwentts_cpp_python-*-win_amd64.whl. Vuoto: si
    usa quella in tools\qwentts-cpp-win\dist se presente, altrimenti niente
    GGUF (resta il runtime BF16).

.PARAMETER Size
    Taglia da scaricare subito: 0.6B (default) o 1.7B. Deve corrispondere a
    quella scelta nella GUI (Motore voce > Qwen3-TTS); cambiandola li', il
    motore scarica la nuova taglia al primo uso.

.PARAMETER NoPrefetch
    Non scarica i modelli adesso (li scarichera' il motore al primo uso).

.EXAMPLE
    .\setup-qwen3tts.ps1
.EXAMPLE
    .\setup-qwen3tts.ps1 -Wheel https://example.org/qwentts_cpp_python-0.5.0+cu13win-py3-none-win_amd64.whl
#>
[CmdletBinding()]
param(
    [string]$VenvRoot = '',
    [string]$Venv = 'dia',
    [string]$Wheel = '',
    [string]$Python310 = '',
    [ValidateSet('0.6B', '1.7B')]
    [string]$Size = '0.6B',
    [switch]$NoPrefetch
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
if (-not $VenvRoot) { $VenvRoot = Join-Path $repo 'tts-venvs' }
$venvDir = Join-Path $VenvRoot $Venv
$py = Join-Path $venvDir 'Scripts\python.exe'

# Avast intercetta il TLS: pip di un venv nuovo vuole il bundle CA completo.
$bundle = 'E:\esp\ca-bundle.pem'
if (Test-Path $bundle) {
    $env:SSL_CERT_FILE = $bundle; $env:REQUESTS_CA_BUNDLE = $bundle; $env:PIP_CERT = $bundle
}

function Pip([string[]]$pipArgs) {
    $prima = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $py -m pip @pipArgs 2>&1 | ForEach-Object { "$_" } | Select-Object -Last 3 }
    finally { $ErrorActionPreference = $prima }
    if ($LASTEXITCODE -ne 0) { throw "pip $($pipArgs -join ' ') fallito" }
}

if (-not (Test-Path $py)) {
    if (-not $Python310) {
        $Python310 = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'
        if (-not (Test-Path $Python310)) { $Python310 = (Get-Command python -ErrorAction Stop).Source }
    }
    Write-Host "Creo il venv $venvDir"
    & $Python310 -m venv $venvDir
}

Write-Host "1/5 torch CUDA 12.8"
Pip @('install', '-U', 'pip', 'wheel', 'setuptools')
Pip @('install', 'torch', 'torchaudio', '--index-url', 'https://download.pytorch.org/whl/cu128')
Write-Host "2/5 faster-qwen3-tts + transformers 5.15.1"
Pip @('install', 'faster-qwen3-tts', 'transformers==5.15.1', 'soundfile', 'scipy', 'openai-whisper')

Write-Host "3/5 runtime GGUF (qwentts-cpp-python, opzionale)"
if (-not $Wheel) {
    $locale = Get-ChildItem (Join-Path $repo 'tools\qwentts-cpp-win\dist') -Filter 'qwentts_cpp_python-*win_amd64.whl' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime | Select-Object -Last 1
    if ($locale) { $Wheel = $locale.FullName }
}
if ($Wheel) {
    Pip @('install', $Wheel)
} else {
    Write-Host "  nessuna wheel: resta il runtime BF16 (torch). Per i GGUF: -Wheel <file o URL>" -ForegroundColor Yellow
}

Write-Host "4/5 verifica"
Pip @('check')
& $py -c "import torch, faster_qwen3_tts; print('torch', torch.__version__, 'CUDA', torch.cuda.is_available())"
if ($Wheel) { & $py -c "from qwentts_cpp import QwenLibrary; print('qwentts.cpp', QwenLibrary().version())" }
if ($NoPrefetch) {
    Write-Host "5/5 modelli: saltati (-NoPrefetch), li scarichera' il motore al primo uso" -ForegroundColor Yellow
} else {
    # Stessa cache e stesse regole del motore: l'helper stesso decide cosa
    # scaricare (backend auto: GGUF Q8_0 se la wheel c'e', altrimenti BF16).
    $cache = Join-Path $env:LOCALAPPDATA 'callAPIcall\models\huggingface'
    Write-Host "5/5 modelli Qwen3-TTS $Size in $cache (puo' richiedere parecchi minuti)"
    $env:HF_HUB_CACHE = $cache
    $env:QWEN3TTS_SIZE = $Size
    $helper = Join-Path $repo 'call-bridge\callbridge\engines\qwen3tts_tts_helper.py'
    $prima = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $py $helper --prefetch 2>&1 | ForEach-Object { "  $_" } }
    finally { $ErrorActionPreference = $prima }
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  download non completato: il motore li riscarichera' al primo uso" -ForegroundColor Yellow
    }
}
Write-Host "Qwen3-TTS pronto nel venv $venvDir. Si sceglie in Identita' (motore Qwen3-TTS)." -ForegroundColor Green
