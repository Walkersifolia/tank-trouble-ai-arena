// Local season state and lightweight, shared Pages exports. No browser-local scores are read.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import { loadEntrant, runMatch, RULES } from '../devtools/matches/run.mjs';
import { LIMITS } from '../engine/arena/sandbox.js';
import { DT } from '../engine/arena/world.js';
import { createSchedule } from './schedule.mjs';
import { aggregateSeason } from './scoring.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL = join(ROOT, 'local-data', 'leaderboard');
const PUBLIC = join(ROOT, 'leaderboard', 'data');
const TOOL_FILES = ['leaderboard/season.mjs', 'leaderboard/cli.mjs', 'leaderboard/schedule.mjs', 'leaderboard/scoring.mjs'];
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const load = filename => JSON.parse(readFileSync(filename, 'utf8'));
const paths = id => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('赛季 ID 只能包含英文字母、数字、短横线和下划线。');
  const directory = join(LOCAL, id);
  return { directory, manifest: join(directory, 'season.json'), records: join(directory, 'matches.jsonl'),
    state: join(directory, 'run.json'), pause: join(directory, 'pause.request') };
};

function environment() {
  const cpus = os.cpus();
  return { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    osRelease: os.release(), cpu: cpus[0].model.trim(), logicalCpus: cpus.length,
    totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10 };
}

function versionFiles(roster) {
  return ['engine', 'devtools/matches/run.mjs', 'bots/roster.json', ...roster.map(e => e.script), ...TOOL_FILES];
}

function requireSeasonVersion(manifest) {
  if (manifest.kind !== 'official') return;
  const files = versionFiles(manifest.roster);
  git('ls-files', '--error-unmatch', '--', ...TOOL_FILES);
  try { git('diff', '--exit-code', '--quiet', manifest.source.commit, '--', ...files); }
  catch { throw new Error('本赛季的选手、引擎或评测规则已变更。请使用原 Git 版本续跑，或为新版本创建完整新赛季。'); }
  const current = environment();
  for (const key of ['node', 'v8', 'platform', 'arch', 'osRelease', 'cpu', 'logicalCpus']) {
    if (current[key] !== manifest.environment[key]) throw new Error(`运行环境 ${key} 与本赛季不同；请回到原环境续跑，或创建新赛季。`);
  }
}

export function initSeason({ id, label = id, kind = 'official', duelSeeds = 50, ffaGamesPerEntrant = 200,
  seedStart = 20261107, entrants }) {
  if (!['official', 'trial'].includes(kind)) throw new Error('--kind 只能为 official 或 trial。');
  for (const [key, value] of Object.entries({ duelSeeds, ffaGamesPerEntrant, seedStart })) {
    if (!Number.isSafeInteger(value) || value < (key === 'seedStart' ? 0 : 1)) throw new Error(`${key} 必须是${key === 'seedStart' ? '非负' : '正'}整数。`);
  }
  const files = paths(id);
  if (existsSync(files.manifest)) throw new Error(`赛季 ${id} 已存在；使用 run 续跑。`);
  let roster = load(join(ROOT, 'bots', 'roster.json'));
  if (entrants) {
    if (kind !== 'trial') throw new Error('正式赛季必须包含 roster.json 全部公开选手；--entrants 仅供独立试跑。');
    const selected = entrants.split(',');
    if (selected.some(id => !roster.some(e => e.id === id))) throw new Error('--entrants 包含不在公开名单中的选手。');
    roster = roster.filter(e => selected.includes(e.id));
  }
  roster = roster.map(e => {
    const commit = git('log', '-1', '--format=%H', '--', e.script);
    return { id: e.id, name: e.name, codename: e.codename, color: e.color, group: e.group,
      script: e.script.replace(/^\.\//, ''), commit, version: commit.slice(0, 8) };
  });
  const config = { duelSeeds, ffaGamesPerEntrant, seedStart };
  const manifest = { schemaVersion: 1, id, label, kind, createdAt: new Date().toISOString(),
    source: { repository: 'https://github.com/Walkersifolia/tank-trouble-ai-arena', commit: git('rev-parse', 'HEAD'),
      engineCommit: git('log', '-1', '--format=%H', '--', 'engine'),
      runnerCommit: git('log', '-1', '--format=%H', '--', 'devtools/matches/run.mjs'),
      ...(kind === 'trial' ? { tools: '试跑时的工作区工具；不作为正式版本成绩' } : {}) },
    roster, environment: environment(), rules: { ...RULES, physicsHz: 1 / DT, decisionMs: LIMITS.decisionMs,
      hardInterruptionMs: LIMITS.replyMs, initMs: LIMITS.initMs }, config, schedule: createSchedule(roster, config) };
  requireSeasonVersion(manifest);
  mkdirSync(files.directory, { recursive: true });
  save(files.manifest, manifest);
  writeFileSync(files.records, '');
  save(files.state, { status: 'pending', updatedAt: manifest.createdAt });
  return statusSeason(id);
}

export function readSeason(id) {
  const files = paths(id), manifest = load(files.manifest);
  // Only newline-terminated matches have been committed. An interrupted final write is unfinished.
  const buffer = readFileSync(files.records), completeBytes = buffer.lastIndexOf(10) + 1;
  const lines = buffer.subarray(0, completeBytes).toString('utf8').split('\n').filter(Boolean);
  const records = [...new Map(lines.map(line => { const match = JSON.parse(line); return [match.id, match]; })).values()];
  return { files, manifest, records, completeBytes, fileBytes: buffer.length, state: load(files.state) };
}

function isRunning(state) {
  if (state.status !== 'running' || !state.pid) return false;
  try { process.kill(state.pid, 0); return true; } catch { return false; }
}

function reportFor(season) {
  const { manifest, records, state } = season;
  const status = records.length === manifest.schedule.matches.length ? 'complete'
    : isRunning(state) ? 'running' : state.status === 'pending' ? 'pending' : 'paused';
  const report = aggregateSeason(manifest, records, { status, updatedAt: new Date().toISOString() });
  const totalMs = records.reduce((sum, match) => sum + match.elapsedMs, 0);
  const modeMean = mode => {
    const matches = records.filter(match => match.mode === mode);
    return matches.length ? matches.reduce((sum, match) => sum + match.elapsedMs, 0) / matches.length : null;
  };
  const duelMeanMs = modeMean('duel'), ffaMeanMs = modeMean('ffa');
  report.timing = { elapsedMs: totalMs, meanMatchMs: records.length ? totalMs / records.length : null,
    duelMeanMs, ffaMeanMs, estimatedRemainingMs: duelMeanMs === null || ffaMeanMs === null ? null
      : (report.progress.duel.total - report.progress.duel.completed) * duelMeanMs
        + (report.progress.ffa.total - report.progress.ffa.completed) * ffaMeanMs };
  return report;
}

export function statusSeason(id) {
  const report = reportFor(readSeason(id));
  return { id, status: report.status, progress: report.progress, schedule: report.season.schedule, timing: report.timing,
    standings: report.standings.map(({ id, provisionalScores, totals }) => ({ id, provisionalScores, games: totals.games })) };
}

export function exportSeason(id) {
  const season = readSeason(id);
  if (season.manifest.kind !== 'official') throw new Error('试跑不能导出到官方公开榜单；试跑记录留在 local-data/leaderboard/。');
  const report = reportFor(season);
  mkdirSync(PUBLIC, { recursive: true });
  save(join(PUBLIC, `${id}.json`), report);
  const seasons = readdirSync(PUBLIC).filter(name => name !== 'seasons.json' && name.endsWith('.json')).map(name => {
    const value = load(join(PUBLIC, name));
    return { id: value.season.id, label: value.season.label, url: `./data/${name}`,
      updatedAt: value.updatedAt, status: value.status, createdAt: value.season.createdAt };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  save(join(PUBLIC, 'seasons.json'), { schemaVersion: 1, seasons });
  return { id, status: report.status, progress: report.progress, output: `leaderboard/data/${id}.json` };
}

export function pauseSeason(id) {
  const files = paths(id);
  load(files.manifest);
  writeFileSync(files.pause, new Date().toISOString() + '\n');
  return { id, message: '已请求暂停；当前局完成并记录后停止。未运行的赛季无需停止。' };
}

export async function runSeason(id, { limit = Infinity } = {}) {
  const season = readSeason(id), { files, manifest, records, state } = season;
  if (isRunning(state)) throw new Error(`赛季已经在进程 ${state.pid} 中串行运行。请用 pause 暂停。`);
  requireSeasonVersion(manifest);
  if (season.completeBytes < season.fileBytes) truncateSync(files.records, season.completeBytes);
  if (existsSync(files.pause)) unlinkSync(files.pause);
  const completed = new Set(records.map(match => match.id));
  const entrants = new Map(manifest.roster.map(e => [e.id, { ...loadEntrant(e.id, join(ROOT, e.script)), name: e.name, color: e.color }]));
  let stopped = false, count = 0;
  const stop = () => { stopped = true; };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const startedAt = new Date().toISOString();
  save(files.state, { status: 'running', pid: process.pid, startedAt, updatedAt: startedAt });
  try {
    for (const match of manifest.schedule.matches) {
      if (completed.has(match.id)) continue;
      await setImmediate();
      if (stopped || existsSync(files.pause) || count >= limit) break;
      const started = performance.now();
      const result = runMatch(match.entrants.map(id => entrants.get(id)), match.seed,
        { rotation: match.rotation, rules: manifest.rules, trace: false });
      const record = { ...match, completedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - started),
        mapStyle: result.mapStyle, initial: result.initial, winnerId: result.winnerId, reason: result.reason,
        ticks: result.ticks, players: result.players, faults: result.faults };
      appendFileSync(files.records, JSON.stringify(record) + '\n');
      completed.add(match.id); count++;
      console.log(JSON.stringify({ season: id, completed: completed.size, total: manifest.schedule.matches.length,
        match: match.id, mode: match.mode, winner: record.winnerId, reason: record.reason, elapsedMs: record.elapsedMs,
        faults: record.faults.map(({ id, code }) => ({ id, code })) }));
    }
  } finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    save(files.state, { status: completed.size === manifest.schedule.matches.length ? 'complete' : 'paused',
      startedAt, updatedAt: new Date().toISOString() });
    if (manifest.kind === 'official') exportSeason(id);
  }
  return statusSeason(id);
}
