@echo off
cd /d "%~dp0"
echo Chrono Quantum vers l evenement TEST (/e/test) - fermer la fenetre pour arreter
py -3 schwimme_relais.py --reseau tcp:127.0.0.1:26700 --evenement test
if errorlevel 1 python schwimme_relais.py --reseau tcp:127.0.0.1:26700 --evenement test
pause
