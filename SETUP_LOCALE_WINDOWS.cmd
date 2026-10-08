@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-local-windows.ps1"
if errorlevel 1 (
  echo.
  echo Setup non completato. Leggi l'errore sopra.
  pause
  exit /b 1
)
echo.
pause
