' Lance le relais Quantum -> Swim Direct sans fenetre.
' Le chrono va a l'evenement regle en mode Bassin dans l'admin du site.
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "pyw -3 """ & dir & "\swim_relais.py"" --reseau tcp:127.0.0.1:26700", 0, False
MsgBox "Direct Swim lance en arriere-plan." & vbCrLf & "Pour l'arreter : arreter_direct.bat", 64, "Swim Direct"
