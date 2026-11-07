// A newcomer is evaluated separately; existing season scores and files stay fixed.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { ROOT, readSeason, runSeason, pauseSeason, statusSeason } from './season.mjs';
import { createSchedule } from './schedule.mjs';
import { aggregateSeason } from './scoring.mjs';

const LOCAL = join(ROOT, 'local-data', 'leaderboard');
const PUBLIC = join(ROOT, 'leaderboard', 'data', 'candidates');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
const load = filename => JSON.parse(readFileSync(filename, 'utf8'));
const save = (filename, value) => writeFileSync(filename, JSON.stringify(value, null, 2) + '\n');
const toolFiles = ['leaderboard/candidate.mjs', 'leaderboard/season.mjs', 'leaderboard/cli.mjs',
  'leaderboard/schedule.mjs', 'leaderboard/scoring.mjs'];

function localId(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) throw new Error('--id 只能包含英文字母、数字、短横线和下划线。');
  return `candidate-${id}`;
}

function versionFiles(roster) {
  return ['engine', 'devtools/matches/run.mjs', ...roster.map(e => e.script), ...toolFiles];
}

function requireVersion(manifest) {
  git('ls-files', '--error-unmatch', '--', ...toolFiles);
  try { git('diff', '--quiet', '--exit-code', manifest.source.commit, '--', ...versionFiles(manifest.roster)); }
  catch { throw new Error('本次预评测的选手、引擎或工具版本已改变，请使用原版本续跑，或另建一次预评测。'); }
  const cpus = os.cpus();
  const current = { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
    osRelease: os.release(), cpu: cpus[0].model.trim(), logicalCpus: cpus.length };
  for (const key of Object.keys(current)) {
    if (current[key] !== manifest.environment[key]) throw new Error(`运行环境 ${key} 与本次预评测不同。`);
  }
}

export function initCandidate({ id, bot, against, label, duelSeeds = 50, ffaGamesPerEntrant = 200, seedStart }) {
  const internalId = localId(id), directory = join(LOCAL, internalId);
  if (existsSync(join(directory, 'season.json'))) throw new Error('该预评测已存在，使用 run 续跑。');
  const base = readSeason(against).manifest;
  if (base.kind !== 'official') throw new Error('--against 必须指定正式赛季。');
  const entrant = load(join(ROOT, 'bots', 'roster.json')).find(e => e.id === bot);
  if (!entrant) throw new Error('--bot 必须是 roster.json 中的公开选手。');
  if (base.roster.some(e => e.id === bot)) throw new Error('该选手已在参考赛季中；此入口用于单独加入的新 AI。');
  const commit = git('log', '-1', '--format=%H', '--', entrant.script);
  if (!commit) throw new Error('请先将新 AI 脚本提交到 Git，再固定本次预评测版本。');
  const target = { id: entrant.id, name: entrant.name, codename: entrant.codename, color: entrant.color,
    group: entrant.group, script: entrant.script.replace(/^\.\//, ''), commit, version: commit.slice(0, 8) };
  const roster = [target, ...base.roster];
  const config = { duelSeeds, ffaGamesPerEntrant, seedStart: seedStart ?? base.config.seedStart + 1000000 };
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value < (key === 'seedStart' ? 0 : 1)) throw new Error(`${key} 必须是${key === 'seedStart' ? '非负' : '正'}整数。`);
  }
  // Reuse the balanced full schedule, but execute only matches involving the newcomer.
  const full = createSchedule(roster, config);
  const matches = full.matches.filter(match => match.entrants.includes(bot));
  const ffa = matches.filter(match => match.mode === 'ffa');
  const seats = [0, 0, 0, 0], coappearances = Object.fromEntries(base.roster.map(e => [e.id, 0]));
  for (const match of ffa) {
    seats[match.entrants.indexOf(bot)]++;
    for (const opponent of match.entrants) if (opponent !== bot) coappearances[opponent]++;
  }
  const cpus = os.cpus();
  const manifest = { schemaVersion: 1, id: internalId, label: label ?? `${target.name} · 新 AI 预评测`,
    kind: 'candidate', createdAt: new Date().toISOString(), targetId: bot,
    referenceSeason: { id: base.id, label: base.label, commit: base.source.commit },
    source: { repository: base.source.repository, commit: git('rev-parse', 'HEAD'),
      engineCommit: base.source.engineCommit, runnerCommit: base.source.runnerCommit },
    roster, environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch,
      osRelease: os.release(), cpu: cpus[0].model.trim(), logicalCpus: cpus.length,
      totalMemoryGB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10 },
    rules: base.rules, config, schedule: { matches, summary: {
      duel: { ...full.summary.duel, games: matches.length - ffa.length },
      ffa: { games: ffa.length, requestedGames: config.ffaGamesPerEntrant, actualGames: ffa.length,
        targetSpawnGames: seats, coappearances,
        opponentMin: Math.min(...Object.values(coappearances)), opponentMax: Math.max(...Object.values(coappearances)),
        adjustments: config.ffaGamesPerEntrant === ffa.length ? []
          : [`为使新 AI 四个出生位均衡，混战从 ${config.ffaGamesPerEntrant} 局向上调整为 ${ffa.length} 局。`] }
    } } };
  // Benchmarks retain their old script and engine versions; the public roster may grow.
  try { git('diff', '--quiet', '--exit-code', base.source.commit, '--', 'engine', 'devtools/matches/run.mjs', ...base.roster.map(e => e.script)); }
  catch { throw new Error('参考赛季的对手或引擎已改变，请使用原版本进行预评测，或开启新完整赛季。'); }
  requireVersion(manifest);
  mkdirSync(directory, { recursive: true });
  save(join(directory, 'season.json'), manifest);
  writeFileSync(join(directory, 'matches.jsonl'), '');
  save(join(directory, 'run.json'), { status: 'pending', updatedAt: manifest.createdAt });
  return statusCandidate(id);
}

export function statusCandidate(id) {
  const season = readSeason(localId(id));
  const status = statusSeason(season.manifest.id);
  const report = aggregateSeason(season.manifest, season.records, { status: status.status });
  const row = report.standings.find(e => e.id === season.manifest.targetId);
  const { ranks, scores: officialScores, ...target } = row;
  return { schemaVersion: 1, evaluation: report.season, updatedAt: report.updatedAt,
    status: status.status, progress: status.progress, timing: status.timing,
    scores: row.provisionalScores, target, opponents: season.manifest.roster.filter(e => e.id !== row.id) };
}

export function exportCandidate(id) {
  const report = statusCandidate(id);
  mkdirSync(PUBLIC, { recursive: true });
  save(join(PUBLIC, `${report.evaluation.id}.json`), report);
  const evaluations = readdirSync(PUBLIC).filter(name => name !== 'index.json' && name.endsWith('.json')).map(name => {
    const data = load(join(PUBLIC, name));
    return { id: data.evaluation.id, label: data.evaluation.label, url: `./data/candidates/${name}`,
      updatedAt: data.updatedAt, createdAt: data.evaluation.createdAt, status: data.status };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  save(join(PUBLIC, 'index.json'), { schemaVersion: 1, evaluations });
  return { id, status: report.status, progress: report.progress,
    output: `leaderboard/data/candidates/${report.evaluation.id}.json` };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const option = (name, fallback) => { const index = args.indexOf(`--${name}`); return index < 0 ? fallback : args[index + 1]; };
  const id = option('id');
  let result;
  if (['init', 'run', 'pause', 'status', 'export'].includes(command) && !id) throw new Error('需要 --id <本次预评测ID>。');
  if (command === 'init') {
    if (!option('bot') || !option('against')) throw new Error('init 需要 --bot <新AI的公开ID> --against <参考赛季ID>。');
    result = initCandidate({ id, bot: option('bot'), against: option('against'), label: option('label'),
      duelSeeds: Number(option('duel-seeds', 50)), ffaGamesPerEntrant: Number(option('ffa-games', 200)),
      seedStart: option('seed') === undefined ? undefined : Number(option('seed')) });
  } else if (command === 'run') {
    const { manifest } = readSeason(localId(id));
    requireVersion(manifest);
    if (statusSeason(manifest.referenceSeason.id).status === 'running') throw new Error('参考赛季仍在评测。请等待完成或正常暂停后再串行运行新 AI 预评测。');
    const limit = Number(option('limit', Infinity));
    if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit 必须是正整数。');
    await runSeason(manifest.id, { limit });
    result = exportCandidate(id);
  } else if (command === 'pause') result = pauseSeason(localId(id));
  else if (command === 'status') result = statusCandidate(id);
  else if (command === 'export') result = exportCandidate(id);
  else console.log(`新 AI 独立预评测；旧榜分数、名次及数据文件不变。
npm run leaderboard:candidate -- init --id newcomer-1 --bot <公开AI的ID> --against 2026-s1
npm run leaderboard:candidate -- run --id newcomer-1
npm run leaderboard:candidate -- pause --id newcomer-1
npm run leaderboard:candidate -- status --id newcomer-1
npm run leaderboard:candidate -- export --id newcomer-1
默认对旧季每位选手各单挑 100 局，新 AI 再参加 200 局混战。仅运行包含新 AI 的对局。
init 可选 --duel-seeds 50 --ffa-games 200 --seed <种子>；run 可选 --limit N。
结果是独立预评测，无正式名次；下次完整赛季再纳入所有公开 AI。`);
  if (result) console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
