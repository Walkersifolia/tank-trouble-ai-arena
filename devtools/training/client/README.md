# AI Training Client 使用说明

这个文件夹可以完整复制到 DeepSeek DSH 的独立工作区。它只需要 **Node.js 18 或以上版本**（建议 Node.js 22），不需要 `npm install`、Electron、游戏项目、引擎源码或任何对手脚本。游戏服务由管理员在另一工作区启动；客户端通过本机 HTTP 提交自己的 JS 文件。

## 1. 连接训练服务

管理员启动服务后，把连接地址和访问令牌交给训练者。默认地址为 `http://127.0.0.1:4765`。在客户端目录创建 `config.json`，格式参照 `config.example.json`：

```json
{
  "url": "http://127.0.0.1:4765",
  "token": "管理员交付的令牌"
}
```

也可以在当前 PowerShell 会话中设置环境变量；环境变量优先于配置文件：

```powershell
$env:TRAINER_URL = 'http://127.0.0.1:4765'
$env:TRAINER_TOKEN = '管理员交付的令牌'
node .\trainer.mjs opponents
```

`config.json` 默认从 `trainer.mjs` 所在目录读取，可用 `TRAINER_CONFIG` 指定其他配置文件。仓库内使用 `devtools/training/client/trainer.cmd` 时自动选用 `local-data/training-client/config.json`；独立交付客户端不需要这份仓库配置。选手路径和输出路径相对于终端当前目录。Windows 下 `node .\trainer.mjs ...` 可以写为 `.\trainer.cmd ...`。

此令牌授权访问该训练服务的训练记录；本地版本没有多个训练者的账号系统。不要把令牌交给无关用户。服务端同时只执行一个比赛任务或一次详细日志生成，忙时返回 HTTP 409，稍后重新提交即可。

## 2. 提交自己的选手

选手必须是独立的 CommonJS 风格 JS 文件，导出同步 `update(state)`。公开状态和动作定义见 [API.md](API.md)，状态样例见 [example_state.json](example_state.json)，最小选手见 [example-bot.js](example-bot.js)。不要在选手中使用 `require`、`import`、文件系统、网络或操作系统接口。

从当前目录提交标准示例：

```powershell
node .\trainer.mjs run --bot .\example-bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --logs representative
```

提交 Gen6，针对 Astra Gen1进行 100 局训练：

```powershell
node .\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign --rounds 100 --seed 6000 --logs representative --log-limit 3 --out .\results\g6-v1
```

客户端默认等待比赛结束，将最终结果作为 JSON 输出到 stdout；任务进度和文件保存位置输出到 stderr。默认保存目录为当前目录下的 `training-results/<jobId>/`，包含 `status.json`、`result.json`；详细模式另保存最多指定数量的 `round-<round>.zip`。使用不同 `--out` 保存不同版本，避免覆盖自己的先前结果。

脚本按提交时的文件内容执行。服务不会修改你的文件，也不会把它安装到正式竞技场。完成迭代后，把最终 JS 文件交给管理员手动导入。

## 3. 常用命令

```powershell
# 查询当前开放的训练对手；客户端只能指定公开 ID
node .\trainer.mjs opponents

# 多对手：每个对手 100 局，共 200 局
node .\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign,chatgpt-g1-weaver --rounds 100 --seed 9000

# 也可以重复 --opponent 参数
node .\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign --opponent chatgpt-g1-weaver --rounds 20

# 无道具模式：仅走位与普通开火，墙体不可破坏
node .\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --powerups off

# 提交后立即返回任务 ID
node .\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign --rounds 100 --seed 6000 --no-wait

# 将以下 JOB_ID 替换为实际任务 ID
node .\trainer.mjs status JOB_ID
node .\trainer.mjs result JOB_ID --out .\results\g6-v1

# 依据 result.json 的 rounds 选择任意已完成的一局，编号从 1 开始
node .\trainer.mjs logs JOB_ID --round 1 --out .\results\g6-v1\round-1.zip

# 列出服务端保留的训练任务
node .\trainer.mjs list

# 删除指定任务的服务端训练记录和详细日志；运行中的任务不能删除
node .\trainer.mjs delete JOB_ID

node .\trainer.mjs --help
```

默认不导出逐 Tick 记录。`--logs representative` 会在完成后下载选出的代表性对局，默认最多 3 局；`--log-limit 0..5` 控制数量。即使最初使用默认模式，也能在完成后通过 `logs` 按需获取任意一局。删除服务端任务后不能再下载该任务，但本地已保存的结果和 ZIP 仍保留。

按 Ctrl+C 结束客户端等待不会取消已经提交的服务端比赛；稍后通过任务 ID 查询即可。普通脚本错误记为该选手败场，通常不会使整个任务进入 `failed`；`failed` 表示任务执行失败，查看 `status` 中的 `error`。

## 4. 公平比较与迭代

服务端直接运行正式游戏引擎和 AI 执行器，固定 **60 Hz** 物理 Tick，单次同步决策预算为 **50 ms**。每局时限为 60 秒游戏时间，墙体不可破坏。道具默认开启（`--powerups on`）；`--powerups off` 为无道具模式，只使用普通炮弹。移动、碰撞、普通弹反弹和胜负规则在两个模式中一致，AI 接口保持兼容。无界面推进速度与机器负载有关，不改变游戏时间步长或决策预算。

`--rounds` 是每个对手的场数，范围 1–1000；一次可选择 1–4 个授权对手。`--seed` 为 0–4294967295 的整数，省略时客户端随机生成并记录在结果中。默认开启出生位置交换；需要固定方向时使用 `--no-swap-spawns`。实际每局种子及是否交换以结果中 `rounds[].worldSeed`、`rounds[].swapped` 为准。

比较两版算法时，保持对手列表、场数、seed、道具模式和出生位置设置一致，并查看每局结果，避免只比较单个总胜率。固定种子固定游戏场景和地图序列；脚本自身的 `Math.random()`、运行耗时以及修改过的对手仍可使结果不同。不要把它理解为所有比赛动作必然逐 Tick 完全复现。

建议先用少量场次确认脚本能够参赛，再进行 100 局调参。用 `--seed 6000` 调参，最后用另一组例如 `--seed 9000` 评估，降低对固定场景过拟合的影响。训练者自行选择候选算法、分析事实和修改脚本；客户端不调用大模型 API。

完整流程：编写候选 JS → `run` → 阅读 `result.json` → 选择败局或异常局 → `logs` → 分析 `summary.md`、事件与逐 Tick 状态 → 修改自己的 JS → 在相同条件下再跑 → 用新 seed 和更强对手评估 → 交付最终 JS。

## 5. 日志与统计

字段说明见 [RESULT_FORMAT.md](RESULT_FORMAT.md)。胜率以全部已完成场数为分母；平局不算胜场。击杀、自杀、比赛时限、决策超时、脚本异常分别统计。开火请求不等于实际射击，冷却与普通弹名额等会阻止请求。

每个详细日志 ZIP 包含 `match.json`、`events.jsonl`、`states.jsonl`、`summary.md`。服务端用已记录的实际动作和比赛种子生成详细日志，不重新执行参赛 AI。日志只含比赛观测、动作和事件，不含引擎源码、对手源码或 AI 私有变量。运行中的 AI 不能读取这些赛后记录。

代表性对局根据已记录事件选择，例如自杀、脚本超时、败局、达到单局时限、道具拾取多或持续时间长。“道具拾取多”只描述事实，不证明对手具有争夺意图；分析无法确定的死因或策略意图时应保持不确定。

## 6. 连接和权限边界

服务端仅监听本机 `127.0.0.1`，需要访问令牌。API 不接受服务端文件路径或系统命令，只接受自己的脚本文本、对手 ID 和训练参数；客户端无法下载对手或引擎源码。训练任务和正式排行榜、正式回放使用不同的数据存储。

HTTP 权限并不等于 Windows 文件权限。如果 DSH 和服务端运行在同一 Windows 用户下，DSH 仍可能通过终端直接读取该用户可访问的游戏目录。需要严格黑盒时，由管理员用两个不同 Windows 用户运行服务端与 DSH，并用 NTFS 权限禁止训练用户读取游戏目录，只把本文件夹和令牌交给训练用户。两个用户在同一台电脑上可通过相同的 `127.0.0.1:4765` 通信。具体账号与权限设置应由管理员按服务端交付说明完成；客户端不需要游戏目录权限。

接口错误会以非零退出码结束。常见状态：401 表示令牌无效，404 表示 ID/对局不存在，409 表示服务忙、结果未完成或尝试删除运行中的任务。若提示无法连接，确认管理员已启动服务、端口与配置一致。
