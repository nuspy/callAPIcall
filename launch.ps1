#requires -Version 5.1
<#
  launch.ps1 - avvia l'applicazione callAPIcall (Control Center + backend).

  Cosa fa: assicura che i due SUPERVISORI siano attivi. Ognuno tiene vivo il suo
  processo e lo rilancia se cade:
    - run-ptt.ps1            -> BACKEND  (main.py all: chiamate, push-to-talk,
                                          overlay, control server su :8770)
    - run-control-center.ps1 -> GUI      (callapicall-control-center.exe, in tray)

  Il Control Center puo' avviare il backend da solo (sezione "Componenti"), ma
  qui lo assicuriamo comunque cosi' l'app e' subito pronta. Idempotente: se un
  supervisore gira gia', non ne parte un secondo.

  NB: parte dall'EXE GUI gia' buildato. Se non esiste ancora, o hai cambiato il
  frontend, esegui prima .\build.ps1.

  Uso:  .\launch.ps1
#>
$ErrorActionPreference = 'Stop'
$repo   = $PSScriptRoot
$gui    = Join-Path $repo 'gui'
$bridge = Join-Path $repo 'call-bridge'

function Ensure-Supervisor {
    param([string]$Script, [string]$Dir, [string]$Sentinel)
    $name = Split-Path $Script -Leaf
    if (-not (Test-Path $Script)) { throw "Supervisore mancante: $Script" }
    $running = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match [regex]::Escape($name) }
    if ($running) { Write-Host "  $name gia' attivo" -ForegroundColor DarkGray; return }
    # Rimuovi l'eventuale sentinella di stop, altrimenti il supervisore non rilancia.
    Remove-Item (Join-Path $Dir $Sentinel) -Force -ErrorAction SilentlyContinue
    Start-Process powershell.exe -WorkingDirectory $Dir -WindowStyle Hidden `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script | Out-Null
    Write-Host "  $name avviato" -ForegroundColor Green
}

Write-Host 'Avvio callAPIcall...' -ForegroundColor Cyan
# 1) Backend per primo (il Control Center lo userebbe comunque, ma lo assicuriamo).
Ensure-Supervisor -Script (Join-Path $bridge 'run-ptt.ps1')            -Dir $bridge -Sentinel 'ptt.stop'
# 2) Control Center (GUI): l'exe parte in tray, il supervisore lo tiene su.
Ensure-Supervisor -Script (Join-Path $gui    'run-control-center.ps1') -Dir $gui    -Sentinel 'cc.stop'
Write-Host 'Fatto. Il Control Center compare nella tray tra pochi secondi.' -ForegroundColor Green
