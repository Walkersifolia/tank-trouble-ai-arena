# 项目约定

- 唯一工作区为 `D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble`；公开远端为 `Walkersifolia/tank-trouble-ai-arena`，发布分支 `main`。
- `index.html`、`web/` 是唯一游戏界面；`engine/` 是公开共享引擎；公开选手在 `bots/`，名单为 `bots/roster.json`。
- 训练配套在 `devtools/training/`；通用对战在 `devtools/matches/`；研究结论与必要结果在 `devtools/research/`；榜单代码集中在 `leaderboard/`。
- `learning-ai/` 和 `local-data/` 全部仅本地，包含神谕、私有选手、环境、模型、完整续训状态、训练任务和敏感配置。不要强制提交，不合并本地旧历史到公开仓库。
- 神谕使用自身冻结引擎及原 Python 环境；工程整理不得改变其训练物理、观测、奖励、算法、模型或进度。原停止的训练保持停止，除非用户要求恢复。
- 沿用 Pages 的 main 根目录发布，不创建另一套源码、整项目备份或同步包装。正常整合远端更新，不强推覆盖历史。
- 只改当前需求直接相关内容，保留其他会话有效修改。测试、额外检查及防御性行为依用户明确授权范围执行；必要验证完成即停止，不扩展审计或优化。
