// 比赛后诊断数据：只读实体和已提交的动作，不访问脚本，也不参与物理或胜负。
import { TANK } from '../config.js';
import { closestPointOnSegment } from '../collision.js';
import { DT } from './world.js';
import { PUBLIC_PHYSICS } from './observation.js';

const DETAIL_LIMIT_BYTES = 64 * 1024 * 1024;
const IDLE = { move: 0, turn: 0, fire: false, special: false };
const wallId = w => `${w.x1},${w.y1},${w.x2},${w.y2}`;
const angleDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const actionView = a => ({ move: a?.move ?? 0, turn: a?.turn ?? 0, fire: !!a?.fire, special: !!a?.special });
const faultView = fault => fault ? { code: fault.code, message: fault.message,
  elapsedMs: fault.elapsedMs, timeout: !!fault.timeout } : null;
const wallView = w => ({ id: wallId(w), x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2,
  border: !!w.border, hp: w.border ? null : w.hp });

function resultView(world, aborted) {
  const result = world.result;
  return {
    winnerId: aborted ? null : result?.winnerId ?? null,
    reason: aborted ? 'aborted' : result?.reason ?? 'unfinished',
    ticks: world.tick,
    players: world.actors.map(p => ({ id: p.id, kills: p.kills, forfeit: faultView(p.forfeit),
      outcome: aborted ? 'unscored' : p.forfeit ? 'loss' : !result?.winnerId ? 'draw' : result.winnerId === p.id ? 'win' : 'loss' })),
  };
}

function nearestWallDistance(world, x, y) {
  let distance = Infinity;
  for (const w of world.maze.walls) {
    const cp = closestPointOnSegment(x, y, w.x1, w.y1, w.x2, w.y2);
    distance = Math.min(distance, Math.hypot(x - cp.x, y - cp.y));
  }
  return Number.isFinite(distance) ? distance : null;
}

function newStatistics(id) {
  return { id, aliveSeconds: 0, fireRequests: 0, shotsFired: 0, projectilesCreated: 0,
    fireBlocked: { cooldown: 0, bullet_limit: 0, dead: 0, other: 0 }, specialRequests: 0, minesDeployed: 0,
    moveReversals: 0, turnReversals: 0, moveChanges: 0, turnChanges: 0, distanceTravelled: 0,
    actualMoveReversals: 0, actualTurnReversals: 0,
    stationaryMoveTicks: 0, wallBlockedTicks: 0, longestBlockedSeconds: 0, longestNoFireSeconds: 0,
    nearWallShots: 0, kills: 0, directKills: 0, ricochetKills: 0, suicides: 0, deaths: 0,
    timeouts: 0, scriptErrors: 0, pickups: { laser: 0, scatter: 0, mine: 0, shield: 0 },
    powerupsUsed: { laser: 0, scatter: 0, mine: 0, shield: 0 }, powerupApproachTicks: 0, reverseApproachTicks: 0 };
}

export class MatchRecording {
  constructor(world, { id, sessionId, round, entrants, detail = false }) {
    world.recordingEnabled = true;
    this.wallValues = new Map(world.maze.walls.map(w => [wallId(w), w.border ? null : w.hp]));
    this.wallVersion = 0;
    this.previous = new Map();
    this.motion = new Map();
    this.windows = new Map();
    this.sequence = 0;
    this.lastTick = world.tick;
    this.done = false;
    this.record = {
      schemaVersion: 1, id, sessionId, round, startedAt: new Date().toISOString(), finishedAt: null,
      physicsHz: 60, seed: world.seed, mapSeed: world.seeds?.mapSeed ?? null,
      physics: structuredClone(PUBLIC_PHYSICS), motionModel: 'planck-hull-barrel-v1',
      players: entrants.map(p => ({ id: p.id, name: p.name, color: p.color,
        filename: p.filename ?? null, updatedAt: p.updatedAt ?? null, versionId: p.versionId ?? null })),
      rules: { timeout: world.options.timeout, powerups: !!world.options.powerups, wallBreak: !!world.options.wallBreak },
      detail: !!detail, detailTruncated: false, detailBytesEstimate: 0, detailLimitBytes: DETAIL_LIMIT_BYTES,
      initialState: null, result: null, summary: {
        durationSeconds: 0, completed: false, reason: null, winnerId: null,
        players: world.actors.map(p => newStatistics(p.id)), behaviorWindows: [],
        definitions: {
          coordinates: '位置单位像素；时间秒；角度弧度，0朝右、顺时针为正；dx/dy/dAngle是本物理Tick实际变化。',
          controls: 'action是实际提交的控制；actionApplied=false表示初始状态或故障结算，未执行物理Tick。phase=fault允许同Tick出现额外帧。',
          fireRequests: '统计实际物理Tick中的fire=true；fire.reason根据调用tryFire前的存活、冷却及在场炮弹上限记录，不推断脚本意图。shotsFired按一次发射计，散射多弹另计projectilesCreated。',
          reversals: 'moveReversals/turnReversals统计连续非零move/turn指令正负改变（中间的0不清除方向）；Changes还包括进入或退出0。actualMoveReversals/actualTurnReversals以同样规则单独统计真实位移方向反转，不把请求等同于已执行运动。',
          actualMovement: 'forwardDistance是本Tick真实位移在起止朝向中间方向上的投影；绝对值≤0.01像素时actualMoveDirection为0，否则为±1。|dAngle|≤0.001弧度时actualTurnDirection为0，否则为±1。阈值仅定义诊断统计，不参与控制或物理。',
          lowDisplacement: '移动请求非零且实际位移小于该Tick期望位移的20%；可能涉及墙或坦克阻挡，不据此推断原因。',
          contacts: 'movement.contacts为本Tick运动求解器中已启用且touching的接触，wall指车身或炮管与厚墙接触，tank指坦克接触；未执行运动时为null。接触可能来自求解前建立的接触表，不表示最终绘制轮廓相交，也不单独证明位移受阻的原因。',
          wallBlocked: 'wallBlockedTicks为低位移且movement.contacts.wall=true；只表达低位移与墙接触同时出现，不再以武器命中圆半径判断运动接触。nearWallDistance仍仅是中心到墙线段的距离。',
          nearWallShot: '发射时坦克中心到最近墙≤坦克半径+炮弹半径+4像素，不表示该发必然自伤。',
          powerupApproach: '现存或当Tick拾取道具的直线距离下降计approach；move<0同时下降计reverseApproach；不代表AI真实目标或可通行路径。forwardDot为炮口方向与指向道具单位向量点积。',
          behaviorWindows: '每名选手每60物理Tick一个窗口，末尾不足一秒也保留；distance是累计路程，netDistance是首尾位移，可据seconds计算切换频率。',
          privacy: '仅赛后保存实际战场和公开控制动作，不含选手源代码、sourcePath、私有决策变量或随机数内部状态。隐形地雷可在赛后状态中记录，但不提供给比赛中的AI。',
        },
      },
      events: [], wallChanges: [], aborted: false,
    };
    this.stats = new Map(this.record.summary.players.map(p => [p.id, p]));
    const initial = this.snapshot(world, {}, 'initial', true, []);
    initial.map = {
      cols: world.maze.cols, rows: world.maze.rows, cellSize: world.maze.cellSize,
      width: world.maze.cols * world.maze.cellSize, height: world.maze.rows * world.maze.cellSize,
      style: world.style, walls: world.maze.walls.map(wallView),
      cells: world.maze.cells.map(row => row.map(c => ({ top: c.top, right: c.right, bottom: c.bottom, left: c.left }))),
    };
    this.record.initialState = initial;
    if (detail) this.record.states = [initial];
    for (const t of initial.tanks) {
      this.previous.set(t.id, t);
      this.motion.set(t.id, { move: 0, turn: 0, actualMove: 0, actualTurn: 0,
        action: { ...IDLE }, blockedTicks: 0, lastShotTime: 0 });
    }
    this.addEvent({ type: 'match_start', tick: world.tick, time: world.tick * DT });
  }

  addEvent(event) {
    // 世界的事件由框架显式构造；复制后不会再随实体变动。
    const saved = { ...structuredClone(event), seq: this.sequence++ };
    this.record.events.push(saved);
    const actor = this.stats.get(saved.actorId ?? saved.ownerId);
    const victim = this.stats.get(saved.victimId);
    if (saved.type === 'fire' && actor) {
      actor.shotsFired++;
      if (saved.nearWall) actor.nearWallShots++;
    }
    if (saved.type === 'projectile_spawn' && actor) actor.projectilesCreated++;
    if (saved.type === 'mine_deploy' && actor) actor.minesDeployed++;
    if (saved.type === 'pickup' && actor) actor.pickups[saved.powerup]++;
    if (saved.type === 'powerup_used' && actor) actor.powerupsUsed[saved.powerup]++;
    if (saved.type === 'forfeit' && victim) {
      if (saved.timeout) victim.timeouts++; else victim.scriptErrors++;
    }
    if (saved.type === 'death') {
      if (victim) victim.deaths++;
      if (saved.selfHit && victim) victim.suicides++;
      else if (actor) {
        actor.kills++;
        if (saved.ricochet) actor.ricochetKills++; else actor.directKills++;
      }
    }
  }

  snapshot(world, actions, phase, entities, events) {
    const stepped = phase === 'step';
    const pickupPoints = events.filter(e => e.type === 'pickup').map(e => ({ id: e.powerupId, x: e.x, y: e.y }));
    const powerups = world.powerups.map(p => ({ id: world.powerupId(p), x: p.x, y: p.y, type: p.type, age: p.age, taken: !!p.taken }));
    const targets = [...powerups, ...pickupPoints];
    const tanks = world.actors.map(p => {
      const t = p.tank, previous = this.previous.get(p.id), action = actionView(actions[p.id]);
      const dx = stepped && previous ? t.x - previous.x : 0;
      const dy = stepped && previous ? t.y - previous.y : 0;
      const dAngle = stepped && previous ? angleDelta(t.angle, previous.angle) : 0;
      const distance = Math.hypot(dx, dy);
      const midAngle = t.angle - dAngle / 2;
      const forwardDistance = dx * Math.cos(midAngle) + dy * Math.sin(midAngle);
      const expectedDistance = stepped && previous?.alive
        ? Math.abs(action.move) * (action.move < 0 ? TANK.reverseSpeed : TANK.moveSpeed) * DT : 0;
      const lowDisplacement = expectedDistance > 0 && distance < expectedDistance * 0.2;
      const diagnostic = stepped ? world.lastStepDiagnostics?.players[p.id] : null;
      return {
        id: p.id, name: p.name, color: p.color, x: t.x, y: t.y, angle: t.angle, vx: p.vx, vy: p.vy,
        alive: t.alive, kills: p.kills, forfeit: faultView(p.forfeit),
        cooldown: Math.max(0, t.cooldown), deployCooldown: Math.max(0, t.deployCooldown),
        scatterShots: t.scatterShots, laserShots: t.laserShots, mineCharges: t.mineCharges,
        mineHoldTime: Math.max(0, t.mineHoldTimer), mineHoldTimer: t.mineHoldTimer,
        shield: t.shield, shieldTime: Math.max(0, t.shieldTimer), shieldTimer: t.shieldTimer,
        action, actionApplied: stepped && !!previous?.alive,
        dx, dy, dAngle,
        movement: { distance, expectedDistance, lowDisplacement, forwardDistance,
          actualMoveDirection: Math.abs(forwardDistance) <= 0.01 ? 0 : Math.sign(forwardDistance),
          actualTurnDirection: Math.abs(dAngle) <= 0.001 ? 0 : Math.sign(dAngle),
          contacts: stepped && previous?.alive ? world.motion.contacts(t) : null,
          nearWallDistance: lowDisplacement ? nearestWallDistance(world, t.x, t.y) : null },
        fire: diagnostic ? { ...diagnostic.fire } : { requested: action.fire, emitted: false, reason: 'not_executed', weapon: null, cooldown: Math.max(0, t.cooldown) },
        special: diagnostic ? { ...diagnostic.special } : { requested: action.special, deployed: false, reason: 'not_executed' },
        powerupDistances: targets.map(pw => {
          const distance = Math.hypot(t.x - pw.x, t.y - pw.y);
          return { id: pw.id, distance, deltaDistance: stepped && previous ? distance - Math.hypot(previous.x - pw.x, previous.y - pw.y) : 0,
            forwardDot: distance ? (Math.cos(t.angle) * (pw.x - t.x) + Math.sin(t.angle) * (pw.y - t.y)) / distance : 0 };
        }),
      };
    });
    const frame = { tick: world.tick, time: world.tick * DT, dt: stepped ? DT : 0, phase,
      wallVersion: this.wallVersion, tanks, powerups };
    if (entities) {
      const owners = new Map(world.actors.map(p => [p.tank, p.id]));
      frame.bullets = world.bullets.map(b => ({ id: b.arenaId, ownerId: owners.get(b.owner) ?? null,
        x: b.x, y: b.y, vx: b.vx, vy: b.vy, angle: Math.atan2(b.vy, b.vx), age: b.age,
        bounces: b.bounces, kind: b.kind || 'bullet', color: b.color, dead: !!b.dead,
        trail: b.trail.map(p => ({ x: p.x, y: p.y })) }));
      frame.mines = world.mines.map(m => ({ id: m.arenaId, ownerId: owners.get(m.owner) ?? null,
        x: m.x, y: m.y, age: m.age, armed: m.armed, visibility: m.visibility(), exploded: m.exploded }));
    }
    return frame;
  }

  captureWalls(world, events) {
    if (!world.options.wallBreak) return;
    if (!events.some(e => e.type === 'wall_destroy' || (e.type === 'bounce' && e.wall && !e.wall.border))) return;
    const current = new Map(world.maze.walls.map(w => [wallId(w), w.border ? null : w.hp]));
    const removed = [...this.wallValues.keys()].filter(id => !current.has(id));
    const updated = [...current].filter(([id, hp]) => this.wallValues.get(id) !== hp).map(([id, hp]) => ({ id, hp }));
    if (removed.length || updated.length) {
      this.record.wallChanges.push({ version: ++this.wallVersion, tick: world.tick, removed, updated });
      this.wallValues = current;
    }
  }

  updateStatistics(frame) {
    for (const t of frame.tanks) {
      const previous = this.previous.get(t.id);
      if (!previous?.alive) continue;
      const s = this.stats.get(t.id), motion = this.motion.get(t.id), action = t.action;
      let window = this.windows.get(t.id);
      if (!window) {
        window = { id: t.id, fromTick: frame.tick - 1, toTick: frame.tick, seconds: 0,
          moveReversals: 0, turnReversals: 0, moveChanges: 0, turnChanges: 0,
          actualMoveReversals: 0, actualTurnReversals: 0,
          distance: 0, netDistance: 0, fireRequests: 0, shotsFired: 0, blockedTicks: 0,
          startX: previous.x, startY: previous.y };
        this.windows.set(t.id, window);
      }
      for (const field of ['move', 'turn']) {
        if (action[field] !== motion.action[field]) { s[`${field}Changes`]++; window[`${field}Changes`]++; }
        const direction = Math.sign(action[field]);
        if (direction && motion[field] && direction !== motion[field]) { s[`${field}Reversals`]++; window[`${field}Reversals`]++; }
        if (direction) motion[field] = direction;
      }
      for (const field of ['actualMove', 'actualTurn']) {
        const direction = t.movement[`${field}Direction`];
        if (direction && motion[field] && direction !== motion[field]) {
          s[`${field}Reversals`]++; window[`${field}Reversals`]++;
        }
        if (direction) motion[field] = direction;
      }
      motion.action = action;
      s.aliveSeconds += DT;
      s.distanceTravelled += t.movement.distance;
      window.toTick = frame.tick;
      window.seconds += DT;
      window.distance += t.movement.distance;
      window.netDistance = Math.hypot(t.x - window.startX, t.y - window.startY);
      if (action.fire) {
        s.fireRequests++; window.fireRequests++;
        if (!t.fire.emitted) s.fireBlocked[t.fire.reason in s.fireBlocked ? t.fire.reason : 'other']++;
      }
      if (action.special) s.specialRequests++;
      s.longestNoFireSeconds = Math.max(s.longestNoFireSeconds, frame.time - motion.lastShotTime);
      if (t.fire.emitted) { motion.lastShotTime = frame.time; window.shotsFired++; }
      if (t.movement.lowDisplacement) {
        s.stationaryMoveTicks++; motion.blockedTicks++; window.blockedTicks++;
        if (t.movement.contacts?.wall) s.wallBlockedTicks++;
        s.longestBlockedSeconds = Math.max(s.longestBlockedSeconds, motion.blockedTicks * DT);
      } else motion.blockedTicks = 0;
      if (t.powerupDistances.some(p => p.deltaDistance < -0.01)) {
        s.powerupApproachTicks++;
        if (action.move < 0) s.reverseApproachTicks++;
      }
      if (frame.tick % 60 === 0 || !t.alive) this.closeWindow(t.id);
    }
  }

  closeWindow(id) {
    const window = this.windows.get(id);
    if (!window) return;
    const { startX, startY, ...summary } = window;
    this.record.summary.behaviorWindows.push(summary);
    this.windows.delete(id);
  }

  capture(world, actions = {}, faults = []) {
    if (this.done) return;
    const events = world.recordEvents.splice(0);
    const stepped = world.tick > this.lastTick;
    if (!stepped && !events.length && !faults.length) return;
    for (const event of events) this.addEvent(event);
    const saveDetail = this.record.detail && !this.record.detailTruncated;
    this.captureWalls(world, events);
    const frame = this.snapshot(world, actions, stepped ? 'step' : 'fault', saveDetail, events);
    if (stepped) this.updateStatistics(frame);
    if (saveDetail) {
      // 按字段数估算序列化体积，不在60Hz循环里JSON.stringify整场录像。
      const size = 180 + frame.tanks.length * 1100 + frame.powerups.length * 120 + frame.mines.length * 160 +
        frame.bullets.reduce((n, b) => n + 240 + b.trail.length * 55, 0);
      if (this.record.detailBytesEstimate + size <= DETAIL_LIMIT_BYTES) {
        this.record.states.push(frame);
        this.record.detailBytesEstimate += size;
      } else this.record.detailTruncated = true;
    }
    for (const t of frame.tanks) this.previous.set(t.id, t);
    this.lastTick = world.tick;
  }

  finish(world, { aborted = false } = {}) {
    if (this.done) return this.record;
    this.capture(world);
    for (const id of this.windows.keys()) this.closeWindow(id);
    const result = resultView(world, aborted);
    this.record.aborted = aborted;
    this.record.result = result;
    this.record.finishedAt = new Date().toISOString();
    Object.assign(this.record.summary, { durationSeconds: world.tick * DT,
      completed: !aborted && !!world.result, reason: result.reason, winnerId: result.winnerId });
    this.addEvent({ type: 'match_end', tick: world.tick, time: world.tick * DT, result });
    this.done = true;
    return this.record;
  }
}
