@echo off
cd /d "%~dp0"
echo Chrono Quantum (port 26700) vers Schwimme Direct - fermer la fenetre pour arreter
py -3 schwimme_relais.py --reseau tcp:127.0.0.1:26700
if errorlevel 1 python schwimme_relais.py --reseau tcp:127.0.0.1:26700
pause
