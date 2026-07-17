@echo off
echo ========================================
echo    Starting Casrion Note Taker...
echo ========================================
echo.

cd /d "%~dp0"

node dev.cjs

echo.
echo Casrion has closed.
pause
