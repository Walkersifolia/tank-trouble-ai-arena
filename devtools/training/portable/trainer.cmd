@echo off
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "TRAINER_URL="
set "TRAINER_TOKEN="
set "TRAINER_CONFIG="
"%~dp0runtime\electron.exe" "%~dp0client\trainer.mjs" %*
exit /b %ERRORLEVEL%
