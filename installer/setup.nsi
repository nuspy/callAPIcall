; Installer di callAPIcall — NSIS, per-utente.
;
; È un installer THIN: porta il codice (~15 MB) e poi chiama installer\setup.ps1,
; che fa il lavoro pesante — Python, venv, dipendenze, modelli. Dipendenze e
; modelli valgono ~4 GB e non stanno in un setup.exe; soprattutto, torch va
; scelto in base alla GPU che si trova sulla macchina, e questo si può sapere
; solo QUI, non al momento della build.
;
; Per-utente (RequestExecutionLevel user): niente UAC, installazione in
; %LOCALAPPDATA%. È anche l'unico modo coerente col resto — bridge e Control
; Center girano nella sessione utente, perché hotkey, audio e overlay in
; sessione 0 non esistono.
;
; Si compila con build-installer.ps1, che prepara il payload e definisce
; VERSION/PAYLOAD.

Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "Sections.nsh"

!define APPNAME    "callAPIcall"
!define REGKEY     "Software\callAPIcall"
!define UNINSTKEY  "Software\Microsoft\Windows\CurrentVersion\Uninstall\callAPIcall"
!ifndef VERSION
  !define VERSION  "0.1.0"
!endif
!ifndef PAYLOAD
  !define PAYLOAD  "..\dist\payload"
!endif
!ifndef OUTFILE
  !define OUTFILE  "..\dist\callAPIcall-Setup-${VERSION}.exe"
!endif

Name "${APPNAME} ${VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\callAPIcall"
InstallDirRegKey HKCU "${REGKEY}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUnInstDetails show

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName"    "${APPNAME}"
VIAddVersionKey "FileDescription" "Installer di ${APPNAME}"
VIAddVersionKey "FileVersion"    "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "callAPIcall"

!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\gui\callapicall-control-center.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Avvia il Control Center"
!define MUI_FINISHPAGE_TEXT "callAPIcall è installato.$\r$\n$\r$\nSe hai saltato dipendenze o modelli, completi in ogni momento con:$\r$\n  installer\setup.ps1$\r$\n  call-bridge\fetch_models.py"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Italian"
!insertmacro MUI_LANGUAGE "English"

; --- provisioning: UNA sola esecuzione, con i flag dei componenti scelti -----
; $R0 = flag. Una chiamata sola e non una per componente: setup.ps1 rifà ogni
; volta prerequisiti e config.json, e vederlo quattro volte non aiuta nessuno.
Function DoProvision
  DetailPrint "Provisioning: setup.ps1 $R0"
  DetailPrint "Può richiedere 10-20 minuti (Python, torch, modelli). Non chiudere."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\installer\setup.ps1" $R0'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ATTENZIONE: il provisioning è uscito con codice $0."
    MessageBox MB_ICONEXCLAMATION|MB_OK "Il provisioning non è andato a buon fine (codice $0).$\r$\n$\r$\nI file sono installati: puoi ritentare quando vuoi con$\r$\n  $INSTDIR\installer\setup.ps1$\r$\n$\r$\nCause tipiche: rete assente o pacchetti non raggiungibili."
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
Section "!Applicazione (richiesta)" SecCore
  SectionIn RO
  SetOutPath "$INSTDIR"
  File /r "${PAYLOAD}\*.*"

  WriteRegStr HKCU "${REGKEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "Version"    "${VERSION}"

  ; Voce in "App installate" (per-utente: HKCU, non HKLM)
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayName"     "${APPNAME}"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr   HKCU "${UNINSTKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr   HKCU "${UNINSTKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr   HKCU "${UNINSTKEY}" "DisplayIcon"     "$INSTDIR\gui\callapicall-control-center.exe"
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINSTKEY}" "EstimatedSize" "$0"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\gui\callapicall-control-center.exe"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Disinstalla ${APPNAME}.lnk" "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

; Le quattro sezioni seguenti sono SOLO caselle da spuntare: il lavoro lo fa la
; sezione nascosta "-Provisioning" in fondo, che legge quali sono selezionate.
Section "Python e dipendenze (~4 GB di download)" SecDeps
SectionEnd

Section "Modelli voce e trascrizione (~800 MB)" SecModels
SectionEnd

Section "Avvio automatico all'accesso" SecAutostart
SectionEnd

Section /o "Skill per l'agente Hermes" SecSkills
SectionEnd

Section /o "Motore voce Qwen3-TTS (~3 GB di download)" SecQwen
SectionEnd

Section "-Provisioning"
  StrCpy $R0 ""
  ${IfNot} ${SectionIsSelected} ${SecDeps}
    StrCpy $R0 "$R0 -SkipDeps"
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SecModels}
    StrCpy $R0 "$R0 -SkipModels"
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SecAutostart}
    StrCpy $R0 "$R0 -SkipAutostart"
  ${EndIf}
  ${IfNot} ${SectionIsSelected} ${SecSkills}
    StrCpy $R0 "$R0 -SkipSkills"
  ${EndIf}
  ${If} ${SectionIsSelected} ${SecQwen}
    StrCpy $R0 "$R0 -Qwen3Tts"
  ${EndIf}
  ; Tutto deselezionato: nessun provisioning da fare, si sono voluti solo i file.
  ${If} $R0 == " -SkipDeps -SkipModels -SkipAutostart -SkipSkills"
    DetailPrint "Nessun componente aggiuntivo selezionato: provisioning saltato."
  ${Else}
    Call DoProvision
  ${EndIf}
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore}      "Control Center, bridge e script (~15 MB)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDeps}      "Installa Python se manca, crea l'ambiente del bridge e scarica le dipendenze (torch CUDA se trova una GPU NVIDIA)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecModels}    "Scarica voce sintetica (Kokoro), diarizzazione e modello di trascrizione, in %LOCALAPPDATA%\callAPIcall\models."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutostart} "Avvia bridge e Control Center a ogni accesso, riavviandoli se cadono."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecSkills}    "Copia le skill telefonate/voce nella cartella di Hermes e ne allinea il modello. Serve Hermes già installato."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecQwen}      "Voci preimpostate e clonazione con Qwen3-TTS, in streaming. Scarica torch CUDA e installa il runtime GGUF incluso nel pacchetto. Serve una GPU NVIDIA (driver >= 580)."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; /NOPROVISION: installa i SOLI file, senza toccare Python, modelli e autostart.
; Serve alle installazioni automatizzate (e a chi vuole provare il pacchetto
; senza scaricare 4 GB); in silenzioso NSIS selezionerebbe tutto.
Function .onInit
  ${GetParameters} $R1
  ClearErrors
  ${GetOptions} $R1 "/NOPROVISION" $R2
  ${IfNot} ${Errors}
    !insertmacro UnselectSection ${SecDeps}
    !insertmacro UnselectSection ${SecModels}
    !insertmacro UnselectSection ${SecAutostart}
    !insertmacro UnselectSection ${SecSkills}
    !insertmacro UnselectSection ${SecQwen}
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------------------
Section "Uninstall"
  ; Autostart prima di tutto: senza, i supervisori rilancerebbero processi che
  ; puntano a file in via di cancellazione.
  DetailPrint "Rimuovo l'avvio automatico..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\call-bridge\install-ptt-task.ps1" -Uninstall'
  Pop $0
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\gui\install-autostart.ps1" -Uninstall'
  Pop $0
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "callAPIcall-ControlCenter"
  nsExec::ExecToLog 'powershell.exe -NoProfile -Command "Get-Process callapicall-control-center -ErrorAction SilentlyContinue | Stop-Process -Force"'
  Pop $0

  RMDir /r "$INSTDIR\call-bridge"
  RMDir /r "$INSTDIR\gui"
  RMDir /r "$INSTDIR\installer"
  RMDir /r "$INSTDIR\hermes-skills"
  Delete "$INSTDIR\launch.ps1"
  Delete "$INSTDIR\uninstall.exe"
  RMDir "$INSTDIR"          ; senza /r: se l'utente ci ha messo roba sua, resta

  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Disinstalla ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"

  DeleteRegKey HKCU "${UNINSTKEY}"
  DeleteRegKey HKCU "${REGKEY}"

  ; I modelli si tengono per default: sono ~800 MB scaricati, e chi disinstalla
  ; per reinstallare non vuole rifarlo. Si chiede, e la risposta di default è NO.
  IfFileExists "$LOCALAPPDATA\callAPIcall\models\*.*" 0 fine
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Rimuovo anche i modelli scaricati (~800 MB) in $LOCALAPPDATA\callAPIcall\models?$\r$\n$\r$\nRispondi No se pensi di reinstallare." IDNO fine
    RMDir /r "$LOCALAPPDATA\callAPIcall\models"
  fine:
SectionEnd
