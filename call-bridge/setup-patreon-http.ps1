<#
  setup-patreon-http.ps1 — Patreon MCP in HTTP come SERVIZIO NSSM (always-on).
  ESEGUIRE COME AMMINISTRATORE.

  Fa:
   1. Crea il servizio NSSM "patreon-mcp-http" = venv-python -m scripts.patreon_http
      (FastMCP streamable-http su 127.0.0.1:8781), auto-start al boot + restart.
      Env: HERMES_HOME, PATREON_ACCESS_TOKEN (dal .env), e cache ML/browser su
      path fissi così i tool RAG/Playwright funzionano anche da servizio LocalSystem.
   2. Avvia il servizio (dopo aver liberato :8781 da eventuale processo di test).
   3. Riavvia HermesGatewayNative (carica la config patreon ora URL-based).
   4. Verifica: :8781, hermes mcp test patreon, stato servizi.

  Config già impostata: mcp_servers.patreon.url = http://127.0.0.1:8781/mcp
  Disinstallare:  nssm stop patreon-mcp-http; nssm remove patreon-mcp-http confirm
#>
$pr = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $pr.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Esegui come Amministratore." -ForegroundColor Red; exit 1
}
# Continue: i comandi nativi (schtasks/nssm) scrivono su stderr anche in casi
# benigni (task/servizio inesistente) e con 'Stop' farebbero abortire lo script.
$ErrorActionPreference = 'Continue'

$H      = "C:\Users\atain\AppData\Local\hermes"
$py     = "$H\hermes-agent\venv\Scripts\python.exe"
$skill  = "$H\skills\patreon-creator-skill"
$logdir = "$H\logs"
$hf     = "$H\hf-cache"
$pw     = "C:\Users\atain\AppData\Local\ms-playwright"
$svc    = "patreon-mcp-http"
$nssm   = "C:\Users\atain\AppData\Local\NSSM\nssm.exe"; if (-not (Test-Path $nssm)) { $nssm = "C:\Users\atain\scoop\shims\nssm.exe" }
New-Item -ItemType Directory -Force -Path $logdir, $hf | Out-Null

# Token dal .env
$line = (Select-String -Path "$H\.env" -Pattern '^PATREON_ACCESS_TOKEN=' -ErrorAction SilentlyContinue | Select-Object -First 1).Line
if (-not $line) { Write-Error "PATREON_ACCESS_TOKEN non trovato in $H\.env"; exit 1 }
$tok = ($line -split '=', 2)[1].Trim()

Write-Host "=== 0) libero :8781 da eventuali processi di test ===" -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'scripts\.patreon_http' } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
# rimuovo un eventuale vecchio task con lo stesso nome (silenzioso anche se non esiste)
cmd /c "schtasks /delete /tn patreon-mcp-http /f >nul 2>nul"
Start-Sleep -Seconds 2

Write-Host "=== 1) (Ri)creo il servizio $svc ===" -ForegroundColor Cyan
if (Get-Service $svc -ErrorAction SilentlyContinue) {
  if ((Get-Service $svc).Status -eq 'Running') { & $nssm stop $svc 2>&1 | Out-Null }
  & $nssm remove $svc confirm 2>&1 | Out-Null; Start-Sleep -Seconds 2
}
& $nssm install $svc $py | Out-Null
& $nssm set $svc AppParameters      "-m scripts.patreon_http"
& $nssm set $svc AppDirectory       $skill
& $nssm set $svc AppEnvironmentExtra "HERMES_HOME=$H" "PATREON_ACCESS_TOKEN=$tok" "PATREON_MCP_PORT=8781" "HF_HOME=$hf" "TRANSFORMERS_CACHE=$hf" "SENTENCE_TRANSFORMERS_HOME=$hf" "PLAYWRIGHT_BROWSERS_PATH=$pw"
& $nssm set $svc Start              SERVICE_AUTO_START
& $nssm set $svc AppStdout          "$logdir\patreon-http.out.log"
& $nssm set $svc AppStderr          "$logdir\patreon-http.err.log"
& $nssm set $svc AppRotateFiles     1
& $nssm set $svc AppRotateBytes     5242880
# Ruota anche a servizio ATTIVO (senza, ruota solo al riavvio).
& $nssm set $svc AppRotateOnline    1
& $nssm set $svc AppExit Default    Restart
& $nssm set $svc AppRestartDelay    5000
& $nssm set $svc DisplayName        "Patreon MCP (HTTP :8781)"
& $nssm set $svc Description         "Patreon MCP via streamable-http per hermes (url-based)"
Write-Host "  servizio creato."

Write-Host "=== 2) Avvio servizio ===" -ForegroundColor Cyan
& $nssm start $svc 2>&1 | Out-Null
Start-Sleep -Seconds 8

Write-Host "=== 3) Riavvio gateway (carica config patreon url) ===" -ForegroundColor Cyan
& $nssm restart HermesGatewayNative 2>&1 | Out-Null
Start-Sleep -Seconds 12

Write-Host "=== 4) Verifica ===" -ForegroundColor Cyan
$c = Get-NetTCPConnection -State Listen -LocalPort 8781 -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host ("  patreon HTTP :8781 -> " + $(if($c){"LISTEN pid="+$c.OwningProcess}else{"GIU"}))
$env:HERMES_HOME = $H
& "$H\hermes-agent\venv\Scripts\hermes.exe" mcp test patreon 2>&1 | Select-Object -First 6
Get-Service "$svc", HermesGatewayNative | Format-Table Name, Status, StartType -Auto
Write-Host "Fatto. Atteso: ':8781 LISTEN' + 'Connected / 52 tools', servizi Running." -ForegroundColor Green
