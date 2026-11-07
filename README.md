# Tank Trouble AI Arena

[打开网页竞技场](https://walkersifolia.github.io/tank-trouble-ai-arena/) · [AI 开发包](https://walkersifolia.github.io/tank-trouble-ai-arena/downloads/AI_Starter_Kit.zip) · [Windows 训练工具](https://github.com/Walkersifolia/tank-trouble-ai-arena/releases/latest/download/AI_Training_Arena_Windows_x64.zip)

唯一维护工作区：`D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble`。公开远端为 `Walkersifolia/tank-trouble-ai-arena`，开发、提交与 Pages 发布均使用本目录，不维护第二份网页工程。

Web 是唯一游戏版本，支持真人挑战、AI 连续混战、回放诊断和 MP4 导出。普通比赛、开发工具及本地榜单沿用同一公开引擎与既有规则。旧 Electron 游戏入口已退役；Electron 仅供黑盒训练服务运行。

## 目录

| 路径 | 用途 | 发布范围 |
| --- | --- | --- |
| `index.html`、`web/` | 唯一网页入口、交互、回放和视频导出 | 公开 |
| `engine/` | 共享物理、观测、执行隔离、录像与渲染 | 公开 |
| `bots/` | 已授权公开的独立 AI；`roster.json` 为网站清单 | 公开 |
| `leaderboard/` | 官方战力榜静态页面、评测工具与公开聚合结果；保留浏览器个人榜单 | 公开 |
| `devtools/training/` | 黑盒训练服务、客户端、运行界面、开发包和打包脚本 | 公开 |
| `devtools/matches/` | 可复用的可信脚本无界面对战工具 | 公开 |
| `devtools/research/proteus/` | 无相评测结论、精简结果、失败案例与构造场景 | 公开 |
| `downloads/` | Pages 直接提供的 AI 开发包 | 公开 |
| `learning-ai/` | 神谕源码、原环境、模型、完整检查点、记录及必要冻结引擎 | 仅本地 |
| `local-data/` | 私有选手、训练任务与配置、日志、回放、原版研究及大型工具包 | 仅本地 |

无相、原版 Opus、Astra Gen3 和已获授权的导师保留原策略行为。研究结果保留真实限制，见 [无相报告](devtools/research/proteus/README.md)。[官方 AI 战力榜](https://walkersifolia.github.io/tank-trouble-ai-arena/leaderboard/) 使用独立统一赛季，未完成评测时明确展示进度和暂定统计；不导入旧研究结果。个人娱乐对局继续只累计本浏览器战绩。

## 启动

在本工作区执行：

```powershell
# 静态网页直接使用本目录，仅需 Python 标准库
python -m http.server 8080 --bind 127.0.0.1
# 打开 http://127.0.0.1:8080/

# 本地黑盒训练场，也可双击 devtools/training/start.cmd
npm run training

# 可信脚本对战，参数与结果格式见研究说明
npm run arena -- --bot proteus=bots/astra-g4-proteus.js --bot opus=bots/opus-g1-prescience.js --seeds 1 --trace off --out local-data/matches.json

# 官方联赛：创建、评测、暂停、续跑与导出见 leaderboard/README.md
npm run leaderboard -- status --season 2026-s1

# 构建可分发工具包
npm run kit:package
npm run training:package

# 神谕监视台；原来停止的训练不会自动恢复
& .\learning-ai\.venv\Scripts\python.exe .\learning-ai\server.py
```

Node.js 20+ 用于对战和开发工具；黑盒服务使用已有 Electron，首次安装依赖使用 `npm ci`。神谕继续使用原 `learning-ai/.venv`，不因目录整理升级 Python、PyTorch 或 CUDA。按 [神谕本地说明](learning-ai/README.md) 中的原参数命令续训；公开引擎后续更新不会自动替换其冻结引擎。

训练包输出至 `local-data/packages/`，通过 Releases 分发；小开发包输出至 `downloads/AI_Starter_Kit.zip`。原任务与令牌保留在 `local-data/training/`，客户端配置在 `local-data/training-client/`，私有选手在 `local-data/private-bots/`。原个人榜单继续使用既有浏览器存储键，目录重组不清空战绩。

## 发布与协作

提交公开改动并正常推送 `main`，沿用 GitHub Pages **main / 根目录** 的 `pages-build-deployment`。保留 `.nojekyll`；公开仓库目录本身就是网站源码，不生成第二份 `dist`，不做双目录同步。开发包资料改变时同时更新 ZIP；大型 Windows 包只上传 Releases。

`learning-ai/`、`local-data/`、运行环境及日志由忽略规则留在本地，不应强制加入提交。原中文仓库的 Git 元数据只移入 `learning-ai/legacy-history.git`，作为无工作区、无远端的本地历史；公开 `main` 继续原 GitHub 历史，两者不合并。协作前确认使用本目录；新增公开选手必须有发布授权。

[网页使用说明](web/README.md) · [训练工具说明](devtools/training/README.md) · [排行榜与评测说明](leaderboard/README.md) · [项目约定](AGENTS.md)

引擎源于 [AbyssWhalen/tank-trouble](https://github.com/AbyssWhalen/tank-trouble)，许可见 [LICENSE](LICENSE)。Opus 来源为 [Sakura1618 的 PR #2](https://github.com/Walkersifolia/tank-trouble-ai-arena/pull/2)，无相保留来源说明；Planck 许可见 [engine/vendor/planck.LICENSE.txt](engine/vendor/planck.LICENSE.txt)。
