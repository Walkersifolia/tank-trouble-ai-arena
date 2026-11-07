// ============================================================
// laser.js — 激光射线（瞬时 hitscan）
// castLaserPath：纯几何——从起点沿方向投射，撞墙反射，直到反弹次数或
//   总长度耗尽，返回折线顶点数组（首=起点，尾=终点）。冒烟测试直接断言。
// LaserBeam：开火后的亮线特效（折线，beamDuration 内淡出），纯表现层。
// renderLaserPreview：持激光时炮口延伸的全程预瞄虚线（含反弹段，随转向
//   实时变化）——激光威力大但持有时弹道全暴露，这是它的平衡设计。
// 命中判定（逐段 vs 坦克圆、沿路径最早命中即截断）在 main——与子弹
// 击中判定同层（需要跨全体坦克交叉），本模块只管几何与画线。
// ============================================================

import { POWERUP, THEME } from "./config.js";
import { segmentVsSegmentParam, reflect } from "./collision.js";

// 从 (x, y) 沿 angle 投射激光：返回折线顶点 [{x, y}, ...]。
// opts 可覆盖反弹次数/总长（预瞄虚线用短参数复用同一函数——所见即所打）。
export function castLaserPath(x, y, angle, walls, opts = {}) {
  const maxBounces = opts.maxBounces ?? POWERUP.laser.maxBounces;
  let remain = opts.maxLength ?? POWERUP.laser.maxLength;

  const pts = [{ x, y }];
  let px = x, py = y;
  let dx = Math.cos(angle), dy = Math.sin(angle);

  for (let seg = 0; seg <= maxBounces && remain > 0.5; seg++) {
    // 当前段按剩余长度探到最远
    const ex = px + dx * remain;
    const ey = py + dy * remain;

    // 找最近的墙交点（t 是相对本段全长的参数）
    let bestT = null;
    let bestWall = null;
    for (const w of walls) {
      const t = segmentVsSegmentParam(px, py, ex, ey, w.x1, w.y1, w.x2, w.y2);
      if (t !== null && (bestT === null || t < bestT)) {
        bestT = t;
        bestWall = w;
      }
    }

    if (bestT === null) {
      // 没撞任何墙：走满剩余长度收尾（场地封闭理论到不了，数值兜底）
      pts.push({ x: ex, y: ey });
      break;
    }

    // 撞墙点入列，扣掉已走长度
    const hx = px + dx * remain * bestT;
    const hy = py + dy * remain * bestT;
    pts.push({ x: hx, y: hy });
    remain -= remain * bestT;

    if (seg === maxBounces) break; // 反弹次数用尽，射线止于这堵墙

    // 沿墙法线反射（法线方向取哪侧无所谓，反射公式对取反不变）
    const wx = bestWall.x2 - bestWall.x1;
    const wy = bestWall.y2 - bestWall.y1;
    const len = Math.hypot(wx, wy) || 1;
    const r = reflect(dx, dy, -wy / len, wx / len);
    dx = r.vx;
    dy = r.vy;

    // 新段起点沿反射方向微移，防浮点误差下同一堵墙再次判交
    px = hx + dx * 0.5;
    py = hy + dy * 0.5;
  }

  return pts;
}

// 激光亮线特效：折线整体淡出，外圈光晕 + 内芯亮线两层描边
export class LaserBeam {
  // points: 折线顶点（main 已按命中截断，视觉上射线止于目标/护盾）
  constructor(points) {
    this.points = points;
    this.age = 0;
    this.duration = POWERUP.laser.beamDuration;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done || this.points.length < 2) return;
    const p = this.age / this.duration;
    const alpha = 1 - p;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = THEME.laserBeam;

    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) {
      ctx.lineTo(this.points[i].x, this.points[i].y);
    }
    // 外圈光晕（粗、淡）
    ctx.globalAlpha = alpha * 0.25;
    ctx.lineWidth = 7;
    ctx.stroke();
    // 内芯亮线（细、实，随时间略变细）——同一路径再描一遍
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2.5 * (1 - p * 0.5);
    ctx.stroke();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// 预瞄虚线：持激光时从炮口画完整弹道预览（含全部反弹段，与实际发射用同一
// 套参数投射——所见即所打）。每帧随 tank.angle 实时重算；世界坐标绘制。
// 全程可见是激光的平衡设计：威力不削，但持有者的杀伤线全暴露，
// 对手可以绕线走位——「暗杀」变「明枪」。
export function renderLaserPreview(ctx, tank, walls) {
  // 出膛点传 walls 做贴墙修正——必须与 tryFire 那一侧同参数，否则贴墙时
  // 虚线画的是穿墙路径而实弹走的是反弹路径，「所见即所打」当场失效
  const m = tank.muzzlePoint(walls);
  const pts = castLaserPath(m.x, m.y, m.angle, walls);
  if (pts.length < 2) return;

  ctx.save();
  ctx.strokeStyle = THEME.laserPreview;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 6]);
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(pts[i].x, pts[i].y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
