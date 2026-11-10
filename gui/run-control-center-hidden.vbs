' Launcher completamente invisibile del supervisore Control Center (run-control-center.ps1).
'
' Stesso motivo del run-ptt-hidden.vbs: la chiave HKCU Run con
' "powershell -WindowStyle Hidden" lascia comunque una finestra nera vuota
' visibile all'avvio. WshShell.Run con modalita' finestra = 0 nasconde
' del tutto anche la PowerShell figlia.
'
' bWaitOnReturn = True: questo script resta vivo quanto il supervisore, cosi' il
' Task Scheduler (che lo esegue) vede l'istanza finire quando il supervisore
' muore e la fa ripartire al tick successivo. Con bWaitOnReturn = False il task
' risultava sempre "gia' concluso" e non riavviava nulla.

Dim sh, rc
Set sh = CreateObject("WScript.Shell")
rc = sh.Run("powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Projects\callAPIcall\gui\run-control-center.ps1""", 0, True)
WScript.Quit(rc)
