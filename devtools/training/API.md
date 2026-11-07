# AI 脚本开发接口

完整且可独立分发的接口文档在 [devtools/training/starter-kit/API.md](starter-kit/API.md)，开发及公平竞赛规则在 [devtools/training/starter-kit/README.md](starter-kit/README.md)。主程序采用同一 v1 协议。

脚本是单个 UTF-8 `.js` 文件，同步导出：

```js
module.exports = {
  update(state) {
    return { move: 0.7, turn: 0.3, fire: state.tick % 60 === 0, special: false };
  }
};
```

`state` 包含 `apiVersion/tick/time/dt/self/enemies/map/bullets/powerups/mines/rules/physics`，为公开状态独立副本。固定每秒 60 Tick。x 向右、y 向下，像素与秒为单位；角度单位弧度、顺时针为正。每局重建 Worker，局内可保存自己的变量。

`move/turn` 为 [-1,1] 内有限数值，默认 0；`fire/special` 为布尔值，默认 false；前进、转向、射击及布雷可以同时进行。布雷需要游戏内拾取地雷道具。没有独立炮塔、跳跃或横移指令。

运动使用共享刚体接触核心，无驾驶惯性或动作保持。满输入前进 `153.12 px/s`、倒车 `122.88 px/s`、转向 `5 rad/s`；`physics.moveSpeed` 仍表示前进速度，新增 `reverseSpeed`。车身（含履带）与圆头炮管参与墙体及车车接触，轮廓见 `physics.tankCollision`；墙厚见 `wallThickness/borderWallThickness`。`tankRadius=16` 保留为武器命中和道具拾取半径，不能再用于推算墙体间隙。观测中的 `x/y/angle` 始终是真实物理姿态，显示插值不回写观测。

同一 Tick 收集全员动作后才推进物理，脚本不获得可修改的引擎对象，也没有 Node/文件/网络接口。**正式单次决策预算统一为 50 ms**，仅测 Worker 内调用及动作字段读取，排队/回传等待不计入；调用中 OS 抢占仍无法精确扣除。另设开始执行后 250 ms 无响应硬终止保护，排队/启动和初始化执行各限 2000 ms；宿主定时器明显迟到时给予一次消息派发宽限，不重试决策。速度模式不改变这些规则。

脚本错误、异常、超时或非法动作只使该选手本局判负并销毁其 Worker，其余选手继续，下一局自动重建并允许重新参赛。所有故障败场进入参赛局数、负场和胜率分母；超时另累计 `timeouts`（负场子集），不赠送其他选手击杀。即使其余选手打平，故障者也计负；全员故障则全员计负。具体计时限制、误差及内存限制见开发包。

从项目根目录使用 `node devtools/training/starter-kit/check.js 路径/你的脚本.js` 做独立格式检查，再通过界面导入。参赛 AI 仅应获得 `devtools/training/starter-kit` 开发包，不要向其提供主项目和私有 `local-data/private-bots` 中的参赛算法。
