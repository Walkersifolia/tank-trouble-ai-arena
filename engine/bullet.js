// ============================================================
// bullet.js — 子弹实体
// 职责：沿速度向量直线运动；撞墙反射（v' = v - 2(v·n)n）并推出墙外，
// 防止嵌进墙里反复反射抖动；反弹次数 / 存活时间超限即标记消亡。
// 击中判定放 main（需要和所有坦克交叉），这里只暴露 owner / age 供其判定。
// ============================================================

import { BULLET, THEME } from "./config.js";
import { reflect, circleVsSegment } from "./collision.js";

export class Bullet {
  // x,y: 出膛位置；vx,vy: 速度向量（像素/秒，已含方向与大小）
  // owner: 发射它的坦克（用于自伤宽限期，避免刚出炮口就打死自己）
  constructor(x, y, vx, vy, owner) {
    this.x = x;
    this.y = y;
    this.vx = vx;
    this.vy = vy;
    this.owner = owner;
    this.color = owner ? owner.color : "#ffffff";
    this.bounces = 0;
    this.age = 0;        // 已存活秒数
    this.dead = false;   // true 时 main 会从数组移除
    this.trail = [];     // 最近几帧的位置（拖尾渲染用，反弹处自然拐弯）
    // 每次反弹削多少点墙耐久。默认 1 = 阶段 18 的原行为；
    // 波次生存的「破障弹头」强化由 tank.spawnBullet 按 mods.erode 写高。
    this.erodePower = 1;
  }

  // dt: 距上一帧秒数；walls: 墙线段数组；
  // erode: 撞击内墙时削其耐久（wall.hp--，阶段 18 子弹磨墙）——只削血不删墙，
  //   归零墙的删除由 main 帧末统一做（遍历中改字段安全、删元素危险）
  update(dt, walls, erode = false, onBounce = null) {
    if (this.dead) return;

    this.age += dt;
    if (this.age >= BULLET.lifetime) {
      this.dead = true;
      return;
    }

    // 拖尾采样：记录移动前的位置（撞墙修正后的最终位置由下一帧记录）
    // 每帧一个采样点，与子步数无关——拖尾是表现层，60fps 下逐字节不变
    this.trail.push({ x: this.x, y: this.y });
    if (this.trail.length > 6) this.trail.shift();

    // 隧道效应防护：碰撞是「先移动再采样」的离散检测，一帧位移超过弹径
    // (2×radius=6px) 时存在「上一帧在墙内侧、这一帧已在墙外侧、中间从未与
    // 墙重叠」的相位——子弹直接穿墙飞出场外，还占着 maxAlive 槽位到寿命尽
    // (10s)，症状是「开火键偶尔按不出子弹」。main 的 dt 钳位上界 0.05s(20fps)
    // 对应 9px > 6px，所以钳位本身防不住它、反而是触发源。
    // 修法是把整段位移拆成 ≤maxSubStep 的子步，各自独立解算碰撞——
    // 位移总量与反弹时序都保持不变（不是把 dt 截短让子弹变慢）。
    //
    // maxSubStep 必须 ≤ radius，不能取 radius*1.5：子步大于弹径半时，子弹能
    // 一步跨到墙的【背面】再被采到，此时 circleVsSegment 的法线指向背面一侧，
    // 推出方向朝墙外更深、反弹后下一子步又撞回来——二次反弹把速度转回原方向，
    // 净效果是「撞墙不减速直接穿过去」，比原 bug 更难看。取 radius 时
    // 「上一子步距墙 >radius（未采到）」蕴含「本子步后距墙 >0（仍在正面）」，
    // 于是撞击总在正面被采到，法线方向恒定正确。
    // 60fps 下 speed*dt 恰好 = 3px = radius ⇒ ceil(3/3)=1 仍是单步（斜向同理，
    // hypot 仍为 speed），故正常帧零额外开销、arena 固定 dt=1/60 跑分逐字节不变。
    const speed = Math.hypot(this.vx, this.vy);
    const maxSubStep = BULLET.radius;
    const steps = Math.max(1, Math.ceil((speed * dt) / maxSubStep));
    const sub = dt / steps;
    for (let s = 0; s < steps; s++) {
      this.stepMove(sub, walls, erode, onBounce);
      if (this.dead) return;
    }
  }

  // 单个子步：移动 + 逐墙反弹解算。由 update 调用，不对外。
  stepMove(dt, walls, erode, onBounce = null) {
    // 沿速度移动
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // 撞墙：可能同一帧贴着多面墙（角落），逐墙解算
    if (walls && walls.length) {
      for (const w of walls) {
        const hit = circleVsSegment(
          this.x, this.y, BULLET.radius,
          w.x1, w.y1, w.x2, w.y2
        );
        if (hit) {
          const previousVx = this.vx, previousVy = this.vy;
          // 1) 先推出墙面，避免嵌进墙里下一帧继续反射
          this.x += hit.nx * hit.depth;
          this.y += hit.ny * hit.depth;
          // 2) 沿墙法线反射速度
          const r = reflect(this.vx, this.vy, hit.nx, hit.ny);
          this.vx = r.vx;
          this.vy = r.vy;
          // 3) 磨墙：内墙被撞掉 erodePower 点耐久（外墙无 hp 字段天然免疫）
          if (erode && !w.border && w.hp !== undefined) w.hp -= this.erodePower;
          // 4) 计反弹次数，超限消亡
          this.bounces++;
          // 仅供竞技场赛后记录；回调不参与轨迹或碰撞判定。
          if (onBounce) onBounce(this, w, previousVx, previousVy);
          if (this.bounces > BULLET.maxBounces) {
            this.dead = true;
            return;
          }
        }
      }
    }
  }

  // 击中判定时调用：该子弹此刻是否可以伤害 tank
  // 出膛宽限只保护"尚未反弹"的子弹（防止刚出炮口就打死自己）；
  // 一旦撞墙反弹就立刻解除豁免——贴墙开炮弹回来打死自己是原版的
  // 经典自杀手感，不能被宽限期豁免掉。
  // 唯一的例外是波次生存的「跳弹免疫」强化（owner.mods.selfSafe）：那是玩家
  // 花一次抽卡换掉这条规则，属于 roguelite 的规则改写，不是默认行为。
  canHit(tank) {
    if (tank === this.owner) {
      if (tank.mods?.selfSafe) return false;
      if (this.bounces === 0 && this.age < BULLET.selfHitGrace) return false;
    }
    return true;
  }

  render(ctx) {
    if (this.dead) return;

    // 拖尾：几个渐隐渐小的灰点垫在弹体后面，浅色场地上似淡淡的烟迹。
    // 反弹瞬间历史点在墙角自然拐弯，跳弹轨迹一眼可读。
    for (let i = 0; i < this.trail.length; i++) {
      const t = this.trail[i];
      const f = (i + 1) / (this.trail.length + 1); // 越新（越靠近弹体）越实
      ctx.globalAlpha = 0.14 * f;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BULLET.radius * (0.4 + 0.5 * f), 0, Math.PI * 2);
      ctx.fillStyle = THEME.bullet;
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // 原版风格：朴素的实心黑色小圆点，无描边、无发光（贴合截图）。
    // 不区分归属——原版子弹本就是不分颜色的黑点，满屏跳弹谁的都一样致命。
    ctx.beginPath();
    ctx.arc(this.x, this.y, BULLET.radius, 0, Math.PI * 2);
    ctx.fillStyle = THEME.bullet;
    ctx.fill();
  }
}
