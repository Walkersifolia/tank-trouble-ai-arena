// Shared tank motion: Box2D contact solving, with model positions in pixels.
// Original-client evidence: tank.js:update sets both velocities every tick;
// b2dutils.js:createTankBody uses a massive box plus massless turret fixtures;
// roundmodel.js advances Box2D with 10 velocity / 10 position iterations.
// Planck is an independent MIT-licensed Box2D port, not the original game code.
import { World, Vec2, Box, Circle } from "./vendor/planck.mjs";
import { CELL_SIZE, TANK, TANK_COLLISION, WALL } from "./config.js";

// The original uses 10 metres per maze cell. Keep Box2D tolerances in that scale.
const PIXELS_PER_METRE = CELL_SIZE / 10;
const TANK_MATERIAL = { density: 1, friction: 0.25, restitution: 0 };
const BARREL_MATERIAL = { density: 0, friction: 0.25, restitution: 0 };
const WALL_MATERIAL = { density: 0, friction: 0.05, restitution: 0 };

export class TankMotion {
  constructor() {
    this.world = new World({ gravity: Vec2(0, 0), allowSleep: false });
    this.tanks = new Map();
    this.walls = new Map();
    this.wallSource = null;
  }

  // controls[i] belongs to tanks[i], including dead players kept in the roster.
  // A whole game's tanks share one step, so tank contacts are solved together.
  // This only writes real x/y/angle; drawing poses live in tank-pose.js.
  step(tanks, dt, walls, controls) {
    if (dt <= 0) return;
    this.syncWalls(walls);

    const active = new Set(tanks.filter((tank) => tank.alive));
    for (const [tank, state] of this.tanks) {
      if (!active.has(tank)) {
        this.world.destroyBody(state.body);
        this.tanks.delete(tank);
      }
    }

    for (let i = 0; i < tanks.length; i++) {
      const tank = tanks[i];
      if (!tank.alive) continue;
      let state = this.tanks.get(tank);
      if (!state) {
        state = this.createTank(tank);
        this.tanks.set(tank, state);
      } else if (tank.x !== state.x || tank.y !== state.y || tank.angle !== state.angle) {
        // Wave/map transitions may reposition an existing tank explicitly.
        state.body.setTransform(Vec2(tank.x / PIXELS_PER_METRE, tank.y / PIXELS_PER_METRE), tank.angle);
      }

      const input = controls[i];
      const speed = input.move * (input.move < 0 ? TANK.reverseSpeed : TANK.moveSpeed)
        * (tank.mods?.speed ?? 1) / PIXELS_PER_METRE;
      // Heading is the model angle at the start of this physics step. Translation
      // and rotation advance together; there is no turn-first position shortcut.
      state.body.setLinearVelocity(Vec2(Math.cos(tank.angle) * speed, Math.sin(tank.angle) * speed));
      state.body.setAngularVelocity(input.turn * TANK.turnSpeed * (tank.mods?.turn ?? 1));
    }

    this.world.step(dt, 10, 10);

    for (const [tank, state] of this.tanks) {
      const position = state.body.getPosition();
      tank.x = state.x = position.x * PIXELS_PER_METRE;
      tank.y = state.y = position.y * PIXELS_PER_METRE;
      tank.angle = state.angle = state.body.getAngle();
    }
  }

  // Read only when a recorder asks for a frame. Touching contacts describe the
  // solver's latest step; they do not prove which contact caused low movement.
  contacts(tank) {
    const state = this.tanks.get(tank);
    if (!state) return null;
    const contacts = { wall: false, tank: false };
    for (let edge = state.body.getContactList(); edge; edge = edge.next) {
      if (!edge.contact.isTouching() || !edge.contact.isEnabled()) continue;
      if (edge.other.isStatic()) contacts.wall = true;
      else if (edge.other.isDynamic()) contacts.tank = true;
    }
    return contacts;
  }

  createTank(tank) {
    const body = this.world.createDynamicBody({
      position: Vec2(tank.x / PIXELS_PER_METRE, tank.y / PIXELS_PER_METRE),
      angle: tank.angle,
      linearDamping: 0,
      angularDamping: 0,
      allowSleep: false,
    });
    const shape = TANK_COLLISION;
    body.createFixture(Box(shape.bodyLength / (2 * PIXELS_PER_METRE), shape.bodyWidth / (2 * PIXELS_PER_METRE)), TANK_MATERIAL);
    const barrelHalfLength = (shape.barrelEnd - shape.barrelStart) / (2 * PIXELS_PER_METRE);
    const barrelCentre = (shape.barrelEnd + shape.barrelStart) / (2 * PIXELS_PER_METRE);
    const barrelRadius = shape.barrelRadius / PIXELS_PER_METRE;
    body.createFixture(Box(barrelHalfLength, barrelRadius, Vec2(barrelCentre, 0)), BARREL_MATERIAL);
    // The rear cap is inside the hull; only the exposed muzzle needs a circle.
    body.createFixture(Circle(Vec2(shape.barrelEnd / PIXELS_PER_METRE, 0), barrelRadius), BARREL_MATERIAL);
    return { body, x: tank.x, y: tank.y, angle: tank.angle };
  }

  syncWalls(walls) {
    // Maze destruction replaces the walls array, keeping surviving segment
    // objects. Preserve their bodies/contact caches instead of rebuilding them.
    if (walls === this.wallSource) return;
    this.wallSource = walls;
    const current = new Set(walls);
    for (const [wall, body] of this.walls) {
      if (!current.has(wall)) {
        this.world.destroyBody(body);
        this.walls.delete(wall);
      }
    }
    for (const wall of walls) {
      if (this.walls.has(wall)) continue;
      const dx = wall.x2 - wall.x1;
      const dy = wall.y2 - wall.y1;
      const halfLength = Math.hypot(dx, dy) / (2 * PIXELS_PER_METRE);
      const halfWidth = (wall.border ? WALL.borderThickness : WALL.thickness) / (2 * PIXELS_PER_METRE);
      const body = this.world.createBody({
        position: Vec2((wall.x1 + wall.x2) / (2 * PIXELS_PER_METRE), (wall.y1 + wall.y2) / (2 * PIXELS_PER_METRE)),
        angle: Math.atan2(dy, dx),
      });
      body.createFixture(Box(halfLength, halfWidth), WALL_MATERIAL);
      // Current artwork draws rounded wall ends. Keep physical ends at the
      // same visible outline rather than using an invisible zero-width segment.
      body.createFixture(Circle(Vec2(-halfLength, 0), halfWidth), WALL_MATERIAL);
      body.createFixture(Circle(Vec2(halfLength, 0), halfWidth), WALL_MATERIAL);
      this.walls.set(wall, body);
    }
  }
}

// Single-entity callers (e.g. a direct Tank.update) can use the same solver.
// Game loops should own one TankMotion and step their entire roster together.
const soloMotion = new WeakMap();
export function moveTank(tank, dt, walls, controls) {
  let motion = soloMotion.get(tank);
  if (!motion) {
    motion = new TankMotion();
    soloMotion.set(tank, motion);
  }
  motion.step([tank], dt, walls, [controls]);
}
