# Tank Trouble AI Training Arena 使用说明

训练场让外部 AI 在独立目录提交自己的 JS，通过主项目的真实引擎对战，并取回统计及赛后日志。它不会修改候选脚本、正式选手或正式排行榜，也不调用大模型 API。

本文说明**本仓库中的训练服务**：从项目根目录运行命令，服务入口位于 `devtools/training/server/training-server.cjs`，客户端源码位于 `devtools/training/client`，数据位于 `local-data/training`。面向朋友的完整免安装训练包使用另一套启动流程，见 [免安装训练包说明](portable/README.md)；其打包源位于 `devtools/training/portable`，生成 ZIP 位于 `local-data/packages/AI_Training_Arena_Windows_x64.zip`。两种用法不要混用目录和启动步骤。

## 1. 启动服务端

在仓库根目录双击 **`启动训练场.cmd`**，或运行下面的命令。公开默认陪练为 Astra Gen1「裁决者」和 ChatGPT Gen1「织局者」，配置位于 `devtools/training/opponents.json`。本机已有的五名私有陪练继续由 `local-data/training/opponents.json` 管理；该文件存在时服务优先使用它。先用客户端 `opponents` 查询本机实际 ID。

在持有主项目的 Windows 用户下打开 PowerShell：

```powershell
Set-Location 'D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble'
npm run training
```

项目依赖尚未安装时，先在此目录执行一次 `npm install`。服务端使用现有 Electron 运行环境创建隐藏窗口，无需启动或操作正式竞技场界面，也无需管理员权限。

终端会显示服务地址、访问令牌及可直接复制的 `config.json` 内容。默认地址为 `http://127.0.0.1:4765`；服务只监听 IPv4 本机回环。保持终端运行，按 `Ctrl+C` 停止。若需换端口，在启动前设置 `$env:TRAINING_PORT = '4766'`，同时更新客户端地址。

首次启动产生 `local-data/training/access-token`，以后重用。将令牌交给被授权的训练者；**同一个令牌视为同一位训练所有者**，可列出、下载和清理该服务的所有训练任务。本版没有多租户账号系统。

服务一次执行一个训练任务或日志展开请求；忙时返回 HTTP 409。每个对手可运行 1–1000 局，一次最多 4 个对手，共最多 4000 局。服务退出后未完成任务在下次启动时标为失败，已完成局的结果保留，不自动接续比赛。

## 2. 把客户端交给 DeepSeek DSH

交付主项目下的整个 `devtools/training/client` 文件夹。可以复制并命名为 `D:\DSH_Workspace\AI_Training_Client`，也可以放入另一独立工作区；下文独立客户端示例仍使用这个交付目录名。客户端仅需可运行的 Node.js，推荐 Node.js 22 或更新版本；无需安装项目依赖、Electron 或游戏引擎。

在客户端目录新建 `config.json`（可参考 `config.example.json`），填入服务端启动时给出的配置：

```json
{
  "url": "http://127.0.0.1:4765",
  "token": "替换为服务端显示的令牌"
}
```

也可以通过 `TRAINER_URL`、`TRAINER_TOKEN` 环境变量覆盖配置，或用 `TRAINER_CONFIG` 指定配置文件。仓库内的 `devtools/training/client/trainer.cmd` 自动读取 `local-data/training-client/config.json`；原本机配置已迁到这里。独立交付客户端仍默认使用同目录 `config.json`。客户端路径可与当前参赛工作目录不同；`--bot` 和 `--out` 相对终端当前目录解释。

仓库内查询本机陪练：

```powershell
.\devtools\training\client\trainer.cmd opponents
```

客户端随附中文说明、接口资料及标准示例。只分发此文件夹；不需要分发 `engine`、`devtools/training/server`、`local-data/private-bots`、`node_modules` 或主项目目录。

## 3. 完整训练流程

在独立工作区中保存自己的 `DeepSeek-g6.js`，然后运行：

```powershell
Set-Location 'D:\DSH_Workspace'
node .\AI_Training_Client\trainer.mjs opponents
node .\AI_Training_Client\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign --rounds 100 --seed 6000 --logs representative --out .\gen6-vs-gen3
```

`run` 默认等待结果，进度写入标准错误，最终结果以 JSON 输出，并保存到 `--out` 指定目录。详细模式下载少量代表局；不传 `--logs representative` 时仅保存统计。快速试跑可将 `--rounds` 改为 `2`。

若只想提交、稍后查询，加 `--no-wait`。记下返回的任务 ID：

```powershell
node .\AI_Training_Client\trainer.mjs status 任务ID
node .\AI_Training_Client\trainer.mjs result 任务ID --out .\gen6-vs-gen3
node .\AI_Training_Client\trainer.mjs logs 任务ID --round 1 --out .\round-1.zip
```

把 `任务ID` 换为实际 UUID；`--round` 使用结果中该局的 `round` 值。任务完成后可以按需导出任意已完成局，无需事先开启详细模式。读取结果后，由 DSH 自行修改自己的脚本、使用相同测试条件比较版本，再换一组种子评价。服务端始终不会替 DSH 修改脚本。

挑战多个授权对手：

```powershell
node .\AI_Training_Client\trainer.mjs run --bot .\DeepSeek-g6.js --opponent astra-g1-sovereign,chatgpt-g1-weaver --rounds 100 --seed 900000 --logs representative --out .\gen6-challenge
```

这里是每个对手 100 局，共 200 局。最终只需把表现满意的单个 UTF-8 JS 文件交给用户手动导入正式竞技场。训练任务不自动注册选手或改变正式成绩。

## 4. 对手配置

授权对手由服务端的 `devtools/training/opponents.json` 管理：

| ID | 名称 | 服务端文件 |
| --- | --- | --- |
| `astra-g1-sovereign` | Astra Gen1「裁决者」 | `bots/astra-g1-sovereign.js` |
| `chatgpt-g1-weaver` | ChatGPT Gen1「织局者」 | `bots/chatgpt-g1-weaver.js` |

`devtools/training/opponents.json` 供公开安装和便携包打包使用。服务在数据目录存在 `opponents.json` 时使用该本地清单；私有脚本路径相对于项目根目录，保存在 `local-data/private-bots/`。本机五名旧陪练 ID 保持为 `astra-g1`、`astra-g2`、`astra-g3`、`deepseek-g3`、`chatgpt-g1`，以下公开示例的 ID 需按 `opponents` 返回值选择。修改配置后重启服务。便携包始终仅收录公开清单，不包含本地清单及私有选手。客户端只获得 ID 和名称，不能指定服务端文件路径。

## 5. 规则、统计与种子

训练直接使用现有 `World`、AI 沙箱及战斗分析模块。每秒固定 60 个物理 Tick，单次 AI 决策预算为 50 ms；移动、转向、弹道与反弹、碰撞及道具均走正式实现。训练采用固定的 60 秒单局时限，关闭墙体破坏。道具默认开启；CLI `--powerups off`（HTTP 请求 `powerups: false`）选择无道具模式，仅保留走位与普通开火。该模式沿用相同 AI 接口；其他物理规则及决策预算不可覆盖。加速推进不会改变物理步长或决策预算。

```powershell
.\devtools\training\client\trainer.cmd run --bot .\candidate.js --opponent astra-g1-sovereign --rounds 2 --seed 6000 --powerups off
```

新任务将实际模式写入结果 `rules` 及录像元数据；历史任务和录像保留当时的道具与墙体破坏设置。

状态按正式 AI API 提供；训练任务、赛后分析、内部动作记录及对手脚本变量不会传入选手状态。脚本异常、非法动作或决策超时按现有竞技场规则判负，不额外赠送其他选手击杀。

结果提供全体统计、按对手统计和逐局结果，包括胜负平、胜率、击杀、自杀、单局时限结束、决策超时、脚本异常、请求开火次数、实际开火次数、炮弹名额导致的开火失败、分类道具拾取数、平均时长，以及可取得的移动受阻和方向切换数据。胜率为胜场数除以已完成比赛数；平均时长是游戏内秒数。字段定义见客户端结果格式说明。

默认交换出生位置：相邻两局使用同一个世界种子，候选与对手交换出生槽位。100 局对应 50 组地图条件；奇数局数的最后一局没有配对局。`--no-swap-spawns` 可关闭交换。多对手使用相同的测试条件序列，便于横向比较。

`--seed` 控制世界随机过程，省略时自动生成并在结果中返回。使用相同种子、对手配置、规则及引擎版本，可以比较候选版本在相同地图条件下的表现；**选手自己调用的 `Math.random()` 不被强制固定，真实决策计时也受机器负载影响，因此固定种子不保证胜负完全重复**。可把 `6000` 用于调参、`900000` 用于最终评价，避免只适应一组地图。

## 6. 赛后详细日志与清理

服务端默认保存每局聚合结果和压缩的动作记录，不保存每局完整逐 Tick 状态。请求详细日志时，使用记录的实际动作在真实引擎中展开，**不会重新调用 AI 决策**。下载的 ZIP 含现有分析格式：

- `match.json`：对局元数据、规则和结果。
- `events.jsonl`：开火、失败原因、拾取、死亡、脚本故障等实际事件。
- `states.jsonl`：逐 Tick 世界状态，供空间与时间分析。
- `summary.md`：可直接阅读的统计摘要。

代表局按已记录事实选择自杀、脚本超时或异常、败局、达到时限、道具拾取较多或用时较长的对局；最多 5 局。标签不代表已推断出战术意图或完整败因。赛后日志展示对战轨迹和公开状态，不包含对手源码或闭包变量。

内部动作记录依赖对应引擎实现。升级或修改引擎前，先导出仍需分析的详细日志；完整 ZIP 可以独立阅读，不需要源码。

训练源码、浏览器运行页、日志导出和打包脚本集中在 `devtools/training/`，运行页直接复用 `engine/`。原有任务、令牌和 Electron 运行资料已迁入 `local-data/training/`；`TRAINING_DATA_DIR` 可指定其他数据目录。训练数据集中在 `local-data/training/jobs`；Electron 的训练运行目录位于 `local-data/training/electron`，与正式竞技场存储分离。查看及清理历史：

```powershell
node .\AI_Training_Client\trainer.mjs list
node .\AI_Training_Client\trainer.mjs delete 任务ID
```

删除会清理该训练任务的聚合结果和内部动作记录，不触及正式回放、排行榜或 `local-data/private-bots`。运行中的任务不能删除。已下载到工作区的结果由训练者自行管理；删除服务端任务后，不能再生成该任务的日志。

## 7. 已实现的访问边界

- HTTP 仅绑定 `127.0.0.1`，请求必须携带训练令牌。
- 客户端只能提交源码文本及允许的训练参数，选择配置中的对手 ID。
- API 无任意文件读取、源码导出、系统命令执行或服务端路径参数；下载仅针对已存在任务、已完成对局的分析 ZIP。
- 选手在现有隔离的 Web Worker 沙箱运行，不暴露 Node.js 文件系统、网络或操作系统接口，并沿用正式决策预算与终止机制。
- 独立服务入口只注册训练 IPC，不加载正式名册、排行榜或正式回放存储；上传内容不写入 `local-data/private-bots`。
- 客户端只包含通信工具、说明和公开 AI 开发资料，可脱离主项目运行。

这些是应用边界。**如果 DSH 与主项目使用同一个 Windows 账户，其其他工具仍可能直接读取主项目；本地 HTTP 和令牌不能限制该账户已有的文件权限。** 本次代码没有创建 Windows 用户或修改 NTFS 权限。需要严格文件隔离时，由管理员按下一节部署。

## 8. Windows 双用户与 NTFS 严格隔离

保留当前主项目用户作为服务端拥有者；新建标准用户 `DSHTrainer` 专门运行 DSH、编辑器和训练客户端。不要让训练用户成为管理员，也不要向其提供服务端用户的密码、已保存凭据或可提权的工具。Node.js 和 DSH 应安装到训练用户能够访问的位置，例如面向所有用户安装 Node.js，并在训练用户自己的账户中配置 DSH。

以下命令由用户自行在 **64 位管理员 PowerShell** 执行。它们创建新用户、复制交付客户端，并仅针对下方明确指定的仓库根目录和独立工作区配置权限；不会修改整个磁盘或整个用户目录。仓库须位于 NTFS 卷。若已有同名用户，跳过创建命令并使用实际训练用户名。

### 创建标准用户

```powershell
$trainingPassword = Read-Host '设置 DSHTrainer 的密码' -AsSecureString
$trainingUser = New-LocalUser -Name 'DSHTrainer' -Password $trainingPassword -Description 'Tank Trouble 独立训练用户'
Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $trainingUser
```

密码从隐藏输入读取，不写进命令行。`S-1-5-32-545` 是内置 Users 组，避免中英文组名不同。参见微软的 [New-LocalUser](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.localaccounts/new-localuser?view=powershell-5.1) 与 [Add-LocalGroupMember](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.localaccounts/add-localgroupmember?view=powershell-5.1) 文档。

### 交付客户端并限制主项目访问

```powershell
$trainingAccount = "$env:COMPUTERNAME\DSHTrainer"
$arenaRepository = 'D:\Documents\ChatGPT\坦克动荡AI斗蛐蛐\tank-trouble'
$arenaProject = $arenaRepository
$trainingWorkspace = 'D:\DSH_Workspace'
New-Item -ItemType Directory -Path $trainingWorkspace -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $arenaProject 'devtools/training/client') -Destination (Join-Path $trainingWorkspace 'AI_Training_Client') -Recurse
icacls $trainingWorkspace /grant "${trainingAccount}:(OI)(CI)M" /T /L
icacls $arenaRepository /deny "${trainingAccount}:(OI)(CI)F" /T /L
```

本仓库的 `.git` 位于上述仓库根目录。私有训练环境应按实际部署位置配置访问权限，包含其 Git 历史。此步骤仅供用户按需手动执行；不会由安装、构建或训练命令自动执行。公开的 `bots/` 仍可从 GitHub 获取。

`M` 授予训练工作区修改权限；对仓库根的 `F` 拒绝项阻止训练账户直接读写，`OI/CI` 令后续文件和子目录继承，`/T` 覆盖现有子项，`/L` 操作符号链接自身。该拒绝项仅针对 `DSHTrainer`，不剥夺服务端原用户权限。命令若报告失败条目，该路径尚未完成隔离，应先处理具体权限错误。参数含义见微软 [icacls 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/icacls)。

同样不要向训练账户开放主项目的其他副本、源码压缩包、私有选手副本、服务端用户目录或共享目录中的源码；仅限制这里的一个目录不会限制其他副本。训练者也不应拥有项目或其父目录的管理、改 ACL、接管所有权或删除受保护目录的权限。原项目若位于向所有普通用户开放修改的共享父目录，请由管理员把项目放到服务端用户私有位置，再按实际路径配置上述项目权限。

### 分别启动服务与训练环境

1. 在原服务端用户的普通 PowerShell 中运行第 1 节的 `npm run training`，保持该会话运行。
2. 管理员将服务端显示的令牌填入 `D:\DSH_Workspace\AI_Training_Client\config.json`；无需让训练用户读取 `local-data/training/access-token`。
3. 使用 Windows“切换用户”登录 `DSHTrainer`，在该账户下启动 DSH 和客户端；原用户保持登录，服务继续运行。

也可以从原用户的 PowerShell 启动一个使用训练身份的终端：

```powershell
runas "/user:$env:COMPUTERNAME\DSHTrainer" "powershell.exe -NoExit -Command Set-Location D:\DSH_Workspace"
```

按提示输入训练用户密码，在新终端中启动 DSH 或执行训练命令。必须让 **DSH 及其所有文件/终端工具本身** 运行在训练账户下；只让一条客户端命令切换用户，而 DSH 仍在原账户运行，并不能形成文件隔离。

不要添加 `/netonly`：它只对远程访问使用另一身份，不改变本地文件访问身份。不要使用 `/savecred` 保存服务端凭据。参见微软 [runas 文档](https://learn.microsoft.com/en-us/previous-versions/windows/it-pro/windows-server-2012-r2-and-2012/cc771525%28v%3Dws.11%29)。

两个本机用户会话使用相同的 `127.0.0.1:4765` 地址通信，不需要开放局域网端口，也不需要将监听地址改成 `0.0.0.0`。这个方案依靠 Windows 标准用户权限和 NTFS 隔离；它不使训练用户免受自身授权工具的行为影响，也不替代对管理员账户的控制。

## 9. 常见返回信息

| 情况 | 处理方法 |
| --- | --- |
| 连接失败 | 在原用户会话启动服务，核对端口与客户端 `url`。 |
| HTTP 401 | 更新客户端令牌，使用本服务启动时显示的值。 |
| HTTP 400 | 按返回信息修正对手 ID、场数或参数；不能传服务端文件路径。 |
| HTTP 409 | 当前任务或日志请求尚未结束，先查询已有任务状态。 |
| 选手语法错误、异常或死循环 | 查看结果中的脚本故障数据及详细日志，修改自己的 JS 后新建任务。 |
| 任务为 `failed` | 读取已有结果和错误信息；若训练执行进程退出，由服务端用户重启服务再提交。 |
| `Access is denied` 访问主项目 | 配置严格隔离后的训练账户应使用独立工作区和客户端，而非主项目路径。 |

## 10. 迁移前的运行记录（2026-11-06）

本次交付完成了以下针对性实跑：

- 使用客户端提交标准 JS 选手，与固定授权对手完成真实对战：4 局、0 胜、4 负、4 次自杀，返回统计与逐局结果一致。
- 导出第 1 局完整日志：79 个 Tick、80 条状态、17 条事件；展开日志的结果与原始比赛结果一致。
- 语法错误记为 `script_error`，死循环记为 `unresponsive_timeout`；随后正常完成双对手训练，服务未持续卡死。
- 无令牌、未开放源码地址和非法提交参数分别返回 HTTP 401、404、400。
- 在临时独立目录仅放置客户端工具、示例 JS 和连接配置即可提交训练，无需引擎源码。
- 排除正式窗口同时比赛的影响后，单独调用训练服务前后，10 名正式选手的成绩统计及正式 `arena.json` 写入时间保持不变。

Windows 双用户及 NTFS 权限仍需用户按第 8 节配置，本次没有创建账户或变更系统权限。

## 11. 生成交付包

从唯一项目根目录执行：

```powershell
npm run kit:package
npm run training:package
```

开发包生成到 `downloads/AI_Starter_Kit.zip`，供网站下载。免安装训练包生成到 `local-data/packages/AI_Training_Arena_Windows_x64.zip`，按需用于 GitHub Releases；它使用项目现有 Electron 版本和共享引擎，包含公开清单中的两个陪练。`local-data/` 中的私有配置、任务、脚本和日志不参与打包。
