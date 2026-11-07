# Tank Trouble 本地 AI 训练场：Windows 免安装版

这个 ZIP 是一套完整的 Windows x64 本地训练环境，内置 Electron 33.4.11、游戏引擎、公开陪练选手、命令行客户端和 AI 开发包。**解压后即可训练，不需要安装 Node.js、npm 或主项目，不需要连接公网游戏服务器。** 下载并解压完成后，断网也能在自己的电脑上运行对战、读取成绩和导出日志。

训练由本地游戏引擎执行，AI 编程助手负责编写和改进你自己的 JavaScript 选手。训练场不调用大模型 API，也不会把脚本上传到主站。它是命令行批量对战工具，不是多人联机服务；不需要打开正式竞技场窗口。

## 1. 从解压到第一份结果

1. 将整个 ZIP 解压到有写入权限的文件夹，例如 `D:\TankTraining`。不要直接在压缩包预览窗口中运行，也不要只取出几个 `.cmd` 文件。
2. 双击 **`启动训练场.cmd`**。首次启动会生成本包的访问令牌和 `client/config.json`，不需要手工复制或填写令牌。
3. 看到本地训练服务已启动的提示后，保持该窗口打开。默认监听地址是 `http://127.0.0.1:4765`。
4. 双击 **`打开训练终端.cmd`**，会在解压目录打开一个可以继续输入命令的 CMD 窗口。
5. 输入以下命令，查看可选对手并提交一场两局的训练：

```bat
trainer.cmd opponents
trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --logs representative --out .\training-results\v1
```

`workspace/bot.js` 是随包提供的可改造入门选手。第二条命令会实际运行它与 Astra Gen1“裁决者”的两局 1v1，然后保存成绩和选出的详细日志。它不是演示输出，也不会把此脚本加入正式网站名单。

如果你使用 PowerShell，在包根目录运行同一组命令时加上 `.\` 前缀：

```powershell
.\trainer.cmd opponents
.\trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --logs representative --out .\training-results\v1
```

正常完成后，阅读 `training-results/v1/result.json`。需要让 AI 编程助手帮你开发时，把根目录的 [prompt.md](prompt.md) 交给它，并补充你的目标、总局数或时间预算。

## 2. 包内目录与文件用途

```text
解压目录/
├─ 启动训练场.cmd          启动本机训练服务，自动配置连接
├─ trainer.cmd            命令行训练入口，不需要系统安装 Node.js
├─ 打开训练终端.cmd        在此目录打开交互 CMD 窗口
├─ README.md              本说明
├─ prompt.md              可直接交给 AI 编程助手的任务提示词
├─ runtime/               内置 Electron 33.4.11 运行环境
├─ app/                   本包游戏引擎、服务及已授权公开对手
│  └─ training-data/      本包的服务端训练数据，启动后生成
├─ client/                trainer.mjs、API、RESULT_FORMAT 等客户端资料
│  └─ config.json         启动脚本自动生成的地址和令牌
├─ workspace/             新版 AI 开发包，共 10 个交付文件
│  ├─ bot.js              自己编写、修改及提交的默认选手
│  └─ …                   接口、状态样例、开发说明和示例脚本
└─ training-results/      CLI 的默认输出位置，运行后生成
```

`workspace` 用来开发自己的选手。`client` 提供公开协议和命令行工具。`app`、`runtime` 是随包运行所需的实现，不必阅读或修改。不要用主项目的 `npm run training` 来启动这个免安装包；使用包根目录的启动脚本即可。

相对路径按**调用命令时的当前工作目录**解释。`--bot .\workspace\bot.js`、`--out .\training-results\v1` 都假设当前目录是包根。也可以使用带引号的绝对路径：

```powershell
.\trainer.cmd run --bot 'D:\我的选手\bot.js' --opponent astra-g1-sovereign --rounds 2 --seed 6000 --out 'D:\训练结果\v1'
```

上面是 PowerShell 写法；CMD 中路径请用双引号。`client/config.json` 则固定从包内客户端所在目录读取，不随当前目录变化。

## 3. 编写可参赛的 AI

选手是单个 UTF-8 JavaScript 文件，使用 CommonJS 导出一个同步函数：

```javascript
let nextShotAt = 1; // 同局保留，每局重新初始化

module.exports = {
  update(state) {
    const fire = state.time >= nextShotAt;
    if (fire) nextShotAt = state.time + 1;
    return { move: 0, turn: 0.35, fire, special: false };
  },
};
```

这个小例子只原地旋转、低频射击，用来说明接口，可能遭到自己的反弹炮弹攻击。开发时请优先阅读 `workspace` 中的说明及 `client/API.md`，完整状态字段以公开 API 为准。

| 动作 | 含义 |
| --- | --- |
| `move` | `[-1, 1]` 的有限数值：正数前进、负数倒车、0 不主动平移 |
| `turn` | `[-1, 1]` 的有限数值：正数顺时针转、负数逆时针转；与移动独立 |
| `fire` | 布尔值；true 表示本 Tick 请求开火，实际发射受引擎规则约束 |
| `special` | 布尔值；true 表示尝试布雷，需有地雷且部署冷却结束 |

必须同步返回动作对象，不能返回 Promise。不要使用 `require`、`import`、文件系统、网络、计时器或外部模型 API。每局在独立环境重新加载脚本；模块变量只用于同一局内记忆。使用 `state.time`、`state.dt` 表示模拟时间，不要用机器时间决定战术节奏。

修改自己的文件后再提交，服务执行的是**提交时读取到的内容**。已经运行的任务不会跟随磁盘文件变化；服务也不会反向修改 `workspace/bot.js`。

## 4. 内置对手与自己的旧版本

本包只内置以下两名陪练。先运行 `trainer.cmd opponents` 获取当前包实际提供的 ID；不要套用旧版客户端资料中的短 ID。其他网站选手不随训练包发布，也不应从主站下载额外高级 AI 加入训练来绕过此范围。

| 组别 | 对手 ID | 名称 |
| --- | --- | --- |
| Astra | `astra-g1-sovereign` | Astra Gen1「裁决者」SOVEREIGN |
| ChatGPT | `chatgpt-g1-weaver` | ChatGPT Gen1「织局者」WEAVER |

### 添加自己的旧版本作为对手

自己的有用旧版本可以作为训练基准，帮助新版本暴露前一版的弱点。这是有目的的版本对战，不是为了保险而创建冗余备份；保留有用的策略版本即可，不必每次修改都复制文件。

将要保留的版本明确命名，例如 `workspace/bot-v1.js`，然后在 PowerShell 执行：

```powershell
.\trainer.cmd opponent-add --bot .\workspace\bot-v1.js --id my-v1 --name "我的v1"
.\trainer.cmd opponents
.\trainer.cmd run --bot .\workspace\bot.js --opponent my-v1 --rounds 2 --seed 6000 --out .\training-results\against-v1
```

CMD 对应写法是 `trainer.cmd opponent-add --bot .\workspace\bot-v1.js --id my-v1 --name "我的v1"`。也可以统一将旧版存到 `workspace/versions/v1.js`，把 `--bot` 改为该路径；新的候选仍在 `workspace/bot.js` 继续修改。

添加时向本机服务提交文件内容，并持久保存到 `app/training-data/custom-opponents.json`；列表立即更新，无需重启。以后修改原文件不会改变已经登记的对手，因为登记捕获的是当时的脚本内容。下一有用版本请使用新的 ID，例如 `my-v2`。

ID 只能包含英文字母、数字、下划线和连字符，长度 1–64；不能覆盖内置或已登记版本。服务忙时返回 409，等当前任务结束再添加。没有删除对手的 CLI 命令，不要通过手改服务端数据来替换已登记版本。

战胜自己的旧版只说明在这批对局中占优，不等于普遍更强；在预算内结合两名内置对手或不同 seed 了解改动能否适用于其他场景。

## 5. 命令与参数

以下使用 PowerShell 写法；在“打开训练终端.cmd”打开的 CMD 中，把开头的 `.\trainer.cmd` 写成 `trainer.cmd` 即可，其他参数相同。

### 查询及提交

```powershell
.\trainer.cmd opponents
.\trainer.cmd --help

# 每个对手 2 局，共 4 局，按对手逐局执行 1v1
.\trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign,chatgpt-g1-weaver --rounds 2 --seed 6000 --out .\training-results\practice

# 代表性详细日志最多导出 2 局
.\trainer.cmd run --bot .\workspace\bot.js --opponent chatgpt-g1-weaver --rounds 2 --seed 6000 --logs representative --log-limit 2 --out .\training-results\weaver

# 无道具模式：纯走位与普通开火
.\trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --powerups off --out .\training-results\classic
```

一次任务接受 1–4 个对手，每个对手 1–1000 局。**多个对手意味着依次运行多组 1v1，不是多人自由混战。** 总局数为去重后的对手数 × `--rounds`。数值范围是工具上限，不代表建议把每次任务跑满。

| 参数 | 用途与默认值 |
| --- | --- |
| `--bot 文件` | 必填；提交自己的单文件 JavaScript |
| `--opponent ID` | 必填；可逗号分隔，也可重复此参数；最多 4 个不同对手 |
| `--rounds N` | 每对手局数；默认 10，因此建议显式填写预算允许的数值 |
| `--seed N` | 0–4294967295 的整数；省略时随机生成并记入结果 |
| `--no-swap-spawns` | 关闭默认的交替交换出生位置 |
| `--powerups on\|off` | 道具模式，默认 on；off 为纯走位与普通开火，两种模式均关闭墙体破坏 |
| `--logs none` | 仅保存汇总和逐局结果；默认模式 |
| `--logs representative` | 自动导出代表性对局的详细 ZIP，默认最多 3 局 |
| `--log-limit N` | 代表性 ZIP 数量，范围 0–5；与 representative 配合使用 |
| `--out 目录` | 保存目录；默认当前目录下 `training-results/<jobId>/` |
| `--no-wait` | 提交后返回任务 ID，不等待全部比赛完成 |

不同训练提交可使用不同输出目录，便于将结果与候选版本对应。这些目录是训练交付物，不需要额外创建脚本备份、快照或哈希清单。重复使用同一 `--out` 时，同名结果文件会被后一次保存覆盖。

### 提交后查询

```powershell
.\trainer.cmd run --bot .\workspace\bot.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --no-wait --out .\training-results\async

# 将 JOB_ID 替换为提交返回的实际任务 ID
.\trainer.cmd status JOB_ID
.\trainer.cmd result JOB_ID --out .\training-results\async
.\trainer.cmd list
```

`run` 默认等待完成。结果 JSON 写入标准输出，任务进度与文件路径写入标准错误，两者是正常的输出分工。`--no-wait` 只提交；稍后使用 `status` 查询，再用 `result` 下载结果。不要因为终端没有立刻显示最终胜率，就重复提交相同任务。

## 6. 训练规则与计时

训练直接使用包内的正式游戏引擎及 AI 执行器，规则如下：

- 60 Hz 固定物理 Tick，每 Tick 为 `1/60` 秒模拟时间。
- 每局最多 60 秒游戏时间，墙体不可破坏。
- 默认开启道具（`--powerups on`），包含激光、散射、地雷和护盾；`--powerups off` 关闭道具，只使用普通炮弹。两个模式共用移动、碰撞、炮弹反弹和胜负判定，AI 接口保持兼容。
- 每次同步决策预算为 50 ms。预算包括 `update()` 和动作字段读取，不包括消息排队及回传等待；操作系统在调用期间的抢占仍可能影响墙钟计时。
- 执行已开始却未返回的调用另有 250 ms 终止期限；启动、初始化及排队有各自的 2000 ms 限制。宿主定时器明显迟到时存在一次消息派发宽限；这不扩大 50 ms 决策预算。
- 脚本异常、非法动作、执行超时会让故障选手本局判负，不会为另一名选手额外记一次击杀。

无画面推进可能比实际游戏时间快，也可能受设备负载影响而变慢；它不改变坦克速度、弹速或决策预算。较复杂对手计算时间更长，不能用“60 秒一局”推算整个训练一定消耗多少真实时间。

默认交换出生位置：相邻两局使用相同世界种子，并交换候选与对手出生槽位。奇数局数最后一局没有对应交换局。实际条件可查看 `rounds[].worldSeed` 和 `rounds[].swapped`。

同样的 seed 用来保持地图等世界随机条件，**不保证 AI 的全部动作和胜负逐 Tick 重复**。脚本自身的 `Math.random()`、设备调度以及版本变化仍会影响结果。比较自己的两个版本时，应记录相同的对手、场数、seed、道具模式、出生交换设置及引擎版本；是否追加其他 seed 的对战，由用户的目标和预算决定。结果 `rules` 和录像记录实际模式，历史录像沿用当时的规则。

## 7. 先读结果，再按需读详细日志

完整字段说明见 `client/RESULT_FORMAT.md`。默认输出包括：

| 文件/字段 | 适合回答的问题 |
| --- | --- |
| `status.json` | 任务是否完成、完成了多少局、服务是否报告任务错误 |
| `result.json` 的 `statistics` | 候选选手整体胜负平、击杀、自杀和超时情况 |
| `byOpponent` | 面对各个对手时的表现 |
| `rounds` | 每局结果、对手 ID、实际种子、故障及事件摘要 |
| `representativeRounds` | 服务根据已记录事实推荐展开的对局 |

胜率为胜场数除以全部已完成场数，平局也计入分母。`fireRequests` 是开火意图，`shotsFired` 才是实际射击；散射一次射击会产生多颗弹体。`matchTimeouts` 表示比赛达到 60 秒时限；`decisionTimeouts` 表示候选单次决策超过 50 ms，二者不能混为一谈。`queue_timeout` 不足以证明算法计算过慢。

在 PowerShell 中查看结果和败局：

```powershell
$result = Get-Content .\training-results\v1\result.json -Raw | ConvertFrom-Json
$result.statistics
$result.byOpponent
$result.rounds | Where-Object outcome -eq loss | Select-Object round, opponentId, reason, worldSeed
```

根据 `rounds[].round` 选择要分析的局；编号从 1 开始，是整个任务内的局号。即使提交时没有启用详细日志，也可以之后获取任意已完成局：

```powershell
.\trainer.cmd logs JOB_ID --round 1 --out .\training-results\v1\round-1.zip
```

这里 `--out` 是 **ZIP 文件路径**；`run`、`result` 的 `--out` 则是目录。日志请求与比赛任务共享同一服务执行通道；服务正忙时应等现有工作结束。

解压日志 ZIP 可以看到：

| 文件 | 内容 |
| --- | --- |
| `summary.md` | 可直接阅读的中文比赛摘要 |
| `match.json` | 规则、参赛信息、地图和种子等元数据 |
| `events.jsonl` | 一行一个事件，记录射击、拾取、死亡、脚本故障等事实 |
| `states.jsonl` | 一行一个 Tick 状态，可联结位置、动作和事件分析 |

详细日志通过已保存的实际动作和种子在引擎中展开，**不会重新运行 AI，也不会另打一局**。日志不含对手源代码或其局内私有变量。统计标签只描述现象：例如拾取数量多，不能直接证明 AI 有主动争夺道具的意图；死前曾倒车，也不能仅凭这一点断言倒车导致死亡。

## 8. 把训练交给 AI 编程助手

使用根目录的 `prompt.md` 作为连接说明和工作约定。告诉助手包的绝对路径，以及本次希望改善什么、允许多少总局数或多少时间。示例请求：

> 请按 prompt.md 使用这个本地训练包，在 workspace/bot.js 上改进贴墙时的射击选择。总预算 12 局，可对战自己的旧版本、astra-g1-sovereign 和 chatgpt-g1-weaver。主动分析前一版的弱点，针对性修改并在预算内继续对战，不需要每局询问我。读取实际日志后修改，不读取 app 或内置对手源码。最后交付 bot.js 和事实依据。

这份授权允许助手主动分析自己前版的弱点，针对性修改、再赛，不需要每局重复询问。用户给定的训练预算优先；未给预算时首轮最多 10 局，完成后报告，不自行无限批量运行。它不需要停留在提出建议，也不应扩展成无关测试、备份体系或新框架。每次修改应针对观察到的问题；把日志直接证明的事实、根据事实作出的推断、尚未验证的想法分开说明。

训练成果是自己的单个 JS 选手文件。可以将它导入网页真人挑战或 AI 观战模式，也可以交给竞技场管理员；训练场不自动替换网站内置 AI，也不写入正式排行榜。

## 9. 连接、端口与退出行为

### 本机连接自动配置

`启动训练场.cmd` 负责首次令牌生成、后续重用以及 `client/config.json` 的连接配置。`trainer.cmd` 会清除调用环境里遗留的 `TRAINER_URL`、`TRAINER_TOKEN`、`TRAINER_CONFIG`，使用**当前包的配置**，避免连接到另一个训练服务。无需手工设置这些变量，也不要把令牌复制进提示词、聊天记录或结果报告。

服务只监听 `127.0.0.1`，不是局域网或公网训练 API；不需要路由器映射、DMZ、云服务器或远程账号。`http://127.0.0.1:4765` 是 API 地址，不是必须在浏览器打开的游戏页面。

如果 4765 被占用，先结束本包正在运行的服务，在 PowerShell 中使用：

```powershell
$env:TRAINING_PORT = '4766'
.\启动训练场.cmd
```

CMD 中使用：

```bat
set "TRAINING_PORT=4766"
call 启动训练场.cmd
```

启动脚本会按所选端口重新生成客户端连接配置。之后仍然使用本包的 `trainer.cmd`；不要只改一边的地址。该设置属于当前终端环境，日后在未设置变量的新窗口双击启动时会使用默认端口。

### 中断与恢复查询

按 Ctrl+C 退出**客户端等待**，不会取消已提交的服务端任务。只要训练服务窗口还开着，任务会继续；记录任务 ID，稍后使用 `status`、`result` 查询即可。

关闭**训练服务窗口**或停止服务，会中断尚未完成的比赛任务。下次启动时，遗留的未完成任务被标记为 `failed`，已完成局的数据保留，**不会自动续跑剩余场数**。如需重新训练，应先查看原任务状态及部分结果，再根据用户预算提交新任务；不要把旧任务失败误记为已完成的全部败场。

同一服务一次只执行一个比赛任务或一次详细日志展开。多开客户端不会并行训练，忙时会返回 409。无需创建更多服务或循环重试来绕过这一限制。

## 10. 数据保存与明确删除

服务端记录位于 `app/training-data/`，CLI 下载结果位于指定的 `--out`，默认是当前工作目录的 `training-results/<jobId>/`。两者独立；清理一个位置不会自动清理另一个位置。此训练包与网站浏览器战绩、主项目 Electron 排行榜互不写入。

可以用以下命令查看已有任务：

```powershell
.\trainer.cmd list
```

**只有用户明确要求删除指定任务后，才执行删除。** 删除服务端任务会永久移除该任务的结果、实际动作记录及生成详细日志所需的数据，无法再向服务请求该任务日志；已经下载到 `training-results` 的文件不受影响。运行中的任务不能删除。

```powershell
# 仅在明确要删除该任务时执行；JOB_ID 必须是指定任务
.\trainer.cmd delete JOB_ID
```

不要为了腾空间自动删除任务、清空 `app/training-data` 或移除用户结果。也不需要为每次训练额外复制整个包、制作备份、快照或哈希清单。

## 11. 黑盒训练的实际边界

通过 CLI/API，编程助手只需要提交自己的脚本，获得公开对手 ID、比赛观测、统计和日志。接口不提供任意文件读取、不接受服务端源码路径、不导出对手代码或私有决策变量。对战中的脚本在隔离 Worker 内同步执行，不具有 Node.js 文件和系统权限。

但是，**完整免安装包包含运行所必需的引擎及已授权对手文件。同一个 Windows 用户的文件工具仍可能读到这些文件。** “只通过 CLI 训练”是工作约定，不是操作系统级强制隐藏。本包不创建 Windows 用户、不修改 ACL，也不宣称硬内存配额或操作系统级完全隔离。

因此，请让 AI 编程助手只在 `workspace` 修改自己的选手，阅读 `client` 公开接口与实际下载的训练结果；不要读取 `app`、`runtime` 或其他选手源文件来抄策略。令牌是访问本包全部训练记录的凭据，本地版本没有多账号权限划分。重新分享给朋友时，使用发行的原始 ZIP，而非含有个人训练记录和连接配置的已使用目录。

## 12. 常见问题

| 情况 | 处理方法 |
| --- | --- |
| 提示缺少 Node.js 或 npm | 本包不需要它们。使用根目录 `trainer.cmd`，不要直接执行网上教程的 `node trainer.mjs`。 |
| 提示无法连接训练服务 | 先启动同一解压目录的 `启动训练场.cmd` 并保持窗口打开；查看启动窗口有没有端口占用错误。 |
| 找不到访问令牌或配置 | 先运行本包启动脚本。不要读取、打印或到聊天中粘贴私有令牌来排查。 |
| HTTP 401 | 当前客户端配置与运行服务不属于同一包，或令牌不一致；使用同一包的启动脚本和 `trainer.cmd`。 |
| HTTP 400 | 按报错修改对手 ID、局数或参数；一次最多 4 个对手，每对手最多 1000 局。 |
| HTTP 404 | 使用 `opponents`、`list` 或已有结果查真实 ID；旧版短对手 ID 不适用于本包。 |
| HTTP 409 | 已有任务或日志展开尚未结束，或结果尚未完成；查询现有任务状态后再决定下一步。 |
| 脚本被判负 | 查看 `faults`、`timeoutBreakdown` 与日志；区分语法/动作错误、50 ms 决策超时、排队或实例无响应。 |
| 任务为 failed | 读取 `status` 的 `error`；它表示任务执行失败，不等于候选每局都输。停止服务后留下的任务不会续跑。 |
| 结果目录不在包内 | 相对 `--out` 取决于当前终端目录。使用“打开训练终端.cmd”从包根开始，或指定绝对路径。 |
| 日志 ZIP 较大 | 只导出与当前问题有关的局；默认汇总模式仍可事后按需展开，不必为所有对局下载逐 Tick 状态。 |
| 断网后还能训练吗 | 可以。运行环境、引擎、对手和 CLI 均在本包内；AI 编程助手本身是否需要网络取决于你使用的助手。 |

主站 [http://wktian.cn:5173](http://wktian.cn:5173) 是游戏与下载入口，**不是这个工具的训练后端**。不要把 `TRAINER_URL` 或客户端地址改成主站网址，也不需要主站在线才能继续已解压的本地训练。

本说明描述工具的用法和边界，不代表已经针对你的电脑、每个对手或每种脚本逐一实测。实际训练结论应来自你运行后生成的任务记录。
