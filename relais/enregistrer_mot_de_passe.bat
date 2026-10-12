@echo off
cd /d "%~dp0"
echo Tape le mot de passe admin de Schwimme Direct puis Entree (il sera garde dans cle.txt sur ce PC).
set /p CLE=Mot de passe : 
>cle.txt echo %CLE%
echo Enregistre.
pause
