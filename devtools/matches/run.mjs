// Serial, seeded strategy matches against the unchanged public arena engine.
// This local runner is for trusted bot files, not for accepting untrusted uploads.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { performance } from 'node:perf_hooks';
import { ArenaWorld } from '../../engine/arena/world.js';
import { observe } from '../../engine/arena/observation.js';
import { LIMITS, IDLE } from '../../engine/arena/sandbox.js';
import { createRng } from '../../engine/rng.js';

export const RULES = Object.freeze({ timeout: 60, powerups: true, wallBreak: false });
const decision = new Script(`{
  globalThis.__started = performance.now();
  const output = __update(__state);
  if (!output || typeof output !== 'object' || Array.isArray(output) || typeof output.then === 'function')
    throw new Error('update must synchronously return an action object');
  globalThis.__action = { move: output.move ?? 0, turn: output.turn ?? 0,
    fire: output.fire ?? false, special: output.special ?? false };
  globalThis.__elapsed = performance.now() - __started;
}`, { filename: 'arena-local-decision.js' });

export function loadEntrant(id, filename) {
  const source = readFileSync(filename, 'utf8');
  return { id, name: id, color: '#91a8ff', filename,
    compiled: new Script(`Math.random = __random;
      (function(module, exports) { 'use strict';\n${source}\n})(module, module.exports);
      globalThis.__update = module.exports.update.bind(module.exports);`, { filename }) };
}

function loadContext(entrant, seed) {
  const context = createContext({ module: { exports: {} }, __random: createRng(seed),
    performance: { now: performance.now.bind(performance) },
    console: { log() {}, warn() {}, error() {} } });
  entrant.compiled.runInContext(context, { timeout: LIMITS.initMs });
  return context;
}

function decide(context, state) {
  context.__state = state;
  context.__started = undefined;
  try {
    decision.runInContext(context, { timeout: LIMITS.replyMs });
    const elapsedMs = context.__elapsed;
    if (elapsedMs > LIMITS.decisionMs) return { action: IDLE, elapsedMs,
      fault: { code: 'decision_timeout', elapsedMs, timeout: true } };
    const a = context.__action;
    if (!Number.isFinite(a.move) || Math.abs(a.move) > 1 || !Number.isFinite(a.turn) ||
      Math.abs(a.turn) > 1 || typeof a.fire !== 'boolean' || typeof a.special !== 'boolean')
      throw new Error('Invalid action fields');
    return { action: { ...a }, elapsedMs };
  } catch (error) {
    const elapsedMs = context.__started === undefined ? 0 : performance.now() - context.__started;
    const timeout = error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || elapsedMs > LIMITS.decisionMs;
    return { action: IDLE, elapsedMs, fault: { code: timeout ? 'decision_timeout' : 'script_error',
      elapsedMs, timeout, message: error.message } };
  }
}

const round = value => Math.round(value * 1000) / 1000;
const compactTank = actor => ({ id: actor.id, x: round(actor.tank.x), y: round(actor.tank.y),
  angle: round(actor.tank.angle), vx: round(actor.vx), vy: round(actor.vy), alive: actor.tank.alive });

export function runMatch(entrants, seed, { rotation = 0, rules = RULES, trace = true, setup } = {}) {
  const world = new ArenaWorld(entrants, { ...rules, seed });
  const setupDetails = setup?.(world);
  const contexts = new Map();
  const stats = Object.fromEntries(entrants.map(e => [e.id, { activeKills: 0, suicides: 0,
    shots: 0, pickups: 0, decisionTimeouts: 0, faults: 0, decisionMs: [],
    lowMotionTicks: 0, blockedRun: 0, longestBlockedTicks: 0,
    rapidTurnReversals: 0, lastTurnSign: 0, lastTurnChange: -100 }]));
  const faults = [], events = [], deathTraces = [], ring = [], openingTrace = [];
  const initial = world.actors.map(compactTank);
  for (const entrant of entrants) {
    try { contexts.set(entrant.id, loadContext(entrant, world.botSeedFor(entrant.id))); }
    catch (error) {
      const fault = { code: 'init_error', message: error.message, timeout: false };
      world.forfeit(entrant.id, fault); stats[entrant.id].faults++;
      faults.push({ id: entrant.id, tick: 0, ...fault });
    }
  }
  world.settle();
  while (!world.result) {
    const actions = {}, replies = [];
    for (const entrant of entrants) {
      if (!world.actors.find(a => a.id === entrant.id).tank.alive) { actions[entrant.id] = IDLE; continue; }
      const reply = decide(contexts.get(entrant.id), observe(world, entrant.id));
      stats[entrant.id].decisionMs.push(reply.elapsedMs);
      actions[entrant.id] = reply.action;
      replies.push({ id: entrant.id, ...reply });
    }
    for (const { id, fault } of replies) if (fault) {
      world.forfeit(id, fault); faults.push({ id, tick: world.tick, ...fault });
      stats[id].faults++; stats[id].decisionTimeouts += Number(fault.timeout);
    }
    world.settle();
    if (world.result) break;
    if (trace && world.tick % 10 === 0) {
      ring.push({ tick: world.tick, tanks: world.actors.map(compactTank), actions,
        bullets: world.bullets.map(b => ({ id: b.arenaId, ownerId: world.ownerId(b.owner),
          x: round(b.x), y: round(b.y), vx: round(b.vx), vy: round(b.vy), bounces: b.bounces })) });
      if (ring.length > 13) ring.shift();
      if (setup && world.tick < 180) openingTrace.push(ring.at(-1));
    }
    world.step(actions);
    for (const actor of world.actors) {
      const s = stats[actor.id], a = actions[actor.id];
      const blocked = actor.tank.alive && Math.abs(a.move) >= 0.5 && Math.hypot(actor.vx, actor.vy) < 12;
      s.blockedRun = blocked ? s.blockedRun + 1 : 0;
      s.lowMotionTicks += Number(blocked);
      s.longestBlockedTicks = Math.max(s.longestBlockedTicks, s.blockedRun);
      const turnSign = Math.abs(a.turn) >= 0.15 ? Math.sign(a.turn) : 0;
      if (actor.tank.alive && turnSign && turnSign !== s.lastTurnSign) {
        if (s.lastTurnSign && world.tick - s.lastTurnChange <= 12) s.rapidTurnReversals++;
        s.lastTurnSign = turnSign; s.lastTurnChange = world.tick;
      }
    }
    for (const event of world.events) {
      if (event.type === 'fire') stats[event.ownerId].shots++;
      if (event.type === 'pickup') stats[event.actorId].pickups++;
      if (event.type === 'death') {
        if (event.selfHit) stats[event.victimId].suicides++;
        else if (event.ownerId) stats[event.ownerId].activeKills++;
        if (trace) deathTraces.push({ death: { tick: world.tick, ...event }, frames: [...ring] });
      }
      if (['fire', 'pickup', 'death', 'shield'].includes(event.type)) events.push({ tick: world.tick, ...event });
    }
  }
  const players = entrants.map(e => {
    const s = stats[e.id], times = s.decisionMs.sort((a, b) => a - b);
    return { id: e.id, outcome: world.actors.find(a => a.id === e.id).forfeit ? 'loss'
      : world.result.winnerId === e.id ? 'win' : world.result.winnerId ? 'loss' : 'draw',
      activeKills: s.activeKills, suicides: s.suicides, shots: s.shots, pickups: s.pickups,
      decisionTimeouts: s.decisionTimeouts, faults: s.faults, decisions: times.length,
      meanDecisionMs: round(times.reduce((a, b) => a + b, 0) / (times.length || 1)),
      p95DecisionMs: round(times[Math.floor((times.length - 1) * 0.95)] || 0),
      maxDecisionMs: round(times.at(-1) || 0), lowMotionTicks: s.lowMotionTicks,
      longestBlockedTicks: s.longestBlockedTicks, rapidTurnReversals: s.rapidTurnReversals };
  });
  return { seed, rotation, entrants: entrants.map(e => e.id), mapStyle: world.style,
    initial, winnerId: world.result.winnerId, reason: world.result.reason, ticks: world.tick,
    players, faults, events, deathTraces, ...(setup ? { setup: setupDetails, openingTrace } : {}) };
}

export function summarize(matches) {
  const totals = {};
  for (const match of matches) for (const player of match.players) {
    const s = totals[player.id] ??= { games: 0, wins: 0, losses: 0, draws: 0,
      activeKills: 0, suicides: 0, matchTimeouts: 0, decisionTimeouts: 0, faults: 0,
      longestBlockedTicks: 0, rapidTurnReversals: 0 };
    s.games++; s[player.outcome === 'win' ? 'wins' : player.outcome === 'loss' ? 'losses' : 'draws']++;
    for (const key of ['activeKills', 'suicides', 'decisionTimeouts', 'faults', 'rapidTurnReversals']) s[key] += player[key];
    s.matchTimeouts += Number(match.reason === 'timeout');
    s.longestBlockedTicks = Math.max(s.longestBlockedTicks, player.longestBlockedTicks);
  }
  return totals;
}

async function main() {
  const args = process.argv.slice(2), values = key => args.flatMap((v, i) => v === key ? [args[i + 1]] : []);
  const value = (key, defaultValue) => values(key).at(-1) ?? defaultValue;
  const entrants = values('--bot').map(spec => { const at = spec.indexOf('='); return loadEntrant(spec.slice(0, at), spec.slice(at + 1)); });
  const mentor = value('--mentor', null);
  if (mentor) entrants.push(loadEntrant('deepseek-g5-mentor', mentor));
  if (entrants.length < 2) throw new Error('Usage: node devtools/matches/run.mjs --bot id=file --bot id=file [--mode duel|roundrobin|ffa] [--seed 6100] [--seeds 4] [--out file.json]');
  const mode = value('--mode', 'duel'), seedStart = Number(value('--seed', '6100')), seedCount = Number(value('--seeds', '4'));
  const rules = { ...RULES, powerups: value('--powerups', 'on') !== 'off' };
  const groups = mode === 'ffa' ? [entrants] : mode === 'roundrobin'
    ? entrants.flatMap((a, i) => entrants.slice(i + 1).map(b => [a, b])) : entrants.slice(1).map(b => [entrants[0], b]);
  const matches = [], started = new Date().toISOString();
  for (const group of groups) for (let index = 0; index < seedCount; index++) for (let rotation = 0; rotation < group.length; rotation++) {
    const order = [...group.slice(rotation), ...group.slice(0, rotation)];
    const match = runMatch(order, seedStart + index, { rotation, rules, trace: value('--trace', 'on') !== 'off' });
    matches.push(match);
    console.log(JSON.stringify({ game: matches.length, seed: match.seed, rotation, opponents: match.entrants,
      winner: match.winnerId, reason: match.reason, seconds: round(match.ticks / 60), faults: match.faults,
      players: match.players.map(p => ({ id: p.id, kills: p.activeKills, suicides: p.suicides,
        maxDecisionMs: p.maxDecisionMs, blocked: p.longestBlockedTicks })) }));
  }
  const report = { protocol: { started, finished: new Date().toISOString(), mode, seedStart, seedCount,
    node: process.version, rules, decisionMs: LIMITS.decisionMs, hardInterruptionMs: LIMITS.replyMs,
    physicsHz: 60, observation: 'engine/arena/observation.js observe(); no private world fields',
    order: 'serial decisions at the same world tick; all faults settle together; cyclic spawn rotations',
    sources: entrants.map(({ id, filename }) => ({ id, filename: basename(filename),
      ...(id === 'deepseek-g5-mentor' ? { source: 'External original DeepSeek Gen5 MENTOR / 导师; path supplied by --mentor' } : {}) })) },
    summary: summarize(matches), matches };
  const out = value('--out', null);
  if (out) writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ summary: report.summary, out }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
