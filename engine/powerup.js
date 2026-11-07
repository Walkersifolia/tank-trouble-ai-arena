// ============================================================
// powerup.js — 道具实体 + 刷新管理
// 职责：在地图上随机刷新可拾取道具（散射弹 / 护盾），并自渲染。
//   - Powerup        单个道具：世界坐标 + 类型，画圆底 + 类型图标
//   - PowerupSpawner 刷新器：持有计时器，到点在空格随机刷一个，
//                    场上数量受 maxOnField 限流；菜单关掉道具则 types 传空，永不刷
// 拾取检测（坦克碾过）放 main —— 与子弹击中判定同一层（都用 circleVsCircle）。
// 效果如何作用在坦克上由 tank.applyPowerup 负责，这里只管"在地上有个能捡的东西"。
// 渲染随竞技场缩放（与子弹/坦克同一套世界坐标），物理与显示解耦。
// ============================================================

import { POWERUP, THEME, CELL_SIZE, TANK } from "./config.js";
import { resolveCircleWalls } from "./collision.js";

// [min, max] 区间取随机数（刷新间隔抖动用）
function randRange([min, max], rng) {
  return min + rng() * (max - min);
}

// 道具类型 → 圆底颜色。**这是全游戏唯一的道具色表**（新增类型在此登记一行即可）：
// 地上道具的圆底、HUD 徽章、以及 PickupFlash 的拾取彩环都读它。effects.js 原先
// 自己抄了第二份，于是那句「登记一行即可」只对一半——见阶段 28.6。
export const TYPE_BG = {
  scatter: THEME.powScatterBg,
  shield: THEME.powShieldBg,
  laser: THEME.powLaserBg,
  mine: THEME.powMineBg,
};

export class Powerup {
  // x, y: 世界坐标（格中心附近）；type: POWERUP.types 之一
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    this.type = type;
    this.age = 0;          // 用于轻微呼吸动画
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    // 轻微呼吸：底圆半径在 ±6% 间缓动，让道具"活"一点，好被注意到
    // （图标本体保持原尺寸——只有底圆呼吸，与提取前的行为一致）
    const pulse = 1 + Math.sin(this.age * 3) * 0.06;
    drawPowerupIcon(ctx, this.type, this.x, this.y, POWERUP.radius, pulse);
  }
}

// 统一的「圆底 + 类型图标」绘制入口（地上道具与 HUD 徽章共用）。
// r 为图标基准半径；bgScale 只缩放底圆（呼吸动画用，默认 1）。
export function drawPowerupIcon(ctx, type, x, y, r, bgScale = 1) {
  ctx.save();
  ctx.translate(x, y);

  // —— 圆底（按类型上色）+ 深色描边 ——
  ctx.fillStyle = TYPE_BG[type] || THEME.powScatterBg;
  ctx.beginPath();
  ctx.arc(0, 0, r * bgScale, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = THEME.powRing;
  ctx.stroke();

  // —— 类型图标（白色线条，压在底色上）——
  ctx.strokeStyle = THEME.powIcon;
  ctx.fillStyle = THEME.powIcon;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (type === "scatter") {
    drawScatterIcon(ctx, r);
  } else if (type === "laser") {
    drawLaserIcon(ctx, r);
  } else if (type === "mine") {
    drawMineIcon(ctx, r);
  } else {
    drawShieldIcon(ctx, r);
  }

  ctx.restore();
}

// 散射图标：三道从左侧汇聚、向右发散的箭线（表"一变三"）
function drawScatterIcon(ctx, r) {
  const len = r * 0.62;
  const originX = -len * 0.6;
  for (const ang of [-0.5, 0, 0.5]) {
    const ex = originX + Math.cos(ang) * len * 1.7;
    const ey = Math.sin(ang) * len * 1.4;
    ctx.beginPath();
    ctx.moveTo(originX, 0);
    ctx.lineTo(ex, ey);
    ctx.stroke();
    // 箭头小叉
    const back = 4;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang - 0.5) * back, ey - Math.sin(ang - 0.5) * back);
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - Math.cos(ang + 0.5) * back, ey - Math.sin(ang + 0.5) * back);
    ctx.stroke();
  }
}

// 护盾图标：经典盾形（顶平、底尖），白描边
function drawShieldIcon(ctx, r) {
  const w = r * 0.5;
  const top = -r * 0.5;
  const mid = r * 0.18;
  const bot = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(-w, top);
  ctx.lineTo(w, top);
  ctx.lineTo(w, mid);
  ctx.quadraticCurveTo(w, bot, 0, bot);   // 右下收向尖底
  ctx.quadraticCurveTo(-w, bot, -w, mid); // 左下收向尖底
  ctx.closePath();
  ctx.stroke();
}

// 地雷图标：半圆雷体扣在地平线上 + 顶部三根触刺 + 中心引信点
function drawMineIcon(ctx, r) {
  const w = r * 0.55;   // 雷体半宽
  const base = r * 0.35; // 地平线高度（图标重心略下移）

  // 地平线
  ctx.beginPath();
  ctx.moveTo(-r * 0.75, base);
  ctx.lineTo(r * 0.75, base);
  ctx.stroke();

  // 半圆雷体（扣在地平线上）
  ctx.beginPath();
  ctx.arc(0, base, w, Math.PI, 0);
  ctx.closePath();
  ctx.stroke();

  // 顶部三根触刺（从雷体表面沿径向朝外，-135°/-90°/-45°）
  for (const a of [-Math.PI * 0.75, -Math.PI * 0.5, -Math.PI * 0.25]) {
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * w, base + Math.sin(a) * w);
    ctx.lineTo(Math.cos(a) * (w + r * 0.3), base + Math.sin(a) * (w + r * 0.3));
    ctx.stroke();
  }

  // 中心引信点
  ctx.beginPath();
  ctx.arc(0, base - w * 0.45, 1.8, 0, Math.PI * 2);
  ctx.fill();
}

// 激光图标：一道折线射线（反弹轨迹意象）+ 末端光点
function drawLaserIcon(ctx, r) {
  const s = r * 0.62;
  ctx.beginPath();
  ctx.moveTo(-s, s * 0.7);
  ctx.lineTo(-s * 0.15, -s * 0.6);
  ctx.lineTo(s * 0.35, s * 0.5);
  ctx.lineTo(s * 0.95, -s * 0.45);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(s * 0.95, -s * 0.45, 2.2, 0, Math.PI * 2);
  ctx.fill();
}

export class PowerupSpawner {
  // types: 本局可刷的种类数组（菜单关掉道具则传 []，永不刷）
  // rng: 本实例独立的 [0,1) 随机函数；省略时仍使用 Math.random。
  constructor(types, rng = Math.random) {
    this.types = types || [];
    this.rng = rng;
    this.timer = randRange(POWERUP.spawnInterval, this.rng); // 开局先等一拍再刷第一个
    // 场上道具上限。默认 = POWERUP.maxOnField（原行为）；波次生存的「补给增量」
    // 强化会把它调高——**必须调这里**，不然多刷的补给会被下面两道门静默吃掉，
    // 那张卡就是一张空卡（场上已有 2 个没捡的道具时 forceSpawn 直接 false）。
    this.cap = POWERUP.maxOnField;
  }

  // 每帧推进。到点且场上未满则刷一个，入 powerups 数组（原地 push）。
  // maze: 当前地图（取 cols/rows/walls 选位）；powerups: 当前场上道具（数量限流）；
  // tanks: 存活坦克数组（避开正踩在上面的位置，防一刷出来就被吃/重叠）；
  // mines: 场上地雷（**必须避**，见 pickSpot 里那段）。可选，缺省视为无雷。
  update(dt, maze, powerups, tanks, mines = []) {
    if (this.types.length === 0) return;      // 道具关闭
    if (powerups.length >= this.cap) return;  // 场上已满

    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = randRange(POWERUP.spawnInterval, this.rng); // 重置下一次刷新计时

    this.forceSpawn(maze, powerups, tanks, mines);
  }

  // 立刻刷一个，绕开计时器（波次生存的开波补给用）。仍守 this.cap 与避位规则——
  // 补给是"多给一次机会"，不是"无视场上限流"。不重置 timer：常规刷新节奏与补给互不干扰。
  // 返回是否真刷出来了（场上满/图太挤时为 false，调用方不必处理，下波再补）。
  forceSpawn(maze, powerups, tanks, mines = []) {
    if (this.types.length === 0) return false;
    if (powerups.length >= this.cap) return false;

    const spot = this.pickSpot(maze, powerups, tanks, mines);
    if (!spot) return false; // 没找到合适位置

    const type = this.types[Math.floor(this.rng() * this.types.length)];
    powerups.push(new Powerup(spot.x, spot.y, type));
    return true;
  }

  // 随机选一个刷新点：随机格中心 → 推出墙体 → 校验不与现有道具/坦克/地雷太近。
  // 试若干次仍找不到就返回 null（地图太挤，本次不刷）。
  //
  // **为什么要避雷**：警戒后的雷是**完全隐形**的（mine.visibility 三条已钉死
  // 「主人也看不见，靠记忆」），所以把补给刷进雷的触发圈 = 摆一个看起来白捡、
  // 走过去必死的诱饵，而且玩家读不出原因。AI 免疫这条：它读 world.mines 有
  // 完美记忆、BFS 又禁行雷格——**所以这只坑真人**，正是最该修的那一类。
  // 避雷半径取「触发圈 + 拾取圈」：玩家必须走到拾取圈内才吃到它，
  // 所以只要格心离雷 ≥ triggerRadius + POWERUP.radius，走过去时就不会踩进触发圈。
  pickSpot(maze, powerups, tanks, mines = []) {
    for (let tries = 0; tries < 12; tries++) {
      const c = Math.floor(this.rng() * maze.cols);
      const r = Math.floor(this.rng() * maze.rows);
      let x = (c + 0.5) * CELL_SIZE;
      let y = (r + 0.5) * CELL_SIZE;
      // 格中心理论上不会嵌墙，但稀疏格栅偶有贴边，兜一下保险
      const fixed = resolveCircleWalls(x, y, POWERUP.radius, maze.walls);
      x = fixed.x;
      y = fixed.y;

      const clear = POWERUP.radius + TANK.radius;
      // 避开正踩在该点的坦克（否则一刷出来立刻被吃，没存在感）
      let tooClose = tanks.some(
        (t) => t.alive && Math.hypot(t.x - x, t.y - y) < clear
      );
      // 避开地雷的杀伤范围（见方法头注释：隐形雷 + 诱饵 = 讲不清的死）
      const mineClear = POWERUP.mine.triggerRadius + POWERUP.radius;
      tooClose = tooClose || mines.some(
        (m) => !m.exploded && Math.hypot(m.x - x, m.y - y) < mineClear
      );
      // 避开已有道具，别叠在一起
      tooClose = tooClose || powerups.some(
        (p) => Math.hypot(p.x - x, p.y - y) < POWERUP.radius * 2.2
      );
      if (!tooClose) return { x, y };
    }
    return null;
  }
}
