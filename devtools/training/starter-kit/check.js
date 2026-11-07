#!/usr/bin/env node
// 独立入口/动作检查器。只读取参赛脚本和本包示例；不加载游戏引擎。
// vm 用于有限时的格式检查，不是恶意代码的安全边界。运行自己的脚本即可。
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log('用法：node check.js [bot.js] [state.json]\n缺省使用本包 bot.js 和 example_state.json。只做一次公开状态调用，不模拟对战。');
    process.exit(0);
  }
  const file = path.resolve(process.argv[2] || path.join(__dirname, 'bot.js'));
  const stateFile = path.resolve(process.argv[3] || path.join(__dirname, 'example_state.json'));
  try {
    const worker = new Worker(__filename, { workerData: {
      source: fs.readFileSync(file, 'utf8'),
      state: JSON.parse(fs.readFileSync(stateFile, 'utf8')),
    } });
    const timer = setTimeout(() => { console.error('不通过：脚本未及时返回，已终止检查。'); worker.terminate(); process.exitCode = 1; }, 2500);
    worker.on('message', result => {
      clearTimeout(timer);
      if (result.error) { console.error('不通过：' + result.error); process.exitCode = 1; }
      else { console.log('通过：update 入口与示例状态调用成功，动作格式合法。'); console.log(JSON.stringify(result.action)); console.log('这不是对战模拟或性能保证；正式单次决策预算为 50 ms，超时仅该选手本局判负。'); }
      worker.terminate();
    });
    worker.on('error', error => { clearTimeout(timer); console.error('不通过：' + error.message); process.exitCode = 1; });
  } catch (error) { console.error('不通过：' + error.message); process.exitCode = 1; }
} else {
  try {
    const context = vm.createContext({}, { codeGeneration: { strings: false, wasm: false } });
    new vm.Script('const module = {exports:{}}; (function(module, exports) { "use strict";\n' + workerData.source + '\n})(module, module.exports);').runInContext(context, { timeout: 2000 });
    const program = new vm.Script(`(() => {
      if (!module.exports || typeof module.exports.update !== 'function') throw new Error('必须导出 module.exports = { update(state) { ... } }');
      const state = ${JSON.stringify(workerData.state)};
      const action = module.exports.update(state);
      if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.then === 'function') throw new Error('update 必须同步返回动作对象');
      const result = { move: action.move ?? 0, turn: action.turn ?? 0, fire: action.fire ?? false, special: action.special ?? false };
      if (!Number.isFinite(result.move) || Math.abs(result.move) > 1 || !Number.isFinite(result.turn) || Math.abs(result.turn) > 1) throw new Error('move 和 turn 必须为 [-1,1] 内有限数值');
      if (typeof result.fire !== 'boolean' || typeof result.special !== 'boolean') throw new Error('fire 和 special 必须为布尔值');
      return JSON.stringify(result);
    })()`);
    const action = JSON.parse(program.runInContext(context, { timeout: 50 }));
    parentPort.postMessage({ action });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
}
