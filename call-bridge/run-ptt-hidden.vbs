' Launcher COMPLETAMENTE INVISIBILE del supervisore PTT (run-ptt.ps1).
'
' Perche' esiste: la chiave Run lanciava `powershell -WindowStyle Hidden`, che
' puo' comunque mostrare un lampo di console e, soprattutto, lascia un processo
' che si puo' chiudere per errore. wscript NON ha finestra; WshShell.Run con
' modalita' finestra = 0 nasconde del tutto anche la PowerShell figlia.
'
' bWaitOnReturn = True -> questo script resta vivo per tutta la durata del
' supervisore. Cosi' il Task Scheduler (che esegue questo .vbs) vede il processo
' terminare se il supervisore muore, e fa scattare il "riavvia in caso di errore".
' WScript.Quit(rc) propaga il codice d'uscita: != 0 se il supervisore e' stato
' ucciso -> il Task lo considera fallito -> lo riavvia.

Dim sh, cmd, rc
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Projects\callAPIcall\call-bridge\run-ptt.ps1"""
rc = sh.Run(cmd, 0, True)   ' 0 = finestra nascosta, True = attendi la fine
WScript.Quit(rc)
