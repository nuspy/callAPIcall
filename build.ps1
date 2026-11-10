#requires -Version 5.1
<#
  build.ps1 - builda frontend + backend di callAPIcall e ricarica l'app.

  - BACKEND (Python, interpretato): non c'e' un vero "build" -> si verifica solo
    che l'intero pacchetto COMPILI (py_compile). Serve a NON ricaricare codice
    rotto. (Se hai cambiato dipendenze: pip install -r call-bridge\requirements.txt
    a parte, non e' automatico qui.)
  - FRONTEND (Tauri): ricompila l'EXE del Control Center incorporando dist/.
    L'exe e' lockato mentre l'app gira, quindi: sentinella cc.stop -> stop app ->
    build -> rimuovi sentinella (il supervisore rilancia il nuovo exe).

  Alla fine RICARICA tutto col codice nuovo: riavvia il backend (main.py) e
  assicura i supervisori via launch.ps1. Con -NoReload fa solo il build.

  Uso:  .\build.ps1            # build + reload (default)
        .\build.ps1 -NoReload  # solo build, non ricaricare
#>
param([switch]$NoReload)
$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$gui    = Join-Path $repo 'gui'
$bridge = Join-Path $repo 'call-bridge'

# --- tool ------------------------------------------------------------------
$py = 'C:\Users\atain\AppData\Local\Programs\Python\Python310\python.exe'
if (-not (Test-Path $py)) { $py = (Get-Command python -ErrorAction Stop).Source }
$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
    $bun = 'C:\Users\atain\AppData\Local\Microsoft\WinGet\Packages\Oven-sh.Bun_Microsoft.Winget.Source_8wekyb3d8bbwe\bun-windows-x64\bun.exe'
}
if (-not (Test-Path $bun)) { throw "bun non trovato: installalo o correggi il path in build.ps1" }

# --- 1) backend: verifica che compili --------------------------------------
Write-Host '== Backend: verifica compilazione (py_compile) ==' -ForegroundColor Cyan
& $py -m compileall -q (Join-Path $bridge 'callbridge') (Join-Path $bridge 'main.py')
if ($LASTEXITCODE -ne 0) { throw 'Il backend NON compila: correggi prima di ricaricare.' }
Write-Host '   ok' -ForegroundColor Green

# --- 2) frontend: build dell'exe Tauri (incorpora dist/) -------------------
Write-Host '== Frontend: build exe Tauri (bun run tauri build --no-bundle) ==' -ForegroundColor Cyan
$ccstop = Join-Path $gui 'cc.stop'
New-Item -ItemType File -Path $ccstop -Force | Out-Null                 # ferma il supervisore GUI
Get-Process -Name 'callapicall-control-center' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1                                                  # lascia rilasciare il lock sull'exe
try {
    Push-Location $gui
    & $bun run tauri build --no-bundle
    if ($LASTEXITCODE -ne 0) { throw 'Build frontend FALLITA.' }
} finally {
    Pop-Location
}
Write-Host '   exe ricostruito' -ForegroundColor Green

# --- 3) reload -------------------------------------------------------------
if ($NoReload) {
    Remove-Item $ccstop -Force -ErrorAction SilentlyContinue
    Write-Host 'Build fatta (-NoReload): servizi NON riavviati. Usa .\launch.ps1 per avviare.' -ForegroundColor Yellow
    return
}
Remove-Item $ccstop -Force -ErrorAction SilentlyContinue               # il supervisore rilancia il nuovo exe
Write-Host '== Reload: riavvio backend + assicuro i supervisori ==' -ForegroundColor Cyan
# Backend: killa main.py -> run-ptt.ps1 lo rilancia col codice nuovo.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'main\.py\s+all' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
# Assicura che entrambi i supervisori siano su (rilancia exe + backend se serve).
& (Join-Path $repo 'launch.ps1')
Write-Host 'FATTO: Control Center e backend aggiornati al codice nuovo.' -ForegroundColor Green
