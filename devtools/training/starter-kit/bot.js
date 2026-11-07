// AI Starter Kit：可改造的单文件追踪示例，不是强 AI。
// 只使用 API.md 的公开状态；每局重新求值本文件，memory 不会跨局保留。
// 局限：不寻路、不躲弹、不预测跳弹、不争抢道具，也不会主动使用地雷。
// 隔墙追人和反弹自伤都是可能的；可以逐步替换下面的策略函数。

const SETTINGS = {
  stopDistance: 120,       // 靠近目标后停止前进，单位：逻辑像素。
  driveAngle: 0.55,        // 车头偏离目标较多时先原地转向，单位：弧度。
  fireAngle: 0.12,
  shotInterval: 0.7,       // 示例自己的射击节奏，单位：模拟秒。
  blockedDuration: 0.65,
  reverseDuration: 0.55,
};

const memory = {
  targetId: null,
  nextShotAt: 0.7,
  previousMove: 0,
  blockedFor: 0,
  reverseUntil: 0,
  reverseDirection: 1,
};

// 只记住目标 ID。每 Tick 的对象都是新副本，不能靠对象引用识别对手。
function chooseTarget(state) {
  const previousTarget = state.enemies.find(enemy => enemy.id === memory.targetId && enemy.alive);
  if (previousTarget) return previousTarget;

  let target = null;
  let nearestDistance = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    const distance = Math.hypot(enemy.x - state.self.x, enemy.y - state.self.y);
    if (distance < nearestDistance) {
      target = enemy;
      nearestDistance = distance;
    }
  }
  memory.targetId = target ? target.id : null;
  return target;
}

// 把角差折回 [-π, π]，从最短方向转向；正值表示顺时针。
function shortestAngle(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function planMovement(state, target) {
  const self = state.self;
  const distance = Math.hypot(target.x - self.x, target.y - self.y);
  const aimError = shortestAngle(Math.atan2(target.y - self.y, target.x - self.x) - self.angle);

  // 上一 Tick 想前进却几乎没移动：尝试短暂倒车转向。
  // 这是简单脱困策略，不会寻找绕墙路线，也不保证能走出死角。
  const actualSpeed = Math.hypot(self.vx, self.vy);
  if (memory.previousMove > 0 && actualSpeed < state.physics.moveSpeed * 0.1) {
    memory.blockedFor += state.dt;
  } else {
    memory.blockedFor = 0;
  }
  if (memory.blockedFor >= SETTINGS.blockedDuration) {
    memory.reverseUntil = state.time + SETTINGS.reverseDuration;
    memory.reverseDirection *= -1;
    memory.blockedFor = 0;
  }
  if (state.time < memory.reverseUntil) {
    return { move: -0.65, turn: memory.reverseDirection * 0.7, aimError, reversing: true };
  }

  // turn 和 move 是独立轴：move=0 时仍可原地转向；负 move 表示倒车。
  const turn = Math.max(-1, Math.min(1, aimError / (state.physics.turnSpeed * state.dt)));
  const move = Math.abs(aimError) < SETTINGS.driveAngle && distance > SETTINGS.stopDistance ? 0.85 : 0;
  return { move, turn, aimError, reversing: false };
}

function chooseFire(state, aimError) {
  if (Math.abs(aimError) > SETTINGS.fireAngle || state.time < memory.nextShotAt || state.self.cooldown > state.dt) {
    return false;
  }
  memory.nextShotAt = state.time + SETTINGS.shotInterval;
  // 这里只发出开火意图；实际冷却、弹体上限及武器消耗由引擎决定。
  // 没有检查墙或自己的回弹路径，后续可在这里加入射击策略。
  return true;
}

module.exports = {
  update(state) {
    const target = chooseTarget(state);
    if (!target) return { move: 0, turn: 0, fire: false, special: false };

    const movement = planMovement(state, target);
    memory.previousMove = movement.move;
    // 引擎先转向再射击，所以使用这一次转向后的角差判断是否瞄准。
    const aimAfterTurn = movement.aimError - movement.turn * state.physics.turnSpeed * state.dt;
    return {
      move: movement.move,
      turn: movement.turn,
      fire: !movement.reversing && chooseFire(state, aimAfterTurn),
      special: false,
    };
  },
};
