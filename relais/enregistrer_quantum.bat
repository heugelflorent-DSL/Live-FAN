@echo off
cd /d "%~dp0"
echo Enregistrement du flux Quantum (port 26700) - fermer la fenetre pour arreter
py -3 schwimme_relais.py --reseau tcp:127.0.0.1:26700 --capture
if errorlevel 1 python schwimme_relais.py --reseau tcp:127.0.0.1:26700 --capture
pause
