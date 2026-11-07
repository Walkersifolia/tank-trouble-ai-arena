@echo off
setlocal
if not defined TRAINER_CONFIG if exist "%~dp0..\..\..\local-data\training-client\config.json" set "TRAINER_CONFIG=%~dp0..\..\..\local-data\training-client\config.json"
node "%~dp0trainer.mjs" %*
exit /b %ERRORLEVEL%
