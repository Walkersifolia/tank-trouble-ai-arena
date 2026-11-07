// ============================================================
// tank.js — 坦克实体
// 职责：维护位置/朝向，按「控制指令」移动转向，渲染自身。
// 不直接读键盘：每帧由外部传入 { turn, move, fire }（人类来自
// input.readControls，AI 来自 ai.js），坦克只消费指令不关心来源。
// ============================================================

import { TANK, BULLET, POWERUP, THEME } from "./config.js";
import { resolveCircleWalls, segmentVsSegmentParam, circleCastSegmentDistance } from "./collision.js?v=wall-shot-1";
import { Bullet } from "./bullet.js";
import { Mine } from "./mine.js";
import { neutralMods } from "./upgrades.js";
import { moveTank } from "./tank-motion.js";

export class Tank {
  // x, y: 车体中心世界坐标（像素）
  // angle: 朝向弧度，0 指向右(+x)，顺时针为正
  // color: 车体颜色
  constructor(x, y, angle, color) {
    this.x = x;
    this.y = y;
    this.angle = angle;
    this.color = color;
    this.alive = true;
    this.cooldown = 0;
    this.deployCooldown = 0;  // 道具键部署冷却（防一帧重复触发，与开火冷却无关）

    // —— 道具状态（捡到道具时由 applyPowerup 设置；无道具时全为初值）——
    // scatter/laser/mine 同属「武器改装槽」互斥（异类拾取清旧换新，同类叠加），
    // shield 独立并存——见 applyPowerup。
    this.scatterShots = 0;   // 剩余「扇形开火」次数，>0 时 tryFire 打扇形并递减
    this.laserShots = 0;     // 剩余激光发数，>0 时开火变瞬时射线（结算在 main）
    this.mineCharges = 0;    // 剩余布雷次数，>0 时道具键在车尾放雷
    this.mineHoldTimer = 0;  // 持雷超时计时（秒）：归零清空存货，部署/拾取时刷新
    this.shield = false;     // 是否持有护盾（挡一次致命伤害）
    this.shieldTimer = 0;    // 护盾剩余时间（秒），到点自动消失防一直龟

    // —— 实例数值倍率（阶段 25 波次生存的强化/词条挂点）——
    // 中性初值 = 原常量行为，所以 pvp/pve/challenge 三个模式一个字不用改。
    // 只有 wave 模式会往这里写（玩家侧 upgrades.applyUpgrade、敌人侧 waves.applyElite）。
    this.mods = neutralMods();
  }

  // dt: 距上一帧的秒数；walls: 墙线段数组，用于撞墙不穿
  // controls: 本帧连续指令 { turn: [-1,1], move: [-1,1] }（fire 走 tryFire）
  // 多车世界先更新计时，再统一 TankMotion.step，避免逐车推进同一个物理世界。
  update(dt, walls, controls, deferMotion = false) {
    if (!this.alive) return;

    // 开炮冷却递减
    if (this.cooldown > 0) this.cooldown -= dt;
    // 部署冷却递减
    if (this.deployCooldown > 0) this.deployCooldown -= dt;

    // 持雷超时：拾取后一直不部署，存货作废（防捏着雷白占武器槽不消耗）。
    // 每次成功部署会刷新计时——积极在用就不没收。
    if (this.mineCharges > 0) {
      this.mineHoldTimer -= dt;
      if (this.mineHoldTimer <= 0) this.mineCharges = 0;
    }

    // 护盾限时流逝：到点自动消失（防止捡到盾就一直龟着不出来打）。
    // 「挡一次伤害」的消耗在 main 的击中判定里做，两条触发先到先算。
    if (this.shield) {
      this.shieldTimer -= dt;
      if (this.shieldTimer <= 0) {
        this.shield = false;
        this.shieldTimer = 0;
      }
    }

    if (!deferMotion) moveTank(this, dt, walls, controls);
  }

  // 尝试开炮：wantFire 为 true + 冷却就绪 + 同屏己方子弹未达上限时，
  // 从炮口开火。返回「开火结果」对象 { bullets, laser }：
  //   普通单发 bullets=[b]、散射多发、不开火/被限流 bullets=[]；
  //   持激光时 bullets=[]、laser={x,y,angle}（出膛点+方向的发射意图）——
  //   激光是瞬时射线没有实体弹，路径投射与命中结算在 main（需要墙和全体坦克）。
  // wantFire 即控制指令的 fire 位（人类是边沿触发，AI 自带开火节奏）。
  // bullets: 全局子弹数组，用于统计自己还有几发在场（实现 maxAlive 限流）——
  // 这是原版"靠子弹上限而非冷却限流"的核心，去掉固定冷却后尤其关键。
  //   散射/激光绕开 maxAlive：散射是一次性集中火力，受限流扇形就废了；
  //   激光不产生实体弹，与在场子弹数无关。普通单发仍严格受限流。
  // walls: 墙线段数组，用于贴墙出膛修正（防穿墙）。
  tryFire(bullets, wantFire, walls) {
    const NO_FIRE = { bullets: [], laser: null };
    if (!this.alive) return NO_FIRE;
    if (this.cooldown > 0) return NO_FIRE;
    if (!wantFire) return NO_FIRE;

    const scattering = this.scatterShots > 0;

    // 同屏己方存活子弹数达上限则不发射（散射/激光绕开：见上方注释）
    if (!scattering && this.laserShots === 0 && bullets) {
      let mine = 0;
      for (const b of bullets) {
        if (b.owner === this && !b.dead) mine++;
      }
      if (mine >= BULLET.maxAlive + (this.mods?.maxAlive ?? 0)) return NO_FIRE;
    }

    this.cooldown = BULLET.cooldown;

    if (scattering) {
      this.scatterShots--; // 消耗一次扇形开火机会，归零自动恢复单发
      // 扇形：以朝向为中线，pellets 发按 spreadAngle 均匀铺开（奇数有正中那发）
      const { pellets, spreadAngle } = POWERUP.scatter;
      const out = [];
      const mid = (pellets - 1) / 2;
      for (let i = 0; i < pellets; i++) {
        out.push(this.spawnBullet(this.angle + (i - mid) * spreadAngle, walls, "scatter"));
      }
      return { bullets: out, laser: null };
    }

    // 激光：消耗一发，返回发射意图；打完存货自动恢复普通弹
    // 激光出膛点沿中心线做贴墙修正；普通弹另按弹体半径扫掠截断。
    if (this.laserShots > 0) {
      this.laserShots--;
      return { bullets: [], laser: this.muzzlePoint(walls) };
    }

    return { bullets: [this.spawnBullet(this.angle, walls)], laser: null };
  }

  // 部署道具（special 键，独立于开火）：持雷时在车尾放一颗雷。
  // 开火键=射击、道具键=部署，两者各有冷却互不影响——持雷也能照常开炮。
  // 部署不产生子弹、不受 maxAlive 限流；deployCooldown 只防一帧内重复触发，
  // 玩家有意快速连按仍可短间隔连丢（快速布阵是合法玩法）。
  // 返回 Mine 或 null，由 main 收进 mines[]。
  tryDeploy(wantSpecial, walls) {
    if (!this.alive) return null;
    if (!wantSpecial) return null;
    if (this.deployCooldown > 0) return null;
    if (this.mineCharges <= 0) return null;

    this.deployCooldown = 0.25;
    this.mineCharges--;
    this.mineHoldTimer = POWERUP.mine.holdTimeout; // 部署刷新持雷计时
    // 落点沿车尾方向探出，贴墙时 resolveCircleWalls 修回可用位置
    const backDist = TANK.radius + POWERUP.mine.discRadius + 4;
    let mx = this.x - Math.cos(this.angle) * backDist;
    let my = this.y - Math.sin(this.angle) * backDist;
    if (walls && walls.length) {
      const fixed = resolveCircleWalls(mx, my, POWERUP.mine.discRadius, walls);
      mx = fixed.x;
      my = fixed.y;
    }
    return new Mine(mx, my, this);
  }

  // 炮口出膛点（激光发射/预瞄虚线/AI 开火门共用）。
  // angle 一并给出方便直接作发射意图。
  // walls: 给了就做贴墙修正——炮口(36px)比车体碰撞半径(16px)伸出 20px，
  //   贴墙时炮口已越到墙另一侧，从那里投射激光会从墙背面出膛 = 隔墙杀。
  //   此处保留激光的中心线钳位；spawnBullet 另按弹体半径处理墙身与端点。
  //   钳位后贴墙开激光会撞墙反弹回来
  //   打死自己，与子弹「贴脸怼墙开炮会弹回来」的既有手感一致。
  //   省略 walls 时行为与钳位前逐字节相同（旧调用点语义不变）。
  // 注意：钳位后出膛点可能落在自己车体圆内，故 main/arena 的 fireLaser
  //   必须在首段跳过射手自己（反弹段照旧可自杀）。
  muzzlePoint(walls) {
    const d = TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2;
    let dist = d;
    if (walls && walls.length) {
      const mx = this.x + Math.cos(this.angle) * d;
      const my = this.y + Math.sin(this.angle) * d;
      for (const w of walls) {
        const t = segmentVsSegmentParam(this.x, this.y, mx, my, w.x1, w.y1, w.x2, w.y2);
        if (t !== null) dist = Math.min(dist, t * d - BULLET.radius - 1);
      }
    }
    return {
      x: this.x + Math.cos(this.angle) * dist,
      y: this.y + Math.sin(this.angle) * dist,
      angle: this.angle,
    };
  }

  // 沿给定 heading 生成一发子弹，含贴墙出膛修正（防穿墙）。
  // 抽出来供单发 / 散射多发共用：每发各按自己的角度独立修正出膛点。
  // kind 标记弹种（"bullet"/"scatter"）——统计击杀归类、AI 弹药预算区分用。
  spawnBullet(heading, walls, kind = "bullet") {
    // 炮口位置：从车体中心沿朝向伸出（炮管末端再多探出一点，避免子弹生成在车体内被自己挡）
    const muzzleDist = TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2;

    // 按弹体半径扫过“车心→炮口”，不能只判炮口中心是否跨过墙线。
    // 出生圆必须留在首次接触前；否则首步可能跨墙，再被反向推出到墙背面。
    const dx = Math.cos(heading), dy = Math.sin(heading);
    let spawnDist = muzzleDist;
    if (walls && walls.length) {
      for (const w of walls) {
        const distance = circleCastSegmentDistance(this.x, this.y, dx, dy,
          BULLET.radius, w.x1, w.y1, w.x2, w.y2);
        if (distance <= muzzleDist) spawnDist = Math.min(spawnDist, distance - 1);
      }
    }

    const bx = this.x + dx * spawnDist;
    const by = this.y + dy * spawnDist;
    const vx = dx * BULLET.speed;
    const vy = dy * BULLET.speed;
    const b = new Bullet(bx, by, vx, vy, this);
    b.kind = kind;
    b.erodePower = 1 + (this.mods?.erode ?? 0); // 破障弹头：每次反弹多削几点墙
    return b;
  }

  // 拾取道具：按类型设置对应状态。
  // 武器改装槽（scatter/laser/mine）互斥：拾取异类先清空旧存货再赋新，
  // 同类拾取叠加次数；shield 独立并存（刷新一层 + 重置计时）。
  // 互斥让 tryFire 的分支优先级永远无歧义，玩家/AI 心智模型也简单。
  // mods.*Bonus 是波次生存的「扩容」强化（中性 0）：只加**拾取时的给予量**，
  // 不改互斥规则，也不给凭空的存货——必须真的捡到那件道具才生效。
  applyPowerup(type) {
    const m = this.mods;
    if (type === "scatter") {
      this.laserShots = 0;
      this.mineCharges = 0;
      this.scatterShots += POWERUP.scatter.shots + (m?.scatterBonus ?? 0);
    } else if (type === "laser") {
      this.scatterShots = 0;
      this.mineCharges = 0;
      this.laserShots += POWERUP.laser.shots + (m?.laserBonus ?? 0);
    } else if (type === "mine") {
      this.scatterShots = 0;
      this.laserShots = 0;
      this.mineCharges += POWERUP.mine.charges + (m?.mineBonus ?? 0);
      this.mineHoldTimer = POWERUP.mine.holdTimeout; // 拾取起算持雷超时
    } else if (type === "shield") {
      this.shield = true;
      this.shieldTimer = POWERUP.shield.duration + (m?.shieldBonus ?? 0);
    }
  }

  // pose 只供绘制；碰撞、命中和 AI 始终读取真实 x/y/angle。
  render(ctx, pose = this) {
    if (!this.alive) return;

    ctx.save();
    ctx.translate(pose.x, pose.y);
    ctx.rotate(pose.angle);

    const {
      bodyLength, bodyWidth,
      treadLength, treadWidth, treadInset,
      turretRadius,
      barrelLength, barrelWidth,
    } = TANK;

    // 履带颜色：统一深色，不随玩家色变（原版风格）
    const treadColor = "#3a3a4a";
    const treadEdge = "rgba(0,0,0,0.5)";

    // —— 1) 上下两条履带（最底层，深色横条，比车体略长两端探出）——
    // 履带在垂直方向(y)位于车体两侧外缘
    const treadY = bodyWidth / 2 - treadInset; // 履带内缘贴着车体外缘
    for (const sign of [-1, 1]) {
      const y = sign * treadY;
      ctx.fillStyle = treadColor;
      ctx.fillRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
      // 履带描边
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = treadEdge;
      ctx.strokeRect(-treadLength / 2, y - (sign < 0 ? treadWidth : 0), treadLength, treadWidth);
      // 履带上的横向纹路（齿），增强"履带"质感
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      const topY = y - (sign < 0 ? treadWidth : 0);
      const segs = 6;
      for (let i = 1; i < segs; i++) {
        const sx = -treadLength / 2 + (treadLength * i) / segs;
        ctx.beginPath();
        ctx.moveTo(sx, topY);
        ctx.lineTo(sx, topY + treadWidth);
        ctx.stroke();
      }
    }

    // —— 2) 车体（中间彩色方块）——
    ctx.fillStyle = this.color;
    ctx.fillRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.35)";
    ctx.strokeRect(-bodyLength / 2, -bodyWidth / 2, bodyLength, bodyWidth);

    // —— 3) 炮管（从中心向前(+x)伸出的圆头管，先画，让炮塔盖住根部）——
    ctx.strokeStyle = "#2b2b3a";
    ctx.lineWidth = barrelWidth;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(turretRadius + barrelLength, 0);
    ctx.stroke();

    // —— 4) 炮塔（中央圆盘，同色系略深，盖住炮管根部）——
    ctx.fillStyle = this.darkColor();
    ctx.beginPath();
    ctx.arc(0, 0, turretRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.stroke();

    ctx.restore();

    // —— 护盾环（持有护盾时，套在车体外的旋转虚线光环）——
    // 单独一段：只平移不旋转，让光环动画与车头朝向解耦（环跟着车走但自转）。
    // 旋转用 lineDashOffset 随 shieldTimer 推进；快到期时闪烁提示即将消失，
    // 阈值与 HUD 徽章共读 POWERUP.shield.blinkUnder（原先两处各硬编码 1.5）。
    if (this.shield) {
      const blink = this.shieldTimer < POWERUP.shield.blinkUnder
        ? 0.4 + 0.4 * Math.abs(Math.sin(this.shieldTimer * 8)) : 0.8;
      ctx.save();
      ctx.translate(pose.x, pose.y);
      ctx.globalAlpha = blink;
      ctx.strokeStyle = THEME.shieldRing;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([6, 5]);
      ctx.lineDashOffset = -this.shieldTimer * 18; // 负值 → 顺时针流动
      ctx.beginPath();
      ctx.arc(0, 0, TANK.radius + 6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);       // 复位虚线，别污染后续绘制
      ctx.globalAlpha = 1;
      ctx.restore();
    }
  }

  // 把车体色压暗，作为炮塔颜色（让炮塔与车体同色系但有层次）
  darkColor() {
    const c = this.color.replace("#", "");
    const r = Math.round(parseInt(c.slice(0, 2), 16) * 0.7);
    const g = Math.round(parseInt(c.slice(2, 4), 16) * 0.7);
    const b = Math.round(parseInt(c.slice(4, 6), 16) * 0.7);
    return `rgb(${r}, ${g}, ${b})`;
  }
}
