import { ArenaWorld, DT } from '../engine/arena/world.js?v=wall-shot-1';
import { observe } from '../engine/arena/observation.js';
import { BotSandbox, IDLE } from '../engine/arena/sandbox.js?v=play-mode-1';
import { ArenaRenderer } from '../engine/arena/render.js';
import { MatchRecording } from '../engine/arena/recording.js';

// Web 入口协调浏览器节奏与输入；世界、观察、隔离执行器也供无头评测使用。
export class ChallengeGame {
  constructor({ canvas, onUpdate = () => {}, onEnd = () => {}, onNotice = () => {} }) {
    Object.assign(this, { onUpdate, onEnd, onNotice });
    this.renderer = new ArenaRenderer(canvas, { maxDpr: 2 });
    this.status = 'idle';
    this.world = null;
    this.players = [];
    this.bots = [];
    this.humanAction = { ...IDLE };
    this.simRate = 1;
    this.speed = 1;
    this.headless = false;
    this.session = 0;
    this.frame = null;
  }

  update(status = this.status) {
    this.status = status;
    this.onUpdate({ world: this.world, status, simRate: this.simRate });
  }

  async start({ players, rules, seed, round = 1 }) {
    this.stop();
    const session = this.session;
    this.players = players;
    this.rules = rules;
    this.enforceDecisionBudget = !players.some(p => p.kind === 'human');
    this.speed = players.some(p => p.kind === 'human') ? 1 : rules.speed;
    this.headless = !players.some(p => p.kind === 'human') && rules.headless;
    this.humanAction = { ...IDLE };
    this.simRate = 1;
    this.slowDevice = false;
    this.recording = null;
    this.world = new ArenaWorld(players, {
      timeout: rules.timeout, powerups: rules.powerups, wallBreak: rules.wallBreak,
      mapStyle: rules.map === 'random' ? undefined : rules.map, recording: true, seed,
    });
    const recordingId = crypto.randomUUID();
    this.recorder = new MatchRecording(this.world, {
      id: recordingId, sessionId: recordingId, round, entrants: players,
      detail: players.some(p => p.kind === 'human') || rules.detailRecording,
    });
    this.bots = players.filter(p => p.kind === 'ai').map(p => new BotSandbox(p, {
      enforceDecisionBudget: this.enforceDecisionBudget,
    }));
    const world = this.world, bots = this.bots;
    this.update('loading');
    this.render(session);
    const initialized = await Promise.all(bots.map(bot => this.call(bot,
      () => bot.start(world.botSeedFor(bot.entrant.id)))));
    if (session !== this.session) return;
    this.applyFaults(initialized);
    if (world.result) { this.finish(); return; }
    this.resetPacing();
    this.update('running');
    // start 只等待初始化，结束结果由 onEnd 交付。
    this.running = this.run(session, world, bots).catch(error => {
      if (session !== this.session) return;
      this.bots.forEach(bot => bot.dispose());
      this.humanAction = { ...IDLE };
      this.update('error');
      this.onNotice(`对局已停止：${error.message}`);
    });
  }

  setHumanAction(action) {
    this.humanAction = {
      move: action.move ?? 0, turn: action.turn ?? 0,
      fire: !!action.fire, special: !!action.special,
    };
  }

  setPlayback(speed, headless) {
    this.speed = speed;
    this.headless = headless;
    if (this.world) this.resetPacing();
    this.update();
  }

  async call(bot, fn) {
    try { return { id: bot.entrant.id, action: await fn() }; }
    catch (error) {
      bot.dispose();
      const code = error.code || 'script_error';
      return { id: bot.entrant.id, action: IDLE, fault: {
        code, message: error.message, elapsedMs: error.elapsedMs,
        timeout: code.endsWith('_timeout'),
      } };
    }
  }

  applyFaults(replies) {
    for (const { id, fault } of replies) {
      if (!fault) continue;
      this.world.forfeit(id, fault);
      const name = this.players.find(p => p.id === id).name;
      const timing = fault.code === 'decision_timeout'
        ? '单次决策超过正式 50 ms 预算（浏览器计时也可能受设备抢占影响）'
        : fault.code === 'queue_timeout'
          ? '执行实例排队/启动未响应，可能是设备负载或浏览器限制，并非已测得决策超过 50 ms'
          : fault.code === 'unresponsive_timeout'
            ? '执行后未返回，已终止本选手；可能是脚本卡死或设备无法及时响应'
            : fault.message;
      this.onNotice(`${name}：${timing}。本局判负，其他选手继续。`);
    }
    // 所有本 Tick 故障先一起处理，胜负不依赖 Worker 消息到达顺序。
    this.world.settle();
    if (replies.some(reply => reply.fault)) {
      this.recorder.capture(this.world, {}, replies.filter(reply => reply.fault));
    }
  }

  resetPacing() {
    const now = performance.now();
    this.due = now;
    this.sampleTime = now;
    this.sampleTick = this.world.tick;
    this.lastUpdate = now;
  }

  async waitForResume(session) {
    if (this.status === 'paused') await new Promise(resolve => { this.resumeWait = resolve; });
    return session === this.session && this.status === 'running';
  }

  async run(session, world, bots) {
    while (session === this.session && !world.result) {
      if (!(await this.waitForResume(session))) return;
      // 所有 AI 观察同一个 Tick；全部回复后才推进一次固定 1/60 秒物理。
      const replies = await Promise.all(bots.map(bot => {
        const alive = world.actors.find(actor => actor.id === bot.entrant.id).tank.alive;
        return alive ? this.call(bot, () => bot.decide(observe(world, bot.entrant.id)))
          : { id: bot.entrant.id, action: IDLE };
      }));
      if (!(await this.waitForResume(session))) return;
      const actions = Object.fromEntries(replies.map(reply => [reply.id, reply.action]));
      for (const player of this.players) {
        if (player.kind === 'human') actions[player.id] = { ...this.humanAction };
      }
      if (replies.some(reply => reply.fault)) this.applyFaults(replies);
      if (world.result) break;
      world.step(actions);
      this.recorder.capture(world, actions);
      this.renderer.consume(world, this.headless);

      const now = performance.now();
      if (now - this.sampleTime >= 2000) {
        this.simRate = (world.tick - this.sampleTick) * DT * 1000 / (now - this.sampleTime);
        const slow = !this.headless && this.simRate < this.speed * 0.85;
        if (slow !== this.slowDevice) {
          this.slowDevice = slow;
          this.onNotice(slow
            ? `当前模拟速度 ${this.simRate.toFixed(2)}×，目标 ${this.speed}×。物理仍为固定 60 Hz，弹速与碰撞不变。${this.enforceDecisionBudget ? 'AI 对战保留 50 ms 决策预算。' : '真人游玩不因 AI 决策超过 50 ms 判负。'}`
            : '已达到所选观战速度。');
        }
        this.sampleTime = now;
        this.sampleTick = world.tick;
      }
      if (now - this.lastUpdate >= 100) { this.lastUpdate = now; this.update(); }
      // 设备较慢时放慢模拟时间，不跳过物理 Tick，也不在恢复后突发追帧。
      if (!this.headless) {
        this.due = Math.max(this.due + DT * 1000 / this.speed, now);
        const wait = this.due - performance.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
      }
    }
    if (session === this.session && world.result) this.finish();
  }

  render(session) {
    let previousTick = this.world.tick;
    let previousFrame = performance.now();
    const draw = now => {
      if (session !== this.session) return;
      const elapsed = (this.world.tick - previousTick) * DT;
      const renderDt = (now - previousFrame) / 1000;
      previousTick = this.world.tick;
      previousFrame = now;
      if (!this.headless) this.renderer.draw(this.world, elapsed, this.status !== 'running', renderDt);
      this.frame = requestAnimationFrame(draw);
    };
    this.frame = requestAnimationFrame(draw);
  }

  finish() {
    this.bots.forEach(bot => bot.dispose());
    this.humanAction = { ...IDLE };
    this.recording = this.recorder.finish(this.world);
    this.recorder = null;
    this.update('finished');
    this.onEnd(this.world.result);
  }

  pause() {
    this.humanAction = { ...IDLE };
    if (this.status === 'running') this.update('paused');
  }

  resume() {
    if (this.status !== 'paused') return;
    this.resetPacing();
    this.update('running');
    this.resumeWait?.();
    this.resumeWait = null;
  }

  stop() {
    this.session++;
    if (this.recorder) {
      this.recording = this.recorder.finish(this.world, { aborted: true });
      this.recorder = null;
    }
    this.humanAction = { ...IDLE };
    this.bots.forEach(bot => bot.dispose());
    this.bots = [];
    this.resumeWait?.();
    this.resumeWait = null;
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.update('stopped');
  }
}
