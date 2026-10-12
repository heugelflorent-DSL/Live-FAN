' Lance le relais Quantum -> Schwimme Direct sans fenetre (evenement test).
' Pour l'evenement principal, retirer " --evenement test".
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir
sh.Run "pyw -3 """ & dir & "\schwimme_relais.py"" --reseau tcp:127.0.0.1:26700 --evenement test", 0, False
MsgBox "Direct Schwimme lance en arriere-plan." & vbCrLf & "Pour l'arreter : arreter_direct.bat", 64, "Schwimme Direct"
