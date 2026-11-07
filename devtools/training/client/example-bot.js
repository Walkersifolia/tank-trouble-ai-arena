// 提交此格式的单个 .js 文件。没有 import、require 或第三方依赖。
// 顶层变量可跨 Tick 保存；每局开始，整个文件在新的脚本作用域中重新求值。
let ticksSeen = 0;
module.exports = {
  update(state) {
    // 例：state.self = { id, x, y, angle, vx, vy, cooldown, ... }
    // state.enemies / bullets / mines / powerups 是当前公开观测数组。
    // state.map.walls 为墙线段；完整字段见 API.md 和 example_state.json。
    ticksSeen++;
    // 仅演示同时前进、转向和开火；请自行设计参赛算法。
    return { move: 0.7, turn: 0.3, fire: ticksSeen % 60 === 0, special: false };
  },
};
