// ============================================================
// effects.js — 视觉特效（世界坐标，跟竞技场一起缩放平移）
// 阶段 6 起：坦克被击破的爆炸——参考原版 Tank Trouble 的死亡演出：
//   烟团：中心几个深色圆斑错位叠放，持续膨胀 + 淡出
//   碎片：若干随机多边形"残骸"四散飞出，自旋 + 阻尼减速 + 淡出
// 道具系统起：PickupFlash 拾取闪光、ShieldBreak 破盾——都是一次性扩散环。
// 纯表现层：不参与碰撞，不影响物理；done 后由 main 从数组移除。
// 联机 v2 直接复用：死亡有反馈而非凭空消失。
// ============================================================

import { EXPLOSION, WALL_BREAK, WALL, THEME, TANK, POWERUP } from "./config.js";
import { TYPE_BG } from "./powerup.js";

// ============================================================
// 屏幕震动 —— 模块级单例（同时只有一段震动，新震动与旧震动取剩余强度大者）。
// 纯 render 层：main 在 renderArena 把偏移加进 ctx.translate（缩放之前，
// 所以震动幅度不随竞技场缩放变化）；PAUSED 状态不施加，暂停画面不抖。
// ============================================================
const shake = { t: 0, dur: 0, mag: 0 };

// 触发一段震动：mag 最大偏移（逻辑像素）、dur 时长（秒）
export function addShake(mag, dur) {
  const remain = shake.dur > 0 ? shake.mag * (shake.t / shake.dur) : 0;
  if (mag >= remain) {
    shake.mag = mag;
    shake.dur = dur;
    shake.t = dur;
  }
}

// 每帧推进（main 的 updateEffects 里调用，与特效同节奏）
export function updateShake(dt) {
  if (shake.t > 0) shake.t = Math.max(0, shake.t - dt);
}

// 当前帧抖动偏移：线性衰减包络 × 每帧随机方向（高频抖动感）
export function shakeOffset() {
  if (shake.t <= 0) return { x: 0, y: 0 };
  const k = shake.mag * (shake.t / shake.dur);
  return { x: (Math.random() * 2 - 1) * k, y: (Math.random() * 2 - 1) * k };
}

// 立刻抹平震动（setupRound 调）。**必须有这个出口**：震动是模块级单例，
// 只有 updateEffects 能排空它，而 MENU 不跑 updateEffects、PAUSED 刻意不推进——
// 于是「击杀后立刻 Esc → 退到菜单 → 重开一局」会把上一局的余震带进新一局的
// 3-2-1 冻结开场（画面在没有任何事发生时抖）。新一局不该继承上一局的镜头状态。
export function resetShake() {
  shake.t = 0;
  shake.dur = 0;
  shake.mag = 0;
}

// [min, max] 区间取随机数
function randRange([min, max]) {
  return min + Math.random() * (max - min);
}

// 生成一个随机碎片多边形（局部坐标顶点数组）：
// 4~5 个顶点按极角排好序，半径抖动，出来就是"纸片残骸"的不规则感
function makeShardShape(size) {
  const n = 4 + Math.floor(Math.random() * 2);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random() * 0.6;
    const r = size * (0.55 + Math.random() * 0.45);
    pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return pts;
}

export class TankExplosion {
  // x, y: 爆炸中心（被击破坦克的位置）；color: 坦克色（碎片淡淡染一点身份色）
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.age = 0;

    // 碎片：随机方向 + 随机初速飞出，自旋方向随机
    const count = Math.round(randRange(EXPLOSION.shardCount));
    this.shards = [];
    for (let i = 0; i < count; i++) {
      const dir = Math.random() * Math.PI * 2;
      const speed = randRange(EXPLOSION.shardSpeed);
      this.shards.push({
        x: 0,                       // 相对爆炸中心
        y: 0,
        vx: Math.cos(dir) * speed,
        vy: Math.sin(dir) * speed,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * EXPLOSION.shardSpin,
        shape: makeShardShape(randRange(EXPLOSION.shardSize)),
        tinted: Math.random() < 0.35, // 少数碎片染坦克色，看得出是谁的残骸
      });
    }

    // 烟团：中心一个 + 周围错位几个，半径各自随机
    this.smoke = [];
    for (let i = 0; i < EXPLOSION.smokeCount; i++) {
      this.smoke.push({
        // 第一个居中，其余在中心附近随机错位
        x: i === 0 ? 0 : (Math.random() * 2 - 1) * 12,
        y: i === 0 ? 0 : (Math.random() * 2 - 1) * 12,
        r: randRange(EXPLOSION.smokeRadius),
      });
    }
  }

  get done() {
    return this.age >= EXPLOSION.duration;
  }

  update(dt) {
    if (this.done) return;
    this.age += dt;

    // 碎片：指数阻尼减速（速度按 e^(-drag·dt) 衰减），边飞边自旋
    const damp = Math.exp(-EXPLOSION.shardDrag * dt);
    for (const s of this.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= damp;
      s.vy *= damp;
      s.rot += s.spin * dt;
    }

    // 烟团持续膨胀
    for (const p of this.smoke) {
      p.r += EXPLOSION.smokeGrow * dt;
    }
  }

  render(ctx) {
    if (this.done) return;

    const progress = this.age / EXPLOSION.duration;
    // 前段全显，过 fadeStart 后线性淡出到 0
    const alpha = progress < EXPLOSION.fadeStart
      ? 1
      : 1 - (progress - EXPLOSION.fadeStart) / (1 - EXPLOSION.fadeStart);

    ctx.save();
    ctx.translate(this.x, this.y);

    // —— 1) 烟团（底层）：深灰圆斑，膨胀中淡出 ——
    ctx.fillStyle = "#2f2f33";
    ctx.globalAlpha = alpha * 0.8;
    for (const p of this.smoke) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // —— 2) 碎片（上层）：浅色"纸片残骸"+ 深色描边，贴近原版截图质感 ——
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = "#2b2b33";
    for (const s of this.shards) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(s.shape[0].x, s.shape[0].y);
      for (let i = 1; i < s.shape.length; i++) {
        ctx.lineTo(s.shape[i].x, s.shape[i].y);
      }
      ctx.closePath();
      ctx.fillStyle = s.tinted ? this.color : "#f2f1ec";
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
    ctx.globalAlpha = 1; // 复位，别污染后续绘制
  }
}

// ============================================================
// WallBreak — 墙段被炸碎（地雷炸墙）：沿墙段撒墙色碎片，法线方向飞散。
// TankExplosion 碎片系统的瘦身版：无烟团、更小更快更干脆。
// ============================================================
export class WallBreak {
  // 传被炸墙段两端点（世界坐标）
  constructor(x1, y1, x2, y2) {
    this.age = 0;

    // 墙段单位法线（横墙法线朝上下、竖墙朝左右，正负随机散布）
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;

    const count = Math.round(randRange(WALL_BREAK.shardPerSeg));
    this.shards = [];
    for (let i = 0; i < count; i++) {
      const t = Math.random();               // 沿墙段随机取生成点
      const side = Math.random() < 0.5 ? 1 : -1;
      const speed = randRange(WALL_BREAK.shardSpeed);
      const jitter = (Math.random() - 0.5) * 0.8; // 法线方向 ± 抖动
      this.shards.push({
        x: x1 + dx * t,
        y: y1 + dy * t,
        vx: (nx * side + (dx / len) * jitter) * speed,
        vy: (ny * side + (dy / len) * jitter) * speed,
        rot: Math.random() * Math.PI * 2,
        spin: (Math.random() * 2 - 1) * WALL_BREAK.shardSpin,
        shape: makeShardShape(randRange(WALL_BREAK.shardSize)),
      });
    }
  }

  get done() {
    return this.age >= WALL_BREAK.duration;
  }

  update(dt) {
    if (this.done) return;
    this.age += dt;
    const damp = Math.exp(-WALL_BREAK.shardDrag * dt);
    for (const s of this.shards) {
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.vx *= damp;
      s.vy *= damp;
      s.rot += s.spin * dt;
    }
  }

  render(ctx) {
    if (this.done) return;
    const progress = this.age / WALL_BREAK.duration;
    const alpha = progress < WALL_BREAK.fadeStart
      ? 1
      : 1 - (progress - WALL_BREAK.fadeStart) / (1 - WALL_BREAK.fadeStart);

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle = WALL.color; // 墙色碎片：看得出是墙的残骸
    for (const s of this.shards) {
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(s.rot);
      ctx.beginPath();
      ctx.moveTo(s.shape[0].x, s.shape[0].y);
      for (let i = 1; i < s.shape.length; i++) {
        ctx.lineTo(s.shape[i].x, s.shape[i].y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ============================================================
// MuzzleFlash — 开炮炮口火光（~0.12s）
// 出膛点一束深灰短光线（中间主束 + 两侧斜线），快速淡出。
// 深灰配浅场地贴原版极简风，不喧宾夺主，只给「炮响了」的顿挫感。
// ============================================================
export class MuzzleFlash {
  // x, y: 炮口位置（首发子弹的出膛点）；angle: 炮管朝向
  constructor(x, y, angle) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.age = 0;
    this.duration = 0.12;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    const len = 10 + p * 6; // 光束随时间略外扩

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.angle);
    ctx.globalAlpha = (1 - p) * 0.9;
    ctx.strokeStyle = "#2b2b3a";
    ctx.lineCap = "round";

    // 中间主光束
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, 0);
    ctx.stroke();
    // 两侧短斜线
    ctx.lineWidth = 2;
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(1, 0);
      ctx.lineTo(len * 0.55, s * len * 0.38);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ============================================================
// MineBlast — 地雷爆炸（~0.5s）
// 深灰冲击环快速扩张 + 内圈警戒红色残光 + 中心烟斑淡出。
// 波及判定在 main（引爆瞬间一次性结算），这里只管演出。
// ============================================================
export class MineBlast {
  // x, y: 爆炸中心（雷的位置）
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.age = 0;
    this.duration = 0.5;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    const alpha = 1 - p;

    ctx.save();
    ctx.translate(this.x, this.y);

    // 外圈冲击环：扩到波及半径**略外**，宣示杀伤范围。末半径接 POWERUP 的常量
    // 而不是写死 70——原先硬编码，把 blastRadius 从 60 调小之后环会画到实际
    // 杀伤圈之外，演出与判定不一致（而演出恰恰是玩家判断站位唯一的依据）
    const ringEnd = POWERUP.mine.blastRadius + 10;
    ctx.globalAlpha = alpha * 0.9;
    ctx.strokeStyle = "#2f2f33";
    ctx.lineWidth = 4 * (1 - p * 0.6);
    ctx.beginPath();
    ctx.arc(0, 0, 12 + p * (ringEnd - 12), 0, Math.PI * 2);
    ctx.stroke();

    // 内圈红色残光（与警戒灯同色，视觉连贯）
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = THEME.mineBlink;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, 6 + p * 40, 0, Math.PI * 2);
    ctx.stroke();

    // 中心烟斑：小幅膨胀淡出
    ctx.globalAlpha = alpha * 0.7;
    ctx.fillStyle = "#2f2f33";
    ctx.beginPath();
    ctx.arc(0, 0, 8 + p * 14, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
    ctx.globalAlpha = 1;
  }
}

// ============================================================
// PickupFlash — 拾取道具时的一圈快速扩散彩环（~0.3s）
// 轻量提示「这里捡到了东西」，颜色按道具类型取（散射橙 / 护盾青）。
// ============================================================
export class PickupFlash {
  // x, y: 拾取位置；type: 道具类型（决定环色，未登记类型走散射橙兜底）
  constructor(x, y, type) {
    this.x = x;
    this.y = y;
    // 复用 powerup.js 那份唯一色表，不抄第二份——抄一份的代价是新增道具类型时
    // 「登记一行即可」变成「登记两处，漏一处就两个地方不同色」
    const colors = TYPE_BG;
    this.color = colors[type] || THEME.powScatterBg;
    this.age = 0;
    this.duration = 0.3;
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    // 环半径从坦克尺寸快速扩到 ~2.5 倍，同时淡出
    const r = TANK.radius * (0.8 + p * 1.7);
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = 1 - p;
    ctx.strokeStyle = this.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ============================================================
// ShieldBreak — 护盾挡下一发时的破碎特效（~0.4s）
// 一圈炸开的光环 + 几片向外飞的弧形碎光，告诉玩家「盾碎了，这下没保护了」。
// ============================================================
export class ShieldBreak {
  // x, y: 坦克位置；color: 护盾环色（与 tank 上的护盾环同色，视觉连贯）
  constructor(x, y, color) {
    this.x = x;
    this.y = y;
    this.color = color;
    this.age = 0;
    this.duration = 0.4;
    // 几片碎光：均匀分布的弧段，向外飞 + 淡出
    this.shards = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      this.shards.push({ a, speed: 70 + Math.random() * 50 });
    }
  }

  get done() {
    return this.age >= this.duration;
  }

  update(dt) {
    this.age += dt;
  }

  render(ctx) {
    if (this.done) return;
    const p = this.age / this.duration;
    const alpha = 1 - p;

    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = this.color;

    // —— 1) 炸开的光环：半径快速扩张 ——
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, (TANK.radius + 6) * (1 + p * 0.8), 0, Math.PI * 2);
    ctx.stroke();

    // —— 2) 碎光：每片是一小段弧，沿各自方向向外飞 ——
    ctx.lineWidth = 2;
    const baseR = TANK.radius + 6;
    for (const s of this.shards) {
      const dist = baseR + s.speed * this.age;
      const cx = Math.cos(s.a) * dist;
      const cy = Math.sin(s.a) * dist;
      ctx.beginPath();
      ctx.arc(cx, cy, 3.5, s.a - 0.6, s.a + 0.6);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }
}
