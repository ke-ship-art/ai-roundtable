@echo off
cd /d "%~dp0"
node --env-file-if-exists=.env scripts\stop-local.mjs
if errorlevel 1 pause
