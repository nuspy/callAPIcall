<#
.SYNOPSIS
  Installer di callAPIcall: registra i componenti come Scheduled Task
  autostart al logon dell'utente, con riavvio automatico in caso di caduta.

.DESCRIPTION
  Si usano gli Scheduled Task (non i Windows Services) perche' i componenti
  hanno bisogno della sessione utente: audio Bluetooth HFP, mic/casse di
  default, hotkey globale. Un servizio in sessione SYSTEM non vedrebbe nulla
  di tutto questo.

  Trigger: al logon dell'utente corrente.
  Riavvio: fino a 999 volte con intervallo di 1 minuto, durata illimitata.
  Sessione: utente corrente, LogonType Interactive (puo' vedere mic/casse/BT).

.PARAMETER Install
  Componenti da installare: combinazione di "handy", "callbridge", "hermes",
  oppure "all". Es: -Install callbridge,hermes

.PARAMETER Uninstall
  Componenti da disinstallare (stessa sintassi di -Install).

.PARAMETER List
  Mostra lo stato di tutti i componenti senza modificare nulla.

.EXAMPLE
  .\install.ps1                                  # menu interattivo
  .\install.ps1 -Install callbridge,hermes
  .\install.ps1 -Install all
  .\install.ps1 -Uninstall all
  .\install.ps1 -List
#>

[CmdletBinding(DefaultParameterSetName = 'Interactive')]
param(
    [Parameter(ParameterSetName = 'Install')]
    [string[]]$Install,

    [Parameter(ParameterSetName = 'Uninstall')]
    [string[]]$Uninstall,

    [Parameter(ParameterSetName = 'List')]
    [switch]$List,

    # Bypassa l'avviso "componente gia' gestito altrove" (utile in batch).
    [Parameter(ParameterSetName = 'Install')]
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# --- costanti ----------------------------------------------------------------

$TaskFolder = 'callAPIcall'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$CurrentUser = "$env:USERDOMAIN\$env:USERNAME"

# --- utility -----------------------------------------------------------------

function Test-PortOpen {
    # NB: il parametro non si chiama $Host perche' e' una variabile
    # automatica di PowerShell (collisione con $Host = console host).
    param([int]$Port, [string]$Address = '127.0.0.1', [int]$TimeoutMs = 500)
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $iar = $client.BeginConnect($Address, $Port, $null, $null)
        $ok = $iar.AsyncWaitHandle.WaitOne($TimeoutMs)
        if ($ok -and $client.Connected) {
            $client.EndConnect($iar) | Out-Null
            $client.Close()
            return $true
        }
        $client.Close()
        return $false
    } catch { return $false }
}

function Get-TaskState {
    param([string]$TaskName)
    try {
        $t = Get-ScheduledTask -TaskName (Split-Path $TaskName -Leaf) `
            -TaskPath ('\' + (Split-Path $TaskName -Parent) + '\') `
            -ErrorAction Stop
        return $t.State.ToString()
    } catch { return $null }
}

function Find-PythonW {
    $candidates = @(
        (Join-Path $RepoRoot 'call-bridge\.venv\Scripts\pythonw.exe'),
        (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
    )
    foreach ($c in $candidates) { if ($c -and (Test-Path $c)) { return $c } }
    return $null
}

function Find-HandyExe {
    # Nota: usiamo [Environment]::GetFolderPath per Program Files (x86): la
    # sintassi "${env:ProgramFiles(x86)}" puo' confondere il parser dentro a
    # una stringa con interpolazione.
    $pfX86 = [Environment]::GetFolderPath('ProgramFilesX86')
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Handy\handy.exe'),
        (Join-Path $pfX86 'Handy\handy.exe'),
        (Join-Path $RepoRoot '..\Handy-API\src-tauri\target\release\handy.exe'),
        (Join-Path $RepoRoot '..\Handy-API\src-tauri\target\release\bundle\msi\handy.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return (Resolve-Path $c).Path } }
    return $null
}

function Find-FreshlyBuiltHandyExe {
    # Il binario *appena compilato* (output di `bun run tauri build`), da usare
    # come "nuovo" eseguibile quando si sostituisce quello di un servizio.
    # Controlla sia il target dir di default che CARGO_TARGET_DIR=C:\B usato
    # dal build.bat dell'utente.
    $candidates = @(
        'C:\B\release\handy.exe',
        (Join-Path $RepoRoot '..\Handy-API\src-tauri\target\release\handy.exe')
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return (Resolve-Path $c).Path }
    }
    return $null
}

function Test-IsAdmin {
    $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($id)
    return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Find-HandyService {
    # Cerca un servizio Windows che gestisce Handy. Riconosce:
    #   - servizi nativi: handy.exe come binario diretto
    #   - servizi NSSM (o wrapper simili): l'eseguibile vero e' in
    #     HKLM\SYSTEM\CurrentControlSet\Services\<svc>\Parameters\Application
    # Ritorna un oggetto con Name, DisplayName, Wrapper, BinaryPath, oppure $null.

    try { $services = Get-CimInstance Win32_Service -ErrorAction Stop }
    catch { return $null }

    foreach ($svc in $services) {
        $pathName = $svc.PathName
        if (-not $pathName) { continue }

        # 1) servizio NSSM o altro wrapper -> leggi Parameters dal registro
        $isNssm = $pathName -match '(?i)nssm\.exe'
        $looksHandy = $svc.DisplayName -match '(?i)handy' -or $svc.Name -match '(?i)handy'
        if ($isNssm -or $looksHandy) {
            $regPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$($svc.Name)\Parameters"
            $params = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
            if ($params -and $params.Application -and ($params.Application -match '(?i)handy\.exe$')) {
                return [PSCustomObject]@{
                    Name        = $svc.Name
                    DisplayName = $svc.DisplayName
                    Wrapper     = if ($isNssm) { 'NSSM' } else { 'Wrapper' }
                    BinaryPath  = $params.Application
                }
            }
        }

        # 2) handy.exe diretto come binario del servizio (con o senza virgolette)
        $exePath = $null
        if ($pathName -match '^"([^"]+handy\.exe)"') { $exePath = $Matches[1] }
        elseif ($pathName -match '^([^\s"]+handy\.exe)') { $exePath = $Matches[1] }
        if ($exePath) {
            return [PSCustomObject]@{
                Name        = $svc.Name
                DisplayName = $svc.DisplayName
                Wrapper     = 'Native'
                BinaryPath  = $exePath
            }
        }
    }
    return $null
}

function Find-HandyInstallation {
    # Cerca un'installazione di Handy attiva, indipendentemente dal meccanismo
    # di autostart. Ritorna un oggetto con Type, Description, BinaryPath e i
    # dettagli per stop/start. Priorita': Service > Task esterno > Registry
    # Run > processo in esecuzione (catch-all).

    # 1) Servizio Windows (nativo o NSSM)
    $svc = Find-HandyService
    if ($svc) {
        return [PSCustomObject]@{
            Type          = 'Service'
            Description   = "servizio Windows '$($svc.Name)' ($($svc.Wrapper))"
            BinaryPath    = $svc.BinaryPath
            Detail        = $svc
            RequiresAdmin = $true
        }
    }

    # 2) Scheduled Task esterno (non nei task creati da questo installer)
    try { $allTasks = Get-ScheduledTask -ErrorAction Stop } catch { $allTasks = @() }
    foreach ($t in $allTasks) {
        if ($t.TaskPath -like "\$TaskFolder\*") { continue }
        foreach ($a in $t.Actions) {
            if ($a.Execute -match '(?i)handy\.exe$') {
                return [PSCustomObject]@{
                    Type          = 'Task'
                    Description   = "scheduled task '$($t.TaskPath)$($t.TaskName)'"
                    BinaryPath    = $a.Execute
                    Detail        = $t
                    RequiresAdmin = $false
                }
            }
        }
    }

    # 3) Registry Run (autostart al logon — il modo Tauri di default)
    foreach ($hive in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run'
    )) {
        $props = Get-ItemProperty -Path $hive -ErrorAction SilentlyContinue
        if (-not $props) { continue }
        foreach ($prop in $props.PSObject.Properties) {
            if ($prop.Name -like 'PS*') { continue }
            $value = [string]$prop.Value
            if ($value -notmatch '(?i)handy\.exe') { continue }
            $exe = $null
            if ($value -match '^"([^"]+handy\.exe)"') { $exe = $Matches[1] }
            elseif ($value -match '^([^\s"]+handy\.exe)') { $exe = $Matches[1] }
            if ($exe) {
                return [PSCustomObject]@{
                    Type          = 'RegistryRun'
                    Description   = "autostart Registry Run ($hive, valore '$($prop.Name)')"
                    BinaryPath    = $exe
                    Detail        = @{ Hive = $hive; Name = $prop.Name; Value = $value }
                    RequiresAdmin = ($hive -like 'HKLM*')
                }
            }
        }
    }

    # 4) Processo in esecuzione (catch-all: avviato a mano, dalla cartella Startup, ecc.)
    try {
        $proc = Get-CimInstance Win32_Process -Filter "Name = 'handy.exe'" `
            -ErrorAction Stop | Select-Object -First 1
    } catch { $proc = $null }
    if ($proc -and $proc.CommandLine) {
        $exe = $null
        if ($proc.CommandLine -match '^"([^"]+handy\.exe)"') { $exe = $Matches[1] }
        elseif ($proc.CommandLine -match '^([^\s"]+handy\.exe)') { $exe = $Matches[1] }
        if ($exe) {
            return [PSCustomObject]@{
                Type          = 'Process'
                Description   = "processo in esecuzione (pid $($proc.ProcessId))"
                BinaryPath    = $exe
                Detail        = $proc
                RequiresAdmin = $false
            }
        }
    }

    return $null
}

function Stop-HandyInstallation {
    param([Parameter(Mandatory)] $Installation)
    switch ($Installation.Type) {
        'Service' {
            $name = $Installation.Detail.Name
            Write-Host "  Stop del servizio '$name'..."
            Stop-Service -Name $name -Force -ErrorAction Stop
            (Get-Service -Name $name).WaitForStatus('Stopped', '00:00:30') | Out-Null
        }
        'Task' {
            Write-Host "  Stop dello scheduled task..."
            try { Stop-ScheduledTask -InputObject $Installation.Detail -ErrorAction SilentlyContinue } catch { }
            Get-CimInstance Win32_Process -Filter "Name = 'handy.exe'" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        }
        default {
            Write-Host "  Termino i processi handy.exe in esecuzione..."
            Get-CimInstance Win32_Process -Filter "Name = 'handy.exe'" -ErrorAction SilentlyContinue |
                ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 2
        }
    }
}

function Start-HandyInstallation {
    param([Parameter(Mandatory)] $Installation)
    switch ($Installation.Type) {
        'Service' {
            $name = $Installation.Detail.Name
            Start-Service -Name $name -ErrorAction Stop
            (Get-Service -Name $name).WaitForStatus('Running', '00:00:30') | Out-Null
            Write-Host "  [OK] servizio '$name' riavviato" -ForegroundColor Green
        }
        'Task' {
            try {
                Start-ScheduledTask -InputObject $Installation.Detail -ErrorAction Stop
                Write-Host "  [OK] scheduled task riavviato" -ForegroundColor Green
            } catch {
                Write-Host "  [WARN] task non riavviabile ($_); partira' al prossimo logon" -ForegroundColor Yellow
            }
        }
        default {
            # RegistryRun / Process: rilancia il nuovo binario in modalita' silenziosa.
            try {
                Start-Process -FilePath $Installation.BinaryPath `
                    -ArgumentList '--start-hidden', '--no-tray' -ErrorAction Stop | Out-Null
                Write-Host "  [OK] handy.exe riavviato" -ForegroundColor Green
            } catch {
                Write-Host "  [WARN] avvio diretto fallito ($_); partira' al prossimo logon" -ForegroundColor Yellow
            }
        }
    }
}

function Replace-HandyBinary {
    # Sostituisce l'eseguibile dell'installazione esistente col nuovo binario,
    # mantenendo intatto il meccanismo di autostart (servizio/task/registry/...).
    param(
        [Parameter(Mandatory)] $Installation,
        [Parameter(Mandatory)] [string]$NewExePath
    )

    $oldExe = $Installation.BinaryPath
    if (-not (Test-Path $oldExe)) {
        Write-Host "  [ERR] binario corrente non trovato: $oldExe" -ForegroundColor Red
        return $false
    }

    # Hash compare: salta se gia' identico.
    try {
        $oldHash = (Get-FileHash -Algorithm SHA256 $oldExe).Hash
        $newHash = (Get-FileHash -Algorithm SHA256 $NewExePath).Hash
        if ($oldHash -eq $newHash) {
            Write-Host "  [SKIP] eseguibile gia' identico (SHA256 $($oldHash.Substring(0,12))...)" -ForegroundColor Yellow
            return $true
        }
    } catch { }

    $backup = "$oldExe.bak"
    Write-Host "  Backup -> $backup"
    try { Copy-Item -LiteralPath $oldExe -Destination $backup -Force -ErrorAction Stop }
    catch { Write-Host "  [WARN] backup non riuscito: $_" -ForegroundColor Yellow }

    try { Stop-HandyInstallation $Installation }
    catch { Write-Host "  [ERR] stop fallito: $_" -ForegroundColor Red; return $false }

    Write-Host "  Sostituzione binario..."
    try {
        Copy-Item -LiteralPath $NewExePath -Destination $oldExe -Force -ErrorAction Stop
        Write-Host "  [OK] eseguibile sostituito" -ForegroundColor Green
    } catch {
        Write-Host "  [ERR] copia fallita: $_" -ForegroundColor Red
        Write-Host "         provo a riavviare col binario vecchio..."
        try { Start-HandyInstallation $Installation } catch { }
        return $false
    }

    try { Start-HandyInstallation $Installation }
    catch { Write-Host "  [ERR] riavvio fallito: $_" -ForegroundColor Red; return $false }

    return $true
}

# --- componenti --------------------------------------------------------------

$Components = [ordered]@{
    'handy' = @{
        Display          = 'Handy (motore STT/TTS)'
        TaskName         = "$TaskFolder\Handy"
        Port             = 8720
        Resolve          = { Find-HandyExe }
        DefaultArgs      = '--start-hidden --no-tray'
        WorkingDir       = $null  # parent della exe
        # Pip deps usate dagli helper TTS che Handy lancia a runtime
        # (Kokoro e Piper).
        PipDeps          = @('kokoro-onnx', 'numpy', 'piper-tts')
        PipRequirements  = $null
    }
    # DEPRECATO — NON usare per il deploy attuale. L'architettura supportata e'
    # lo "split": gateway headless via NSSM (call-bridge\install-service.ps1,
    # `main.py gateway`) + PTT in sessione utente via Scheduled Task
    # (call-bridge\install-ptt-task.ps1, `main.py all --no-gateway`). Questo task
    # `main.py serve` su :8770 CONFLIGGE con quel PTT (stessa porta) e col
    # servizio NSSM. Lasciato solo per compatibilita' storica.
    'callbridge' = @{
        Display          = '[DEPRECATO] Call-bridge (usa install-service.ps1 + install-ptt-task.ps1)'
        TaskName         = "$TaskFolder\CallBridge"
        Port             = 8770
        Resolve          = { Find-PythonW }
        DefaultArgs      = 'main.py serve'
        WorkingDir       = (Join-Path $RepoRoot 'call-bridge')
        PipDeps          = $null
        PipRequirements  = (Join-Path $RepoRoot 'call-bridge\requirements.txt')
    }
    # DEPRECATO — il phone server stub su :8780 e' superato dall'agente Hermes
    # nativo (cutover-hermes-native.ps1): con acp_enabled i cervelli usano ACP.
    'hermes' = @{
        Display          = '[DEPRECATO] Hermes server stub (superato da Hermes nativo/ACP)'
        TaskName         = "$TaskFolder\HermesServer"
        Port             = 8780
        Resolve          = { Find-PythonW }
        DefaultArgs      = 'hermes_server.py'
        WorkingDir       = (Join-Path $RepoRoot 'skill')
        PipDeps          = @('flask')
        PipRequirements  = $null
    }
}

function Install-PipDeps {
    # Installa le dipendenze pip del componente. Per call-bridge/hermes usa il
    # python del venv se esiste; altrimenti il python di sistema. Per Handy
    # usa sempre il python di sistema (quello che l'helper Kokoro invochera').
    param([Parameter(Mandatory)] [string]$Key)
    $c = $Components[$Key]
    if (-not $c.PipDeps -and -not $c.PipRequirements) { return }

    $py = $null
    if ($Key -in 'callbridge', 'hermes') {
        $pyw = Find-PythonW
        if ($pyw) {
            $candidate = Join-Path (Split-Path $pyw -Parent) 'python.exe'
            if (Test-Path $candidate) { $py = $candidate }
        }
    }
    if (-not $py) {
        $cmd = Get-Command python.exe -ErrorAction SilentlyContinue
        if ($cmd) { $py = $cmd.Source }
    }
    if (-not $py) {
        Write-Host "  [WARN] python.exe non trovato: pip install saltato." -ForegroundColor Yellow
        return
    }

    if ($c.PipRequirements -and (Test-Path $c.PipRequirements)) {
        Write-Host "  Pip install -r $($c.PipRequirements)" -ForegroundColor DarkGray
        & $py -m pip install -r $c.PipRequirements --quiet 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [WARN] pip install -r ha riportato errori." -ForegroundColor Yellow
        }
    }
    if ($c.PipDeps) {
        Write-Host "  Pip install $($c.PipDeps -join ' ') (python: $py)" -ForegroundColor DarkGray
        $args = @('-m', 'pip', 'install', '--quiet') + $c.PipDeps
        & $py @args 2>&1 | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  [WARN] pip install ha riportato errori." -ForegroundColor Yellow
        }
    }
}

function Get-ComponentStatus {
    param([string]$Key)
    $c = $Components[$Key]
    $exe = & $c.Resolve
    $state = Get-TaskState $c.TaskName
    $listening = Test-PortOpen $c.Port
    [PSCustomObject]@{
        Key       = $Key
        Display   = $c.Display
        Port      = $c.Port
        Exe       = $exe
        Listening = $listening
        TaskState = $state
    }
}

# --- registrazione/rimozione del task ---------------------------------------

function Install-Component {
    param([string]$Key, [switch]$Force)
    $c = $Components[$Key]

    # DEPRECATO: se e' attivo lo "split" (servizio NSSM gateway o task PTT) NON
    # installare i componenti legacy 'callbridge'/'hermes' (main.py serve su
    # :8770 e phone server :8780): confliggerebbero con lo split. -Force forza.
    if ($Key -in @('callbridge', 'hermes') -and -not $Force) {
        $splitActive = (Get-Service 'callAPIcall-orchestrator' -ErrorAction SilentlyContinue) `
            -or (Get-ScheduledTask -TaskName 'callAPIcall-PTT' -ErrorAction SilentlyContinue)
        if ($splitActive) {
            Write-Host "  [SKIP] $Key deprecato: architettura split attiva " -ForegroundColor Yellow -NoNewline
            Write-Host "(usa install-service.ps1 + install-ptt-task.ps1). -Force per forzare."
            return
        }
    }

    $exe = & $c.Resolve
    if (-not $exe) {
        Write-Host "  [SKIP] $Key - eseguibile non trovato. " -ForegroundColor Yellow -NoNewline
        Write-Host "Compila/installa il componente prima."
        return
    }

    $existingTask = Get-TaskState $c.TaskName

    # Caso speciale Handy: se esiste gia' un'installazione (servizio Windows,
    # scheduled task esterno, Registry Run, o anche solo un processo in
    # esecuzione), proponi di sostituire l'eseguibile mantenendo il
    # meccanismo di autostart intatto — niente duplicato, niente nuovo task.
    if ($Key -eq 'handy' -and -not $existingTask) {
        $existing = Find-HandyInstallation
        if ($existing) {
            Write-Host "  [INFO] Handy gia' installato:" -ForegroundColor Cyan
            Write-Host "         tipo     : $($existing.Type) - $($existing.Description)"
            Write-Host "         binario  : $($existing.BinaryPath)"

            $newExe = Find-FreshlyBuiltHandyExe
            if (-not $newExe) {
                Write-Host "  [SKIP] nuovo handy.exe non disponibile" -ForegroundColor Yellow
                Write-Host "         (compila prima Handy: 'bun run tauri build' in Handy-API)."
                return
            }
            Write-Host "         nuovo    : $newExe"

            $ans = if ($Force) { 'y' } else {
                Read-Host "  Sostituire l'eseguibile mantenendo l'installazione esistente? [y/N]"
            }
            if ($ans -notmatch '^[yY]') {
                Write-Host "  [SKIP] eseguibile non sostituito; l'installazione esistente resta intatta." -ForegroundColor Yellow
                return
            }

            if ($existing.RequiresAdmin -and -not (Test-IsAdmin)) {
                Write-Host "  [ERR] serve PowerShell come Amministratore per modificare" -ForegroundColor Red
                Write-Host "         il binario di un $($existing.Type)."
                Write-Host "         Rilancia come Admin oppure premi 'n' alla domanda."
                return
            }

            $ok = Replace-HandyBinary -Installation $existing -NewExePath $newExe
            if ($ok) {
                # Anche se l'autostart e' gia' configurato, le pip deps
                # (kokoro-onnx, numpy) servono al nuovo helper Kokoro.
                Install-PipDeps -Key 'handy'
                Write-Host "  [OK]   Handy aggiornato; $($existing.Type) mantenuto." -ForegroundColor Green
            }
            # NESSUN task viene registrato: l'autostart esistente resta autorita'.
            return
        }
    }

    # Safety generale: gia' in ascolto su quella porta ma SENZA il nostro task?
    # Significa che il componente e' gestito da qualcos'altro che non e' un
    # servizio Windows riconoscibile (es. processo lanciato a mano, altro task).
    # Installando creeremmo un duplicato che si scontra sulla porta.
    if ((Test-PortOpen $c.Port) -and -not $existingTask -and -not $Force) {
        Write-Host "  [WARN] $Key gia' in ascolto su :$($c.Port) ma NON gestito da questo installer." -ForegroundColor Yellow
        Write-Host "         Installando creerei un task duplicato che fallirebbe per port conflict."
        $ans = Read-Host "         Procedere comunque? [y/N]"
        if ($ans -notmatch '^[yY]') {
            Write-Host "  [SKIP] $Key non installato (gia' gestito altrove)." -ForegroundColor Yellow
            return
        }
    }

    $wd = if ($c.WorkingDir) { $c.WorkingDir } else { Split-Path $exe -Parent }

    # Azione: eseguibile + argomenti + working dir.
    $actionArgs = @{
        Execute  = $exe
        Argument = $c.DefaultArgs
        WorkingDirectory = $wd
    }
    $action = New-ScheduledTaskAction @actionArgs

    # Trigger: al logon dell'utente corrente.
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser

    # Settings: riavvio illimitato in caso di caduta, niente timeout.
    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -MultipleInstances IgnoreNew `
        -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

    # Principal: utente corrente, sessione interattiva (per audio/BT/hotkey).
    $principal = New-ScheduledTaskPrincipal `
        -UserId $CurrentUser -LogonType Interactive -RunLevel Limited

    # Assicura la cartella del task.
    $taskLeaf = Split-Path $c.TaskName -Leaf
    $taskPath = '\' + (Split-Path $c.TaskName -Parent) + '\'

    Register-ScheduledTask `
        -TaskName $taskLeaf -TaskPath $taskPath `
        -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
        -Description "Autostart di callAPIcall: $($c.Display)" `
        -Force | Out-Null

    # Installa le pip deps PRIMA che il task parta al prossimo logon.
    Install-PipDeps -Key $Key

    Write-Host "  [OK]   $Key" -ForegroundColor Green -NoNewline
    Write-Host " -> task '$($c.TaskName)' (exe: $exe)"
}

function Uninstall-Component {
    param([string]$Key)
    $c = $Components[$Key]
    $taskLeaf = Split-Path $c.TaskName -Leaf
    $taskPath = '\' + (Split-Path $c.TaskName -Parent) + '\'
    try {
        Unregister-ScheduledTask -TaskName $taskLeaf -TaskPath $taskPath -Confirm:$false -ErrorAction Stop
        Write-Host "  [OK]   $Key rimosso" -ForegroundColor Green
    } catch {
        Write-Host "  [SKIP] $Key non era installato" -ForegroundColor Yellow
    }
}

function Start-Component {
    param([string]$Key)
    $c = $Components[$Key]
    $taskLeaf = Split-Path $c.TaskName -Leaf
    $taskPath = '\' + (Split-Path $c.TaskName -Parent) + '\'
    try {
        Start-ScheduledTask -TaskName $taskLeaf -TaskPath $taskPath -ErrorAction Stop
        Write-Host "  [OK]   $Key avviato" -ForegroundColor Green
    } catch {
        Write-Host "  [ERR]  $Key non avviabile: $_" -ForegroundColor Red
    }
}

# --- UI ---------------------------------------------------------------------

function Show-Status {
    Write-Host ''
    Write-Host '  #  Componente                                                   Porta  In ascolto  Task'
    Write-Host '  -- ------------------------------------------------------------ ------ ----------- --------------'
    $i = 0
    foreach ($key in $Components.Keys) {
        $i++
        $s = Get-ComponentStatus $key
        $listening = if ($s.Listening) { 'SI ' } else { 'no ' }
        $task = if ($s.TaskState) { $s.TaskState } else { 'non install.' }
        $exe = if ($s.Exe) { '' } else { '  (eseguibile non trovato)' }
        $line = ('  {0,2}  {1,-60} {2,5}  {3,-9}   {4,-12}{5}' -f `
            $i, $s.Display, $s.Port, $listening, $task, $exe)
        Write-Host $line
    }
    Write-Host ''
}

function Get-KeyByIndex {
    param([int]$Index)
    $keys = @($Components.Keys)
    if ($Index -ge 1 -and $Index -le $keys.Count) { return $keys[$Index - 1] }
    return $null
}

function Resolve-Selection {
    param([string[]]$Items)
    $result = @()
    foreach ($item in $Items) {
        $tok = $item.Trim().ToLower()
        if (-not $tok) { continue }
        if ($tok -eq 'all') { return @($Components.Keys) }
        if ($Components.Contains($tok)) { $result += $tok; continue }
        if ($tok -match '^\d+$') {
            $k = Get-KeyByIndex ([int]$tok)
            if ($k) { $result += $k }
        }
    }
    return ($result | Select-Object -Unique)
}

function Interactive-Menu {
    while ($true) {
        Clear-Host
        Write-Host '=== callAPIcall - installer autostart ===' -ForegroundColor Cyan
        Show-Status
        Write-Host '  Comandi:'
        Write-Host '    1,2,3 ...        installa quei componenti (separati da virgola)'
        Write-Host '    u 1,2 / u all    disinstalla'
        Write-Host '    s 1 / s all      avvia subito (oltre alla registrazione)'
        Write-Host '    l                ricarica lo stato'
        Write-Host '    q                esci'
        Write-Host ''
        $input = Read-Host 'Cosa fare?'
        $input = $input.Trim()
        if (-not $input) { continue }
        if ($input -eq 'q') { return }
        if ($input -eq 'l') { continue }
        if ($input -match '^u\b\s*(.*)$') {
            $sel = Resolve-Selection ($Matches[1] -split ',')
            if (-not $sel) { $sel = @($Components.Keys) }
            Write-Host "Disinstallo: $($sel -join ', ')" -ForegroundColor Yellow
            foreach ($k in $sel) { Uninstall-Component $k }
            Read-Host 'Invio per continuare' | Out-Null
            continue
        }
        if ($input -match '^s\b\s*(.*)$') {
            $sel = Resolve-Selection ($Matches[1] -split ',')
            if (-not $sel) { $sel = @($Components.Keys) }
            Write-Host "Avvio: $($sel -join ', ')" -ForegroundColor Yellow
            foreach ($k in $sel) { Start-Component $k }
            Read-Host 'Invio per continuare' | Out-Null
            continue
        }
        $sel = Resolve-Selection ($input -split ',')
        if (-not $sel) {
            Write-Host 'Selezione non valida.' -ForegroundColor Red
            Read-Host 'Invio per continuare' | Out-Null
            continue
        }
        Write-Host "Installo: $($sel -join ', ')" -ForegroundColor Yellow
        foreach ($k in $sel) { Install-Component $k }
        Read-Host 'Invio per continuare' | Out-Null
    }
}

# --- main -------------------------------------------------------------------

if ($List) {
    Show-Status
    exit 0
}

if ($Install) {
    $sel = Resolve-Selection $Install
    if (-not $sel) { Write-Host 'Nessun componente valido nella selezione.' -ForegroundColor Red; exit 1 }
    Write-Host "Installo: $($sel -join ', ')" -ForegroundColor Cyan
    foreach ($k in $sel) { Install-Component $k -Force:$Force }
    exit 0
}

if ($Uninstall) {
    $sel = Resolve-Selection $Uninstall
    if (-not $sel) { Write-Host 'Nessun componente valido nella selezione.' -ForegroundColor Red; exit 1 }
    Write-Host "Disinstallo: $($sel -join ', ')" -ForegroundColor Cyan
    foreach ($k in $sel) { Uninstall-Component $k }
    exit 0
}

Interactive-Menu
