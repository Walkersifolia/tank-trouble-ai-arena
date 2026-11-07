// 显示位置独立于 Tank 的真实碰撞/瞄准位置，不保存或延长任何控制输入。
// 原版本地显示每 60 Hz 帧取 (旧显示 + 模型) / 2；这里用等效时间常数
// 1 / (60 * ln(2)) ≈ 24 ms，让不同刷新率的显示追随速度一致。
export const TANK_DISPLAY_TIME_CONSTANT = 1 / (60 * Math.LN2);

export class TankDisplayPoses {
  constructor() { this.reset(); }

  reset() { this.poses = new WeakMap(); }

  get(tank, renderDt, snap = false) {
    let pose = this.poses.get(tank);
    if (!pose || snap) {
      pose = { x: tank.x, y: tank.y, angle: tank.angle };
      this.poses.set(tank, pose);
      return pose;
    }
    const blend = 1 - Math.exp(-renderDt / TANK_DISPLAY_TIME_CONSTANT);
    pose.x += (tank.x - pose.x) * blend;
    pose.y += (tank.y - pose.y) * blend;
    const turn = Math.atan2(Math.sin(tank.angle - pose.angle), Math.cos(tank.angle - pose.angle));
    pose.angle += turn * blend;
    return pose;
  }
}
