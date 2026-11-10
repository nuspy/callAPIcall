# OBS Virtual Camera — filtro DirectShow standalone

La "OBS Virtual Camera" è solo un filtro DirectShow: **non serve installare
OBS Studio** sulle macchine di destinazione. Questi 5 file (estratti da
OBS 32.1.2, `data\obs-plugins\win-dshow\`) bastano:

| File | Ruolo |
|---|---|
| `obs-virtualcam-module64.dll` | il filtro (app a 64 bit: Meet/Zoom/Teams/browser) |
| `obs-virtualcam-module32.dll` | idem per app a 32 bit |
| `placeholder.png` | immagine mostrata quando nessuno trasmette |
| `virtualcam-install.bat` | registrazione (`regsvr32`), da eseguire **come amministratore** |
| `virtualcam-uninstall.bat` | rimozione |

## Installazione su una macchina nuova

1. Copia questa cartella.
2. Tasto destro su `virtualcam-install.bat` → *Esegui come amministratore*.
3. Fine: "OBS Virtual Camera" compare tra le webcam di sistema.

Il produttore dei frame è `pyvirtualcam` (nel worker `avatar_worker.py`),
che implementa da sé il protocollo del filtro: OBS Studio non è richiesto
né a runtime né come dipendenza.

Nota licenza: le DLL provengono da OBS Studio (GPLv2). Per la
ridistribuzione pubblica vanno rispettati i termini GPL; per uso interno
non ci sono vincoli pratici.
