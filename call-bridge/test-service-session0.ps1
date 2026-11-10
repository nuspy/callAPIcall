# Test EMPIRICO: una hotkey globale viene ricevuta da `main.py all` lanciato
# COME SERVIZIO (sessione 0)? E l'audio locale e' accessibile da li'?
#
# Crea un servizio NSSM usa-e-getta su PORTE 8880-8882 e HOTKEY Shift+F9/F10/F11
# (cosi' NON va in conflitto con l'istanza viva che usa F1-F4), lo avvia, ti da'
# 90 secondi per premere Shift+F9, poi legge il log e RIMUOVE tutto.
#
# COME SI USA:
#  1) Apri PowerShell come AMMINISTRATORE.
#  2) Lancia:  powershell -ExecutionPolicy Bypass -File C:\Projects\callAPIcall\call-bridge\test-service-session0.ps1
#  3) Quando vedi "ADESSO premi Shift+F9", premi Shift+F9 un paio di volte.
#  4) A fine test, il log resta in svctest.log (lo leggo io).

$ErrorActionPreference = 'Continue'
$Name = 'callAPIcall-svctest'
$Dir  = 'C:\Projects\callAPIcall\call-bridge'
$Py   = 'C:\Users\atain\AppData\Local\Programs\Python\Python310\python.exe'
$Log  = Join-Path $Dir 'svctest.log'
$Nssm = 'C:\Users\atain\scoop\shims\nssm.exe'
$WindowSec = 90

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "ERRORE: esegui da PowerShell ELEVATO (Run as Administrator)." -ForegroundColor Red; return }

# Pulizia preventiva
& $Nssm stop   $Name 2>$null | Out-Null
& $Nssm remove $Name confirm 2>$null | Out-Null
Remove-Item $Log -ErrorAction SilentlyContinue

Write-Host "1) Installo servizio di test '$Name' -> main.py all" -ForegroundColor Cyan
Write-Host "   porte 8880-8882, hotkey Shift+F9/F10/F11, stub, no ACP, no copilota" -ForegroundColor DarkGray
& $Nssm install $Name $Py 'main.py' 'all' | Out-Null
& $Nssm set $Name AppDirectory $Dir | Out-Null
& $Nssm set $Name AppStdout    $Log | Out-Null
& $Nssm set $Name AppStderr    $Log | Out-Null
& $Nssm set $Name AppExit Default Exit | Out-Null
& $Nssm set $Name AppEnvironmentExtra `
    "CALLBRIDGE_CONTROL_PORT=8880" `
    "CALLBRIDGE_GATEWAY_PORT=8881" `
    "CALLBRIDGE_GATEWAY_MEDIA_PORT=8882" `
    "CALLBRIDGE_HERMES_MODE=stub" `
    "CALLBRIDGE_ACP_ENABLED=false" `
    "CALLBRIDGE_COPILOT_ENABLED=false" `
    "CALLBRIDGE_PUSH_TO_TALK_HOTKEY=shift+f9" `
    "CALLBRIDGE_PUSH_TO_TALK_HOTKEY_FULLDUPLEX=shift+f10" `
    "CALLBRIDGE_PUSH_TO_TALK_HOTKEY_LIMITED=shift+f11" | Out-Null

Write-Host "2) Avvio servizio e attendo l'inizializzazione (8s)..." -ForegroundColor Cyan
& $Nssm start $Name | Out-Null
Start-Sleep -Seconds 8

$ctrl = Get-NetTCPConnection -LocalPort 8880 -State Listen -ErrorAction SilentlyContinue
if ($ctrl) { Write-Host "   Control 8880 in ascolto (servizio partito) OK" -ForegroundColor Green }
else { Write-Host "   ATTENZIONE: 8880 non in ascolto, il servizio potrebbe non essere partito" -ForegroundColor Yellow }

Write-Host ""
Write-Host "============================================================" -ForegroundColor Magenta
Write-Host "  ADESSO premi  Shift+F9  un paio di volte (anche da qui)." -ForegroundColor Magenta
Write-Host "  Hai $WindowSec secondi. Va bene anche con questa finestra a fuoco:" -ForegroundColor Magenta
Write-Host "  un hook globale non dipende dal focus." -ForegroundColor Magenta
Write-Host "============================================================" -ForegroundColor Magenta
for ($i = $WindowSec; $i -gt 0; $i -= 5) {
    Write-Host ("   ...restano {0}s (premi Shift+F9)" -f $i) -ForegroundColor DarkGray
    Start-Sleep -Seconds 5
}

Write-Host "3) Tempo scaduto. Leggo il log del servizio..." -ForegroundColor Cyan
if (Test-Path $Log) {
    $c = Get-Content $Log
    $c | ForEach-Object { "   | $_" }
    "   ----- DIAGNOSI -----"
    # Marcatori che compaiono SOLO se la pressione del tasto ha raggiunto il servizio:
    $press = $c | Select-String -Pattern 'sessione avviata|modelli caricati|caricamento modelli fallito|device audio non disponibili|caricamento modelli'
    $audioFail = $c | Select-String -Pattern 'device audio non disponibili'
    if ($press) {
        Write-Host "   HOTKEY RICEVUTA in sessione 0! Marcatore: $($press[0].Line.Trim())" -ForegroundColor Green
        if ($audioFail) { Write-Host "   ...ma AUDIO non disponibile in sessione 0: $($audioFail[0].Line.Trim())" -ForegroundColor Yellow }
        else { Write-Host "   ...e l'audio si e' aperto (nessun errore device)." -ForegroundColor Green }
    } else {
        Write-Host "   NESSUN marcatore di pressione: la hotkey NON e' arrivata al servizio (sessione 0 isolata)." -ForegroundColor Yellow
    }
} else {
    "   (nessun log prodotto)"
}

Write-Host "4) Pulizia: fermo e rimuovo il servizio di test..." -ForegroundColor Cyan
& $Nssm stop   $Name 2>$null | Out-Null
& $Nssm remove $Name confirm 2>$null | Out-Null
Write-Host "Fatto. Log conservato in: $Log (lo leggo io dopo)" -ForegroundColor Green