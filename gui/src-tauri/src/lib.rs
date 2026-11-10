//! Control Center — comandi Tauri locali + tray.
//!
//! I comandi coprono cio' che il control server NON puo' fare quando e' giu':
//! leggere il config (token di auth), verificare le porte, ripartire il
//! supervisore run-ptt. Il resto passa tutto dall'HTTP del backend.
//!
//! L'app vive nella system tray: chiudere la finestra la NASCONDE (l'app
//! resta attiva), "Esci" dal menu tray termina davvero e scrive la
//! sentinella cc.stop cosi' il supervisore (run-control-center.ps1) non la
//! rilancia. `--hidden` avvia direttamente in tray (usato dall'autostart).

use std::net::TcpStream;
use std::path::PathBuf;
use std::time::Duration;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Radice del backend call-bridge (installazione su questa macchina).
const BRIDGE_DIR: &str = r"C:\Projects\callAPIcall\call-bridge";

/// Sentinella letta dal supervisore della GUI: finche' esiste, il Control
/// Center non viene rilanciato (scritta da "Esci" nel menu tray).
const GUI_STOP_SENTINEL: &str = r"C:\Projects\callAPIcall\gui\cc.stop";

/// Eseguibile del server wikibridge (LLM Wiki per progetti, porta 8775).
/// Avviato on-demand dalla GUI quando la sezione Conoscenza lo trova giu'.
const WIKIBRIDGE_EXE: &str = r"C:\Projects\wikibridge\.venv\Scripts\wikibridge.exe";

fn bridge_path(name: &str) -> PathBuf {
    PathBuf::from(BRIDGE_DIR).join(name)
}

/// Contenuto di call-bridge/config.json (per host/porta/token del bridge).
#[tauri::command]
fn read_bridge_config() -> Result<String, String> {
    std::fs::read_to_string(bridge_path("config.json"))
        .map_err(|e| format!("config.json non leggibile: {e}"))
}

/// True se qualcosa ascolta su 127.0.0.1:port (probe di raggiungibilita').
/// `async` cosi' Tauri lo esegue nel thread pool: da `fn` sincrona girava sul
/// main thread e il probe (fino a 1200ms) faceva scattare la UI a ogni giro
/// del loop di avvio dei componenti.
#[tauri::command]
async fn is_port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &([127, 0, 0, 1], port).into(),
        Duration::from_millis(1200),
    )
    .is_ok()
}

/// Rimuove la sentinella ptt.stop (il supervisore riprende a rilanciare).
#[tauri::command]
fn clear_stop_sentinel() -> Result<bool, String> {
    let sentinel = bridge_path("ptt.stop");
    if sentinel.exists() {
        std::fs::remove_file(&sentinel).map_err(|e| e.to_string())?;
        return Ok(true);
    }
    Ok(false)
}

/// Apre un URL nel browser predefinito (i wizard OAuth devono mandare
/// l'utente su console.cloud.google.com / portal.azure.com: dal webview
/// window.open non esce dall'app).
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("solo URL http(s)".into());
    }
    // `explorer <url>` passa l'URL come singolo argomento via CreateProcess:
    // niente parsing di cmd.exe, quindi un `&` nella query non spezza il comando
    // (con `cmd /C start "" <url>` l'URL non quotato permetteva command injection).
    std::process::Command::new("explorer")
        .arg(&url)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Avvia il server wikibridge (:8775) senza finestra. Il chiamante fa poi
/// polling su /health: se la porta era gia' occupata il nuovo processo
/// muore da solo (bind fallito) e non resta nulla di doppio.
#[tauri::command]
fn start_wikibridge() -> Result<String, String> {
    if !std::path::Path::new(WIKIBRIDGE_EXE).is_file() {
        return Err(format!("wikibridge non installato: {WIKIBRIDGE_EXE}"));
    }
    let mut cmd = std::process::Command::new(WIKIBRIDGE_EXE);
    cmd.arg("serve");
    cmd.stdin(std::process::Stdio::null());
    cmd.stdout(std::process::Stdio::null());
    cmd.stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // SOLO CREATE_NO_WINDOW (0x0800_0000): console nascosta che i figli
        // (stub pip -> python venvlauncher -> python base) ereditano, quindi
        // nessuna finestra in tutta la catena; sopravvive comunque alla GUI.
        // NON aggiungere DETACHED_PROCESS (0x08): per i docs Microsoft rende
        // CREATE_NO_WINDOW IGNORATO, il processo resta senza console e il primo
        // figlio console se ne alloca una NUOVA e VISIBILE.
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn().map_err(|e| format!("avvio wikibridge fallito: {e}"))?;
    Ok("wikibridge in avvio".into())
}

/// Avvia il supervisore run-ptt.ps1 (finestra nascosta). Da usare SOLO quando
/// il main e' giu' e il supervisore non sta gia' girando: il chiamante (GUI)
/// prima cancella la sentinella e attende qualche secondo che la porta 8770
/// si apra da sola (supervisore gia' attivo che rilancia).
#[tauri::command]
fn start_supervisor() -> Result<String, String> {
    let script = bridge_path("run-ptt.ps1");
    if !script.is_file() {
        return Err(format!("script non trovato: {}", script.display()));
    }
    std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-WindowStyle",
            "Hidden",
            "-File",
        ])
        .arg(&script)
        .spawn()
        .map_err(|e| format!("avvio supervisore fallito: {e}"))?;
    Ok("supervisore avviato".into())
}

/// Cold restart completo: lancia `restart-all.ps1` staccato e ritorna subito.
/// Deve girare QUI (non nel bridge) perche' lo script uccide il bridge stesso e
/// deve poter funzionare anche quando il bridge e' gia' giu'.
#[tauri::command]
fn system_restart() -> Result<String, String> {
    let script = bridge_path("restart-all.ps1");
    if !script.is_file() {
        return Err(format!("script non trovato: {}", script.display()));
    }
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args([
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-WindowStyle",
        "Hidden",
        "-File",
    ])
    .arg(&script);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: nessuna console. Lo script sopravvive alla chiusura
        // della GUI (che e' proprio uno dei passi del restart).
        cmd.creation_flags(0x0800_0000);
    }
    cmd.spawn()
        .map_err(|e| format!("avvio restart fallito: {e}"))?;
    Ok("restart avviato".into())
}

/// Mostra (e porta in primo piano) la finestra principale.
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Seconda istanza (es. doppio avvio dal supervisore o dall'utente):
        // non si apre, ma mostra la finestra dell'istanza esistente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .invoke_handler(tauri::generate_handler![
            read_bridge_config,
            is_port_open,
            clear_stop_sentinel,
            start_supervisor,
            start_wikibridge,
            system_restart,
            open_url,
        ])
        .setup(|app| {
            // Icona nella tray con menu Apri/Esci; click sinistro = apri.
            let apri = MenuItem::with_id(app, "open", "Apri", true, None::<&str>)?;
            let esci = MenuItem::with_id(app, "quit", "Esci", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&apri, &esci])?;
            let mut tray = TrayIconBuilder::with_id("main-tray");
            // Degrada senza icona invece di panicare (app che non parte) se
            // l'icona di default manca.
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray
                .tooltip("callAPIcall Control Center")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => {
                        // Uscita VOLUTA: sentinella per il supervisore, che
                        // altrimenti rilancerebbe l'app entro pochi secondi.
                        let _ = std::fs::write(
                            GUI_STOP_SENTINEL,
                            "stop richiesto dal menu tray\n",
                        );
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            // --hidden: avvio direttamente in tray (autostart all'accesso).
            if std::env::args().any(|a| a == "--hidden") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
            }
            Ok(())
        })
        // Chiudere la finestra = tornare in tray (l'app resta attiva).
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("errore nell'avvio dell'applicazione Tauri");
}
