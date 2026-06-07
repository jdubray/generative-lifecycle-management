@echo off
REM ---------------------------------------------------------------------------
REM GLM server supervisor for the "GLM Server" scheduled task.
REM Self-locating: cd's to the repo root (this script lives in scripts/),
REM resolves bun from PATH (falling back to %USERPROFILE%\.bun), and restarts
REM the server if it ever exits. Bun auto-loads .env (PORT, GLM_SOLO_TOKEN)
REM from the working directory.
REM ---------------------------------------------------------------------------
setlocal enableextensions
cd /d "%~dp0.."

if not exist "logs" mkdir "logs"
set "LOG=logs\glm-server.log"

where bun >nul 2>&1 && (set "BUN=bun") || (set "BUN=%USERPROFILE%\.bun\bin\bun.exe")

:loop
echo [%date% %time%] starting GLM server via "%BUN%" >> "%LOG%"
"%BUN%" run src/server/server.ts >> "%LOG%" 2>&1
echo [%date% %time%] GLM server exited (code %errorlevel%); restarting in 5s >> "%LOG%"
timeout /t 5 /nobreak >nul
goto loop
