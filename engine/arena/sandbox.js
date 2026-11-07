// 50 ms 只测 Worker 内 update + 动作字段读取；排队/回传不计入正式预算。
// 浏览器不提供线程 CPU 时钟，调用期间的 OS 抢占仍可能进入 elapsedMs。
export const LIMITS = { decisionMs: 50, replyMs: 250, initMs: 2000, queueMs: 2000 };
export const IDLE = Object.freeze({ move: 0, turn: 0, fire: false, special: false });

// 只在不透明来源的 iframe 所创建的 Web Worker 内运行。
function workerMain(createRng) {
  const send = globalThis.postMessage.bind(globalThis);
  const now = performance.now.bind(performance);
  const compile = Function;
  let source, update, budget;
  // 参赛接口是同步纯 JS；不提供后台任务、子 Worker 或外部通信。
  for (const key of ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'Worker', 'SharedWorker',
    'BroadcastChannel', 'importScripts', 'setTimeout', 'setInterval']) {
    Object.defineProperty(globalThis, key, { value: undefined, writable: false, configurable: false });
  }
  function reset() {
    const module = { exports: {} };
    compile('module', 'exports', '"use strict";\n' + source)(module, module.exports);
    const bot = module.exports;
    if (!bot || typeof bot.update !== 'function') throw new Error('脚本必须导出 module.exports = { update(state) { ... } }');
    update = bot.update.bind(bot);
  }
  globalThis.onmessage = ({ data }) => {
    // 宿主收到此消息才启动“执行未返回”的硬终止计时。
    send({ phase: 'started' });
    let start;
    try {
      if (data.type === 'init') {
        source = data.source;
        budget = data.budget;
        if (data.seed !== undefined) Math.random = createRng(data.seed);
        reset();
        send({ ok: true });
      }
      else {
        start = now();
        const action = update(data.state);
        // 取字段也纳入预算；带有死循环 getter 的返回值仍由宿主超时终止。
        if (!action || typeof action !== 'object' || typeof action.then === 'function' || Array.isArray(action)) {
          throw new Error('update 必须同步返回动作对象');
        }
        const result = { move: action.move ?? 0, turn: action.turn ?? 0, fire: action.fire ?? false, special: action.special ?? false };
        const elapsedMs = now() - start;
        if (elapsedMs > budget) {
          send({ error: `决策用时 ${elapsedMs.toFixed(1)} ms，超过 ${budget} ms 预算`, code: 'decision_timeout', elapsedMs });
        } else send({ action: result, elapsedMs });
      }
    } catch (error) {
      const elapsedMs = start === undefined ? undefined : now() - start;
      const timeout = elapsedMs > budget;
      send({ error: timeout ? `决策用时 ${elapsedMs.toFixed(1)} ms，超过 ${budget} ms 预算` : String(error?.message || error).slice(0, 800),
        code: timeout ? 'decision_timeout' : 'script_error', elapsedMs });
    }
  };
}

// 可信中继只持有本选手 Worker。使用专属 MessagePort，不接受其他选手消息。
function frameMain() {
  window.onmessage = event => {
    if (event.source !== parent || !event.ports[0]) return;
    window.onmessage = null;
    const port = event.ports[0];
    const url = URL.createObjectURL(new Blob([event.data.worker], { type: 'text/javascript' }));
    const worker = new Worker(url);
    URL.revokeObjectURL(url);
    port.onmessage = e => {
      if (e.data.type === 'terminate') { worker.terminate(); port.close(); }
      else worker.postMessage(e.data);
    };
    worker.onmessage = e => port.postMessage(e.data);
    worker.onerror = e => { e.preventDefault(); port.postMessage({ error: e.message || 'Worker 执行异常', code: 'script_error' }); };
    port.postMessage({ connected: true });
  };
}

function validateAction(action) {
  if (!action || !Number.isFinite(action.move) || Math.abs(action.move) > 1 ||
    !Number.isFinite(action.turn) || Math.abs(action.turn) > 1 ||
    typeof action.fire !== 'boolean' || typeof action.special !== 'boolean') {
    throw new Error('动作格式错误：move/turn 应为 [-1,1] 有限数值，fire/special 应为布尔值');
  }
  return { move: action.move, turn: action.turn, fire: action.fire, special: action.special };
}

export class BotSandbox {
  constructor(entrant) {
    this.entrant = entrant;
  }

  // 仅固定 Math.random；保留真实 Date / performance 和原有决策计时。
  // 省略 seed 的旧调用保持原生随机；reset() 沿用本实例之前传入的种子。
  async start(seed = this.seed) {
    this.seed = seed;
    this.frame = document.createElement('iframe');
    this.frame.hidden = true;
    this.frame.setAttribute('sandbox', 'allow-scripts');
    // 无同源权限、无文件/网络连接。Blob Worker 继承此 CSP。
    this.frame.srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'"><script>(${frameMain.toString()})()<\/script>`;
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = ({ data }) => this.receive(data);
    const ready = this.waitForReply(LIMITS.initMs, 'connect');
    this.frame.onload = () => this.frame.contentWindow.postMessage({ worker: `(${workerMain.toString()})(${createRng.toString()})` }, '*', [channel.port2]);
    document.body.append(this.frame);
    await ready;
    await this.request({ type: 'init', source: this.entrant.source, seed: this.seed, budget: LIMITS.decisionMs }, LIMITS.initMs);
  }

  receive(data) {
    const pending = this.pending;
    if (!pending) return;
    if (data.phase === 'started') {
      if (!pending.started) {
        pending.started = true;
        this.armTimer(pending, pending.executionMs);
      }
      return;
    }
    clearTimeout(pending.timer);
    this.pending = null;
    if (data.error) {
      pending.reject(Object.assign(new Error(data.error), { code: data.code || 'script_error', elapsedMs: data.elapsedMs }));
    } else pending.resolve(data);
  }

  armTimer(pending, ms) {
    clearTimeout(pending.timer);
    const due = performance.now() + ms;
    pending.timer = setTimeout(() => {
      if (this.pending !== pending) return;
      // 宿主定时器本身严重迟到时，给恢复后已排队的回复一次派发机会。
      // 不重新执行脚本，不增加 Worker 内的 50 ms 决策预算。
      if (!pending.resumeGrace && performance.now() - due > LIMITS.decisionMs) {
        pending.resumeGrace = true;
        this.armTimer(pending, LIMITS.replyMs);
        return;
      }
      this.pending = null;
      const code = !pending.started ? 'queue_timeout' : pending.type === 'init' ? 'init_timeout' : 'unresponsive_timeout';
      const message = !pending.started ? '执行实例排队或启动后未响应' : pending.type === 'init'
        ? `脚本初始化 ${LIMITS.initMs} ms 内未返回` : `Worker 开始执行后 ${LIMITS.replyMs} ms 内未返回（硬终止）`;
      this.dispose();
      pending.reject(Object.assign(new Error(message), { code }));
    }, ms);
  }

  waitForReply(executionMs, type) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject, executionMs, type, started: false, resumeGrace: false };
      this.armTimer(this.pending, LIMITS.queueMs);
    });
  }
  request(message, ms = LIMITS.replyMs) {
    const reply = this.waitForReply(ms, message.type);
    this.port.postMessage(message);
    return reply;
  }
  async reset(seed = this.seed) { this.dispose(); await this.start(seed); }
  async decide(state) { return validateAction((await this.request({ type: 'tick', state })).action); }
  dispose() {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('比赛已停止'));
      this.pending = null;
    }
    this.port?.postMessage({ type: 'terminate' });
    this.port?.close();
    this.frame?.remove();
  }
}
import { createRng } from '../rng.js';

