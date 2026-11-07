// 训练只更换赛程、随机流和数据出口；逐 Tick 决策与物理仍由正式竞技场运行。
import { ArenaWorld } from '../../../engine/arena/world.js';
import { MatchRunner } from '../../../engine/arena/runner.js';
import { MatchRecording } from '../../../engine/arena/recording.js';
import { IDLE } from '../../../engine/arena/sandbox.js';

const RULES = Object.freeze({ timeout: 60, powerups: true, wallBreak: false });
const FAULT_CODES = new Set(['script_error', 'decision_timeout', 'init_timeout', 'queue_timeout', 'unresponsive_timeout']);
const publicPlayer = ({ id, name, color }) => ({ id, name, color });

function seedFor(seed, mapIndex) {
  let value = 2166136261;
  for (const char of `${seed}:${mapIndex}`) {
    value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  }
  return value >>> 0;
}

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) >>> 0;
    let n = Math.imul(value ^ value >>> 15, 1 | value);
    n ^= n + Math.imul(n ^ n >>> 7, 61 | n);
    return ((n ^ n >>> 14) >>> 0) / 4294967296;
  };
}

class TrainingRunner extends MatchRunner {
  async call(bot, fn) {
    try { return { id: bot.entrant.id, action: await fn() }; }
    catch (error) {
      bot.dispose();
      const code = FAULT_CODES.has(error.code) ? error.code : 'script_error';
      // 不返回对手自行构造的异常文本（其中可能包含源码或内部变量）。
      return { id: bot.entrant.id, action: IDLE, fault: {
        code, message: code, timeout: code.endsWith('_timeout'),
        ...(Number.isFinite(error.elapsedMs) ? { elapsedMs: error.elapsedMs } : {}),
      } };
    }
  }
}

class TapeRecording extends MatchRecording {
  constructor(world, options, tape) {
    super(world, options);
    this.tape = tape;
  }

  capture(world, actions = {}, faults = []) {
    if (!this.done && (world.tick > this.lastTick || world.recordEvents.length || faults.length)) {
      // 仅保存已经接收的公开控制与故障，按需用同一引擎展开为原有完整日志。
      this.tape.push({ tick: world.tick, stepped: world.tick > this.lastTick,
        actions: structuredClone(actions),
        faults: faults.map(({ id, fault }) => ({ id, fault: { ...fault } })),
      });
    }
    super.capture(world, actions, faults);
  }
}

async function runTraining(request) {
  const originalRandom = Math.random;
  const rules = { ...RULES, powerups: request.powerups !== false };
  const total = request.rounds * request.opponents.length;
  let completed = 0;
  try {
    for (const opponent of request.opponents) {
      for (let index = 0; index < request.rounds; index++) {
        const round = completed + 1;
        const swapped = !!request.swapSpawns && index % 2 === 1;
        const worldSeed = seedFor(request.seed, request.swapSpawns ? Math.floor(index / 2) : index);
        const candidate = { id: 'candidate', name: request.name, color: '#3b82f6', source: request.source };
        const entrants = swapped ? [opponent, candidate] : [candidate, opponent];
        const players = entrants.map(publicPlayer);
        const tape = [];
        let record, failure;
        const progress = tick => window.training.progress({ id: request.id, completed, total,
          round, opponentId: opponent.id, tick });
        const runner = new TrainingRunner({
          onChange() {}, onResult() {},
          onStep() { if (runner.world.tick % 120 === 0) progress(runner.world.tick); },
          onError(error) { failure = error; },
          onRecording(value) { record = value; },
          makeWorld(orderedEntrants, options) {
            // 只设置可信 renderer 的随机流；AI 在独立 Worker 中仍只有正式 API。
            Math.random = seededRandom(worldSeed);
            return new ArenaWorld(orderedEntrants, options);
          },
          makeRecording(world) {
            return new TapeRecording(world, { id: `${request.id}-${round}`, sessionId: request.id,
              round, entrants: players, detail: false }, tape);
          },
        });
        runner.headless = true;
        progress(0);
        await runner.start(entrants, { ...rules, rounds: 1, recording: true, detailRecording: false });
        if (failure) throw failure;
        const metadata = { id: record.id, sessionId: request.id, round, worldSeed, swapped,
          opponentId: opponent.id, players, rules: { ...rules },
          startedAt: record.startedAt, finishedAt: record.finishedAt };
        const candidateResult = record.result.players.find(player => player.id === 'candidate');
        const { durationSeconds, completed: matchCompleted, reason, winnerId, players: stats } = record.summary;
        const faults = tape.flatMap(frame => frame.faults.map(({ id, fault }) => ({ id, code: fault.code, timeout: fault.timeout })));
        const result = { round, opponentId: opponent.id, worldSeed, swapped, faults,
          outcome: candidateResult.outcome, reason, winnerId, ticks: record.result.ticks,
          summary: { durationSeconds, completed: matchCompleted, reason, winnerId, players: stats } };
        await window.training.round({ id: request.id, round, tape, metadata, result });
        completed++;
        progress(record.result.ticks);
      }
    }
    await window.training.done({ id: request.id });
  } finally {
    Math.random = originalRandom;
  }
}

async function replayTraining(request) {
  const { metadata, tape } = request;
  const originalRandom = Math.random;
  try {
    Math.random = seededRandom(metadata.worldSeed);
    const world = new ArenaWorld(metadata.players, { ...metadata.rules, recording: true });
    const recorder = new MatchRecording(world, { id: metadata.id, sessionId: metadata.sessionId,
      round: metadata.round, entrants: metadata.players, detail: true });
    for (const frame of tape) {
      if (frame.stepped) world.step(frame.actions);
      else {
        for (const entry of frame.faults) world.forfeit(entry.id, entry.fault);
        world.settle();
      }
      recorder.capture(world, frame.actions, frame.faults);
    }
    const record = recorder.finish(world);
    record.trainingSeed = metadata.worldSeed;
    record.startedAt = metadata.startedAt;
    record.finishedAt = metadata.finishedAt;
    await window.training.replayed({ requestId: request.requestId, record });
  } finally {
    Math.random = originalRandom;
  }
}

// 两种工作共用可信引擎随机流，按到达次序运行。
let pending = Promise.resolve();
function enqueue(handler, request, message) {
  pending = pending.then(() => handler(request)).catch(() => {
    window.training.failed({ id: request.id, ...(request.requestId ? { requestId: request.requestId } : {}), message });
  });
}
window.training.onRun(request => enqueue(runTraining, request, 'training_failed'));
window.training.onReplay(request => enqueue(replayTraining, request, 'replay_failed'));
await window.training.ready();
