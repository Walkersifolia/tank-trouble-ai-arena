import { initSeason, runSeason, pauseSeason, statusSeason, exportSeason } from './season.mjs';

const [command, ...args] = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index < 0 ? fallback : args[index + 1];
};
const id = option('season', undefined);

try {
  let result;
  if (command === 'init') {
    if (!id) throw new Error('init 需要 --season <赛季ID>。');
    result = initSeason({ id, label: option('label', id), kind: option('kind', 'official'),
      duelSeeds: Number(option('duel-seeds', 50)), ffaGamesPerEntrant: Number(option('ffa-games', 200)),
      seedStart: Number(option('seed', 20261107)), entrants: option('entrants', undefined) });
  } else if (['run', 'pause', 'status', 'export'].includes(command)) {
    if (!id) throw new Error(`${command} 需要 --season <赛季ID>。`);
    if (command === 'run') {
      const limit = Number(option('limit', Infinity));
      if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error('--limit 必须是正整数，只控制本次运行结束点，不缩减赛季计划。');
      result = await runSeason(id, { limit });
    } else result = { pause: pauseSeason, status: statusSeason, export: exportSeason }[command](id);
  } else {
    console.log(`官方 AI 联赛（在项目根目录执行）
npm run leaderboard -- init --season 2026-s1 --label "2026 · 第一赛季"
npm run leaderboard -- run --season 2026-s1
npm run leaderboard -- pause --season 2026-s1
npm run leaderboard -- status --season 2026-s1
npm run leaderboard -- export --season 2026-s1

init 可选：--duel-seeds 50 --ffa-games 200 --seed 20261107
独立试跑：init --season trial-1 --kind trial --duel-seeds 1 --ffa-games 4
试跑可选 --entrants id1,id2,id3,id4（仅公开名单）；不能导出为正式成绩。
run 可选 --limit N：完成本次 N 局后正常暂停；再次 run 仅补未完成局。
Ctrl+C 或 pause 均在当前局完成后停止。详细说明见 leaderboard/README.md。`);
  }
  if (result) console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
