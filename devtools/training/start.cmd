@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0..\.."
title Tank Trouble - AI Training Arena
echo 正在启动黑盒训练场……
echo 看到“训练服务已启动”后，请保持此窗口打开。
echo DeepSeek 使用独立客户端提交比赛，不需要打开正式竞技场。
echo.
call npm run training
echo.
echo 训练服务已停止，按任意键关闭此窗口。
pause >nul
endlocal
