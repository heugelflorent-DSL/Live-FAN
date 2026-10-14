@echo off
cd /d "%~dp0"
echo Chrono Quantum (port 26700) vers Swim Direct - fermer la fenetre pour arreter
py -3 swim_relais.py --reseau tcp:127.0.0.1:26700
if errorlevel 1 python swim_relais.py --reseau tcp:127.0.0.1:26700
pause
