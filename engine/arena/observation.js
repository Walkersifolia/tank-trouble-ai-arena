import { TANK, TANK_COLLISION, BULLET, POWERUP, WALL } from '../config.js';
import { DT } from './world.js';

export const PUBLIC_PHYSICS = {
  // tankRadius 继续用于武器命中/道具拾取；运动接触使用下方车身与炮管轮廓。
  tankRadius: TANK.radius, moveSpeed: TANK.moveSpeed, reverseSpeed: TANK.reverseSpeed, turnSpeed: TANK.turnSpeed,
  tankCollision: { ...TANK_COLLISION },
  wallThickness: WALL.thickness, borderWallThickness: WALL.borderThickness,
  bulletRadius: BULLET.radius, bulletSpeed: BULLET.speed, bulletLifetime: BULLET.lifetime,
  fireCooldown: BULLET.cooldown, maxBullets: BULLET.maxAlive, selfHitGrace: BULLET.selfHitGrace,
  wallHp: WALL.hp,
  muzzleOffset: TANK.bodyLength / 2 + TANK.barrelLength + BULLET.radius + 2,
  powerupRadius: POWERUP.radius,
  scatter: { pellets: POWERUP.scatter.pellets, spreadAngle: POWERUP.scatter.spreadAngle, shots: POWERUP.scatter.shots },
  laser: { shots: POWERUP.laser.shots, maxBounces: POWERUP.laser.maxBounces, maxLength: POWERUP.laser.maxLength },
  mine: { charges: POWERUP.mine.charges, armDelay: POWERUP.mine.armDelay, triggerRadius: POWERUP.mine.triggerRadius,
    blastRadius: POWERUP.mine.blastRadius, wallBlastRadius: POWERUP.mine.wallBlastRadius,
    visibleTime: POWERUP.mine.visibleTime, fadeTime: POWERUP.mine.fadeTime, holdTimeout: POWERUP.mine.holdTimeout,
    discRadius: POWERUP.mine.discRadius, deployCooldown: 0.25 },
  shieldDuration: POWERUP.shield.duration,
};

// 只列出公开字段。主引擎对象、脚本、随机状态和赛程不进入消息。
export function observe(world, id) {
  const ownerId = tank => world.actors.find(p => p.tank === tank)?.id ?? null;
  const tankView = p => ({
    id: p.id, name: p.name, color: p.color, alive: p.tank.alive,
    x: p.tank.x, y: p.tank.y,
    angle: ((p.tank.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2),
    vx: p.vx, vy: p.vy,
    cooldown: Math.max(0, p.tank.cooldown), deployCooldown: Math.max(0, p.tank.deployCooldown),
    bulletsActive: world.bullets.filter(b => b.owner === p.tank).length,
    scatterShots: p.tank.scatterShots, laserShots: p.tank.laserShots, mineCharges: p.tank.mineCharges,
    mineHoldTime: Math.max(0, p.tank.mineHoldTimer), shield: p.tank.shield, shieldTime: Math.max(0, p.tank.shieldTimer),
  });
  return {
    apiVersion: 1, tick: world.tick, time: world.tick * DT, dt: DT,
    self: tankView(world.actors.find(p => p.id === id)),
    enemies: world.actors.filter(p => p.id !== id).map(tankView),
    map: {
      cols: world.maze.cols, rows: world.maze.rows, cellSize: world.maze.cellSize,
      width: world.maze.cols * world.maze.cellSize, height: world.maze.rows * world.maze.cellSize,
      cells: world.maze.cells.map(row => row.map(c => ({ top: c.top, right: c.right, bottom: c.bottom, left: c.left }))),
      walls: world.maze.walls.map(w => ({ x1: w.x1, y1: w.y1, x2: w.x2, y2: w.y2, border: !!w.border, hp: w.border ? null : w.hp })),
    },
    bullets: world.bullets.map(b => ({ id: b.arenaId, ownerId: ownerId(b.owner), x: b.x, y: b.y,
      vx: b.vx, vy: b.vy, age: b.age, bounces: b.bounces, kind: b.kind || 'bullet' })),
    powerups: world.powerups.map(p => ({ x: p.x, y: p.y, type: p.type })),
    mines: world.mines.filter(m => m.visibility() > 0).map(m => ({ id: m.arenaId, ownerId: ownerId(m.owner),
      x: m.x, y: m.y, age: m.age, armed: m.armed, visibility: m.visibility() })),
    rules: { timeout: world.options.timeout, wallBreak: world.options.wallBreak, powerups: world.options.powerups },
    physics: structuredClone(PUBLIC_PHYSICS),
  };
}
