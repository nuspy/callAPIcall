<#
.SYNOPSIS
  Installer UNICO di callAPIcall (MonolitOne) — provisioning completo + lato Hermes.

.DESCRIPTION
  Un solo script che prepara tutto ciò che serve a distribuire callAPIcall, ora che
  i motori STT/TTS sono NATIVI (Handy eliminato):

    1. venv Python del bridge + dipendenze (requirements.txt)
    2. torch (CUDA o CPU) — backend di whisper
    3. modelli: Kokoro (TTS) scaricati + whisper (STT) pre-caricato
    4. config.json: backend nativo + server compat :8720
    5. LATO HERMES: deploy delle skill (hermes-skills/ -> %LOCALAPPDATA%\hermes\skills)
       e modello di default in config.yaml (l'agente acp usa quello, non -m)
    6. autostart: task del bridge (run-ptt) + Control Center

  Idempotente: rilanciarlo aggiorna ciò che manca. Non richiede admin (task in
  sessione utente).

.PARAMETER Cpu
  Installa torch CPU-only (niente GPU). Default: GPU se rilevata (nvidia-smi).

.PARAMETER TorchIndex
  Indice wheel di torch per la GPU (default cu124, ampia compatibilità).
  La macchina di sviluppo usa cu130: `-TorchIndex https://download.pytorch.org/whl/cu130`.

.PARAMETER HermesModel
  Modello LLM di default per Hermes (scritto in config.yaml model.default).
  Default: gemma-4-12b-obliterated (il "ponte" funzionante).

.PARAMETER SkipDeps / SkipModels / SkipSkills / SkipAutostart
  Salta la fase corrispondente.

.PARAMETER Qwen3Tts
  Installa anche il motore voce Qwen3-TTS (voci preimpostate + clonazione,
  streaming) nel venv tts-venvs\dia: torch CUDA (~3 GB di download) piu' la
  wheel GGUF qwentts-cpp-python che viaggia con l'installer
  (tools\qwentts-cpp-win\dist). Opzionale: solo con GPU NVIDIA.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File installer\setup.ps1
  powershell -ExecutionPolicy Bypass -File installer\setup.ps1 -TorchIndex https://download.pytorch.org/whl/cu130
  powershell -ExecutionPolicy Bypass -File installer\setup.ps1 -Cpu -SkipAutostart
#>

param(
    [switch]$Cpu,
    [string]$TorchIndex = 'https://download.pytorch.org/whl/cu124',
    [string]$HermesModel = 'gemma-4-12b-obliterated',
    [string]$HermesProvider = 'lmstudio',
    # Modello STT da pre-caricare: small (~460 MB) | medium | large-v3 (~2,9 GB) | none
    [string]$WhisperModel = 'small',
    [switch]$SkipPython,
    [switch]$SkipDeps,
    [switch]$SkipModels,
    [switch]$SkipSkills,
    [switch]$SkipAutostart,
    # Runtime avatar (MuseTalk): clone + venv + pesi (~4 GB) + mmcv compilato.
    # Richiede Python 3.10 e, per mmcv, Visual Studio + CUDA Toolkit.
    [switch]$SkipAvatar,
    # Motore voce Qwen3-TTS (opzionale, pesante): vedi tools\tts-engines.
    [switch]$Qwen3Tts
)

$ErrorActionPreference = 'Stop'
$RepoRoot   = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Bridge     = Join-Path $RepoRoot 'call-bridge'
$Venv       = Join-Path $Bridge '.venv'
$VenvPy     = Join-Path $Venv 'Scripts\python.exe'
$ModelsDir  = Join-Path $env:LOCALAPPDATA 'callAPIcall\models'
$HermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$SkillsSrc  = Join-Path $RepoRoot 'hermes-skills'

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    ! $msg" -ForegroundColor Yellow }

Write-Host "=== callAPIcall — installer unico (MonolitOne) ===" -ForegroundColor Magenta
Write-Host "Repo: $RepoRoot"

# --- 0. Prerequisiti ---------------------------------------------------------
Step 0 "Prerequisiti"

# Python 3.10-3.12: si CERCA nei posti dove sta di solito, e solo se non c'e'
# proprio lo si installa. Non si tocca un'installazione esistente: il bridge
# gira comunque in un venv suo, quindi non sporca nulla.
function Find-Python {
    $cand = @()
    $cmd = (Get-Command python -ErrorAction SilentlyContinue).Source
    if ($cmd) { $cand += $cmd }
    # `py` conosce anche le installazioni fuori PATH
    if (Get-Command py -ErrorAction SilentlyContinue) {
        foreach ($v in '3.12', '3.11', '3.10') {
            $p = & py "-$v" -c "import sys;print(sys.executable)" 2>$null
            if ($LASTEXITCODE -eq 0 -and $p) { $cand += $p.Trim() }
        }
    }
    foreach ($root in @($env:LOCALAPPDATA, $env:ProgramFiles)) {
        foreach ($v in '312', '311', '310') {
            $cand += (Join-Path $root "Programs\Python\Python$v\python.exe")
            $cand += (Join-Path $root "Python$v\python.exe")
        }
    }
    foreach ($p in $cand) {
        if (-not (Test-Path $p)) { continue }
        $v = & $p -c "import sys;print('%d.%d' % sys.version_info[:2])" 2>$null
        if ($v -match '^3\.(1[0-2])$') { return @{ Path = $p; Version = $v } }
    }
    return $null
}

function Install-Python {
    # Per-utente (InstallAllUsers=0): niente UAC e niente modifiche di sistema.
    $ver = '3.10.11'
    $url = "https://www.python.org/ftp/python/$ver/python-$ver-amd64.exe"
    $exe = Join-Path $env:TEMP "python-$ver-amd64.exe"
    Ok "Python non trovato: scarico $ver (~28 MB)..."
    Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    Ok "installo Python $ver per l'utente corrente..."
    $p = Start-Process $exe -Wait -PassThru -ArgumentList @(
        '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1',
        'Include_test=0', 'Include_doc=0', 'SimpleInstall=1')
    Remove-Item $exe -Force -ErrorAction SilentlyContinue
    if ($p.ExitCode -ne 0) { throw "installazione di Python fallita (exit $($p.ExitCode))" }
    $found = Find-Python
    if (-not $found) { throw "Python installato ma non trovato: riapri il terminale e rilancia." }
    return $found
}

$py = Find-Python
if (-not $py) {
    if ($SkipPython) { throw "Python 3.10-3.12 non trovato e -SkipPython attivo." }
    $py = Install-Python
}
$SysPy = $py.Path
Ok "Python: $SysPy (v$($py.Version))"
$HasGpu = $false
if (-not $Cpu) {
    $HasGpu = [bool](Get-Command nvidia-smi -ErrorAction SilentlyContinue)
    if ($HasGpu) { Ok "GPU NVIDIA rilevata -> torch CUDA ($TorchIndex)" }
    else { Warn "Nessuna GPU NVIDIA -> torch CPU"; }
} else { Warn "Forzato CPU (-Cpu)" }

# --- 1. venv + dipendenze ----------------------------------------------------
if (-not $SkipDeps) {
    Step 1 "venv del bridge + dipendenze"
    if (-not (Test-Path $VenvPy)) {
        & $SysPy -m venv $Venv
        Ok "creato venv $Venv"
    } else { Ok "venv già presente" }
    & $VenvPy -m pip install --upgrade pip -q
    Ok "installo requirements.txt ..."
    & $VenvPy -m pip install -q -r (Join-Path $Bridge 'requirements.txt')
    Step '1b' "torch (backend whisper)"
    if ($HasGpu) { & $VenvPy -m pip install -q torch --index-url $TorchIndex }
    else { & $VenvPy -m pip install -q torch }
    $tok = & $VenvPy -c "import torch;print(torch.cuda.is_available())"
    Ok "torch installato (cuda disponibile: $tok)"
} else { Warn "Deps saltate (-SkipDeps)" }

# --- 2. Modelli --------------------------------------------------------------
if (-not $SkipModels) {
    Step 2 "Modelli STT/TTS"
    New-Item -ItemType Directory -Force -Path $ModelsDir | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $ModelsDir 'cloned_voices') | Out-Null
    # Un solo downloader per tutti i modelli (Kokoro, diarizzazione, VAD, whisper):
    # vedi call-bridge\fetch_models.py. Sta fuori dall'installazione, così
    # aggiornare l'app non costa 700 MB di download.
    $fetch = Join-Path $Bridge 'fetch_models.py'
    # Con il venv pronto si usa quello: `whisper` sta lì, e il preload STT serve
    # a non far aspettare la prima trascrizione.
    if ((-not $SkipDeps) -and (Test-Path $VenvPy)) {
        & $VenvPy $fetch --dest $ModelsDir --whisper $WhisperModel
    } else {
        Warn "venv non pronto: scarico i modelli senza il preload di whisper"
        & $SysPy $fetch --dest $ModelsDir --whisper none
    }
    if ($LASTEXITCODE -ne 0) { throw "download dei modelli fallito (exit $LASTEXITCODE)" }
} else { Warn "Modelli saltati (-SkipModels)" }

# --- 3. config.json (backend nativo + compat) --------------------------------
Step 3 "config.json — backend nativo + server compat :8720"
$cfgPath = Join-Path $Bridge 'config.json'
if (-not (Test-Path $cfgPath)) { Copy-Item (Join-Path $Bridge 'config.json.example') $cfgPath -ErrorAction SilentlyContinue }
$cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
$cfg | Add-Member -NotePropertyName stt_backend -NotePropertyValue 'native' -Force
$cfg | Add-Member -NotePropertyName tts_backend -NotePropertyValue 'native' -Force
$cfg | Add-Member -NotePropertyName handy_compat_enabled -NotePropertyValue $true -Force
$cfg | Add-Member -NotePropertyName kokoro_model_dir -NotePropertyValue $ModelsDir -Force
$cfg | Add-Member -NotePropertyName diarization_model_dir -NotePropertyValue (Join-Path $ModelsDir 'diarization') -Force
$cfg | Add-Member -NotePropertyName stt_model -NotePropertyValue $(if ($WhisperModel -eq 'none') {'small'} else {$WhisperModel}) -Force
$cfg | Add-Member -NotePropertyName stt_device -NotePropertyValue ($(if ($HasGpu) {'cuda'} else {'cpu'})) -Force
$cfg | Add-Member -NotePropertyName acp_model -NotePropertyValue $HermesModel -Force
$cfg | Add-Member -NotePropertyName acp_provider -NotePropertyValue $HermesProvider -Force
# UTF-8 SENZA BOM: `Set-Content -Encoding UTF8` su PowerShell 5.1 il BOM ce lo
# mette, e il bridge leggeva un file che comincia con tre byte inattesi.
[IO.File]::WriteAllText($cfgPath, ($cfg | ConvertTo-Json -Depth 20),
                        (New-Object Text.UTF8Encoding $false))
Ok "config.json aggiornato (native, compat, kokoro_model_dir=$ModelsDir)"

# --- 4. LATO HERMES: skill + modello di default ------------------------------
if (-not $SkipSkills) {
    Step 4 "Lato Hermes — skill + modello di default"
    if (-not (Test-Path $HermesHome)) {
        Warn "Hermes non trovato in $HermesHome — salto il deploy skill/config."
    } else {
        # 4a. deploy skill
        $map = @{
            'phone-calls' = Join-Path $HermesHome 'skills\media\phone-calls'
            'voice-mode'  = Join-Path $HermesHome 'skills\communication\voice-mode'
        }
        foreach ($k in $map.Keys) {
            $src = Join-Path $SkillsSrc $k
            if (-not (Test-Path $src)) { Warn "manca hermes-skills\$k"; continue }
            New-Item -ItemType Directory -Force -Path $map[$k] | Out-Null
            Copy-Item (Join-Path $src '*') $map[$k] -Recurse -Force
            Ok "skill '$k' -> $($map[$k])"
        }
        # 4b. config.yaml: model.default = modello funzionante (acp ignora -m!)
        $yaml = Join-Path $HermesHome 'config.yaml'
        if (Test-Path $yaml) {
            Copy-Item $yaml "$yaml.bak-callapicall" -Force
            $lines = Get-Content $yaml
            $inModel = $false; $done = $false; $out = New-Object System.Collections.Generic.List[string]
            foreach ($ln in $lines) {
                if ($ln -match '^model:\s*$') { $inModel = $true; $out.Add($ln); continue }
                if ($inModel -and $ln -match '^\S') { $inModel = $false }
                if ($inModel -and $ln -match '^(\s+)default:') { $out.Add("$($Matches[1])default: $HermesModel"); $done = $true; continue }
                if ($inModel -and $ln -match '^(\s+)provider:') { $out.Add("$($Matches[1])provider: $HermesProvider"); continue }
                $out.Add($ln)
            }
            if ($done) { $out | Set-Content $yaml -Encoding UTF8; Ok "config.yaml model.default = $HermesModel" }
            else { Warn "config.yaml: blocco model: non trovato — imposta il modello con 'hermes model'." }
        } else { Warn "config.yaml assente — configura Hermes prima (hermes setup)." }
    }
} else { Warn "Lato Hermes saltato (-SkipSkills)" }

# --- 4b. Runtime avatar (MuseTalk) -------------------------------------------
# Sta in uno script suo: e' lungo, fragile (mmcv va compilato) e utile anche
# da solo, su un'installazione gia' fatta a cui si vuole aggiungere l'avatar.
if (-not $SkipAvatar) {
    Step '4b' "Runtime avatar (MuseTalk)"
    $avatarInst = Join-Path $PSScriptRoot 'install-avatar.ps1'
    if (Test-Path $avatarInst) {
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $avatarInst -TorchIndex $TorchIndex
            Ok "runtime avatar installato (o gia' presente)"
        } catch {
            # L'avatar e' opzionale: un suo fallimento non deve far fallire
            # l'installazione di tutto il resto.
            Warn "installazione avatar non riuscita: $_"
            Warn "il resto di callAPIcall funziona; riprova con installer\install-avatar.ps1"
        }
    } else { Warn "manca installer\install-avatar.ps1" }
} else { Warn "Runtime avatar saltato (-SkipAvatar)" }

# --- 4c. Motore voce Qwen3-TTS (opzionale) -------------------------------------
# Script suo, come l'avatar: utile anche dopo, su un'installazione esistente.
# La wheel GGUF (qwentts-cpp-python per Windows) non e' pubblica: viaggia con
# l'installer in tools\qwentts-cpp-win\dist e lo script la trova da solo.
if ($Qwen3Tts) {
    Step '4c' "Motore voce Qwen3-TTS"
    $qwenInst = Join-Path $RepoRoot 'tools\tts-engines\setup-qwen3tts.ps1'
    if (-not $HasGpu) {
        Warn "Qwen3-TTS richiede una GPU NVIDIA: saltato"
    } elseif (Test-Path $qwenInst) {
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $qwenInst -Python310 $SysPy
            if ($LASTEXITCODE -ne 0) { throw "uscito con codice $LASTEXITCODE" }
            Ok "motore Qwen3-TTS installato"
        } catch {
            Warn "installazione Qwen3-TTS non riuscita: $_"
            Warn "il resto di callAPIcall funziona; riprova con tools\tts-engines\setup-qwen3tts.ps1"
        }
    } else { Warn "manca tools\tts-engines\setup-qwen3tts.ps1" }
}

# --- 5. Autostart ------------------------------------------------------------
if (-not $SkipAutostart) {
    Step 5 "Autostart (bridge + Control Center)"
    $pttTask = Join-Path $Bridge 'install-ptt-task.ps1'
    if (Test-Path $pttTask) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $pttTask -NoStart
        Ok "task bridge (run-ptt) registrato"
    } else { Warn "manca install-ptt-task.ps1" }
    $ccAuto = Join-Path $RepoRoot 'gui\install-autostart.ps1'
    if (Test-Path $ccAuto) {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $ccAuto
        Ok "autostart Control Center registrato"
    } else { Warn "manca gui\install-autostart.ps1 (Control Center opzionale)" }
} else { Warn "Autostart saltato (-SkipAutostart)" }

Write-Host "`n=== Installazione completata ===" -ForegroundColor Magenta
Write-Host "Avvio: rilogga, oppure 'Start-ScheduledTask -TaskName callAPIcall-PTT'."
Write-Host "Il bridge apre :8770 (control), :8720 (STT/TTS nativo per Hermes), :8771 (gateway)."
Write-Host "Nota GPU/torch: se la trascrizione non usa la GPU, reinstalla torch con la"
Write-Host "wheel CUDA giusta: $VenvPy -m pip install torch --index-url <cuXXX>"
