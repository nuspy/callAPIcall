# Installa il supervisore del Control Center (icona nella tray) come TASK
# PIANIFICATO auto-riavviante e invisibile.
#
# Sostituisce la chiave Run HKCU "callAPIcall-ControlCenter" di
# install-autostart.ps1, fragile per due motivi:
#   - lanciata UNA sola volta al logon: se il supervisore muore (o qualcuno lo
#     chiude), la tray resta vuota fino al login successivo;
#   - se la chiave sparisce, l'app non parte piu' e non c'e' nessun segnale.
# Il Task invece:
#   - parte al logon (SESSIONE UTENTE: una tray icon dalla sessione 0 di un
#     servizio Windows non e' visibile, per isolamento di sessione);
#   - gira via run-control-center-hidden.vbs (wscript) -> nessuna finestra;
#   - ha un tick di poll ogni minuto che lo RIAVVIA se e' morto.
# Stesso schema di call-bridge\install-ptt-task.ps1 (backend).
#
# NON richiede privilegi di amministratore.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File install-cc-task.ps1            # installa + avvia
#   powershell -ExecutionPolicy Bypass -File install-cc-task.ps1 -NoStart   # installa soltanto
#   powershell -ExecutionPolicy Bypass -File install-cc-task.ps1 -Uninstall # rimuove il task

param([switch]$Uninstall, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$TaskName = 'callAPIcall-ControlCenter'
$Dir      = $PSScriptRoot
if (-not $Dir) { $Dir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$Vbs      = Join-Path $Dir 'run-control-center-hidden.vbs'
$RunKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Task '$TaskName' rimosso." -ForegroundColor Green
    return
}

if (-not (Test-Path $Vbs)) { throw "Manca il launcher: $Vbs" }

Write-Host "1) Rimuovo la vecchia chiave Run HKCU '$TaskName' (se presente)..." -ForegroundColor Cyan
if (Get-ItemProperty -Path $RunKey -Name $TaskName -ErrorAction SilentlyContinue) {
    Remove-ItemProperty -Path $RunKey -Name $TaskName
    Write-Host "   rimossa." -ForegroundColor DarkGray
} else { Write-Host "   non presente (ok)." -ForegroundColor DarkGray }

Write-Host "2) Registro il Task pianificato '$TaskName'..." -ForegroundColor Cyan
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $Vbs)
# Due trigger, come per il PTT: AtLogOn per essere pronti all'accesso, e un
# trigger a tempo con ripetizione ogni minuto come poll di self-heal (la
# ripetizione innestata su AtLogOn non scatta finche' non rifai il login).
# MultipleInstances=IgnoreNew: se il supervisore e' vivo il tick e' ignorato.
$tLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$tPoll  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew -StartWhenAvailable -Hidden
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($tLogon, $tPoll) `
    -Principal $principal -Settings $settings -Force `
    -Description 'Supervisore Control Center callAPIcall (tray) — invisibile, auto-riavviante' | Out-Null
Write-Host "   registrato (logon + riavvio automatico)." -ForegroundColor Green

if ($NoStart) {
    Write-Host "Installazione completata. Partira' al prossimo logon (o: Start-ScheduledTask -TaskName $TaskName)." -ForegroundColor Green
    return
}

Write-Host "3) Fermo i vecchi supervisori e avvio il Task ora..." -ForegroundColor Cyan
Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -match 'run-control-center\.ps1|run-control-center-hidden\.vbs'
} | ForEach-Object {
    try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "  fermato PID $($_.ProcessId)" } catch {}
}
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName

Write-Host "4) Verifico che il Control Center compaia (max 60s)..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 120; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-Process -Name 'callapicall-control-center' -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if ($ok) { Write-Host "   OK: Control Center attivo, icona nella tray." -ForegroundColor Green }
else { Write-Host "   ATTENZIONE: non ancora partito. Controlla gui\cc-supervisor.log." -ForegroundColor Yellow }

Write-Host "Fatto. Stato task:" -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
(Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult | ForEach-Object { "   LastTaskResult: $_" }
