@echo off
cd /d "%~dp0"
echo Tape la cle du relais (secret RELAY_KEY cree dans Cloudflare) puis Entree (elle sera gardee dans cle.txt sur ce PC).
set /p CLE=Cle du relais : 
>cle.txt echo %CLE%
echo Enregistre.
pause
