@echo off
cd /d "%~dp0"
if not exist relais.pid (echo Aucun relais en cours. & pause & exit /b)
set /p P=<relais.pid
taskkill /PID %P% /F
del relais.pid
echo Direct arrete.
pause
