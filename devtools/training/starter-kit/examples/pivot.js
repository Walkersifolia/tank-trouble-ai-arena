// 原地旋转 + 每模拟秒尝试一次射击，演示 move / turn / fire 独立。
// 不追踪目标或检查回弹；这是动作示例，不是比赛策略。
let nextShotAt = 1; // 同一局保留，每局重新初始化。

module.exports = {
  update(state) {
    const fire = state.time >= nextShotAt;
    if (fire) nextShotAt = state.time + 1;
    return {
      move: 0,
      turn: 0.35,
      fire,
      special: false,
    };
  },
};
