# Installa il supervisore PTT come TASK PIANIFICATO auto-riavviante e invisibile.
#
# Sostituisce la vecchia chiave Run HKCU "callAPIcall-PTT" (fragile: lanciata una
# sola volta al logon; se il supervisore muore, niente lo rimette su fino al
# prossimo login). Il Task:
#   - parte al logon (sessione utente -> hotkey/overlay/audio funzionano)
#   - gira via run-ptt-hidden.vbs (wscript) -> NESSUNA finestra da chiudere
#   - se il supervisore muore, il Task lo RIAVVIA da solo (ogni 1 min, ~illimitato)
#
# NON richiede privilegi di amministratore (task nella sessione dell'utente).
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File install-ptt-task.ps1            # installa + attiva
#   powershell -ExecutionPolicy Bypass -File install-ptt-task.ps1 -NoStart   # installa senza switchover
#   powershell -ExecutionPolicy Bypass -File install-ptt-task.ps1 -Uninstall # rimuove il task

param([switch]$Uninstall, [switch]$NoStart)

$ErrorActionPreference = 'Stop'
$TaskName = 'callAPIcall-PTT'
$Dir      = 'C:\Projects\callAPIcall\call-bridge'
$Vbs      = Join-Path $Dir 'run-ptt-hidden.vbs'
$RunKey   = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'

function Stop-OldSupervisors {
    # Ferma ogni vecchio supervisore (powershell run-ptt.ps1, wscript del vbs) e
    # le istanze main.py all, per evitare doppioni / conflitti di porta.
    Get-CimInstance Win32_Process | Where-Object {
        $_.CommandLine -match 'run-ptt\.ps1|run-ptt-hidden\.vbs' -or $_.CommandLine -match 'main\.py\s+all'
    } | ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; "  fermato PID $($_.ProcessId)" } catch {}
    }
}

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
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $Vbs)
# DUE trigger:
#  - AtLogOn: avvio pronto al login.
#  - Once (adesso) + ripetizione ogni 1 min a tempo indeterminato: e' il POLL di
#    self-heal indipendente dal logon. Con MultipleInstances=IgnoreNew: se il
#    supervisore e' gia' vivo il tick viene ignorato; se e' morto, lo riavvia.
# NOTA: la ripetizione DEVE stare su un trigger a tempo, NON innestata sul trigger
# di logon (li' non scatta finche' non rifai il login: testato, non riavviava).
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
    -Description 'Supervisore PTT callAPIcall (main.py all) — invisibile, auto-riavviante' | Out-Null
Write-Host "   registrato (logon + restart automatico)." -ForegroundColor Green

if ($NoStart) {
    Write-Host "Installazione completata. Partira' al prossimo logon (o: Start-ScheduledTask -TaskName $TaskName)." -ForegroundColor Green
    return
}

Write-Host "3) Switchover: fermo i vecchi supervisori e avvio il Task ora..." -ForegroundColor Cyan
Stop-OldSupervisors
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName $TaskName

Write-Host "4) Verifico che il gateway 8771 risalga (max 40s)..." -ForegroundColor Cyan
$ok = $false
for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 500
    if (Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue) { $ok = $true; break }
}
if ($ok) { Write-Host "   OK: supervisore attivo e invisibile, gateway su." -ForegroundColor Green }
else { Write-Host "   ATTENZIONE: 8771 non ancora su. Controlla ptt.log." -ForegroundColor Yellow }

Write-Host "Fatto. Stato task:" -ForegroundColor Green
Get-ScheduledTask -TaskName $TaskName | Select-Object TaskName, State
(Get-ScheduledTaskInfo -TaskName $TaskName).LastTaskResult | ForEach-Object { "   LastTaskResult: $_" }
