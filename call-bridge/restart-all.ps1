# Cold restart COMPLETO di callAPIcall e dei servizi collegati: riporta la
# macchina allo stato "appena avviata".
#
#   1. sentinelle    ptt.stop / cc.stop rimosse (niente resta giu' per scelta)
#   2. VRAM          istanze vLLM fermate via manager (tree-kill degli EngineCore)
#                    + modelli LM Studio scaricati
#   3. figli         worker avatar (MuseTalk), agente ACP (hermes), helper TTS
#   4. processi      bridge main.py e Control Center chiusi -> li rilanciano i
#                    supervisori run-ptt.ps1 / run-control-center.ps1 (3-5s)
#   5. servizi       vLLMManager e callAPIcall-orchestrator riavviati SE si hanno
#                    i privilegi (vedi sotto), altrimenti saltati e loggati
#   6. verifica      porte 8770/8771/8720 e VRAM finale nel log
#
# I servizi NSSM non sono avviabili dall'utente interattivo (il loro SDDL da' a
# IU solo query, non START/STOP): per riavviarli senza UAC a ogni giro si usa il
# task pianificato `callAPIcall-SystemRestart` (RunLevel Highest), registrato una
# volta da installer\install-restart-task.ps1. Senza quel task il resto funziona
# comunque: si salta solo il riavvio dei due servizi.
#
# Uso:  .\restart-all.ps1              (dalla GUI: bottone "Restart completo")
#       .\restart-all.ps1 -ServicesOnly  (lo esegue il task elevato)
param(
    [switch]$ServicesOnly,   # solo i servizi: e' la parte che richiede privilegi
    [switch]$NoServices      # salta i servizi (utile per test)
)

$ErrorActionPreference = 'Continue'
# Radice RICAVATA (questo script sta in <root>\call-bridge): il bottone
# "Restart completo" deve funzionare anche in un'installazione.
$root    = Split-Path -Parent $PSScriptRoot
if (-not $root) { $root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Definition) }
$bridge  = Join-Path $root 'call-bridge'
$gui     = Join-Path $root 'gui'
$log     = Join-Path $bridge 'restart-all.log'
$manager = 'http://127.0.0.1:7860'

function W($msg) {
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $log -Value $line
    Write-Host $line
}

function Test-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ServicePid([string]$svc) {
    $line = (sc.exe queryex $svc | Select-String -Pattern '^\s*PID\s*:\s*(\d+)')
    if ($line -and $line.Matches.Count) { return [int]$line.Matches[0].Groups[1].Value }
    return 0
}

function Test-GatewayVivo {
    # Il gateway e' il processo python `main.py gateway` lanciato da NSSM: se
    # quello manca, le porte 8771/8772 restano chiuse anche col servizio
    # "Running". La porta da sola non basta come prova (potrebbe tenerla un
    # orfano), il processo neppure (potrebbe essere in avvio): servono i due.
    $proc = Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
        Where-Object { $_.CommandLine -match 'main\.py gateway' }
    if (-not $proc) { return $false }
    $null -ne (Get-NetTCPConnection -LocalPort 8771 -State Listen -ErrorAction SilentlyContinue)
}

function Restart-OneService([string]$svc) {
    if (-not (Get-Service -Name $svc -ErrorAction SilentlyContinue)) {
        W "  servizio $svc non installato: salto"; return
    }
    # Stop con attesa limitata. Visto sul campo: il wrapper NSSM di
    # callAPIcall-orchestrator resta appeso in STOP_PENDING anche quando il
    # processo applicativo e' gia' morto -> senza il tree-kill qui sotto il
    # servizio non riparte piu' e il gateway resta giu' per sempre.
    #
    # `sc.exe stop` e NON `Stop-Service`: quest'ultimo ASPETTA che il servizio
    # si fermi davvero, e con un wrapper appeso resta bloccato per minuti
    # stampando "WARNING: Waiting for service ... to stop". Il risultato era
    # beffardo: il rimedio (il tree-kill qui sotto) era gia' scritto ma non
    # veniva MAI raggiunto, perche' si restava fermi dentro Stop-Service.
    # `sc.exe stop` manda il comando e torna subito, cosi' l'attesa la
    # governiamo noi, con la nostra scadenza.
    sc.exe stop $svc 2>&1 | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    while ((Get-Date) -lt $deadline -and (Get-Service $svc).Status -ne 'Stopped') {
        Start-Sleep -Seconds 1
    }
    if ((Get-Service $svc).Status -ne 'Stopped') {
        $svcPid = Get-ServicePid $svc
        W "  servizio $svc bloccato in $((Get-Service $svc).Status): tree-kill del wrapper (PID $svcPid)"
        if ($svcPid -gt 0) {
            # /T: anche i figli (il processo applicativo e i suoi worker).
            taskkill /PID $svcPid /T /F 2>&1 | Out-Null
        }
        $deadline = (Get-Date).AddSeconds(20)
        while ((Get-Date) -lt $deadline -and (Get-Service $svc).Status -ne 'Stopped') {
            Start-Sleep -Seconds 2
        }
    }
    # ORFANI: NSSM a volte si ferma senza portarsi via il processo figlio, che
    # resta vivo e TIENE LA PORTA. Il servizio riparte, il nuovo processo prova
    # a legarsi e muore con "Errno 10048: Only one usage of each socket
    # address", mentre dall'esterno la porta risulta in ascolto — quella del
    # vecchio. Visto dal vivo: gateway di un'ora prima ancora su 8771, con il
    # nuovo morto all'avvio e nessun segnale evidente.
    #
    # Per questo NON basta guardare se la porta risponde: si cerca chi la tiene
    # e, se e' un processo che il servizio avrebbe dovuto chiudere, lo si
    # termina.
    #
    # ATTENZIONE all'ordine: si spara SOLO a servizio fermo. Visto sul campo il
    # 2026-09-15: il tree-kill del wrapper qui sopra fa scattare il recovery di
    # Windows, il servizio risale da solo in tre secondi e il gateway nuovo si
    # lega alle porte; cinque secondi dopo questo blocco lo prendeva per un
    # orfano e lo ammazzava, e il successivo `sc.exe start` non rilanciava
    # niente perche' il servizio risultava gia' Running. Risultato: 8771 e 8772
    # giu' e nessun errore da nessuna parte.
    if ($svc -eq 'callAPIcall-orchestrator' -and
            (Get-Service $svc).Status -eq 'Stopped') {
        foreach ($porta in 8771, 8772) {
            $conn = Get-NetTCPConnection -LocalPort $porta -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($conn) {
                $orfano = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
                if ($orfano) {
                    W "  porta $porta ancora tenuta da PID $($orfano.Id) ($($orfano.ProcessName)): orfano, lo chiudo"
                    taskkill /PID $orfano.Id /T /F 2>&1 | Out-Null
                    Start-Sleep -Seconds 1
                }
            }
        }
    }
    # Anche l'avvio via sc.exe, per lo stesso motivo: Start-Service aspetta che
    # il servizio dichiari Running e puo' restare appeso. Qui si manda il
    # comando e si verifica con una scadenza nostra.
    sc.exe start $svc 2>&1 | Out-Null
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline -and (Get-Service $svc).Status -ne 'Running') {
        Start-Sleep -Seconds 1
    }
    $stato = (Get-Service $svc).Status
    if ($stato -eq 'Running') { W "  servizio $svc riavviato (stato: $stato)" }
    else { W "  servizio $svc NON riavviato (stato: $stato)" }

    # "Running" e' il WRAPPER, non l'applicazione: NSSM resta Running anche col
    # figlio morto. Per l'orchestrator si verifica che il processo del gateway
    # esista davvero e, se manca, si rifa' un giro pulito di stop/start.
    if ($svc -eq 'callAPIcall-orchestrator' -and $stato -eq 'Running') {
        $deadline = (Get-Date).AddSeconds(30)
        while ((Get-Date) -lt $deadline -and -not (Test-GatewayVivo)) {
            Start-Sleep -Seconds 2
        }
        if (-not (Test-GatewayVivo)) {
            W "  servizio $svc Running ma il gateway NON c'e': riprovo"
            sc.exe stop $svc 2>&1 | Out-Null
            Start-Sleep -Seconds 5
            sc.exe start $svc 2>&1 | Out-Null
            $deadline = (Get-Date).AddSeconds(40)
            while ((Get-Date) -lt $deadline -and -not (Test-GatewayVivo)) {
                Start-Sleep -Seconds 2
            }
            if (Test-GatewayVivo) { W "  gateway ripartito al secondo tentativo" }
            else { W "  ATTENZIONE: gateway ancora assente (vedi call-bridge\serve.log)" }
        }
    }
}

function Restart-Services {
    foreach ($svc in 'vLLMManager', 'callAPIcall-orchestrator') { Restart-OneService $svc }
}

# --- ramo elevato: il task pianificato entra qui e fa solo i servizi ----------
if ($ServicesOnly) {
    W "=== restart servizi (task elevato) ==="
    Restart-Services
    W "=== fine (servizi) ==="
    return
}

W "================ RESTART COMPLETO callAPIcall ================"

# 1) Sentinelle: dopo un restart completo nulla deve restare spento per scelta.
foreach ($s in (Join-Path $bridge 'ptt.stop'), (Join-Path $gui 'cc.stop')) {
    if (Test-Path $s) { Remove-Item $s -Force -ErrorAction SilentlyContinue; W "sentinella rimossa: $s" }
}

# 2) VRAM: prima le istanze vLLM (il manager fa tree-kill degli EngineCore, che
#    e' l'unico modo affidabile di restituire la memoria), poi LM Studio.
try {
    $insts = (Invoke-RestMethod -Uri "$manager/api/instances" -TimeoutSec 8).instances
    if (-not $insts) { W "vLLM: nessuna istanza da fermare" }
    foreach ($i in $insts) {
        try {
            Invoke-RestMethod -Uri "$manager/api/instances/$($i.id)" -Method Delete -TimeoutSec 45 | Out-Null
            W "vLLM: istanza $($i.id) ($($i.model)) fermata"
        } catch { W "vLLM: stop di $($i.id) fallito: $($_.Exception.Message)" }
    }
} catch {
    W "vLLM: manager non raggiungibile ($($_.Exception.Message)) - salto le istanze"
}

$lms = Join-Path $env:USERPROFILE '.lmstudio\bin\lms.exe'
if (Test-Path $lms) {
    # Solo se il server risponde: `lms` AVVIA LM Studio quando lo si interroga,
    # e un restart non deve accendere cio' che era spento.
    $up = $false
    try { $up = (Invoke-WebRequest -Uri 'http://127.0.0.1:1234/v1/models' -TimeoutSec 2 -UseBasicParsing).StatusCode -eq 200 } catch {}
    if ($up) {
        & $lms unload --all 2>&1 | Out-Null
        W "LM Studio: modelli scaricati"
    } else { W "LM Studio: spento, non lo tocco" }
}

# 3) Figli del bridge: worker avatar, agente ACP, helper TTS. Il bridge esce con
#    os._exit e non sempre fa in tempo a chiuderli -> restano a tenere VRAM/RAM.
#    NB: match su percorsi/nomi ESATTI, mai su substring generiche del progetto
#    (una ricerca larga match-erebbe questa stessa shell).
$patterns = @(
    'avatar\\avatar_worker\.py',
    'hermes-agent\\venv\\Scripts\\hermes\.exe',
    'chatterbox_helper\.py',
    'kokoro_helper\.py'
)
foreach ($pat in $patterns) {
    Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='pythonw.exe' or Name='hermes.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match $pat } |
        ForEach-Object {
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; W "chiuso figlio PID $($_.ProcessId) ($pat)" } catch {}
        }
}

# 4) Bridge e GUI: uccisi qui, rilanciati dai rispettivi supervisori.
Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'main\.py\s+(all|server|gateway)' } |
    ForEach-Object {
        try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop; W "bridge PID $($_.ProcessId) terminato" } catch {}
    }
Get-Process -Name 'callapicall-control-center' -ErrorAction SilentlyContinue |
    ForEach-Object { try { Stop-Process -Id $_.Id -Force -ErrorAction Stop; W "Control Center PID $($_.Id) chiuso" } catch {} }

# 5) Servizi: diretti se siamo elevati, altrimenti tramite il task pianificato.
if ($NoServices) {
    W "servizi: saltati (-NoServices)"
} elseif (Test-Elevated) {
    W "servizi: riavvio diretto (processo elevato)"
    Restart-Services
} else {
    $task = 'callAPIcall-SystemRestart'
    $exists = (schtasks /Query /TN $task 2>$null); $ok = $LASTEXITCODE -eq 0
    if ($ok) {
        schtasks /Run /TN $task | Out-Null
        W "servizi: avviato il task elevato $task"
    } else {
        W "servizi: NON riavviati (task $task non registrato; esegui installer\install-restart-task.ps1 come amministratore)"
    }
}

# 6) Verifica: i supervisori hanno 3-5s di attesa, diamo tempo e poi sondiamo.
$deadline = (Get-Date).AddSeconds(120)
$ports = @{ 8770 = 'control server'; 8720 = 'motori voce'; 8771 = 'gateway' }
$seen = @{}
while ((Get-Date) -lt $deadline -and $seen.Count -lt $ports.Count) {
    foreach ($p in $ports.Keys) {
        if ($seen.ContainsKey($p)) { continue }
        $c = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue
        if ($c) { $seen[$p] = $true; W "porta $p ($($ports[$p])) di nuovo in ascolto" }
    }
    Start-Sleep -Seconds 2
}
foreach ($p in $ports.Keys) {
    if (-not $seen.ContainsKey($p)) { W "ATTENZIONE: porta $p ($($ports[$p])) non risponde entro 120s" }
}
try {
    $vram = (nvidia-smi --query-gpu=memory.used,memory.total --format=csv,noheader) -join ' '
    W "VRAM dopo il restart: $vram"
} catch {}
W "================ FINE RESTART ================"
