import { Tank } from '../tank.js';
import { Bullet } from '../bullet.js';
import { Powerup } from '../powerup.js';
import { Mine } from '../mine.js';
import { TANK_COLLISION } from '../config.js';

// 只还原绘图对象。这里不调用物理 step、选手脚本或成绩存储。
export class MatchReplay {
  constructor(record) {
    this.record = record;
    this.states = record.states;
    this.totalTicks = this.states[this.states.length - 1].tick;
    this.position = 0;
    this.playing = false;
    this.speed = 1;
    this.index = -1;
    this.wallVersion = -1;
    this.world = {
      maze: { ...record.initialState.map, walls: [] }, actors: [], bullets: [], powerups: [], mines: [], events: [], tick: 0,
      tankRenderScale: record.physics.tankCollision.bodyLength / TANK_COLLISION.bodyLength,
      tankRadius: record.physics.tankRadius,
      get alive() { return this.actors.filter(p => p.tank.alive); },
    };
    this.seek(0);
  }

  get time() { return this.position / this.record.physicsHz; }

  seek(tick) {
    this.position = Math.max(0, Math.min(this.totalTicks, tick));
    let lo = 0, hi = this.states.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.states[mid].tick <= this.position) lo = mid + 1;
      else hi = mid;
    }
    const index = Math.max(0, lo - 1);
    if (this.index === index) return;
    this.index = index;
    const state = this.states[index], world = this.world;
    if (this.wallVersion !== state.wallVersion) {
      const walls = new Map(this.record.initialState.map.walls.map(w => [w.id, { ...w }]));
      for (const change of this.record.wallChanges) {
        if (change.version > state.wallVersion) break;
        change.removed.forEach(id => walls.delete(id));
        change.updated.forEach(w => { walls.get(w.id).hp = w.hp; });
      }
      world.maze.walls = [...walls.values()];
      this.wallVersion = state.wallVersion;
    }
    world.tick = state.tick;
    world.actors = state.tanks.map(t => ({
      id: t.id, name: t.name, color: t.color,
      tank: Object.assign(new Tank(t.x, t.y, t.angle, t.color), {
        alive: t.alive, cooldown: t.cooldown, deployCooldown: t.deployCooldown,
        scatterShots: t.scatterShots, laserShots: t.laserShots, mineCharges: t.mineCharges,
        mineHoldTimer: t.mineHoldTimer, shield: t.shield, shieldTimer: t.shieldTimer,
      }),
      vx: t.vx, vy: t.vy, forfeit: t.forfeit, action: t.action,
    }));
    const owners = new Map(world.actors.map(p => [p.id, p.tank]));
    world.bullets = state.bullets.map(b => Object.assign(new Bullet(b.x, b.y, b.vx, b.vy, owners.get(b.ownerId)), {
      arenaId: b.id, age: b.age, bounces: b.bounces, kind: b.kind, color: b.color, trail: b.trail,
    }));
    world.powerups = state.powerups.map(p => Object.assign(new Powerup(p.x, p.y, p.type), { age: p.age }));
    world.mines = state.mines.map(m => Object.assign(new Mine(m.x, m.y, owners.get(m.ownerId)), { age: m.age, exploded: m.exploded }));
  }

  advance(seconds) {
    if (!this.playing) return;
    this.seek(this.position + seconds * this.speed * this.record.physicsHz);
    if (this.position >= this.totalTicks) this.playing = false;
  }

  eventsBefore(tick) {
    const events = this.record.events;
    let lo = 0, hi = events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (events[mid].tick <= tick) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  recentEvents(seconds = 1) {
    return this.record.events.slice(this.eventsBefore(this.position - seconds * this.record.physicsHz), this.eventsBefore(this.position));
  }
}
