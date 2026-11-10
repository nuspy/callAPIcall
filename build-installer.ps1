#requires -Version 5.1
<#
  build-installer.ps1 — costruisce il setup.exe di callAPIcall.

  Produce un installer THIN (~15 MB): dentro c'è il codice, non le dipendenze.
  Python, torch (~4 GB) e i modelli (~800 MB) li scarica setup.ps1 sulla
  macchina di destinazione — torch va scelto in base alla GPU che si trova lì,
  e i modelli fuori dall'installazione sopravvivono agli aggiornamenti.

  Cosa fa:
    1. build del frontend Tauri (a meno di -SkipGui)
    2. staging del payload in dist\payload, senza log/artifact/venv/modelli
    3. makensis su installer\setup.nsi -> dist\callAPIcall-Setup-<versione>.exe

  Uso:  .\build-installer.ps1
        .\build-installer.ps1 -Version 0.2.0
        .\build-installer.ps1 -SkipGui      # riusa l'exe già compilato
#>
param(
    [string]$Version = '0.1.0',
    [switch]$SkipGui
)

$ErrorActionPreference = 'Stop'
$repo    = $PSScriptRoot
$gui     = Join-Path $repo 'gui'
$bridge  = Join-Path $repo 'call-bridge'
$dist    = Join-Path $repo 'dist'
$payload = Join-Path $dist 'payload'
$guiExe  = Join-Path $gui 'src-tauri\target\release\callapicall-control-center.exe'

function Step($msg) { Write-Host "`n== $msg" -ForegroundColor Cyan }
function Ok($msg)   { Write-Host "   $msg" -ForegroundColor Green }

# --- makensis: quello che Tauri si è già scaricato, o uno nel PATH -----------
$nsis = Join-Path $env:LOCALAPPDATA 'tauri\NSIS\makensis.exe'
if (-not (Test-Path $nsis)) { $nsis = (Get-Command makensis -ErrorAction SilentlyContinue).Source }
if (-not $nsis) {
    throw "makensis non trovato. Installa NSIS, oppure builda una volta la GUI con 'bun run tauri build' (Tauri se lo scarica da solo)."
}

# --- 1. frontend ------------------------------------------------------------
if (-not $SkipGui) {
    Step 'Build del Control Center (Tauri)'
    $bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
    if (-not $bun) {
        $bun = 'C:\Users\atain\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe'
    }
    if (-not (Test-Path $bun)) { throw "bun non trovato: installalo o usa -SkipGui." }
    Push-Location $gui
    try {
        & $bun run tauri build --no-bundle
        if ($LASTEXITCODE -ne 0) { throw "build del frontend fallita." }
    } finally { Pop-Location }
    Ok 'exe del Control Center ricostruito'
} else { Ok 'build GUI saltata (-SkipGui)' }

if (-not (Test-Path $guiExe)) { throw "manca $guiExe : builda la GUI (senza -SkipGui)." }

# --- 2. payload -------------------------------------------------------------
Step 'Preparo il payload'
if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
New-Item -ItemType Directory -Force -Path $payload | Out-Null

# call-bridge: codice e script, NON il resto. Le esclusioni sono la parte
# importante — .venv e artifacts pesano GB e sono roba di questa macchina.
# `secrets` è la voce che conta: contiene i token OAuth dei calendari. Le altre
# sono peso morto o dati di questa macchina (registrazioni, trascrizioni, voci).
$escludi = @('.venv', '__pycache__', 'artifacts', 'turni', 'diag', 'cloned_voices',
             'models', 'poc', '.pytest_cache', 'secrets',
             # registrazioni della voce (dump-voce) e stato di QUESTA macchina:
             # ptt.stop nel pacchetto terrebbe ferma la bridge installata.
             'voce', 'ptt.stop', 'dump-voce.on', 'dump-turni.on', '.phone_cache.json')
$bridgeDst = Join-Path $payload 'call-bridge'
New-Item -ItemType Directory -Force -Path $bridgeDst | Out-Null
Get-ChildItem $bridge -Force | Where-Object {
    $_.Name -notin $escludi -and
    $_.Name -notmatch '\.(log|out|prev|pyc)$' -and
    $_.Name -notmatch '^(ptt|gw|serve|bridge-manual|gateway-manual|restart-all)' -and
    $_.Name -ne 'config.json'          # la config dell'utente non si distribuisce
} | ForEach-Object {
    Copy-Item $_.FullName -Destination $bridgeDst -Recurse -Force
}
# restart-all.ps1 serve al bottone "Restart completo" della GUI: si recupera a
# mano perché il filtro sopra scarta tutto ciò che comincia per "restart".
Copy-Item (Join-Path $bridge 'restart-all.ps1') $bridgeDst -Force
# Il VAD (2 MB) viaggia col codice: senza, il push-to-talk non sa dove finisce
# una frase. Gli altri modelli no, quelli si scaricano.
New-Item -ItemType Directory -Force -Path (Join-Path $bridgeDst 'models') | Out-Null
Copy-Item (Join-Path $bridge 'models\silero_vad_v4.onnx') (Join-Path $bridgeDst 'models') -Force
# config.json.example diventa il config iniziale: setup.ps1 lo completa.
if (Test-Path (Join-Path $bridge 'config.json.example')) {
    Copy-Item (Join-Path $bridge 'config.json.example') (Join-Path $bridgeDst 'config.json') -Force
}
Ok "call-bridge: $((Get-ChildItem $bridgeDst -Recurse -File | Measure-Object).Count) file"

# gui: solo l'exe e i supervisori (i sorgenti del frontend sono già dentro l'exe)
$guiDst = Join-Path $payload 'gui'
New-Item -ItemType Directory -Force -Path $guiDst | Out-Null
Copy-Item $guiExe $guiDst -Force
foreach ($f in 'run-control-center.ps1', 'run-control-center-hidden.vbs', 'install-autostart.ps1', 'install-cc-task.ps1') {
    Copy-Item (Join-Path $gui $f) $guiDst -Force
}
Ok "gui: exe + supervisore"

# installer + skill + launcher
$instDst = Join-Path $payload 'installer'
New-Item -ItemType Directory -Force -Path $instDst | Out-Null
foreach ($f in 'setup.ps1', 'install.ps1', 'install-restart-task.ps1', 'README.md') {
    $src = Join-Path $repo "installer\$f"
    if (Test-Path $src) { Copy-Item $src $instDst -Force }
}
Copy-Item (Join-Path $repo 'hermes-skills') $payload -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $repo 'launch.ps1') $payload -Force

# Motore Qwen3-TTS: script di setup + wheel Windows di qwentts-cpp-python, che
# NON e' pubblicata da nessuna parte e viaggia solo dentro l'installer (~180 MB).
# Stessi percorsi relativi del repo: setup-qwen3tts.ps1 cerca la wheel in
# tools\qwentts-cpp-win\dist. Senza wheel il motore funziona lo stesso (BF16).
$ttsDst = Join-Path $payload 'tools\tts-engines'
New-Item -ItemType Directory -Force -Path $ttsDst | Out-Null
Copy-Item (Join-Path $repo 'tools\tts-engines\*') $ttsDst -Recurse -Force
$wheel = Get-ChildItem (Join-Path $repo 'tools\qwentts-cpp-win\dist') -Filter 'qwentts_cpp_python-*win_amd64.whl' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime | Select-Object -Last 1
if ($wheel) {
    $whlDst = Join-Path $payload 'tools\qwentts-cpp-win\dist'
    New-Item -ItemType Directory -Force -Path $whlDst | Out-Null
    Copy-Item $wheel.FullName $whlDst -Force
    Copy-Item (Join-Path $repo 'tools\qwentts-cpp-win\README.md') (Split-Path $whlDst) -Force
    Ok ("wheel GGUF Qwen3-TTS inclusa: {0} ({1:N0} MB)" -f $wheel.Name, ($wheel.Length / 1MB))
} else {
    Write-Host "  [WARN] wheel qwentts-cpp-python assente: Qwen3-TTS installabile solo in BF16." -ForegroundColor Yellow
    Write-Host "         Costruiscila con tools\qwentts-cpp-win\build-wheel.ps1" -ForegroundColor Yellow
}
$mb = [math]::Round((Get-ChildItem $payload -Recurse -File | Measure-Object Length -Sum).Sum / 1MB, 1)
Ok "payload pronto: $mb MB"

# --- 2b. rete di sicurezza: niente dati personali nel pacchetto -------------
# Una svista qui non è un bug, è un token OAuth spedito a qualcun altro. Il
# controllo sta QUI e non nella testa di chi builda: le esclusioni sopra si
# possono dimenticare, questo no. Un solo riscontro ferma la build.
Step 'Controllo che non ci siano dati personali'
$sospetti = Get-ChildItem $payload -Recurse -File | Where-Object {
    $_.Name -match '(?i)(secret|token|credential|password|\.env$|\.pem$|\.key$)' -or
    $_.FullName -match '(?i)\\secrets\\' -or
    $_.Extension -in '.log', '.wav', '.mp3', '.m4a'
}
if ($sospetti) {
    $sospetti | ForEach-Object { Write-Host "   TROVATO: $($_.FullName.Substring($payload.Length + 1))" -ForegroundColor Red }
    throw "Il payload contiene file che non vanno distribuiti. Aggiungili alle esclusioni e ribuilda."
}
# config.json: deve essere il modello con i segnaposto, non quello in uso qui.
$cfgPay = Join-Path $bridgeDst 'config.json'
if (Test-Path $cfgPay) {
    $c = Get-Content $cfgPay -Raw
    foreach ($chiave in 'auth_token', 'control_auth_token', 'gateway_auth_token',
                        'calendar_google_client_secret') {
        if ($c -match "`"$chiave`"\s*:\s*`"(?!`"|change-me)[^`"]+`"") {
            throw "config.json nel payload ha '$chiave' valorizzato: dev'essere config.json.example."
        }
    }
}
Ok 'nessun dato personale nel payload'

# --- 3. installer -----------------------------------------------------------
Step 'Compilo l''installer (NSIS)'
$nsi = Join-Path $repo 'installer\setup.nsi'
# NSIS in modo Unicode pretende il BOM e altrimenti si ferma con "Bad text
# encoding" alla riga 1. Molti editor lo tolgono salvando: lo si rimette qui,
# così chi modifica lo script non deve saperlo.
$raw = [IO.File]::ReadAllBytes($nsi)
if ($raw.Length -lt 3 -or $raw[0] -ne 0xEF -or $raw[1] -ne 0xBB -or $raw[2] -ne 0xBF) {
    $testo = [IO.File]::ReadAllText($nsi, [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($nsi, $testo, [Text.UTF8Encoding]::new($true))
    Ok 'BOM ripristinato in setup.nsi'
}
$out = Join-Path $dist "callAPIcall-Setup-$Version.exe"
& $nsis /DVERSION=$Version /DPAYLOAD=$payload /DOUTFILE=$out $nsi
if ($LASTEXITCODE -ne 0) { throw "makensis ha fallito (exit $LASTEXITCODE)." }

$size = [math]::Round((Get-Item $out).Length / 1MB, 1)
Write-Host "`nFATTO: $out ($size MB)" -ForegroundColor Green
Write-Host "Sulla macchina di destinazione l'installer scarica Python, le dipendenze e i modelli."
