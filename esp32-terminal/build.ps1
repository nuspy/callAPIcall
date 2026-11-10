# Compila (e, con -Flash, installa) il firmware del terminale ESP32-P4.
#
# Perche' questo script invece di `idf.py` nudo: su questa macchina servono tre
# cose che non sono nell'ambiente di default.
#   1. ESP-IDF sta su E: (C: ha poco spazio), con i tool in E:\esp\tools;
#   2. Avast intercetta il TLS, quindi pip e i download di ESP-IDF vogliono un
#      bundle di certificati che includa il suo root (vedi ca-bundle.pem);
#   3. il target e' esp32p4, che non e' il default.
#
# Uso:
#   .\build.ps1                 # compila
#   .\build.ps1 -Flash          # compila e installa, poi apre il monitor
#   .\build.ps1 -Flash -Port COM3
#   .\build.ps1 -Clean          # ricompila da zero

param(
    [switch]$Flash,
    [switch]$SoloApp,
    [switch]$Clean,
    [switch]$Monitor,
    [string]$Port = "COM3"
)

$ErrorActionPreference = "Stop"

# Attenzione: ErrorActionPreference non vale per gli eseguibili esterni. idf.py
# puo' fallire e lo script tirerebbe avanti (e' successo: un flash fallito era
# passato inosservato perche' subito dopo si apriva il monitor). Ogni chiamata
# va quindi verificata a mano.
# Niente param() con [Parameter(...)]: renderebbe la funzione "advanced" e i
# suoi parametri comuni intercetterebbero -p ("ambiguous ... -ProgressAction").
# Con $args automatico gli argomenti passano a idf.py cosi' come sono.
function Invoke-Idf {
    & idf.py @args
    if ($LASTEXITCODE -ne 0) {
        throw "idf.py $($args -join ' ') ha restituito $LASTEXITCODE"
    }
}

$env:IDF_PATH = "E:\esp\esp-idf"
$env:IDF_TOOLS_PATH = "E:\esp\tools"
$bundle = "E:\esp\ca-bundle.pem"
if (Test-Path $bundle) {
    $env:SSL_CERT_FILE = $bundle
    $env:REQUESTS_CA_BUNDLE = $bundle
    $env:PIP_CERT = $bundle
    $env:CURL_CA_BUNDLE = $bundle
}

if (-not (Test-Path "$env:IDF_PATH\export.ps1")) {
    throw "ESP-IDF non trovato in $env:IDF_PATH"
}

Write-Host "== preparo l'ambiente ESP-IDF ==" -ForegroundColor Cyan
. "$env:IDF_PATH\export.ps1" | Out-Null

Push-Location $PSScriptRoot
try {
    if ($Clean) {
        Write-Host "== pulizia ==" -ForegroundColor Cyan
        Invoke-Idf fullclean
    }

    Invoke-Idf set-target esp32p4 | Out-Null

    Write-Host "== compilo ==" -ForegroundColor Cyan
    Invoke-Idf build

    if ($Flash) {
        # Attenzione: `idf.py flash` scrive bootloader, tabella delle partizioni,
        # app E l'immagine spiffs (il progetto la include con FLASH_IN_PROJECT),
        # quindi sovrascrive lo `storage` con il contenuto di ../spiffs.
        # Con -SoloApp si scrive la sola partizione dell'app e tutto il resto
        # della flash resta com'e'.
        if ($SoloApp) {
            Write-Host "== installo la sola app su $Port ==" -ForegroundColor Cyan
            Invoke-Idf -p $Port app-flash
        } else {
            Write-Host "== installo tutto su $Port (anche lo spiffs) ==" -ForegroundColor Cyan
            Invoke-Idf -p $Port flash
        }
    }
    if ($Flash -or $Monitor) {
        Write-Host "== monitor (Ctrl+] per uscire) ==" -ForegroundColor Cyan
        idf.py -p $Port monitor
    }
} finally {
    Pop-Location
}
