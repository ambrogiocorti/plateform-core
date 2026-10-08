@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local-windows.ps1"
if errorlevel 1 (
  echo.
  echo Avvio non riuscito. Leggi l'errore sopra.
  pause
  exit /b 1
)
