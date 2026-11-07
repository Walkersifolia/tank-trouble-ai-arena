// ============================================================
// collision.js — 纯几何碰撞工具
// 全是无状态函数，不依赖游戏对象，方便单独推理与复用。
//
// 用途：
//   - circleVsSegment：坦克(圆)/子弹(圆) 撞墙(线段) 检测
//   - resolveCircleWalls：把圆推出所有相交的墙，实现"撞墙不穿 + 沿墙滑动"
//   - reflect：子弹撞墙的反射向量（阶段 3 用）
// ============================================================

// 求点 P 到线段 AB 的最近点
export function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return { x: x1, y: y1 }; // 退化成点
  // 投影参数 t，夹到 [0,1] 限制在线段内
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

// 圆(cx,cy,r) 是否与线段相交。相交则返回穿透信息，否则返回 null。
// 返回 { nx, ny, depth }：nx,ny 是从墙指向圆心的单位法线，depth 是穿透深度。
export function circleVsSegment(cx, cy, r, x1, y1, x2, y2) {
  const cp = closestPointOnSegment(cx, cy, x1, y1, x2, y2);
  let nx = cx - cp.x;
  let ny = cy - cp.y;
  const distSq = nx * nx + ny * ny;

  if (distSq >= r * r) return null; // 没碰到

  const dist = Math.sqrt(distSq);
  if (dist === 0) {
    // 圆心正好落在线段上：退化，用线段法线方向兜底
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    nx = -dy / len;
    ny = dx / len;
    return { nx, ny, depth: r };
  }

  return { nx: nx / dist, ny: ny / dist, depth: r - dist };
}

// 把圆从所有相交的墙里推出来。
// 逐墙解算并把圆心沿法线推出穿透深度——多墙时迭代几遍收敛，
// 角落里被两面墙夹住也能稳定停住（这就是"沿墙滑动"的来源：
// 沿墙方向的分量不被抵消，只消掉朝墙里钻的分量）。
// 返回修正后的 { x, y }。
export function resolveCircleWalls(cx, cy, r, walls, iterations = 3) {
  let x = cx;
  let y = cy;
  for (let iter = 0; iter < iterations; iter++) {
    let moved = false;
    for (const w of walls) {
      const hit = circleVsSegment(x, y, r, w.x1, w.y1, w.x2, w.y2);
      if (hit) {
        x += hit.nx * hit.depth;
        y += hit.ny * hit.depth;
        moved = true;
      }
    }
    if (!moved) break; // 这一轮没有任何穿透，已收敛
  }
  return { x, y };
}

// 等质量双圆分离（坦克-坦克碰撞用）：圆心距小于 minDist 时沿连线各推一半，
// 返回修正后两圆心 { ax, ay, bx, by }；未重叠返回 null。
// 完全重合（圆心距≈0）退化沿 +x 推开，保证总能分离。
export function separateCircles(ax, ay, bx, by, minDist) {
  const dx = bx - ax;
  const dy = by - ay;
  const distSq = dx * dx + dy * dy;
  if (distSq >= minDist * minDist) return null;

  const dist = Math.sqrt(distSq);
  let nx = 1, ny = 0; // 重合退化方向
  if (dist > 1e-6) {
    nx = dx / dist;
    ny = dy / dist;
  }
  const push = (minDist - dist) / 2;
  return {
    ax: ax - nx * push, ay: ay - ny * push,
    bx: bx + nx * push, by: by + ny * push,
  };
}

// 反射向量：入射速度 (vx,vy) 碰到单位法线 (nx,ny) 后的反射速度。
// v' = v - 2(v·n)n   （阶段 3 子弹反弹用）
export function reflect(vx, vy, nx, ny) {
  const dot = vx * nx + vy * ny;
  return { vx: vx - 2 * dot * nx, vy: vy - 2 * dot * ny };
}

// 两圆是否相交（子弹击中坦克用）
export function circleVsCircle(x1, y1, r1, x2, y2, r2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const rr = r1 + r2;
  return dx * dx + dy * dy <= rr * rr;
}

// 两线段 AB(x1,y1→x2,y2) 与 CD(x3,y3→x4,y4) 相交检测——参数版。
// 标准参数法：解 A+t·AB = C+u·CD，t、u 都落在 [0,1] 即相交，
// 返回交点在 AB 上的参数 t；不相交返回 null。
// 平行/共线（分母≈0）一律按不相交处理——墙都有渲染厚度，
// 恰好沿墙面掠过的射线判通判堵都无碍，不值得为共线重叠做精确解。
// 用途：炮口出膛点贴墙修正（需要知道截在哪）、segmentVsSegment 的底层。
export function segmentVsSegmentParam(x1, y1, x2, y2, x3, y3, x4, y4) {
  const dx1 = x2 - x1;
  const dy1 = y2 - y1;
  const dx2 = x4 - x3;
  const dy2 = y4 - y3;

  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-9) return null; // 平行或共线

  const t = ((x3 - x1) * dy2 - (y3 - y1) * dx2) / denom;
  const u = ((x3 - x1) * dy1 - (y3 - y1) * dx1) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

// 两线段是否相交（布尔便捷版）。用途：AI 视线/探路检测。
export function segmentVsSegment(x1, y1, x2, y2, x3, y3, x4, y4) {
  return segmentVsSegmentParam(x1, y1, x2, y2, x3, y3, x4, y4) !== null;
}
