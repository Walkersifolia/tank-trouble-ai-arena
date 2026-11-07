// 分阶段操控：前进 → 原地右转 → 倒车 → 倒车左转，再循环。
// 使用模拟时间，暂停时阶段不流逝；不依赖帧率或外部计时器。
// 没有寻路或避障，撞墙时仍会按计划进入下一阶段。
const phases = [
  { seconds: 2, move: 1, turn: 0 },
  { seconds: 0.8, move: 0, turn: 1 },
  { seconds: 1, move: -0.65, turn: 0 },
  { seconds: 1.2, move: -0.65, turn: -0.6 },
];
let phaseIndex = 0;
let phaseEndsAt = phases[0].seconds;

module.exports = {
  update(state) {
    if (state.time >= phaseEndsAt) {
      phaseIndex = (phaseIndex + 1) % phases.length;
      phaseEndsAt += phases[phaseIndex].seconds;
    }
    const phase = phases[phaseIndex];
    return { move: phase.move, turn: phase.turn, fire: false, special: false };
  },
};
