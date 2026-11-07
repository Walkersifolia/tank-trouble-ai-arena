@echo off
chcp 65001 >nul
setlocal
set "ELECTRON_RUN_AS_NODE="
echo 正在启动本地 AI 训练场，请保持训练场窗口开启。
echo 关闭训练场窗口即可停止服务。
"%~dp0runtime\electron.exe" "%~dp0app"
set "TRAINING_EXIT_CODE=%ERRORLEVEL%"
echo.
echo 训练场已停止，按任意键关闭此窗口。
pause >nul
exit /b %TRAINING_EXIT_CODE%
