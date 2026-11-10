<#
  activate-split.ps1 — Attiva l'architettura "split" (opzione A) di callAPIcall.

  ESEGUIRE COME AMMINISTRATORE.

  Risultato:
   - Servizio NSSM headless  callAPIcall-orchestrator -> `main.py gateway`
       = voice gateway (app Android, :8771) + media server (:8772). Resiliente,
         avvio al boot, restart automatico. (Niente audio locale: ok in Session 0.)
   - Task utente            callAPIcall-PTT          -> `main.py all --no-gateway`
       = control server (chiamate, audio HFP) + PTT + overlay + copilota (:8770).

  Transizione atomica: ferma l'istanza unica corrente, libera le porte, avvia il
  servizio, riavvia il task, verifica.

  Ritorno indietro (single-instance): rimettere run-ptt.ps1 a `main.py all` e
  disinstallare il servizio (install-service.ps1 -Uninstall).
#>

$ErrorActionPreference = 'Continue'
$pr = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Esegui questo script in un PowerShell *come amministratore*."; exit 1
}
$Dir = 'C:\Projects\callAPIcall\call-bridge'

Write-Host "`n=== 1) Stop task PTT + istanze correnti (libera 8770/8771/8772) ===" -ForegroundColor Cyan
schtasks /end /tn callAPIcall-PTT 2>$null | Out-Null
Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'run-ptt\.ps1' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'main\.py\s+(all|ptt|gateway|serve)' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
Start-Sleep -Seconds 3

Write-Host "`n=== 2) Installa/configura/avvia il servizio gateway (install-service.ps1) ===" -ForegroundColor Cyan
& (Join-Path $Dir 'install-service.ps1')
Start-Sleep -Seconds 5

Write-Host "`n=== 3) Riavvia il task PTT (-> main.py all --no-gateway) ===" -ForegroundColor Cyan
schtasks /run /tn callAPIcall-PTT 2>$null | Out-Null
Write-Host "  Attendo l'avvio del control server (:8770)..."
$deadline = (Get-Date).AddSeconds(40); $ok8770 = $false
do {
  Start-Sleep -Seconds 4
  if (Get-NetTCPConnection -State Listen -LocalPort 8770 -ErrorAction SilentlyContinue) { $ok8770 = $true; break }
} while ((Get-Date) -lt $deadline)

Write-Host "`n=== 4) Verifica porte ===" -ForegroundColor Cyan
foreach ($p in @(@{n=8770;w='control (task)'}, @{n=8771;w='gateway (servizio)'}, @{n=8772;w='media (servizio)'})) {
  $c = Get-NetTCPConnection -State Listen -LocalPort $p.n -ErrorAction SilentlyContinue | Select-Object -First 1
  $who = if ($c) { "LISTEN pid=$($c.OwningProcess)" } else { "GIU" }
  Write-Host ("  {0,-5} {1,-20} {2}" -f $p.n, $p.w, $who)
}
Write-Host "`n=== Servizio ===" -ForegroundColor Cyan
Get-Service callAPIcall-orchestrator | Format-List Name, Status, StartType
Write-Host "Atteso: 8770 (task/control) + 8771/8772 (servizio/gateway+media) tutti LISTEN, servizio Running/Automatic." -ForegroundColor Green
