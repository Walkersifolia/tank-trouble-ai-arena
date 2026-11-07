// 独立 Electron 入口：只注册训练 IPC，不加载正式名册、排行榜或回放存储。
const { app, BrowserWindow, ipcMain } = require('electron');
const http = require('node:http');
const fs = require('node:fs/promises');
const { createReadStream, writeFileSync, existsSync } = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const { gzip, gunzip } = require('node:zlib');
const { pipeline } = require('node:stream/promises');
const { createRecordingStore } = require('./recordings.cjs');

const ROOT = path.resolve(__dirname, '../../..');
const DATA = process.env.TRAINING_DATA_DIR || path.join(ROOT, 'local-data', 'training');
const JOBS = path.join(DATA, 'jobs');
const CUSTOM_OPPONENTS = path.join(DATA, 'custom-opponents.json');
const PORT = Number(process.env.TRAINING_PORT || 4765);
const compress = promisify(gzip), decompress = promisify(gunzip);
const jobs = new Map();
let win, server, token, opponents, active = null, replay = null;
app.setPath('userData', path.join(DATA, 'electron'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const jobDirectory = id => {
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(id)) fail(404, '任务不存在');
  const directory = path.resolve(JOBS, id);
  if (path.dirname(directory) !== JOBS) fail(404, '任务不存在');
  return directory;
};
const statusView = job => ({ id: job.id, status: job.status, createdAt: job.createdAt,
  finishedAt: job.finishedAt, completed: job.rounds.length, total: job.total,
  progress: job.progress, error: job.error });
const saveJob = job => fs.writeFile(path.join(jobDirectory(job.id), 'job.json'), JSON.stringify(job));
const getJob = id => { jobDirectory(id); return jobs.get(id) || fail(404, '任务不存在'); };
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function body(req) {
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 1024 * 1024) fail(413, '请求最多 1 MiB');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, '请求必须是 JSON'); }
}

function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '请求必须是对象');
  const allowed = new Set(['source', 'name', 'opponents', 'rounds', 'seed', 'swapSpawns', 'powerups', 'detailLimit']);
  if (Object.keys(input).some(key => !allowed.has(key))) fail(400, '请求含未知参数；不接受服务端路径或规则覆盖');
  if (typeof input.source !== 'string' || !input.source.trim() || Buffer.byteLength(input.source) > 512 * 1024) fail(400, '脚本必须为非空 JS 文本，最多 512 KiB');
  if (!Array.isArray(input.opponents) || !input.opponents.length || input.opponents.length > 4 ||
    input.opponents.some(id => !opponents.some(p => p.id === id))) fail(400, '请选择 1–4 个已添加的对手 ID；使用 opponents 查询');
  const ids = [...new Set(input.opponents)];
  const rounds = input.rounds ?? 100, seed = input.seed ?? randomBytes(4).readUInt32LE(), detailLimit = input.detailLimit ?? 0;
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 1000) fail(400, '每个对手场数须为 1–1000');
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail(400, 'seed 须为 uint32 整数');
  if (!Number.isInteger(detailLimit) || detailLimit < 0 || detailLimit > 5) fail(400, 'detailLimit 须为 0–5');
  if (input.swapSpawns !== undefined && typeof input.swapSpawns !== 'boolean') fail(400, 'swapSpawns 须为布尔值');
  if (input.powerups !== undefined && typeof input.powerups !== 'boolean') fail(400, 'powerups 须为布尔值');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)) fail(400, 'name 须为 1–100 字符');
  return { source: input.source, name: input.name || '候选选手', opponents: ids, rounds,
    seed, swapSpawns: input.swapSpawns !== false, powerups: input.powerups !== false, detailLimit };
}

function aggregate(rounds) {
  const output = { matches: rounds.length, wins: 0, losses: 0, draws: 0, winRate: 0,
    kills: 0, suicides: 0, matchTimeouts: 0, decisionTimeouts: 0, executionTimeouts: 0, scriptErrors: 0,
    timeoutBreakdown: { decision_timeout: 0, init_timeout: 0, queue_timeout: 0, unresponsive_timeout: 0 },
    fireRequests: 0, shotsFired: 0, bulletLimitFailures: 0,
    pickups: { laser: 0, scatter: 0, mine: 0, shield: 0 }, totalPickups: 0,
    averageDurationSeconds: 0, wallBlockedTicks: 0, moveReversals: 0, turnReversals: 0,
    longestNoFireSeconds: 0 };
  for (const round of rounds) {
    output[{ win: 'wins', loss: 'losses', draw: 'draws' }[round.outcome]]++;
    if (round.reason === 'timeout') output.matchTimeouts++;
    const stats = round.summary.players.find(p => p.id === 'candidate');
    for (const key of ['kills', 'suicides', 'scriptErrors', 'fireRequests', 'shotsFired', 'wallBlockedTicks', 'moveReversals', 'turnReversals']) output[key] += stats[key];
    output.executionTimeouts += stats.timeouts;
    for (const fault of round.faults) if (fault.id === 'candidate' && fault.timeout) output.timeoutBreakdown[fault.code]++;
    output.bulletLimitFailures += stats.fireBlocked.bullet_limit;
    output.longestNoFireSeconds = Math.max(output.longestNoFireSeconds, stats.longestNoFireSeconds);
    for (const type of Object.keys(output.pickups)) output.pickups[type] += stats.pickups[type];
    output.averageDurationSeconds += round.summary.durationSeconds;
  }
  output.totalPickups = Object.values(output.pickups).reduce((a, b) => a + b, 0);
  output.decisionTimeouts = output.timeoutBreakdown.decision_timeout;
  output.winRate = output.matches ? output.wins / output.matches : 0;
  output.averageDurationSeconds = output.matches ? output.averageDurationSeconds / output.matches : 0;
  return output;
}

function representatives(rounds, limit) {
  const selected = new Map();
  const add = (round, reason) => {
    if (round && !selected.has(round.round) && selected.size < limit) selected.set(round.round, { round: round.round, reason });
  };
  const stats = r => r.summary.players.find(p => p.id === 'candidate');
  add(rounds.find(r => stats(r).suicides > 0), '记录到候选选手自杀');
  add(rounds.find(r => stats(r).timeouts > 0 || stats(r).scriptErrors > 0), '记录到脚本超时或异常');
  add(rounds.find(r => r.outcome === 'loss'), '候选选手败局');
  add(rounds.find(r => r.reason === 'timeout'), '达到单局时限');
  add([...rounds].sort((a, b) => b.summary.players.reduce((n, p) => n + Object.values(p.pickups).reduce((x, y) => x + y, 0), 0) -
    a.summary.players.reduce((n, p) => n + Object.values(p.pickups).reduce((x, y) => x + y, 0), 0))[0], '道具拾取最多的对局（不推断争夺意图）');
  add([...rounds].sort((a, b) => b.summary.durationSeconds - a.summary.durationSeconds)[0], '用时最长的对局');
  for (const round of rounds) add(round, '补充对局');
  return [...selected.values()];
}

function resultView(job) {
  return { schemaVersion: 1, id: job.id, status: job.status, createdAt: job.createdAt, finishedAt: job.finishedAt,
    parameters: job.parameters, rules: job.rules ?? { physicsHz: 60, decisionMs: 50, timeout: 60, powerups: true, wallBreak: true },
    statistics: aggregate(job.rounds), byOpponent: job.parameters.opponents.map(id => ({ id,
      name: job.opponents.find(p => p.id === id).name, ...aggregate(job.rounds.filter(r => r.opponentId === id)) })),
    representativeRounds: representatives(job.rounds, job.parameters.detailLimit), rounds: job.rounds };
}

async function markFailed(message) {
  if (!active) return;
  const job = jobs.get(active); active = null;
  if (!job) return;
  job.status = 'failed'; job.error = message; job.finishedAt = new Date().toISOString();
  await saveJob(job);
}

function registerIPC(ready) {
  const handle = (name, callback) => ipcMain.handle(`training:${name}`, (event, value) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) throw new Error('只允许训练主窗口调用');
    return callback(value);
  });
  handle('ready', ready);
  handle('progress', data => {
    if (data.id !== active) return;
    jobs.get(active).progress = data;
  });
  handle('round', async data => {
    if (data.id !== active) throw new Error('任务已结束');
    const job = jobs.get(active);
    await fs.writeFile(path.join(jobDirectory(job.id), `round-${data.round}.json.gz`),
      await compress(JSON.stringify({ tape: data.tape, metadata: data.metadata })));
    job.rounds.push(data.result);
    await saveJob(job);
  });
  handle('done', async data => {
    if (data.id !== active) return;
    const job = jobs.get(active);
    job.status = 'completed'; job.finishedAt = new Date().toISOString();
    await saveJob(job); active = null;
  });
  handle('failed', async data => {
    if (data.requestId && replay?.requestId === data.requestId) {
      replay.reject(new Error('详细日志生成失败')); replay = null;
    } else await markFailed('训练执行失败；服务端终端可查看原因');
    console.error('训练执行失败：', data.message);
  });
  handle('replayed', data => {
    if (replay?.requestId !== data.requestId) return;
    replay.resolve(data.record); replay = null;
  });
}

async function route(req, res) {
  if (req.headers.authorization !== `Bearer ${token}`) fail(401, '需要正确的训练访问令牌');
  const parts = new URL(req.url, 'http://127.0.0.1').pathname.split('/').filter(Boolean);
  if (parts[0] !== 'v1') fail(404, '接口不存在');
  if (parts[1] === 'opponents' && parts.length === 2 && req.method === 'GET')
    return json(res, 200, { opponents: opponents.map(({ id, name, custom }) => ({ id, name, ...(custom ? { custom: true } : {}) })) });
  if (parts[1] === 'opponents' && parts.length === 2 && req.method === 'POST') {
    const input = await body(req);
    if (active || replay) fail(409, '训练服务正在执行任务，请完成后再添加对手');
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail(400, '请求必须是对象');
    if (Object.keys(input).some(key => !['id', 'name', 'source'].includes(key))) fail(400, '请求只接受 id、name、source；不接受服务端文件路径');
    if (typeof input.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(input.id)) fail(400, 'id 须为 1–64 位英文字母、数字、下划线或连字符');
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100) fail(400, 'name 须为 1–100 字符');
    if (typeof input.source !== 'string' || !input.source.trim() || Buffer.byteLength(input.source) > 512 * 1024) fail(400, '脚本必须为非空 JS 文本，最多 512 KiB');
    if (opponents.some(p => p.id === input.id)) fail(409, '对手 ID 已存在，请使用新的 ID 保存版本');
    const opponent = { id: input.id, name: input.name.trim(), source: input.source, custom: true };
    writeFileSync(CUSTOM_OPPONENTS, JSON.stringify([...opponents.filter(p => p.custom), opponent], null, 2), 'utf8');
    opponents.push(opponent);
    return json(res, 201, { id: opponent.id, name: opponent.name });
  }
  if (parts[1] !== 'jobs') fail(404, '接口不存在');
  if (parts.length === 2 && req.method === 'GET') return json(res, 200, { jobs: [...jobs.values()].map(statusView) });
  if (parts.length === 2 && req.method === 'POST') {
    const input = validateRequest(await body(req));
    if (active || replay) fail(409, '训练服务正在执行任务，请稍后提交');
    if (win.isDestroyed()) fail(503, '训练窗口已结束，请重启服务');
    const id = randomUUID(); active = id;
    try {
      const selected = await Promise.all(input.opponents.map(async id => {
        const config = opponents.find(p => p.id === id);
        return { id, name: config.name, color: '#f78066', source: config.custom ? config.source : await fs.readFile(path.resolve(ROOT, config.file), 'utf8') };
      }));
      const { source, ...parameters } = input;
      const job = { id, status: 'running', createdAt: new Date().toISOString(),
        rules: { physicsHz: 60, decisionMs: 50, timeout: 60, powerups: input.powerups, wallBreak: false },
        parameters, opponents: selected.map(({ id, name }) => ({ id, name })), rounds: [], total: input.rounds * selected.length };
      await fs.mkdir(jobDirectory(id), { recursive: true }); jobs.set(id, job); await saveJob(job);
      win.webContents.send('training:run', { ...input, id, opponents: selected });
      return json(res, 202, statusView(job));
    } catch (error) { await markFailed('无法加载训练对手或保存任务'); active = null; throw error; }
  }
  const job = getJob(parts[2] || '');
  if (parts.length === 3 && req.method === 'GET') return json(res, 200, statusView(job));
  if (parts.length === 3 && req.method === 'DELETE') {
    if (job.status === 'running' || replay?.id === job.id) fail(409, '运行中的任务不能清理');
    await fs.rm(jobDirectory(job.id), { recursive: true }); jobs.delete(job.id);
    return json(res, 200, { deleted: job.id });
  }
  if (parts.length === 4 && parts[3] === 'result' && req.method === 'GET') {
    if (job.status === 'running') fail(409, '任务仍在运行，请先查询状态');
    return json(res, 200, resultView(job));
  }
  if (parts.length === 6 && parts[3] === 'rounds' && parts[5] === 'logs' && req.method === 'GET') {
    const round = Number(parts[4]);
    if (!Number.isInteger(round) || !job.rounds.some(r => r.round === round)) fail(404, '对局不存在');
    if (active || replay) fail(409, '训练服务忙，请在比赛完成后获取日志');
    const requestId = randomUUID();
    const recordPromise = new Promise((resolve, reject) => { replay = { requestId, id: job.id, resolve, reject }; });
    // 先读取指定任务的内部动作记录；客户端永远不能提交路径或重放内容。
    try {
      const saved = JSON.parse((await decompress(await fs.readFile(path.join(jobDirectory(job.id), `round-${round}.json.gz`)))).toString('utf8'));
      win.webContents.send('training:replay', { requestId, id: job.id, round, ...saved });
    } catch (error) { replay = null; throw error; }
    const record = await recordPromise;
    const exported = await createRecordingStore(jobDirectory(job.id)).exportAnalysis(record);
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="round-${round}.zip"`, 'Cache-Control': 'no-store' });
    try { await pipeline(createReadStream(exported.path), res); }
    finally { await fs.unlink(exported.path); }
    return;
  }
  fail(404, '接口不存在');
}

async function main() {
  await fs.mkdir(JOBS, { recursive: true });
  const tokenPath = path.join(DATA, 'access-token');
  try { token = (await fs.readFile(tokenPath, 'utf8')).trim(); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('hex'); await fs.writeFile(tokenPath, token, { mode: 0o600 });
  }
  const localOpponents = path.join(DATA, 'opponents.json');
  const opponentsFile = existsSync(localOpponents) ? localOpponents : path.join(__dirname, '..', 'opponents.json');
  opponents = JSON.parse(await fs.readFile(opponentsFile, 'utf8'));
  try { opponents.push(...JSON.parse(await fs.readFile(CUSTOM_OPPONENTS, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of await fs.readdir(JOBS, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{8}-[0-9a-f-]{27}$/.test(entry.name)) continue;
    const job = JSON.parse(await fs.readFile(path.join(jobDirectory(entry.name), 'job.json'), 'utf8'));
    if (job.status === 'running') {
      job.status = 'failed'; job.error = '上次服务退出时训练未完成'; await saveJob(job);
    }
    jobs.set(job.id, job);
  }
  let ready;
  const loaded = new Promise(resolve => { ready = resolve; });
  registerIPC(ready);
  win = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false,
    preload: path.join(__dirname, 'training-preload.cjs'),
  } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('render-process-gone', async () => {
    if (replay) { replay.reject(new Error('训练执行进程已退出，请重启服务')); replay = null; }
    await markFailed('训练执行进程已退出，请重启服务');
  });
  await win.loadFile(path.join(__dirname, '..', 'runtime', 'index.html'));
  await loaded;
  server = http.createServer((req, res) => {
    route(req, res).catch(error => {
      if (!error.status) console.error('训练服务错误：', error);
      if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务端处理失败，请查看服务端终端' });
      else res.destroy();
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve); });
  console.log(`训练服务已启动：http://127.0.0.1:${PORT}\n训练访问令牌：${token}\n客户端 config.json：${JSON.stringify({ url: `http://127.0.0.1:${PORT}`, token })}\n按 Ctrl+C 退出；未完成任务在重启后标记失败。`);
}

app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.close());
process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());
