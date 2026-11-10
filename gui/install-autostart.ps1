# Autostart del Control Center (icona nella tray) — COMPATIBILITA'.
#
# Questo script registrava una chiave Run HKCU "callAPIcall-ControlCenter",
# lanciata una sola volta al logon: se il supervisore moriva, la tray restava
# vuota fino al login successivo (successo davvero: Control Center giu' dal
# 29/08 senza che nulla lo rimettesse su).
# Ora delega a install-cc-task.ps1, che registra un Task pianificato con
# logon + poll di self-heal ogni minuto. Resta qui perche' installer/setup.ps1,
# build-installer.ps1 e la documentazione puntano a questo nome.
#
# Uso (invariato):
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1
# Per rimuovere l'autostart:
#   powershell -ExecutionPolicy Bypass -File install-cc-task.ps1 -Uninstall

$ErrorActionPreference = 'Stop'
$dir = $PSScriptRoot
if (-not $dir) { $dir = Split-Path -Parent $MyInvocation.MyCommand.Definition }
$task = Join-Path $dir 'install-cc-task.ps1'
if (-not (Test-Path $task)) { throw "Manca $task (autostart del Control Center)." }
& $task @args
