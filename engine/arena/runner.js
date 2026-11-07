import { ArenaWorld, DT } from './world.js';
import { observe } from './observation.js';
import { BotSandbox, IDLE } from './sandbox.js';
import { MatchRecording } from './recording.js';

export class MatchRunner {
  constructor({ onChange, onStep, onResult, onError, onForfeit = () => {}, onRecording = async () => {},
    makeWorld = (entrants, options) => new ArenaWorld(entrants, options),
    makeRecording = (world, options) => new MatchRecording(world, options) }) {
    Object.assign(this, { onChange, onStep, onResult, onError, onForfeit, onRecording, makeWorld, makeRecording });
    this.status = 'idle';
    this.completed = 0;
    this.world = null;
    this.speed = 1;
    this.headless = false;
    this.bots = [];
  }
  setStatus(status) { this.status = status; this.onChange(); }
  get active() { return ['loading', 'running', 'paused'].includes(this.status); }

  async start(entrants, options) {
    this.entrants = entrants;
    this.options = options;
    this.completed = 0;
    this.world = null;
    this.bots = entrants.map(p => new BotSandbox(p));
    this.setStatus('loading');
    try {
      if (options.recording) {
        this.sessionId = crypto.randomUUID();
        this.recordingEntrants = await Promise.all(entrants.map(async p => ({
          id: p.id, name: p.name, color: p.color, filename: p.filename, updatedAt: p.updatedAt,
          versionId: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.source))),
            n => n.toString(16).padStart(2, '0')).join(''),
        })));
      }
      await this.run();
    } catch (error) {
      if (this.status === 'stopped') return;
      this.bots.forEach(b => b.dispose());
      await this.finishRecording(true);
      this.setStatus('error');
      await this.onError(error);
    }
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
    for (const reply of replies) {
      if (!reply.fault) continue;
      this.world.forfeit(reply.id, reply.fault);
      const entrant = this.entrants.find(p => p.id === reply.id);
      this.onForfeit({ ...reply.fault, entrantId: reply.id, name: entrant.name, round: this.completed + 1 });
    }
    // 同批异常全部淘汰后再判胜负，避免消息先后顺序给某人制造胜场。
    this.world.settle();
    this.onChange();
  }

  async waitWhilePaused() {
    if (this.status === 'paused') await new Promise(resolve => { this.resumeWait = resolve; });
    return this.active;
  }

  async run() {
    while (this.active) {
      if (!(await this.waitWhilePaused())) return;
      this.world = this.makeWorld(this.entrants, this.options);
      this.recorder = this.options.recording ? this.makeRecording(this.world, {
        id: `${this.sessionId}-${this.completed + 1}`, sessionId: this.sessionId,
        round: this.completed + 1, entrants: this.recordingEntrants, detail: this.options.detailRecording,
      }) : null;
      const initialized = await Promise.all(this.bots.map(bot => this.call(bot,
        () => this.completed > 0 ? bot.reset() : bot.start())));
      if (!(await this.waitWhilePaused())) return;
      if (this.status === 'loading') this.setStatus('running');
      this.applyFaults(initialized);
      if (initialized.some(reply => reply.fault)) this.recorder?.capture(this.world, {}, initialized.filter(reply => reply.fault));
      let due = performance.now();
      this.onChange();
      while (!this.world.result) {
        if (!(await this.waitWhilePaused())) return;
        // 每个观察来自同一 Tick，所有动作到齐才推进物理。
        const commands = await Promise.all(this.bots.map(async bot => {
          const alive = this.world.actors.find(p => p.id === bot.entrant.id).tank.alive;
          return alive ? this.call(bot, () => bot.decide(observe(this.world, bot.entrant.id))) : { id: bot.entrant.id, action: IDLE };
        }));
        if (!(await this.waitWhilePaused())) return;
        const actions = Object.fromEntries(commands.map(reply => [reply.id, reply.action]));
        if (commands.some(reply => reply.fault)) {
          this.applyFaults(commands);
          this.recorder?.capture(this.world, actions, commands.filter(reply => reply.fault));
        }
        if (this.world.result) break;
        this.world.step(actions);
        this.recorder?.capture(this.world, actions);
        this.onStep();
        if (!this.headless) {
          due = Math.max(due, performance.now() - 100) + DT * 1000 / this.speed;
          const wait = due - performance.now();
          if (wait > 1) await new Promise(resolve => setTimeout(resolve, wait));
        }
      }
      // step 的 result 缓存和此唯一出口保证暂停/继续不会重复计分。
      this.completed++;
      const recording = this.recorder?.finish(this.world);
      this.recorder = null;
      await this.onResult(this.world.result);
      if (recording) await this.onRecording(recording);
      this.onChange();
      if (!this.active) return;
      if (this.options.rounds && this.completed >= this.options.rounds) break;
      if (!this.headless) await new Promise(resolve => setTimeout(resolve, 700 / this.speed));
    }
    if (!this.active) return;
    this.bots.forEach(b => b.dispose());
    this.setStatus('finished');
  }

  pause() { if (this.status === 'running') this.setStatus('paused'); }
  resume() { if (this.status === 'paused') { this.setStatus('running'); this.resumeWait?.(); this.resumeWait = null; } }
  stop() {
    this.setStatus('stopped');
    this.resumeWait?.(); this.resumeWait = null;
    this.bots.forEach(b => b.dispose());
    void this.finishRecording(true);
  }

  async finishRecording(aborted) {
    if (!this.recorder) return;
    const recording = this.recorder.finish(this.world, { aborted });
    this.recorder = null;
    await this.onRecording(recording);
  }
}
