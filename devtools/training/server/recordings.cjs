const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const archiver = require('archiver');

const pick = (value, keys) => Object.fromEntries(keys.filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
const point = value => pick(value, ['x', 'y']);
const wall = value => pick(value, ['id', 'x1', 'y1', 'x2', 'y2', 'border', 'hp']);
const counts = value => pick(value, ['scatter', 'laser', 'mine', 'shield']);
const fault = value => value ? pick(value, ['code', 'message', 'elapsedMs', 'timeout']) : null;
const resultView = value => value ? {
  ...pick(value, ['winnerId', 'reason', 'ticks']),
  players: (value.players || []).map(player => ({ ...pick(player, ['id', 'kills', 'outcome']), forfeit: fault(player.forfeit) })),
} : null;
const playerView = player => pick(player, ['id', 'name', 'color', 'filename', 'updatedAt', 'versionId']);

// 日志独立于选手存储，只接收公开比赛事实；不序列化参赛脚本对象。
function eventView(event) {
  const output = pick(event, [
    'seq', 'type', 'tick', 'time', 'actorId', 'ownerId', 'victimId', 'killer', 'victim',
    'weapon', 'cause', 'classification', 'selfHit', 'ricochet', 'shotId', 'projectileId',
    'projectileIds', 'mineId', 'powerupId', 'powerup', 'reason', 'message', 'elapsedMs',
    'timeout', 'outcome', 'x', 'y', 'angle', 'color', 'vx', 'vy', 'previousVx', 'previousVy',
    'bounces', 'impactX', 'impactY', 'wallDistance', 'nearWall', 'charges',
  ]);
  if (event.points) output.points = event.points.map(point);
  if (event.wall) output.wall = wall(event.wall);
  if (event.walls) output.walls = event.walls.map(wall);
  if (event.result) output.result = resultView(event.result);
  return output;
}

function stateView(state) {
  const output = {
    ...pick(state, ['tick', 'time', 'phase', 'dt', 'wallVersion']),
    tanks: state.tanks.map(tank => ({
      ...pick(tank, ['id', 'name', 'color', 'x', 'y', 'angle', 'vx', 'vy', 'alive', 'cooldown',
        'deployCooldown', 'mineHoldTime', 'scatterShots', 'laserShots', 'mineCharges', 'shield',
        'shieldTimer', 'shieldTime', 'mineHoldTimer', 'dx', 'dy', 'dAngle', 'actionApplied', 'kills']),
      forfeit: fault(tank.forfeit),
      action: pick(tank.action, ['move', 'turn', 'fire', 'special']),
      fire: pick(tank.fire, ['requested', 'emitted', 'reason', 'weapon', 'cooldown']),
      special: pick(tank.special, ['requested', 'deployed', 'reason']),
      movement: pick(tank.movement, ['distance', 'expectedDistance', 'lowDisplacement', 'nearWallDistance']),
      powerupDistances: (tank.powerupDistances || []).map(value => pick(value, ['id', 'distance', 'deltaDistance', 'forwardDot'])),
    })),
    bullets: state.bullets.map(bullet => ({
      ...pick(bullet, ['id', 'ownerId', 'x', 'y', 'vx', 'vy', 'angle', 'age', 'bounces', 'kind', 'color', 'dead']),
      trail: (bullet.trail || []).map(point),
    })),
    powerups: state.powerups.map(powerup => pick(powerup, ['id', 'x', 'y', 'type', 'age', 'taken'])),
    mines: state.mines.map(mine => pick(mine, ['id', 'ownerId', 'x', 'y', 'age', 'armed', 'visibility', 'exploded'])),
  };
  if (state.map) output.map = {
    ...pick(state.map, ['cols', 'rows', 'cellSize', 'width', 'height', 'style']),
    walls: state.map.walls.map(wall),
    cells: state.map.cells.map(row => row.map(cell => pick(cell, ['top', 'right', 'bottom', 'left']))),
  };
  return output;
}

function summaryView(summary) {
  if (!summary) return null;
  return {
    ...pick(summary, ['durationSeconds', 'completed', 'reason', 'winnerId']),
    players: (summary.players || []).map(player => ({
      ...pick(player, ['id', 'aliveSeconds', 'fireRequests', 'shotsFired', 'projectilesCreated',
        'specialRequests', 'minesDeployed', 'moveReversals', 'turnReversals', 'moveChanges',
        'turnChanges', 'distanceTravelled', 'stationaryMoveTicks', 'wallBlockedTicks',
        'longestBlockedSeconds', 'longestNoFireSeconds', 'nearWallShots', 'kills', 'directKills',
        'ricochetKills', 'suicides', 'deaths', 'timeouts', 'scriptErrors', 'powerupApproachTicks',
        'reverseApproachTicks']),
      fireBlocked: pick(player.fireBlocked, ['cooldown', 'bullet_limit', 'dead', 'other']),
      pickups: counts(player.pickups),
      powerupsUsed: counts(player.powerupsUsed),
    })),
    behaviorWindows: (summary.behaviorWindows || []).map(window => pick(window, [
      'id', 'fromTick', 'toTick', 'seconds', 'moveReversals', 'turnReversals', 'distance',
      'netDistance', 'fireRequests', 'shotsFired', 'blockedTicks', 'moveChanges', 'turnChanges',
    ])),
    definitions: pick(summary.definitions, ['coordinates', 'controls', 'fireRequests', 'reversals',
      'lowDisplacement', 'wallBlocked', 'nearWallShot', 'powerupApproach', 'behaviorWindows', 'privacy']),
  };
}

function recordView(record, detailed) {
  const output = {
    ...pick(record, ['schemaVersion', 'id', 'sessionId', 'round', 'startedAt', 'finishedAt',
      'physicsHz', 'mapSeed', 'aborted', 'detail', 'detailTruncated', 'detailBytesEstimate', 'detailLimitBytes']),
    players: record.players.map(playerView),
    rules: pick(record.rules, ['timeout', 'wallBreak', 'powerups']),
    result: resultView(record.result),
    summary: summaryView(record.summary),
    events: record.events.map(eventView),
  };
  if (record.initialState) output.initialState = stateView(record.initialState);
  if (record.wallChanges) output.wallChanges = record.wallChanges.map(change => ({
    ...pick(change, ['version', 'tick', 'removed']),
    updated: (change.updated || []).map(value => pick(value, ['id', 'hp'])),
  }));
  if (detailed && record.states?.length) output.states = record.states.map(stateView);
  return output;
}

const matchFilename = id => `match-${String(id).replace(/[^a-z0-9_-]/gi, '_').slice(0, 120)}`;
const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : '');
const md = value => String(value ?? '').replace(/[\r\n|]/g, ' ');
const number = value => Number(value || 0).toFixed(2).replace(/\.00$/, '');
const reasonNames = { survivor: '最后存活', timeout: '到达单局时限', mutual: '全员死亡', all_forfeit: '全员脚本故障', stopped: '手动停止', aborted: '中途停止' };
const eventNames = { match_start: '比赛开始', fire: '开火', projectile_spawn: '炮弹生成', bounce: '炮弹反弹', hit: '命中', death: '死亡', shield: '护盾破裂', laser: '激光路径', pickup: '拾取道具', powerup_spawn: '道具生成', powerup_used: '道具使用', powerup_expired: '道具结束', mine_deploy: '布雷', mine_armed: '地雷激活', mine: '地雷爆炸', wall_destroy: '墙体破坏', projectile_end: '炮弹结束', forfeit: '脚本故障判负', match_end: '比赛结束' };

function analysisFilename(record) {
  const winner = record.players.find(player => player.id === record.result?.winnerId);
  const outcomes = { timeout: '局时到平局', mutual: '全员死亡平局', all_forfeit: '全员故障判负', aborted: '中途停止不计分' };
  const outcome = winner ? `${winner.name}获胜` : outcomes[record.result?.reason] || '未结算';
  const title = `第${record.round}局_${outcome}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 90);
  const date = new Date(record.startedAt);
  const pad = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${String(date.getMilliseconds()).padStart(3, '0')}`;
  return `${title}_${stamp}_${record.states?.length ? '详细分析' : '事件分析'}.zip`;
}

function summaryMarkdown(record) {
  const names = new Map(record.players.map(player => [player.id, player.name]));
  const name = id => md(names.get(id) || id || '无');
  const summary = record.summary || {};
  const completed = summary.completed !== false && !!record.result;
  const lines = [
    '# Tank Trouble AI Arena 战术分析包', '',
    `- 比赛 ID：${md(record.id)}；本次赛程第 ${record.round} 局。`,
    `- 开始时间：${md(record.startedAt)}；结束时间：${md(record.finishedAt)}。`,
    `- 物理频率：${record.physicsHz} Hz；游戏内时长：${number(summary.durationSeconds)} 秒。`,
    `- 结果：${completed ? (record.result.winnerId ? `${name(record.result.winnerId)} 获胜` : '无获胜者') : '中途停止，不计入成绩'}；原因：${reasonNames[summary.reason || record.result?.reason] || md(summary.reason || record.result?.reason)}。`,
    `- 地图种子：${record.mapSeed == null ? '未提供；原引擎未保存随机种子' : md(record.mapSeed)}。`,
    `- 详细 Tick 数据：${record.states?.length ? `${record.states.length} 条${record.detailTruncated ? '（达到记录容量上限，仅有前段）' : ''}` : '未保存，只有事件和统计，不能进行完整回放'}。`,
    '', '## 参赛版本', '', '| 选手 | ID | 文件名 | 版本标识 | 更新时间 |', '| --- | --- | --- | --- | --- |',
    ...record.players.map(player => `| ${md(player.name)} | ${md(player.id)} | ${md(player.filename)} | ${md(player.versionId)} | ${md(player.updatedAt)} |`),
    '', '## 本局结果与行为统计', '',
    '| 选手 | 结果 | 击杀 | 反弹击杀 | 自杀 | 超时 | 请求开火 | 实际开火 | 移动反向 | 转向反向 | 移动距离 | 最长不开火 |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const player of record.players) {
    const stats = summary.players?.find(entry => entry.id === player.id) || {};
    const result = record.result?.players?.find(entry => entry.id === player.id);
    const outcome = !completed ? '未计分' : result?.forfeit ? '脚本故障判负' : record.result.winnerId === player.id ? '胜' : record.result.winnerId ? '负' : '平';
    lines.push(`| ${md(player.name)} | ${outcome} | ${stats.kills ?? result?.kills ?? 0} | ${stats.ricochetKills || 0} | ${stats.suicides || 0} | ${stats.timeouts || 0} | ${stats.fireRequests || 0} | ${stats.shotsFired || 0} | ${stats.moveReversals || 0} | ${stats.turnReversals || 0} | ${number(stats.distanceTravelled)} px | ${number(stats.longestNoFireSeconds)} s |`);
  }
  lines.push('', '## 道具、受阻与异常', '');
  for (const player of summary.players || []) {
    const pickups = Object.entries(player.pickups || {}).map(([type, count]) => `${type}×${count}`).join('、') || '无';
    lines.push(`- ${name(player.id)}：拾取 ${pickups}；开火阻止原因 ${JSON.stringify(player.fireBlocked || {})}；连续受阻最长 ${number(player.longestBlockedSeconds)} 秒；近墙开火 ${player.nearWallShots || 0} 次；超时 ${player.timeouts || 0}，其他脚本错误 ${player.scriptErrors || 0}。`);
  }
  lines.push('', '## 关键事件', '');
  const notable = new Set(['pickup', 'death', 'forfeit', 'match_end']);
  for (const event of record.events.filter(event => notable.has(event.type))) {
    const actor = event.actorId || event.victimId || event.victim || event.ownerId;
    lines.push(`- ${number(event.time)} s / Tick ${event.tick}：${eventNames[event.type] || event.type}${actor ? ` · ${name(actor)}` : ''}${event.powerup ? ` · ${event.powerup}` : ''}${event.classification ? ` · ${md(event.classification)}` : ''}${event.message ? ` · ${md(event.message)}` : ''}。`);
  }
  lines.push('', '## 文件与解释', '',
    '- `match.json`：比赛元信息、结果、统计，以及存在时的初始地图和墙体变化；不含脚本源码、来源路径或选手私有决策变量。',
    '- `events.jsonl`：每行一个实际引擎事件，按 `seq` 排列；`tick` 和 `time` 是物理 Tick 与游戏内秒数。',
    '- `states.jsonl`：仅有详细记录时提供。每行一个状态，位置单位 px，角度单位 rad，速度单位 px/s；X 向右、Y 向下、角度 0 朝右且正方向顺时针。`action` 是对应 Tick 提交的控制，`dx/dy/dAngle` 是该步实际变化。',
    '- `initialState.map` 给出初始地图。状态的 `wallVersion` 对应 `wallChanges`：按版本顺序删除 `removed` 中的墙体 ID、应用 `updated` 中的生命值。',
    '- 同 Tick 可以有初始或故障状态，按文件中的顺序解释。回放读取状态，不再次运行 AI，也不重新结算成绩。',
    '- `fireRequests` 是请求次数，`shotsFired` 是引擎实际成功开火次数；不能据此推断脚本内部动机。反向次数只反映已提交动作的方向切换，不能单独证明策略错误。',
    '- `behaviorWindows` 按短时间窗记录反向次数、路程、净位移和射击数据，用来区分有效躲避与近原地振荡。',
    '- 只有存档中的实际事件和状态可作为证据；不包含未来状态或 AI 内部计划。日志可能暴露地雷等赛后完整战场信息，由比赛所有者决定是否提供给参赛开发者。',
    '');
  return lines.join('\n');
}

function createRecordingStore(root) {
  const logsDirectory = path.join(root, 'gamelogs');
  return {
    async exportAnalysis(record) {
      const output = recordView(record, true);
      const directory = path.join(logsDirectory, 'exports');
      await fs.mkdir(directory, { recursive: true });
      const filename = path.join(directory, analysisFilename(output));
      const { events, states, ...metadata } = output;
      const files = ['summary.md', 'match.json', 'events.jsonl'];
      const archive = archiver('zip', { zlib: { level: 6 } });
      const written = pipeline(archive, createWriteStream(filename));
      archive.append(summaryMarkdown(output), { name: 'summary.md' });
      archive.append(JSON.stringify(metadata, null, 2), { name: 'match.json' });
      archive.append(jsonl(events), { name: 'events.jsonl' });
      if (states?.length) {
        files.push('states.jsonl');
        archive.append(jsonl(states), { name: 'states.jsonl' });
      }
      await Promise.all([archive.finalize(), written]);
      return { directory, path: filename, files };
    },
  };
}

module.exports = { createRecordingStore };
