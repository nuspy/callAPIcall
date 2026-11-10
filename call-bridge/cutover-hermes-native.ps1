<#
  cutover-hermes-native.ps1  —  Cutover gateway/cron da Hermes-WSL a Hermes-nativo.

  ESEGUIRE COME AMMINISTRATORE (crea/ferma servizi Windows).

  Cosa fa:
   1. Ferma e DISABILITA il servizio NSSM HermesGatewayWSL (il suo trap EXIT
      spegne hermes-gateway/phone dentro WSL); in più li ferma esplicitamente
      via systemctl --user (belt-and-suspenders). NON spegne l'intera WSL
      (resta su per altri usi, es. Handy ZONOS2).
   2. Crea il servizio NSSM HermesGatewayNative -> "hermes.exe gateway run
      --accept-hooks", HERMES_HOME = %LOCALAPPDATA%\hermes, auto-start, log,
      restart automatico. Gira come l'utente .\atain (come faceva il WSL).
   3. Avvia il servizio e mostra stato + ultime righe di log.

  Reversibile: per tornare a WSL ->  Set-Service HermesGatewayWSL -StartupType Automatic; Start-Service HermesGatewayWSL
               e  nssm stop/remove HermesGatewayNative
#>

$ErrorActionPreference = 'Stop'

# --- guard: admin ---
$pr = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Error "Esegui questo script in un PowerShell *come amministratore*."; exit 1
}

$HERMES_HOME = "C:\Users\atain\AppData\Local\hermes"
$HERMES_EXE  = "$HERMES_HOME\hermes-agent\venv\Scripts\hermes.exe"
$NSSM        = "C:\Users\atain\AppData\Local\NSSM\nssm.exe"
if (-not (Test-Path $NSSM)) { $NSSM = "C:\Users\atain\scoop\shims\nssm.exe" }
$SVC_NEW     = "HermesGatewayNative"
$SVC_OLD     = "HermesGatewayWSL"
$LOGDIR      = "$HERMES_HOME\logs"

if (-not (Test-Path $HERMES_EXE)) { Write-Error "hermes.exe non trovato: $HERMES_EXE"; exit 1 }
if (-not (Test-Path $NSSM))       { Write-Error "nssm.exe non trovato"; exit 1 }
New-Item -ItemType Directory -Force -Path $LOGDIR | Out-Null

Write-Host "`n=== 1) Stop + disable $SVC_OLD (gateway WSL) ===" -ForegroundColor Cyan
$old = Get-Service $SVC_OLD -ErrorAction SilentlyContinue
if ($old) {
  if ($old.Status -ne 'Stopped') { Stop-Service $SVC_OLD -Force; Start-Sleep 3 }
  Set-Service $SVC_OLD -StartupType Disabled
  Write-Host "  ${SVC_OLD}: $((Get-Service $SVC_OLD).Status), StartType Disabled"
} else { Write-Host "  $SVC_OLD non presente (ok)" }

# Belt-and-suspenders: ferma i servizi gateway DENTRO WSL (senza spegnere la distro)
Write-Host "  Stop gateway dentro WSL (systemctl --user)..."
& wsl.exe -d Ubuntu -- bash -lc "systemctl --user stop hermes-gateway hermes-phone hermes-dashboard 2>/dev/null; systemctl --user disable hermes-gateway hermes-phone hermes-dashboard 2>/dev/null; echo done" 2>&1 | Out-Host

Write-Host "`n=== 2) (Ri)crea servizio $SVC_NEW (gateway nativo) ===" -ForegroundColor Cyan
$exists = Get-Service $SVC_NEW -ErrorAction SilentlyContinue
if ($exists) {
  if ($exists.Status -ne 'Stopped') { & $NSSM stop $SVC_NEW | Out-Null; Start-Sleep 2 }
  & $NSSM remove $SVC_NEW confirm | Out-Null; Start-Sleep 2
  Write-Host "  vecchio $SVC_NEW rimosso"
}

# Credenziali per far girare il servizio come l'utente (come il vecchio WSL = .\atain)
Write-Host "  Inserisci la password dell'utente PLUTO-MAX\atain per il service account:" -ForegroundColor Yellow
$cred = Get-Credential -UserName ".\atain" -Message "Account per il servizio $SVC_NEW"

& $NSSM install $SVC_NEW $HERMES_EXE | Out-Null
& $NSSM set $SVC_NEW AppParameters "gateway run --accept-hooks" | Out-Null
& $NSSM set $SVC_NEW AppDirectory $HERMES_HOME | Out-Null
# HERMES_HOME + Git Bash (i cron/terminal tool usano bash; un servizio NON eredita
# le variabili d'ambiente UTENTE, quindi vanno passate qui esplicitamente).
& $NSSM set $SVC_NEW AppEnvironmentExtra "HERMES_HOME=$HERMES_HOME" "HERMES_GIT_BASH_PATH=C:\Program Files\Git\bin\bash.exe" | Out-Null
& $NSSM set $SVC_NEW Start SERVICE_AUTO_START | Out-Null
& $NSSM set $SVC_NEW AppStdout "$LOGDIR\gateway-native.out.log" | Out-Null
& $NSSM set $SVC_NEW AppStderr "$LOGDIR\gateway-native.err.log" | Out-Null
& $NSSM set $SVC_NEW AppRotateFiles 1 | Out-Null
& $NSSM set $SVC_NEW AppRotateBytes 5242880 | Out-Null
# AppRotateOnline 1: ruota i log MENTRE il servizio gira (senza, ruota solo al
# riavvio -> i log crescono senza limite tra un restart e l'altro).
& $NSSM set $SVC_NEW AppRotateOnline 1 | Out-Null
& $NSSM set $SVC_NEW AppExit Default Restart | Out-Null
& $NSSM set $SVC_NEW AppRestartDelay 5000 | Out-Null
& $NSSM set $SVC_NEW DisplayName "Hermes Gateway (native)" | Out-Null
& $NSSM set $SVC_NEW Description "Hermes Agent messaging gateway + cron dispatch (Windows-native)" | Out-Null
& $NSSM set $SVC_NEW ObjectName ".\atain" $cred.GetNetworkCredential().Password | Out-Null
Write-Host "  $SVC_NEW creato."

Write-Host "`n=== 3) Avvio $SVC_NEW ===" -ForegroundColor Cyan
& $NSSM start $SVC_NEW | Out-Null
Start-Sleep 8
Write-Host "  Stato: $((Get-Service $SVC_NEW).Status)"

Write-Host "`n=== Log gateway nativo (ultime righe) ===" -ForegroundColor Cyan
Start-Sleep 4
Get-Content "$LOGDIR\gateway-native.out.log" -Tail 20 -ErrorAction SilentlyContinue
Get-Content "$LOGDIR\gateway-native.err.log" -Tail 20 -ErrorAction SilentlyContinue

Write-Host "`n=== hermes gateway status ===" -ForegroundColor Cyan
$env:HERMES_HOME = $HERMES_HOME
& $HERMES_EXE gateway status 2>&1 | Select-Object -First 20

# --- Nota: phone server HTTP (:8780) ora obsoleto ---
# Dopo il cutover il phone server WSL (:8780) NON gira piu'. callAPIcall ora usa
# l'agente ACP nativo per TUTTI i cervelli (F1/F2/F3, gateway, GSM e chiamate
# Android): con acp_enabled=true le funzioni make_full_brain/make_limited_brain
# e l'integrazione orchestrator ignorano hermes_mode e usano ACP. Il campo
# hermes_mode:"http" / hermes_base_url :8780 in config.json e' quindi INERTE
# (nessuno lo consuma piu' con ACP attivo). Puoi lasciarlo o metterlo su "stub".
Write-Host "`n[nota] Phone server :8780 obsoleto: con acp_enabled i cervelli usano ACP; hermes_mode:http e' inerte." -ForegroundColor DarkYellow

Write-Host "`nFatto. Se vedi il gateway 'running' e Telegram connesso, il cutover e' riuscito." -ForegroundColor Green
Write-Host "Per tornare a WSL:  Set-Service $SVC_OLD -StartupType Automatic; Start-Service $SVC_OLD ; nssm stop $SVC_NEW; nssm remove $SVC_NEW confirm" -ForegroundColor DarkGray
