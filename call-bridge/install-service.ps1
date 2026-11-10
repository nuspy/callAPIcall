# Installa/riconfigura l'orchestrator callAPIcall come SERVIZIO Windows via NSSM.
# Avvio automatico al boot + restart automatico ILLIMITATO su crash/uscita.
#
# ESEGUIRE DA POWERSHELL "COME AMMINISTRATORE":
#   powershell -ExecutionPolicy Bypass -File C:\Projects\callAPIcall\call-bridge\install-service.ps1
#
# Disinstallare:
#   powershell -ExecutionPolicy Bypass -File ...\install-service.ps1 -Uninstall

param([switch]$Uninstall, [switch]$Clean)

$ErrorActionPreference = 'Stop'
# Log su file: la console elevata e' separata, questo permette di verificare
# l'esito da fuori.
try { Start-Transcript -Path (Join-Path $PSScriptRoot 'install-service.log') -Force | Out-Null } catch {}
trap { Write-Host "ERRORE: $_"; try { Stop-Transcript | Out-Null } catch {}; }

# Architettura "split" (opzione A): questo servizio headless fa girare SOLO il
# voice gateway (app Android) + media server (parti senza-sessione, resilienti).
# Il control server (chiamate, audio HFP) + PTT girano nel task utente
# (callAPIcall-PTT -> main.py all --no-gateway).
$Name = 'callAPIcall-orchestrator'
# Percorsi derivati (meno fragili degli assoluti hardcoded): la dir e' quella
# dello script; Python e Hermes da %LOCALAPPDATA% con fallback all'assoluto.
$Dir  = $PSScriptRoot
$Py   = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'
if (-not (Test-Path $Py)) { $Py = 'C:\Users\atain\AppData\Local\Programs\Python\Python310\python.exe' }
$Log  = Join-Path $Dir 'serve.log'
# Env per l'ACP che il gateway spawna (un servizio NON eredita le var UTENTE).
$HermesHome   = Join-Path $env:LOCALAPPDATA 'hermes'
$GitBashPath  = 'C:\Program Files\Git\bin\bash.exe'
$Nssm = (Get-Command nssm -ErrorAction SilentlyContinue).Source
if (-not $Nssm) { $Nssm = 'C:\Users\atain\scoop\shims\nssm.exe' }

# Richiede privilegi di amministratore.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { throw "Esegui questo script da un PowerShell elevato (Run as Administrator)." }

if ($Uninstall) {
    & $Nssm stop $Name
    & $Nssm remove $Name confirm
    Write-Host "Servizio '$Name' rimosso."
    try { Stop-Transcript | Out-Null } catch {}
    return
}

if ($Clean) {
    # Rimuove le istanze duplicate dell'orchestrator e lascia attiva solo
    # quella del servizio. Ferma il servizio, uccide OGNI python 'main.py gateway'
    # rimasto (orfani da restart precedenti; non tocca ComfyUI/Binance perche'
    # il match e' specifico per 'main.py gateway'), poi riavvia il servizio.
    Write-Host "Stop servizio..."
    & $Nssm stop $Name 2>&1 | Out-Null
    Start-Sleep -Seconds 3
    $killed = @()
    Get-CimInstance Win32_Process -Filter "Name='python.exe' OR Name='pythonw.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'main\.py\s+gateway' } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; $killed += $_.ProcessId } catch {}
        }
    Write-Host ("Istanze orchestrator terminate: " + ($(if ($killed) { $killed -join ', ' } else { 'nessuna' })))
    Start-Sleep -Seconds 2
    $stillBound = (Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($stillBound) {
        Write-Host "Porta 8771 ancora occupata da PID ${stillBound}: la libero"
        Stop-Process -Id $stillBound -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    Write-Host "Start servizio..."
    & $Nssm start $Name
    Start-Sleep -Seconds 3
    & $Nssm status $Name
    $bound = (Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue).OwningProcess
    $count = (Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
              Where-Object { $_.CommandLine -match 'main\.py\s+gateway' }).Count
    Write-Host "Istanze orchestrator attive ora: $count | listener 8771 = PID $bound"
    try { Stop-Transcript | Out-Null } catch {}
    return
}

# Se esiste gia', fermalo prima di riconfigurarlo. Tollerante se e' gia' fermo:
# `nssm stop` su un servizio non avviato scrive su stderr e con EAP=Stop
# farebbe abortire lo script PRIMA di riconfigurare/avviare.
if (Get-Service -Name $Name -ErrorAction SilentlyContinue) {
    if ((Get-Service -Name $Name).Status -eq 'Running') { & $Nssm stop $Name 2>&1 | Out-Null }
} else {
    & $Nssm install $Name $Py 'main.py' 'gateway'
}

# Configurazione
& $Nssm set $Name Application        $Py
& $Nssm set $Name AppParameters      'main.py gateway'
& $Nssm set $Name AppDirectory       $Dir
& $Nssm set $Name AppEnvironmentExtra "HERMES_HOME=$HermesHome" "HERMES_GIT_BASH_PATH=$GitBashPath"
& $Nssm set $Name DisplayName        'callAPIcall Gateway'
& $Nssm set $Name Description        'callAPIcall voice gateway (app Android) + media server — architettura split (headless)'
& $Nssm set $Name Start              SERVICE_AUTO_START      # avvio al boot
# Il gateway binda su 0.0.0.0: assicura che lo stack TCP/IP sia su prima di
# partire (Tcpip e' sempre presente). Per il bind sull'IP Tailscale, aggiungere
# manualmente il servizio: nssm set $Name DependOnService Tcpip Tailscale
& $Nssm set $Name DependOnService    Tcpip

# Restart automatico illimitato (Default = Restart e' gia' il comportamento NSSM;
# lo rendiamo esplicito e impostiamo i ritardi).
& $Nssm set $Name AppExit Default    Restart
& $Nssm set $Name AppRestartDelay    5000                    # attesa 5s tra i restart
& $Nssm set $Name AppThrottle        5000                    # soglia anti-loop (non smette mai)

# Log con rotazione (stdout+stderr -> serve.log)
& $Nssm set $Name AppStdout          $Log
& $Nssm set $Name AppStderr          $Log
& $Nssm set $Name AppRotateFiles     1
& $Nssm set $Name AppRotateOnline    1
& $Nssm set $Name AppRotateBytes     10485760                # ruota a 10 MB

& $Nssm start $Name 2>&1 | Out-Null

Start-Sleep -Seconds 3
& $Nssm status $Name 2>&1
Get-Service -Name $Name | Format-List Name,Status,StartType
Write-Host "Fatto. Log servizio: $Log"
try { Stop-Transcript | Out-Null } catch {}
