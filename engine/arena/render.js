import { CELL_SIZE, WALL, THEME } from '../config.js';
import { renderLaserPreview, LaserBeam } from '../laser.js';
import { TankExplosion, MuzzleFlash, ShieldBreak, PickupFlash, MineBlast } from '../effects.js';
import { TankDisplayPoses } from '../tank-pose.js';
function effectFor(e) {
  if (e.type === 'death') return new TankExplosion(e.x, e.y, e.color);
  if (e.type === 'fire') return new MuzzleFlash(e.x, e.y, e.angle);
  if (e.type === 'shield') return new ShieldBreak(e.x, e.y, e.color);
  if (e.type === 'pickup') return new PickupFlash(e.x, e.y, e.powerup);
  if (e.type === 'mine') return new MineBlast(e.x, e.y);
  if (e.type === 'laser') return new LaserBeam(e.points);
}
export class ArenaRenderer {
  constructor(canvas, { maxDpr = Infinity } = {}) { this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.effects = []; this.world = null; this.maxDpr = maxDpr; this.tankPoses = new TankDisplayPoses(); }
  consume(world, headless) {
    if (world !== this.world) { this.world = world; this.effects = []; this.tankPoses.reset(); }
    if (headless) { this.effects = []; this.tankPoses.reset(); return; }
    for (const e of world.events) {
      const effect = effectFor(e);
      if (effect) this.effects.push(effect);
    }
  }
  recordedEffects(world, events, time) {
    const reset = this.world !== world || time < this.replayTime;
    if (reset) this.replayEffects = new Map();
    const previous = this.replayEffects || new Map(), next = new Map();
    for (const e of events) {
      const existing = previous.get(e.seq), effect = existing || effectFor(e);
      if (!effect) continue;
      effect.update(Math.max(0, time - (existing ? this.replayTime : e.time)));
      if (!effect.done) next.set(e.seq, effect);
    }
    this.world = world;
    this.replayTime = time;
    this.replayEffects = next;
    this.effects = [...next.values()];
  }
  draw(world, elapsed, paused, renderDt = elapsed) {
    const { canvas, ctx } = this;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.maxDpr);
    const width = Math.round(rect.width * dpr), height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!world) return;
    if (world !== this.world) { this.world = world; this.effects = []; this.tankPoses.reset(); }
    const w = world.maze.cols * CELL_SIZE, h = world.maze.rows * CELL_SIZE;
    const scale = Math.min((rect.width - 40) / w, (rect.height - 56) / h);
    ctx.save();
    ctx.translate((rect.width - w * scale) / 2, (rect.height - h * scale) / 2);
    ctx.scale(scale, scale);
    ctx.fillStyle = THEME.arenaBg;
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = WALL.color;
    ctx.lineWidth = WALL.thickness;
    ctx.lineCap = 'round';
    for (const wall of world.maze.walls) {
      ctx.globalAlpha = wall.border ? 1 : 0.35 + 0.65 * Math.max(0, wall.hp) / WALL.hp;
      ctx.beginPath(); ctx.moveTo(wall.x1, wall.y1); ctx.lineTo(wall.x2, wall.y2); ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = THEME.arenaBorder;
    ctx.lineWidth = WALL.borderThickness;
    ctx.strokeRect(0, 0, w, h);
    world.powerups.forEach(p => p.render(ctx));
    world.mines.forEach(m => m.render(ctx));
    world.alive.forEach(p => { if (p.tank.laserShots > 0) renderLaserPreview(ctx, p.tank, world.maze.walls); });
    world.bullets.forEach(b => b.render(ctx));
    // 只有精灵/姓名跟随显示 pose；预瞄、命中与观察仍读取真实 Tank。
    const drawPoses = new Map();
    world.actors.forEach(p => {
      const pose = this.tankPoses.get(p.tank, renderDt, paused);
      drawPoses.set(p.tank, pose);
      p.tank.render(ctx, pose);
    });
    for (const p of world.alive) {
      ctx.font = 'bold 14px "Microsoft YaHei", sans-serif';
      ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#eeeeef'; ctx.fillStyle = '#222735';
      const pose = drawPoses.get(p.tank);
      const labelY = Math.max(16, pose.y - 29);
      ctx.strokeText(p.name, pose.x, labelY); ctx.fillText(p.name, pose.x, labelY);
    }
    if (!paused) this.effects.forEach(e => e.update(elapsed));
    this.effects = this.effects.filter(e => !e.done);
    this.effects.forEach(e => e.render(ctx));
    ctx.restore();
  }
}
