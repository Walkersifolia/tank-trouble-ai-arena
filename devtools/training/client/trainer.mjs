#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, basename, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const clientDir = dirname(fileURLToPath(import.meta.url));
const help = `Tank Trouble AI Training Client（需要 Node.js 18 或以上）

  node trainer.mjs opponents
  node trainer.mjs opponent-add --bot ./workspace/bot-v1.js --id my-v1 --name 我的v1
  node trainer.mjs run --bot ./candidate.js --opponent <对手ID> --rounds 10
  node trainer.mjs run --bot ./candidate.js --opponent <ID1,ID2> --seed 20261106 --logs representative
  node trainer.mjs run --bot ./workspace/bot-v2.js --opponent my-v1 --rounds 100
  node trainer.mjs status <jobId>
  node trainer.mjs result <jobId> [--out ./results]
  node trainer.mjs logs <jobId> --round 1 [--out ./round-1.zip]
  node trainer.mjs list
  node trainer.mjs delete <jobId>

opponent-add 参数：
  --bot <path>             要保存为个人对手的 JS 文件，只提交脚本文本
  --id <id>               唯一版本 ID，1–64 位英文字母、数字、下划线或连字符
  --name <name>           显示名称，1–100 字符；包含空格时加引号
  个人对手保存在本地训练服务，添加后可立即参赛，重启后仍保留。
  已有 ID 不覆盖；保存新版本请使用新的 ID。

run 参数：
  --bot <path>             当前工作区中的单个 JS 选手文件
  --opponent <id[,id]>     对手 ID；可重复传入
  --rounds <n>             每个对手的比赛场数（默认 10）
  --seed <uint32>          基础随机种子（省略则随机生成，并记录在结果中）
  --no-swap-spawns         不交替交换出生位置（默认交换）
  --powerups on|off        道具开关（默认 on）；off 为纯走位与普通开火，墙体始终不可破坏
  --logs none|representative  是否自动导出代表性对局（默认 none）
  --log-limit <0..5>       代表性日志数量（详细模式默认 3）
  --out <directory>       保存目录（默认 ./training-results/<jobId>）
  --no-wait               提交后立即退出；稍后使用 status/result/logs

连接：TRAINER_CONFIG 指定配置文件，默认同目录 config.json；TRAINER_URL、TRAINER_TOKEN 优先。
默认地址：http://127.0.0.1:4765。结果 JSON 写 stdout，进度与文件位置写 stderr。
`;

function parseArgs(argv) {
  const positional = [];
  const options = {};
  const flags = new Set(['help', 'no-wait', 'no-swap-spawns']);
  const values = new Set(['bot', 'opponent', 'round', 'rounds', 'seed', 'powerups', 'logs', 'log-limit', 'out', 'id', 'name']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h') { options.help = true; continue; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const key = arg.slice(2);
    if (flags.has(key)) { options[key] = true; continue; }
    if (!values.has(key)) throw new Error(`未知参数：${arg}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`);
    if (key === 'opponent') (options.opponents ??= []).push(...value.split(',').filter(Boolean));
    else options[key] = value;
  }
  return { positional, options };
}

function integer(value, name, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} 必须为 ${min} 至 ${max} 的整数`);
  }
  return number;
}

function print(value) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }
function note(message) { process.stderr.write(`${message}\n`); }
function jobPath(id) { return `/v1/jobs/${encodeURIComponent(id)}`; }
function outputDir(options, id) { return resolve(options.out ?? join('training-results', id)); }
async function saveJson(directory, name, value) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [command, id] = positional;
  if (!command || options.help || command === 'help') { process.stdout.write(help); return; }
  if (!['opponents', 'opponent-add', 'run', 'status', 'result', 'logs', 'list', 'delete'].includes(command)) {
    throw new Error(`未知命令：${command}；使用 --help 查看说明`);
  }
  if (['status', 'result', 'logs', 'delete'].includes(command) && !id) {
    throw new Error(`${command} 命令需要 jobId`);
  }

  let config = {};
  try { config = JSON.parse(await readFile(process.env.TRAINER_CONFIG || join(clientDir, 'config.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取 config.json，请确认文件内容是有效 JSON'); }
  const serverUrl = (process.env.TRAINER_URL || config.url || 'http://127.0.0.1:4765').replace(/\/+$/, '');
  const token = process.env.TRAINER_TOKEN || config.token;
  if (!token) throw new Error('尚未配置连接令牌：设置 TRAINER_TOKEN，或在客户端 config.json 中填写服务端提供的 token');

  async function request(path, { method = 'GET', body, binary = false } = {}) {
    let response;
    try {
      response = await fetch(`${serverUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error('无法连接训练服务，请确认服务已启动且连接地址正确');
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      const message = typeof error.error === 'string' ? error.error : error.message || `HTTP ${response.status}`;
      throw new Error(`训练服务返回 ${response.status}：${String(message).replaceAll(token, '[令牌已隐藏]')}`);
    }
    return binary ? Buffer.from(await response.arrayBuffer()) : response.json();
  }

  async function downloadLog(jobId, round, destination) {
    const data = await request(`${jobPath(jobId)}/rounds/${round}/logs`, { binary: true });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, data);
    note(`已保存详细日志：${destination}`);
    return destination;
  }

  if (command === 'opponents') { print(await request('/v1/opponents')); return; }
  if (command === 'opponent-add') {
    if (!options.bot) throw new Error('opponent-add 命令需要 --bot <JS 文件>');
    if (!options.id) throw new Error('opponent-add 命令需要 --id <版本 ID>');
    if (!options.name) throw new Error('opponent-add 命令需要 --name <显示名称>');
    print(await request('/v1/opponents', { method: 'POST', body: {
      id: options.id, name: options.name, source: await readFile(resolve(options.bot), 'utf8'),
    } }));
    return;
  }
  if (command === 'list') { print(await request('/v1/jobs')); return; }
  if (command === 'status') { print(await request(jobPath(id))); return; }
  if (command === 'delete') { print(await request(jobPath(id), { method: 'DELETE' })); return; }
  if (command === 'result') {
    const result = await request(`${jobPath(id)}/result`);
    const directory = outputDir(options, id);
    await saveJson(directory, 'result.json', result);
    note(`已保存成绩：${join(directory, 'result.json')}`);
    print(result);
    return;
  }
  if (command === 'logs') {
    if (options.round === undefined) throw new Error('logs 命令需要 --round <round>');
    const round = integer(options.round, '--round', 1, Number.MAX_SAFE_INTEGER);
    const file = resolve(options.out ?? join('training-results', id, `round-${round}.zip`));
    await downloadLog(id, round, file);
    print({ id, round, file });
    return;
  }

  if (!options.bot) throw new Error('run 命令需要 --bot <JS 文件>');
  if (!options.opponents?.length) throw new Error('run 命令需要 --opponent <对手 ID>；先用 opponents 查询可用对手');
  const logs = options.logs ?? (options['log-limit'] === undefined ? 'none' : 'representative');
  if (!['none', 'representative'].includes(logs)) throw new Error('--logs 只能是 none 或 representative');
  const detailLimit = logs === 'none' ? 0 : integer(options['log-limit'] ?? 3, '--log-limit', 0, 5);
  const powerups = options.powerups ?? 'on';
  if (!['on', 'off'].includes(powerups)) throw new Error('--powerups 只能是 on 或 off');
  const body = {
    source: await readFile(resolve(options.bot), 'utf8'),
    name: basename(options.bot),
    opponents: [...new Set(options.opponents)],
    rounds: integer(options.rounds ?? 10, '--rounds', 1, Number.MAX_SAFE_INTEGER),
    seed: options.seed === undefined ? randomBytes(4).readUInt32LE() : integer(options.seed, '--seed', 0, 0xffffffff),
    swapSpawns: !options['no-swap-spawns'],
    powerups: powerups === 'on',
    detailLimit,
  };
  let status = await request('/v1/jobs', { method: 'POST', body });
  const directory = outputDir(options, status.id);
  await saveJson(directory, 'status.json', status);
  note(`已提交任务 ${status.id}，seed=${body.seed}，每个对手 ${body.rounds} 局`);
  if (options['no-wait']) { print(status); return; }

  let previousProgress = '';
  while (!['completed', 'failed'].includes(status.status)) {
    const progress = JSON.stringify(status.progress ?? status.status);
    if (progress !== previousProgress) { note(`任务 ${status.id}：${progress}`); previousProgress = progress; }
    await delay(1000);
    status = await request(jobPath(status.id));
  }
  await saveJson(directory, 'status.json', status);
  if (status.status === 'failed') {
    print(status);
    throw new Error(`训练任务 ${status.id} 失败，原因见 status.json`);
  }
  const result = await request(`${jobPath(status.id)}/result`);
  await saveJson(directory, 'result.json', result);
  note(`已保存成绩：${join(directory, 'result.json')}`);
  if (detailLimit > 0) {
    for (const entry of (result.representativeRounds ?? []).slice(0, detailLimit)) {
      await downloadLog(status.id, entry.round, join(directory, `round-${entry.round}.zip`));
    }
  }
  print(result);
}

main().catch(error => { note(`错误：${error.message}`); process.exitCode = 1; });
