// 基于上游 scripts/arena.mjs 的逐 Tick 结算，实体、碰撞与地图仍使用原引擎。
import { generateMaze, destroyWallsInRadius, destroyWallSegments } from '../maze.js';
import { Tank } from '../tank.js?v=wall-shot-1';
import { PowerupSpawner } from '../powerup.js';
import { castLaserPath } from '../laser.js';
import { circleVsCircle, closestPointOnSegment } from '../collision.js';
import { TankMotion } from '../tank-motion.js';
import { createRng, deriveSeed } from '../rng.js';
import { CELL_SIZE, TANK, BULLET, POWERUP, MAZE_TIERS } from '../config.js';

export const DT = 1 / 60;
const pick = (list, rng) => list[Math.floor(rng() * list.length)];
function shuffled(list, rng) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export class ArenaWorld {
  constructor(entrants, options) {
    this.options = options;
    // 主种子只抽一次，其余随机行为均使用各自的独立流。
    this.seed = options.seed === undefined ? Math.floor(Math.random() * 0x100000000) : options.seed >>> 0;
    this.seeds = {
      mapSeed: deriveSeed(this.seed, 'map'), spawnSeed: deriveSeed(this.seed, 'spawn'),
      orderSeed: deriveSeed(this.seed, 'order'), powerupSeed: deriveSeed(this.seed, 'powerup'),
    };
    const mapRng = createRng(this.seeds.mapSeed);
    const spawnRng = createRng(this.seeds.spawnSeed);
    const orderRng = createRng(this.seeds.orderSeed);
    const powerupRng = createRng(this.seeds.powerupSeed);
    // 小场地至少 9×7 格；更多选手仍沿用随人数平方根增长的地图尺寸。
    const scale = Math.sqrt(entrants.length / 2);
    const cols = Math.max(MAZE_TIERS.medium.cols, Math.ceil(MAZE_TIERS.small.cols * scale));
    const rows = Math.max(MAZE_TIERS.medium.rows, Math.ceil(MAZE_TIERS.small.rows * scale));
    this.style = options.mapStyle || pick(['sparse', 'symmetric', 'rooms'], mapRng);
    this.maze = generateMaze(cols, rows, this.style, mapRng);
    // 隔一格安排一个候选出生位；此地图尺寸下候选数足够容纳全部参赛者。
    // 每局随机栅格偏移、位置分配及内部结算次序，出生点间距至少两格。
    const spawnCells = [];
    const startColumn = Math.floor(spawnRng() * 2);
    const startRow = Math.floor(spawnRng() * 2);
    for (let r = startRow; r < rows; r += 2) {
      for (let c = startColumn; c < cols; c += 2) {
        spawnCells.push({ x: (c + 0.5) * CELL_SIZE, y: (r + 0.5) * CELL_SIZE });
      }
    }
    const spots = shuffled(spawnCells, spawnRng);
    this.actors = shuffled(entrants.map((p, i) => ({
      id: p.id, name: p.name, color: p.color,
      tank: new Tank(spots[i].x, spots[i].y, spawnRng() * Math.PI * 2, p.color),
      vx: 0, vy: 0, kills: 0,
    })), orderRng);
    this.motion = new TankMotion();
    this.tick = 0;
    this.bullets = [];
    this.powerups = [];
    this.mines = [];
    this.spawner = new PowerupSpawner(options.powerups ? [...POWERUP.types] : [], powerupRng);
    this.events = [];
    this.result = null;
    this.nextEntityId = 1;
    this.recordingEnabled = !!options.recording;
    this.recordEvents = [];
    this.lastStepDiagnostics = null;
    this.powerupIds = new WeakMap();
    this.nextPowerupId = 1;
    this.nextShotId = 1;
  }

  get alive() { return this.actors.filter(p => p.tank.alive); }

  botSeedFor(id) { return deriveSeed(this.seed, `bot:${id}`); }

  ownerId(tank) { return this.actors.find(p => p.tank === tank)?.id ?? null; }
  powerupId(powerup) {
    if (!this.powerupIds.has(powerup)) this.powerupIds.set(powerup, `p${this.nextPowerupId++}`);
    return this.powerupIds.get(powerup);
  }
  record(event) {
    if (!this.recordingEnabled) return;
    const tick = this.eventTick ?? this.tick;
    this.recordEvents.push({ ...event, tick, time: tick * DT });
  }
  emit(event) { this.events.push(event); this.record(event); }

  forfeit(id, fault) {
    const actor = this.actors.find(p => p.id === id);
    if (!actor.tank.alive) return;
    // 规则判负绕过护盾，不经过击杀结算，不给其他选手增加击杀。
    actor.tank.alive = false;
    actor.vx = 0; actor.vy = 0;
    actor.forfeit = fault;
    this.record({ type: 'forfeit', actorId: id, victimId: id, reason: fault.code,
      message: fault.message, elapsedMs: fault.elapsedMs, timeout: !!fault.timeout,
      outcome: 'loss', x: actor.tank.x, y: actor.tank.y });
  }

  kill(tank, owner, cause, impact = {}) {
    if (!tank.alive) return;
    const victim = this.actors.find(p => p.tank === tank);
    const killer = this.actors.find(p => p.tank === owner);
    const detail = { ownerId: killer?.id ?? null, victimId: victim.id, cause, weapon: cause,
      selfHit: killer === victim, ricochet: (impact.bounces || 0) > 0, ...impact };
    this.record({ type: 'hit', x: tank.x, y: tank.y, ...detail, outcome: tank.shield ? 'shield' : 'death' });
    if (tank.shield) {
      tank.shield = false;
      tank.shieldTimer = 0;
      this.emit({ type: 'shield', x: tank.x, y: tank.y, color: tank.color, ...detail });
      this.record({ type: 'powerup_used', actorId: victim.id, powerup: 'shield', reason: 'absorbed_hit' });
      return;
    }
    tank.alive = false;
    if (killer && killer !== victim) killer.kills++;
    this.emit({ type: 'death', x: tank.x, y: tank.y, color: tank.color, victim: victim.id,
      killer: killer?.id, ...detail, classification: killer === victim ? 'suicide' :
        !killer ? 'environment' : detail.ricochet ? 'ricochet_kill' : 'direct_kill' });
  }

  fireLaser(origin, shooter, shotId) {
    const points = castLaserPath(origin.x, origin.y, origin.angle, this.maze.walls);
    let hitId = null;
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i], b = points[i + 1];
      if (i > 0) this.record({ type: 'bounce', weapon: 'laser', ownerId: shooter.id,
        shotId, x: a.x, y: a.y, bounces: i });
      let hit = null;
      for (const p of this.alive) {
        if (i === 0 && p === shooter) continue;
        const cp = closestPointOnSegment(p.tank.x, p.tank.y, a.x, a.y, b.x, b.y);
        if (Math.hypot(p.tank.x - cp.x, p.tank.y - cp.y) > TANK.radius) continue;
        const distance = Math.hypot(cp.x - a.x, cp.y - a.y);
        if (!hit || distance < hit.distance) hit = { p, cp, distance };
      }
      if (hit) {
        hitId = hit.p.id;
        this.kill(hit.p.tank, shooter.tank, 'laser', { shotId, bounces: i,
          impactX: hit.cp.x, impactY: hit.cp.y });
        points.splice(i + 1, points.length, hit.cp);
        break;
      }
    }
    this.emit({ type: 'laser', points, ownerId: shooter.id, shotId, victimId: hitId });
  }

  step(actions) {
    if (this.result) return this.result;
    this.events = [];
    this.eventTick = this.tick + 1;
    this.lastStepDiagnostics = this.recordingEnabled ? { tick: this.tick + 1, players: {} } : null;
    const before = this.actors.map(p => ({ x: p.tank.x, y: p.tank.y }));
    for (const p of this.actors) {
      const shield = p.tank.shield, mineCharges = p.tank.mineCharges;
      p.tank.update(DT, this.maze.walls, actions[p.id], true);
      if (shield && !p.tank.shield) this.record({ type: 'powerup_expired', actorId: p.id, powerup: 'shield' });
      if (mineCharges > 0 && !p.tank.mineCharges) this.record({ type: 'powerup_expired', actorId: p.id, powerup: 'mine', charges: mineCharges });
    }
    this.motion.step(this.actors.map(p => p.tank), DT, this.maze.walls,
      this.actors.map(p => actions[p.id]));
    const tanks = this.alive.map(p => p.tank);
    this.actors.forEach((p, i) => {
      p.vx = (p.tank.x - before[i].x) / DT;
      p.vy = (p.tank.y - before[i].y) / DT;
    });
    const powerupCount = this.powerups.length;
    this.spawner.update(DT, this.maze, this.powerups, tanks, this.mines);
    if (this.recordingEnabled) for (const pw of this.powerups.slice(powerupCount)) {
      this.record({ type: 'powerup_spawn', powerupId: this.powerupId(pw), powerup: pw.type, x: pw.x, y: pw.y });
    }
    for (const p of this.alive) {
      for (const pw of this.powerups) {
        if (!pw.taken && circleVsCircle(p.tank.x, p.tank.y, TANK.radius, pw.x, pw.y, POWERUP.radius)) {
          p.tank.applyPowerup(pw.type);
          pw.taken = true;
          this.emit({ type: 'pickup', x: pw.x, y: pw.y, powerup: pw.type,
            actorId: p.id, powerupId: this.powerupId(pw) });
          break;
        }
      }
    }
    this.powerups = this.powerups.filter(p => !p.taken);
    for (const m of this.mines) {
      const wasArmed = m.armed;
      m.update(DT);
      if (!wasArmed && m.armed) this.record({ type: 'mine_armed', mineId: m.arenaId, ownerId: this.ownerId(m.owner), x: m.x, y: m.y });
      if (!m.armed || !this.alive.some(p => Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.triggerRadius)) continue;
      m.exploded = true;
      if (this.options.wallBreak) {
        const destroyed = destroyWallsInRadius(this.maze, m.x, m.y, POWERUP.mine.wallBlastRadius);
        if (destroyed.length) this.record({ type: 'wall_destroy', cause: 'mine', mineId: m.arenaId,
          ownerId: this.ownerId(m.owner), walls: destroyed.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })) });
      }
      for (const p of this.alive) {
        if (Math.hypot(p.tank.x - m.x, p.tank.y - m.y) < POWERUP.mine.blastRadius) this.kill(p.tank, m.owner, 'mine', { mineId: m.arenaId, bounces: 0 });
      }
      this.emit({ type: 'mine', x: m.x, y: m.y, mineId: m.arenaId, ownerId: this.ownerId(m.owner) });
    }
    this.mines = this.mines.filter(m => !m.exploded);
    // 同 Tick 决策先全部收集，再按上游顺序移动、射击、弹体命中。
    for (const p of this.actors) {
      const action = actions[p.id];
      const weapon = p.tank.scatterShots > 0 ? 'scatter' : p.tank.laserShots > 0 ? 'laser' : 'bullet';
      let diagnostic;
      if (this.recordingEnabled) {
        const reason = !p.tank.alive ? 'dead' : !action.fire ? 'not_requested' : p.tank.cooldown > 0 ? 'cooldown' :
          weapon === 'bullet' && this.bullets.filter(b => b.owner === p.tank && !b.dead).length >= BULLET.maxAlive + (p.tank.mods?.maxAlive ?? 0) ? 'bullet_limit' : null;
        diagnostic = this.lastStepDiagnostics.players[p.id] = {
          fire: { requested: !!action.fire, emitted: false, reason, weapon, cooldown: Math.max(0, p.tank.cooldown) },
        };
      }
      const shot = p.tank.tryFire(this.bullets, action.fire, this.maze.walls);
      const shotId = shot.bullets.length || shot.laser ? this.nextShotId++ : null;
      for (const b of shot.bullets) {
        b.arenaId = this.nextEntityId++; this.bullets.push(b);
        this.record({ type: 'projectile_spawn', projectileId: b.arenaId, shotId, ownerId: p.id,
          weapon: b.kind || 'bullet', x: b.x, y: b.y, vx: b.vx, vy: b.vy });
      }
      if (shot.bullets.length || shot.laser) {
        let wallDistance = null;
        if (this.recordingEnabled) {
          wallDistance = Math.min(...this.maze.walls.map(w => {
            const cp = closestPointOnSegment(p.tank.x, p.tank.y, w.x1, w.y1, w.x2, w.y2);
            return Math.hypot(cp.x - p.tank.x, cp.y - p.tank.y);
          }));
          diagnostic.fire.emitted = true;
          diagnostic.fire.reason = 'fired';
        }
        this.emit({ type: 'fire', ...p.tank.muzzlePoint(this.maze.walls), actorId: p.id, ownerId: p.id,
          shotId, weapon, projectileIds: shot.bullets.map(b => b.arenaId), wallDistance,
          nearWall: wallDistance !== null && wallDistance <= TANK.radius + BULLET.radius + 4 });
        if (weapon !== 'bullet') this.record({ type: 'powerup_used', actorId: p.id, powerup: weapon, shotId });
      }
      if (shot.laser) this.fireLaser(shot.laser, p, shotId);
      if (diagnostic) diagnostic.special = { requested: !!action.special, deployed: false,
        reason: !p.tank.alive ? 'dead' : !action.special ? 'not_requested' : p.tank.deployCooldown > 0 ? 'cooldown' : p.tank.mineCharges <= 0 ? 'no_mine' : null };
      const mine = p.tank.tryDeploy(action.special, this.maze.walls);
      if (mine) {
        mine.arenaId = this.nextEntityId++; this.mines.push(mine);
        if (diagnostic) { diagnostic.special.deployed = true; diagnostic.special.reason = 'deployed'; }
        this.record({ type: 'mine_deploy', mineId: mine.arenaId, actorId: p.id, ownerId: p.id, x: mine.x, y: mine.y });
        this.record({ type: 'powerup_used', actorId: p.id, powerup: 'mine', mineId: mine.arenaId });
      }
    }
    const onBounce = this.recordingEnabled ? (b, w, previousVx, previousVy) => {
      this.record({ type: 'bounce', weapon: b.kind || 'bullet', projectileId: b.arenaId, ownerId: this.ownerId(b.owner),
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, previousVx, previousVy, bounces: b.bounces,
        wall: { x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, border: !!w.border, hp: w.border ? null : w.hp } });
    } : null;
    for (const b of this.bullets) {
      b.update(DT, this.maze.walls, this.options.wallBreak, onBounce);
      if (b.dead) this.record({ type: 'projectile_end', projectileId: b.arenaId, ownerId: this.ownerId(b.owner),
        x: b.x, y: b.y, reason: b.age >= BULLET.lifetime ? 'lifetime' : 'bounce_limit', bounces: b.bounces });
    }
    if (this.options.wallBreak) {
      const crumbled = this.maze.walls.filter(w => !w.border && w.hp <= 0);
      if (crumbled.length) {
        destroyWallSegments(this.maze, crumbled);
        this.record({ type: 'wall_destroy', cause: 'projectile', walls: crumbled.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2 })) });
      }
    }
    for (const b of this.bullets) {
      if (b.dead) continue;
      for (const p of this.alive) {
        if (b.canHit(p.tank) && circleVsCircle(b.x, b.y, BULLET.radius, p.tank.x, p.tank.y, TANK.radius)) {
          b.dead = true;
          this.kill(p.tank, b.owner, b.kind || 'bullet', { projectileId: b.arenaId, bounces: b.bounces,
            impactX: b.x, impactY: b.y });
          break;
        }
      }
    }
    this.bullets = this.bullets.filter(b => !b.dead);
    for (const pw of this.powerups) pw.update(DT);
    this.tick++;
    this.eventTick = null;
    return this.settle();
  }

  settle() {
    if (this.result) return this.result;
    const living = this.alive;
    const timeout = this.tick >= Math.round(this.options.timeout * 60);
    if (living.length <= 1 || timeout) {
      this.result = {
        winnerId: living.length === 1 ? living[0].id : null,
        reason: this.actors.every(p => p.forfeit) ? 'all_forfeit' : living.length === 0 ? 'mutual' : living.length === 1 ? 'survivor' : 'timeout',
        ticks: this.tick,
        players: this.actors.map(p => ({ id: p.id, kills: p.kills, forfeit: p.forfeit || null })),
      };
    }
    return this.result;
  }
}
