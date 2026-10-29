@echo off
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 22 or newer is required.
  echo Install Node.js, then double-click start.cmd again.
  pause
  exit /b 1
)

node --env-file-if-exists=.env scripts\launch.mjs
if errorlevel 1 (
  echo.
  echo Startup failed. Keep this window open and read the error above.
  pause
  exit /b 1
)
