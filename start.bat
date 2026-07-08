@echo off
cd /d "%~dp0"
echo Starting Knote...
call npm run dev -- --open
pause
