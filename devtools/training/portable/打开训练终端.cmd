@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
echo Tank Trouble AI 本地训练终端
echo 请先双击“启动训练场.cmd”，并保持训练场窗口开启。
echo.
echo 查看对手：trainer.cmd opponents
echo 提交训练：trainer.cmd run --bot ".\workspace\bot.js" --opponent astra-g1-sovereign --rounds 2
echo 查看帮助：trainer.cmd --help
echo.
echo 脚本和输出目录的相对路径，以终端当前目录为准。
echo 输入 exit 退出终端。
"%ComSpec%" /d /k
