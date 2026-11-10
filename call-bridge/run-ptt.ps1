# Supervisore callAPIcall (architettura "split", opzione A).
# Riavvia `main.py all --no-gateway` all'infinito (auto-restart su crash/uscita):
# control server (chiamate, con audio HFP) + push-to-talk + overlay + copilota,
# nello stesso processo. DEVE girare nella SESSIONE UTENTE (hotkey globali,
# device audio e overlay tkinter, che un servizio sessione-0 non ha).
# Il voice gateway (app Android) + media server girano nel servizio NSSM
# headless `callAPIcall-orchestrator` (main.py gateway).
# Lanciato all'accesso dal task "callAPIcall-PTT", finestra nascosta.

$ErrorActionPreference = 'Continue'
# Windows 11 demota i PowerShell nascosti in Efficiency Mode (EcoQoS) e i
# FIGLI la ereditano: gli import Python passano da ms a ~15s l'uno e il main
# sembra appeso. Alziamo la priorita' del supervisore e di ogni figlio.
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch {}
# Percorsi RICAVATI, non cablati: lo stesso script deve funzionare nel repo di
# sviluppo e in un'installazione (dove né la cartella né il Python stanno dove
# stanno qui). Il venv ha la precedenza: è lì che l'installer mette le dipendenze.
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$py = Join-Path $dir '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    $py = (Get-Command python -ErrorAction SilentlyContinue).Source
}
if (-not $py) { throw "Python non trovato: né in $dir\.venv né nel PATH." }
$life = Join-Path $dir 'ptt-supervisor.log'
$out  = Join-Path $dir 'ptt.out'
$err  = Join-Path $dir 'ptt.log'

# Un solo supervisore: se un altro run-ptt.ps1 e' gia' attivo, esco subito
# (due supervisori si ucciderebbero i main a vicenda nella pulizia orfani).
# MA verifica anche la SALUTE: un supervisore appeso (bloccato in WaitForExit
# con il main.py morto) lascerebbe il PTT giu' per sempre. Se esiste un altro
# supervisore ma NESSUN main.py all e' vivo, quello e' bloccato: lo rimpiazzo.
$me = $PID
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'run-ptt\.ps1' }
if ($others) {
    $mainAlive = Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'main\.py\s+all' }
    if ($mainAlive) { exit 0 }  # supervisore sano (main vivo): non interferire
    # Supervisore presente ma senza main.py vivo = bloccato: lo termino e subentro.
    $others | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
}

# La sentinella di stop vale SOLO per la sessione in cui e' stata scritta: uno
# "Stop" dalla GUI non deve lasciare callAPIcall spento per sempre. Se ptt.stop
# e' anteriore all'ultimo avvio di Windows e' stantia -> la rimuovo, cosi' ogni
# accensione riparte pulita. (Accaduto davvero: stop dalla GUI il 25/08, backend
# giu' per settimane perche' nessuno cancellava il file.)
$stopFile = Join-Path $dir 'ptt.stop'
if (Test-Path $stopFile) {
    try {
        $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
        if ((Get-Item $stopFile).LastWriteTime -lt $boot) {
            Remove-Item $stopFile -Force -ErrorAction Stop
            Add-Content -Path $life -Value ("[{0}] ptt.stop stantia (pre-boot): rimossa" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
        }
    } catch {}
}

while ($true) {
    # Sentinella di stop (scritta da POST /components/main/stop nella GUI):
    # finche' esiste NON rilanciamo. Lo start dalla GUI cancella il file.
    if (Test-Path (Join-Path $dir 'ptt.stop')) {
        Start-Sleep -Seconds 3
        continue
    }
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    # Pulizia orfani: se un precedente supervisore e' stato ucciso, il suo
    # `main.py all` figlio puo' essere sopravvissuto (Windows non uccide i figli)
    # e terrebbe occupate le porte 8770-8772. Lo termino prima di rilanciare,
    # cosi' il restart (anche via Task Scheduler) parte sempre pulito.
    Get-CimInstance Win32_Process -Filter "Name='python.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'main\.py\s+all' } |
        ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {} }
    # Conserva stdout/err del run PRECEDENTE: -RedirectStandard* li TRONCA a ogni
    # rilancio, perdendo lo stack trace del crash proprio quando serve. Ruota .prev.
    foreach ($f in @($out, $err)) {
        if (Test-Path $f) { Move-Item -Path $f -Destination "$f.prev" -Force -ErrorAction SilentlyContinue }
    }
    # Rotazione del log supervisore oltre ~1MB (altrimenti cresce all'infinito).
    if ((Test-Path $life) -and ((Get-Item $life).Length -gt 1MB)) {
        Move-Item -Path $life -Destination "$life.1" -Force -ErrorAction SilentlyContinue
    }
    Add-Content -Path $life -Value "[$ts] avvio istanza utente (main.py all --no-gateway)"
    try {
        $p = Start-Process -FilePath $py `
            -ArgumentList 'main.py', 'all', '--no-gateway' `
            -WorkingDirectory $dir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $out `
            -RedirectStandardError $err `
            -PassThru
        try { $p.PriorityClass = 'Normal' } catch {}
        $p.WaitForExit()
        $code = $p.ExitCode
    } catch {
        $code = "errore avvio: $_"
    }
    $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    Add-Content -Path $life -Value "[$ts] PTT terminato (exit $code) -> riavvio tra 3s"
    Start-Sleep -Seconds 3
}
