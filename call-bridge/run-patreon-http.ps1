# DEPRECATO — sostituito dal servizio NSSM `patreon-mcp-http` (setup-patreon-http.ps1).
# Supervisore del Patreon MCP in modalità HTTP (streamable-http) su 127.0.0.1:8781.
# hermes lo usa come MCP url-based (mcp_servers.patreon.url) — aggira il bug del
# connettore stdio di hermes. Riavvia il server all'infinito (auto-restart).
$ErrorActionPreference = 'Continue'
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch {}

# Se il servizio NSSM esiste, NON avviare questo supervisore: il suo
# kill-by-pattern (piu' sotto) ucciderebbe ANCHE il processo del servizio,
# innescando un loop kill/restart su :8781.
$svc = Get-Service -Name 'patreon-mcp-http' -ErrorAction SilentlyContinue
if ($svc) {
    Write-Warning "patreon-mcp-http gestito da NSSM: run-patreon-http.ps1 e' deprecato, esco."
    exit 0
}

$H     = 'C:\Users\atain\AppData\Local\hermes'
$py    = "$H\hermes-agent\venv\Scripts\python.exe"
$skill = "$H\skills\patreon-creator-skill"
$log   = "$H\logs\patreon-http.out.log"
$err   = "$H\logs\patreon-http.err.log"

$env:HERMES_HOME = $H
# Token dal .env (serve al server per le chiamate ai tool Patreon).
$line = (Select-String -Path "$H\.env" -Pattern '^PATREON_ACCESS_TOKEN=' -ErrorAction SilentlyContinue | Select-Object -First 1).Line
if ($line) { $env:PATREON_ACCESS_TOKEN = ($line -split '=', 2)[1].Trim() }

# Un solo supervisore.
$me = $PID
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'run-patreon-http\.ps1' }
if ($others) { exit 0 }

while ($true) {
    # Pulizia orfani del server (libera :8781).
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'scripts\.patreon_http' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    Set-Location $skill
    try {
        $p = Start-Process -FilePath $py -ArgumentList '-m', 'scripts.patreon_http' `
            -WorkingDirectory $skill -WindowStyle Hidden `
            -RedirectStandardOutput $log -RedirectStandardError $err -PassThru
        try { $p.PriorityClass = 'Normal' } catch {}
        $p.WaitForExit()
    } catch {}
    Start-Sleep -Seconds 3
}
