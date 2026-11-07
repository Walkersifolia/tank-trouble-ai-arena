# 训练数据格式 v1

所有 JSON 均为 UTF-8。客户端保存服务端返回的原始 JSON；stdout 也可直接交给程序读取。时间戳使用 ISO 8601。`round` 是整个任务内从 1 开始的对局编号，不是某个对手内的局号。

## 任务状态：status.json

`run --no-wait` 和 `status JOB_ID` 返回任务状态。关键字段：

| 字段 | 含义 |
|---|---|
| `id` | 服务端分配的任务 ID |
| `status` | `running`、`completed` 或 `failed` |
| `createdAt` / `finishedAt` | 创建和结束时间，未结束时没有 `finishedAt` |
| `completed` / `total` | 已保存的对局数 / 计划总对局数 |
| `progress` | 当前比赛推进信息；以服务端返回字段为准 |
| `error` | 任务失败原因；正常任务不含此字段 |

退出客户端等待不影响服务端任务。`result` 在任务完成后返回聚合结果；任务失败时可返回已经完成的部分对局，应先查看 `status`。

## 聚合结果：result.json

| 字段 | 含义 |
|---|---|
| `schemaVersion` | 当前为 `1` |
| `id`、`status`、`createdAt`、`finishedAt` | 任务标识和状态 |
| `parameters` | 提交的选手名、对手 ID、每对手场数、seed、出生交换、道具开关 `powerups` 和代表日志数量；不含脚本源码 |
| `rules` | 实际规则摘要：`physicsHz: 60`、`decisionMs: 50`、`timeout: 60`、`powerups` 和 `wallBreak`；新任务墙体不可破坏 |
| `statistics` | 候选选手的整体统计 |
| `byOpponent` | 分对手统计数组，各项包含 `id`、`name` 以及与 `statistics` 相同的统计字段 |
| `rounds` | 全部已完成对局的轻量结果与事件摘要 |
| `representativeRounds` | 推荐导出的对局，格式为 `[{"round":1,"reason":"候选选手败局"}]` |

新任务 `rules.powerups` 与提交模式一致，`rules.wallBreak=false`。历史任务及录像保留当时的规则，不随新默认值改变。

`statistics` 和 `byOpponent[]` 中的统计只描述本次提交的候选选手，以下另有说明的字段除外：

| 字段 | 含义 |
|---|---|
| `matches` | 已完成比赛场数 |
| `wins` / `losses` / `draws` | 胜 / 负 / 平，合计为 `matches` |
| `winRate` | `wins / matches`，范围 0–1；显示百分比时乘以 100 |
| `kills` | 候选选手击杀对手次数；脚本故障淘汰不计为击杀 |
| `suicides` | 候选选手被自己武器杀死的次数 |
| `matchTimeouts` | 整场比赛达到游戏时限的次数，不等同于 AI 决策超时 |
| `decisionTimeouts` | 候选选手单次决策超过 50 ms 的次数，仅统计 `decision_timeout` |
| `executionTimeouts` | 候选选手所有类别的执行超时判负总次数 |
| `timeoutBreakdown` | 按 `decision_timeout`、`init_timeout`、`queue_timeout`、`unresponsive_timeout` 分别统计；排队超时不能据此判断算法计算慢 |
| `scriptErrors` | 候选选手脚本错误次数，不包含超时 |
| `fireRequests` | 返回 `fire: true` 的动作请求次数 |
| `shotsFired` | 实际触发射击次数；散射一次射击产生多个弹体，不能将弹体数作为射击次数 |
| `bulletLimitFailures` | 普通弹在场名额限制导致的开火失败次数 |
| `pickups` | 按 `laser`、`scatter`、`mine`、`shield` 类型统计拾取次数 |
| `totalPickups` | 各类型道具拾取次数总和 |
| `averageDurationSeconds` | 已完成比赛的平均游戏时长，单位秒，不是训练消耗的真实墙钟时间 |
| `wallBlockedTicks` | 记录到移动被墙阻挡的 Tick 数 |
| `moveReversals` / `turnReversals` | 移动 / 转向指令正负方向切换次数 |
| `longestNoFireSeconds` | 所有比赛中最长连续未实际射击时段，单位游戏秒 |

每个 `rounds[]` 包含：

| 字段 | 含义 |
|---|---|
| `round` | 对局编号，供 `logs --round` 使用 |
| `opponentId` | 训练对手 ID |
| `worldSeed` | 本局实际游戏种子 |
| `swapped` | 是否交换候选选手与对手的出生位置 |
| `outcome` | 候选选手视角的 `win`、`loss`、`draw` |
| `reason` | 引擎记录的结束原因，例如 `timeout` |
| `winnerId` | 获胜选手 ID；无胜者时为空 |
| `ticks` | 本局经过的物理 Tick 数 |
| `faults` | 本局脚本故障数组 `[{id,code,timeout}]`，用于区分具体超时或异常 |
| `summary.durationSeconds` | 本局游戏时长 |
| `summary.players` | 两个选手各自的比赛事件统计；候选选手 ID 为 `candidate` |

读取失败局的例子（PowerShell）：

```powershell
$result = Get-Content .\results\g6-v1\result.json -Raw | ConvertFrom-Json
$result.statistics
$result.byOpponent
$result.rounds | Where-Object outcome -eq loss | Select-Object round, opponentId, reason, worldSeed
node .\trainer.mjs logs JOB_ID --round 1 --out .\results\g6-v1\round-1.zip
```

## 详细记录：round-N.zip

ZIP 复用正式竞技场已有战斗日志格式：

| 文件 | 用途 |
|---|---|
| `match.json` | 本局配置、公开参赛信息、地图/种子等元数据 |
| `events.jsonl` | 一行一个 JSON 事件，记录射击、死亡、道具和脚本故障等事实 |
| `states.jsonl` | 一行一个 Tick 状态，可按 Tick 联结事件、位置和动作分析 |
| `summary.md` | 独立可读的中文比赛摘要 |

详细日志在请求时根据服务端保存的实际动作生成，不重新执行 AI；因此适合分析原比赛。行为原因需要结合状态和事件推断，摘要不保证能确定算法内部动机。日志不会包含任何参赛源码、引擎源码或选手私有决策变量。

## HTTP 接口

客户端已经封装这些接口。所有请求需要 `Authorization: Bearer <token>`。API 不支持文件路径参数、执行系统命令或读取任意服务端文件。

| 方法与路径 | 请求 / 响应 |
|---|---|
| `GET /v1/opponents` | `{opponents:[{id,name}]}` |
| `POST /v1/jobs` | JSON `{source,name,opponents,rounds,seed,swapSpawns,powerups,detailLimit}`；202 返回任务状态 |
| `GET /v1/jobs` | `{jobs:[任务状态]}` |
| `GET /v1/jobs/:id` | 单个任务状态 |
| `GET /v1/jobs/:id/result` | 完整 `result.json` |
| `GET /v1/jobs/:id/rounds/:round/logs` | `application/zip` 详细记录 |
| `DELETE /v1/jobs/:id` | 清理指定已结束任务，返回 `{deleted:id}` |

脚本文本最多 512 KiB，请求最多 1 MiB。`opponents` 为 1–4 个白名单 ID；`rounds` 为 1–1000；`seed` 为 uint32；`detailLimit` 为 0–5。`powerups` 为可选布尔值，省略为 `true`，传 `false` 选择无道具模式；新任务墙体始终不可破坏，不接受 `wallBreak` 覆盖。服务端只接受这些训练参数，不接受覆盖其他物理规则或 AI 预算的请求。
