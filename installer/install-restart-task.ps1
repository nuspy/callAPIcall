# Registra il task pianificato che riavvia i SERVIZI di callAPIcall con
# privilegi elevati. Da eseguire UNA VOLTA come amministratore.
#
# Perche' serve: i servizi NSSM (`vLLMManager`, `callAPIcall-orchestrator`) hanno
# un SDDL che concede all'utente interattivo solo la QUERY, non START/STOP. Senza
# questo task il bottone "Restart completo" della GUI farebbe tutto tranne il
# riavvio dei due servizi (che verrebbe saltato e annotato nel log).
#
# Il task esegue `restart-all.ps1 -ServicesOnly`: SOLO i servizi. Il resto
# (worker, bridge, GUI, VRAM) lo fa la GUI nella sessione utente, non elevato —
# cosi' bridge e Control Center ripartono con i privilegi giusti.

$ErrorActionPreference = 'Stop'

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Esegui questo script come amministratore (tasto destro -> Esegui come amministratore)."
}

$taskName = 'callAPIcall-SystemRestart'
$script   = 'C:\Projects\callAPIcall\call-bridge\restart-all.ps1'
if (-not (Test-Path $script)) { throw "script non trovato: $script" }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -ServicesOnly"
# Gira come SYSTEM: nessuna password da conservare e privilegi sufficienti per
# start/stop dei servizi. Nessun trigger: parte solo su richiesta (schtasks /Run).
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal `
    -Settings $settings -Description 'Riavvia i servizi callAPIcall (vLLMManager, orchestrator) su richiesta della GUI' `
    -Force | Out-Null

# Un task che gira come SYSTEM non e' avviabile dall'utente normale se il suo
# descrittore non lo consente: senza questo, `schtasks /Run` dalla GUI darebbe
# "accesso negato" e il bottone salterebbe i servizi in silenzio.
# BA/SY = pieno controllo; AU (utenti autenticati) = lettura + esecuzione.
$sddl = 'D:(A;;GA;;;BA)(A;;GA;;;SY)(A;;GRGX;;;AU)'
try {
    $svc = New-Object -ComObject Schedule.Service
    $svc.Connect()
    $svc.GetFolder('\').GetTask($taskName).SetSecurityDescriptor($sddl, 0)
    Write-Host "Permessi di esecuzione concessi agli utenti autenticati." -ForegroundColor Green
} catch {
    Write-Warning "SDDL non applicato ($($_.Exception.Message)): il bottone potrebbe non poter avviare il task."
}

Write-Host "Task '$taskName' registrato." -ForegroundColor Green
Write-Host "Il bottone 'Restart completo' della GUI ora riavvia anche i servizi." -ForegroundColor Green
