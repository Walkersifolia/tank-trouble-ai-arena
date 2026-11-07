# 给 AI 编程助手的本地训练任务提示词

将下面“任务正文”整段交给有本地文件编辑与终端能力的编程助手，例如 DeepSeek DSH、Codex 或其他助手。先填写包的绝对路径、目标及预算。无需提供访问令牌；启动脚本和 `trainer.cmd` 会自动使用包内配置。

用户先双击 `启动训练场.cmd`，保持窗口打开。如果希望助手代为启动，可在任务里明确写明“允许启动本包本地训练服务”。训练包可以断网运行；编程助手自身的联网需求由该助手决定。

---

## 任务正文

请实际使用我的 Tank Trouble 本地训练包，编写并改进单文件 JavaScript AI，完成授权范围内的对战、日志分析和代码修改，最终交付可直接导入游戏的选手文件。

### 我的任务参数

- 训练包绝对路径：`在这里填写，例如 D:\TankTraining`
- 自己的候选文件：`workspace/bot.js`，或我另行指定的 `workspace` 内文件。
- 本轮目标：`填写需要改善的行为或希望挑战的对手`。
- 对手：`填写 astra-g1-sovereign、chatgpt-g1-weaver，或自己已登记的版本 ID`。
- 对战预算：`填写允许的总局数及/或真实时间上限`。
- 道具模式：`on（默认有道具） / off（纯走位与普通开火）`；两种模式均关闭墙体破坏。
- 服务状态：`已由我启动 / 允许你启动本包服务`。
- 其他限制：`填写需要保留的行为、禁止修改部分等；没有则写无`。

如果我已经在当前对话给了这些信息，以当前对话为准，不要重复询问。用户给定的训练预算优先；未给预算时首轮最多运行 10 局并报告，不无限追加批量对战。在预算内主动分析、修改和再赛，不需要每局询问。工具支持的 1000 局上限不是默认授权预算。

### 工作范围与可读取资料

1. 先进入训练包根目录，阅读根目录 `README.md`、`workspace` 内开发资料、`client/API.md` 和 `client/RESULT_FORMAT.md`。只阅读理解接口所需的公开资料，不进行全包扫描。
2. 只修改 `workspace` 内我自己的选手文件。日志输出可以放在 `training-results`；不要修改引擎、运行环境、陪练配置或其他选手。
3. 不读取 `app`、`runtime` 或任何内置陪练选手源代码，不反编译运行环境，不从别的目录寻找高级 AI 的实现，也不从主站下载额外高级 AI 加入训练来绕过范围。通过公开观测与赛后日志分析内置对手；自己的旧版本可以在 `workspace` 阅读和比较。
4. 不读取或输出 `client/config.json`、服务令牌文件及其内容；连接由工具自动配置，令牌无需写入提示词或报告。
5. 完整包在同一个 Windows 用户下不具备强制文件保密能力。请遵守上述黑盒工作范围，不把它描述为已实现操作系统级隔离；不要创建用户、修改 ACL、添加防火墙规则或构造权限平台。

### 本地连接与命令

这是 Windows x64 免安装环境，内置 Electron 33.4.11。不要安装 Node.js/npm，不执行 npm install，不连接远程训练后端。根目录的 `trainer.cmd` 会使用随包运行环境执行客户端，并忽略外部遗留的 `TRAINER_URL`、`TRAINER_TOKEN`。

默认服务地址是 `http://127.0.0.1:4765`；首次运行 `启动训练场.cmd` 会生成独有令牌和包内连接配置，无需手工复制。若我允许你启动，请启动包根目录的该脚本，不要启动主项目或自己实现训练服务。已有服务可用时直接使用。

在 PowerShell 中，从包根目录执行：

```powershell
.\trainer.cmd opponents
.\trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --logs representative --out .\training-results\v1
```

上面两局命令只是语法示例，实际对手和局数按我的任务预算确定。CMD 对应写法为：

```bat
trainer.cmd opponents
trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --logs representative --out .\training-results\v1
```

无道具训练在 `run` 命令加入 `--powerups off`；省略或 `--powerups on` 为有道具模式。根据我的模式设置提交任务，比较版本时保持模式一致。

如果从其他目录调用包根 `trainer.cmd`，`--bot`、`--out` 仍相对当前目录解释，应使用正确的绝对路径。`打开训练终端.cmd` 会在包根打开交互 CMD。无需浏览器打开 API 地址。

本包只内置以下两名对手，其他网站选手不随包提供：

```text
astra-g1-sovereign
chatgpt-g1-weaver
```

可以主动登记自己的有用旧版本作为对手，当前候选继续修改 `workspace/bot.js`。例如已保留 `workspace/bot-v1.js` 后执行：

```powershell
.\trainer.cmd opponent-add --bot .\workspace\bot-v1.js --id my-v1 --name "我的v1"
.\trainer.cmd run --bot .\workspace\bot.js --opponent my-v1 --rounds 2 --seed 6000 --out .\training-results\against-v1
```

也可将旧版本明确存放为 `workspace/versions/v1.js`，相应修改添加命令的路径。这些版本是用于对战的训练基准，不是冗余备份；只保留有用版本，不为每次编辑无节制复制。

`opponent-add` 向本机提交文件当时的内容，服务保存到 `app/training-data/custom-opponents.json`，`opponents` 立即可见，无需重启；以后改原文件不会改变已登记对手。ID 只用字母、数字、下划线、连字符，长度 1–64，不能覆盖已有 ID。新版本用新 ID，服务忙返回 409 时等待当前任务结束再添加。没有删除对手 CLI，不要手改服务端数据。

对手以 `opponents` 实际返回为准。一次可指定 1–4 个不同对手，每个对手 1–1000 局，按对手串行逐局运行 1v1；不是多人混战。`--rounds` 是每个对手的局数，默认 10，请显式设置。两名内置加一名自己旧版、每人 2 局就是 6 局，必须计入总预算。

以下命令用于跟进已经提交的任务，而非重新提交同一任务：

```powershell
.\trainer.cmd status JOB_ID
.\trainer.cmd result JOB_ID --out .\training-results\v1
.\trainer.cmd logs JOB_ID --round 1 --out .\training-results\v1\round-1.zip
.\trainer.cmd list
```

将 `JOB_ID` 和局号换成真实值。默认 `run` 等待完成；加 `--no-wait` 只提交并返回 ID。Ctrl+C 终止客户端等待不会取消服务端任务。服务窗口关闭会中断任务，重启后遗留任务标为 failed，不会自动续跑；先查看已有状态，不要默默重跑并超出预算。服务一次只执行一个任务或日志展开，409 时查询现有工作，不并行轰炸或无限重试。

主站 `http://wktian.cn:5173` 只是游戏和下载入口，不是训练后端。不要把本地连接改为主站地址，不上传我的候选脚本、日志或令牌。

### AI 文件必须满足的接口

- 单文件 UTF-8 JavaScript，导出 `module.exports = { update(state) { ... } }`。
- `update()` 同步返回普通对象，包含 `move`、`turn`、`fire`、`special`。
- `move`、`turn` 是 `[-1, 1]` 的有限数；`fire`、`special` 是布尔值。
- 前进/倒车和转向是独立轴，允许原地旋转和倒车同时转向。
- 每局新作用域，局内可保留模块变量；按实体 ID 跟踪目标，不依赖跨 Tick 对象引用。
- 不使用 `require`、`import`、Promise、外部计时器、Node.js、DOM、网络或文件系统；不调用大模型 API 代替对战中的每 Tick 决策。
- 使用 `state.time`、`state.dt` 和公开物理参数。完整字段按 `client/API.md`，不要凭印象虚构状态字段、武器行为或私有数据。

训练始终使用固定 60 Hz 物理、60 秒单局时限、不可破坏墙壁，以及每次同步决策 50 ms 预算；道具模式按任务参数选择，默认开启。无道具时 `state.rules.powerups=false`，地面道具数组为空，保持相同状态和动作接口。你只能改自己的策略，不允许调慢炮弹、削弱对手、修改命中判定或扩大决策预算来提高成绩。

### 执行、分析与迭代

1. 根据我指定的目标，读自己的脚本和必要接口资料，主动分析前一版的弱点，找出要实现的具体行为。可以将自己的有用旧版登记为对手，在预算内直接编写和对战，不要只给方案，也不要每局重复征求确认。
2. 运行与当前修改直接相关的对战，显式记录对手、局数、seed、道具模式、出生交换设置和输出目录。默认相邻两局交换出生位置；固定 seed 只固定世界随机条件，不保证脚本 Math.random 或机器计时完全复现。
3. 先读取 `result.json` 的整体、分对手及逐局结果，再选择少数有助于回答当前问题的真实对局查看日志。`--logs representative` 默认最多下载 3 局，`--log-limit` 范围 0–5；不要默认展开所有逐 Tick 记录。
4. 详细日志由服务使用原比赛实际动作展开，不重新执行 AI、不另打一场。可以在比赛结束后按需请求任意已完成局，初始未开详细模式也不影响。
5. 按实际证据针对性修改自己的策略，再在剩余预算内继续对战。需要比较版本时保持相关条件一致。打赢自己旧版不等于普遍更强，应在预算内结合两名内置对手或不同 seed 了解改动在其他场景的表现；不要下载额外高级 AI 扩大对手范围，不自行扩展成无关验收。
6. 达成目标或用尽授权预算后停止，交付最终 JS 和简洁的事实报告。无需追加全项目测试、额外编译、回归矩阵、备份副本、哈希清单、守卫脚本或通用训练框架。

只有用户明确要求删除指定任务后才使用 `delete`。删除会不可逆地移除服务端该任务的结果和动作记录；已下载文件虽然还在，也不能因此认为服务端删除无影响。不要自动清理 `app/training-data` 或 `training-results`。

### 如何解释结果

`statistics.winRate` 是胜场 / 全部已完成场数，平局计入分母。`fireRequests` 是指令，`shotsFired` 才是实际射击；`matchTimeouts` 是整局到时，`decisionTimeouts` 是 50 ms 决策超时。`queue_timeout`、`init_timeout`、`unresponsive_timeout` 不应不加区分地称为“算法超过 50 ms”。

日志 ZIP 中先看 `summary.md`、`match.json`，再按问题读取 `events.jsonl` 和 `states.jsonl`。使用实际任务 ID、局号、Tick 和事件支持结论，不把道具拾取次数等统计推测成已经证实的策略意图。没有日志证据时明确写“推测”或“尚未验证”；不得伪造实跑、胜率、速度提升、死因或日志内容。

最终报告应包含：

- 修改了哪个候选文件、实现什么行为、仍有什么局限。
- 实际运行的任务 ID、对手、总局数、seed 和对应结果路径。
- 实测胜负平、超时/异常，以及直接支持改动判断的关键日志事实。
- 哪些结论是实测，哪些只是推断；预算用量和未完成事项。
- 最终单文件 JS 的路径，方便我导入网页或正式竞技场。

不要更改或宣称更新网站公开选手。这个训练包只训练我自己的候选；是否发布最终算法由我另行决定。
