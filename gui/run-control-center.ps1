# Supervisore del Control Center (stesso pattern di run-ptt.ps1).
# Tiene l'app SEMPRE attiva nella sessione utente: se crasha o viene uccisa
# la rilancia entro pochi secondi, in tray (--hidden). "Esci" dal menu tray
# scrive la sentinella cc.stop: finche' esiste NON si rilancia (l'autostart
# al prossimo accesso la rimuove e riparte pulito).
# Registrato dal Task pianificato "callAPIcall-ControlCenter" (vedi
# install-cc-task.ps1): parte al logon e viene RIAVVIATO se muore, finestra
# nascosta. Prima era una chiave Run HKCU, lanciata una volta sola al logon.

$ErrorActionPreference = 'Continue'
# Anti Efficiency-Mode: vedi run-ptt.ps1 (l'EcoQoS ereditato strozza i figli).
try { (Get-Process -Id $PID).PriorityClass = 'Normal' } catch {}
# Percorsi RICAVATI, non cablati: in sviluppo l'exe sta dove lo lascia cargo, in
# un'installazione sta accanto a questo script. Si prova prima quello accanto,
# così l'installato non dipende da una cartella di build che lì non esiste.
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$exe = Join-Path $dir 'callapicall-control-center.exe'
if (-not (Test-Path $exe)) {
    $exe = Join-Path $dir 'src-tauri\target\release\callapicall-control-center.exe'
}
$life = Join-Path $dir 'cc-supervisor.log'
$stop = Join-Path $dir 'cc.stop'
$proc = 'callapicall-control-center'

# Un solo supervisore per sessione: se un altro run-control-center.ps1 gira
# gia', questo esce subito.
$me = $PID
$others = Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessId -ne $me -and $_.CommandLine -match 'run-control-center\.ps1' }
if ($others) {
    exit 0
}

# Nuovo accesso/avvio del supervisore: si riparte puliti (l'eventuale "Esci"
# della sessione precedente non vale piu').
Remove-Item $stop -ErrorAction SilentlyContinue

$ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
Add-Content -Path $life -Value "[$ts] supervisore avviato (exe: $exe)"

while ($true) {
    if (Test-Path $stop) {
        Start-Sleep -Seconds 5
        continue
    }
    if (-not (Test-Path $exe)) {
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $life -Value "[$ts] eseguibile mancante: $exe (riprovo tra 60s)"
        Start-Sleep -Seconds 60
        continue
    }
    if (-not (Get-Process -Name $proc -ErrorAction SilentlyContinue)) {
        $ts = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $life -Value "[$ts] Control Center non attivo -> avvio (--hidden)"
        try {
            $p = Start-Process -FilePath $exe -ArgumentList '--hidden' -WorkingDirectory $dir -PassThru
            try { $p.PriorityClass = 'Normal' } catch {}
        } catch {
            Add-Content -Path $life -Value "[$ts] avvio fallito: $_"
        }
    }
    Start-Sleep -Seconds 5
}
