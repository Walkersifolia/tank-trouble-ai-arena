const $ = (id) => document.getElementById(id);
const integers = new Intl.NumberFormat('zh-CN');
const decimals = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const dates = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const labels = { overall: '综合分', duel: '单挑分', ffa: '混战分' };
const boardCopy = {
  overall: ['综合战力', '单挑成绩与四人混战成绩各占 50%'],
  duel: ['单挑战力', '先计算每名对手的平均得分，再对所有对手等权平均'],
  ffa: ['四人混战战力', '均衡赛程中的平均每局得分，胜者 100 分，其余 0 分'],
};
const statusLabels = { pending: '等待评测', running: '评测中', paused: '评测已暂停', complete: '评测完成' };
let selectedBoard = 'overall';
let seasonData;
let seasons = [];

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function setText(id, text) {
  $(id).textContent = text;
}

function count(value) {
  return integers.format(value);
}

function score(value) {
  return value === null || value === undefined ? '—' : decimals.format(value);
}

function progressText(completed, total) {
  return `${count(completed)} / ${count(total)}`;
}

function duration(milliseconds) {
  const minutes = Math.ceil(milliseconds / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${count(hours)} 小时${remainder ? ` ${remainder} 分钟` : ''}`;
}

function repositoryUrl(data) {
  const repository = data.season.source.repository.replace(/\.git$/, '');
  return repository.startsWith('https://') ? repository : `https://github.com/${repository}`;
}

function commitLink(data, commit, text) {
  const link = element('a', '', text);
  link.href = `${repositoryUrl(data)}/commit/${commit}`;
  link.target = '_blank';
  link.rel = 'noopener';
  return link;
}

function plannedGames(entrant, mode) {
  return mode === 'overall' ? entrant.duel.plannedGames + entrant.ffa.plannedGames : entrant[mode].plannedGames;
}

function completedGames(entrant, mode) {
  return mode === 'overall' ? entrant.duel.games + entrant.ffa.games : entrant[mode].games;
}

function renderSpecification(data) {
  const { season } = data;
  const { schedule, rules, source, environment } = season;
  const grid = element('div', 'spec-grid');
  const scheduleBlock = element('div');
  scheduleBlock.append(element('h3', '', '本季实际赛程'));
  scheduleBlock.append(element('p', '', `单挑共 ${count(schedule.duel.games)} 局；每对不同 AI ${count(schedule.duel.gamesPerPair)} 局，使用 ${count(schedule.duel.seedsPerPair)} 个地图种子，每个种子交换出生位。`));
  scheduleBlock.append(element('p', '', `四人混战共 ${count(schedule.ffa.games)} 局，每局四名不同选手；每名选手请求 ${count(schedule.ffa.requestedGamesPerEntrant)} 局，实际 ${count(schedule.ffa.actualGamesPerEntrant)} 局；四个出生位分别 ${schedule.ffa.spawnGamesPerEntrant.map(count).join(' / ')} 局。`));
  scheduleBlock.append(element('p', '', `任意两名选手同场 ${count(schedule.ffa.pairMin)}${schedule.ffa.pairMin === schedule.ffa.pairMax ? '' : `–${count(schedule.ffa.pairMax)}`} 次；不要求所有四人组合次数一致。种子起点 ${season.config.seedStart}。`));
  for (const adjustment of schedule.ffa.adjustments) scheduleBlock.append(element('p', '', `赛程调整：${adjustment}`));
  const rulesBlock = element('div');
  rulesBlock.append(element('h3', '', '固定比赛规则'));
  rulesBlock.append(element('p', '', `${rules.powerups ? '有道具' : '无道具'} · 墙体${rules.wallBreak ? '可破坏' : '不可破坏'} · 每局 ${rules.timeout} 秒 · 物理 ${rules.physicsHz} Hz · 单次决策预算 ${rules.decisionMs} ms。`));
  rulesBlock.append(element('p', '', `初始化预算 ${rules.initMs} ms，硬中断上限 ${rules.hardInterruptionMs} ms。其余初始化、故障与结算规则完整沿用本季共享引擎和正式运行器。评测默认串行运行。`));
  const sourceBlock = element('div');
  sourceBlock.append(element('h3', '', '冻结版本来源'));
  for (const [label, commit] of [['赛季来源', source.commit], ['共享引擎', source.engineCommit], ['正式运行器', source.runnerCommit]]) {
    const line = element('p', '', `${label}：`);
    line.append(commitLink(data, commit, commit.slice(0, 12)));
    sourceBlock.append(line);
  }
  sourceBlock.append(element('p', '', `赛季创建于 ${dates.format(new Date(season.createdAt))}（北京时间）。名单与每名选手脚本版本以本季公开数据为准。`));
  const environmentBlock = element('div');
  environmentBlock.append(element('h3', '', '统一运行环境'));
  environmentBlock.append(element('p', '', `Node.js ${environment.node} · V8 ${environment.v8}`));
  environmentBlock.append(element('p', '', `${environment.platform} ${environment.arch} · OS ${environment.osRelease}`));
  environmentBlock.append(element('p', '', `${environment.cpu} · ${environment.logicalCpus} 逻辑处理器 · ${environment.totalMemoryGB} GB 内存`));
  grid.append(scheduleBlock, rulesBlock, sourceBlock, environmentBlock);
  $('season-specification').replaceChildren(grid);
}

function renderOpponentTable(entrant, mode, data, container, description) {
  const section = entrant[mode];
  const byId = new Map(data.standings.map((opponent) => [opponent.id, opponent]));
  description.textContent = mode === 'duel'
    ? '对每名对手的平均得分先单独计算，再等权汇总为单挑成绩。未交手时显示「—」。'
    : '这里统计与该对手同场时，本选手的赛果；并非两人单挑。一局可出现在多个对手行中，不能将各行相加作为总场次。无人获胜不计分。';
  const table = element('table', 'opponents-table');
  const head = element('thead');
  const headRow = element('tr');
  for (const title of ['对手', '已完成 / 计划', '胜 / 平 / 负', '平均得分', '主动击杀', '自杀', '决策超时', '故障场次']) {
    const heading = element('th', '', title);
    heading.scope = 'col';
    headRow.append(heading);
  }
  head.append(headRow);
  const body = element('tbody');
  for (const [opponentId, record] of Object.entries(section.opponents)) {
    const row = element('tr');
    const values = [byId.get(opponentId).name, progressText(record.games, record.plannedGames), `${count(record.wins)} / ${count(record.draws)} / ${count(record.losses)}`, score(record.score), count(record.activeKills), count(record.suicides), count(record.decisionTimeouts), count(record.faults)];
    for (const value of values) row.append(element('td', '', value));
    body.append(row);
  }
  table.append(head, body);
  container.replaceChildren(table);
}

function renderEntrantDetail(entrant, data) {
  const panel = element('section', 'entrant-detail');
  panel.setAttribute('aria-label', `${entrant.name}交手详情`);
  const heading = element('div', 'detail-title');
  heading.append(element('span', '', `${entrant.name} · 本季累计统计`));
  const scriptLink = element('a', '', entrant.script);
  scriptLink.href = `${repositoryUrl(data)}/blob/${entrant.commit}/${entrant.script.replace(/^\.\//, '')}`;
  scriptLink.target = '_blank';
  scriptLink.rel = 'noopener';
  heading.append(scriptLink);
  const stats = entrant.totals;
  const summary = element('dl', 'summary-stat-grid');
  const summaryValues = [
    ['已完成 / 计划', progressText(entrant.duel.games + entrant.ffa.games, entrant.duel.plannedGames + entrant.ffa.plannedGames)],
    ['胜 / 平 / 负', `${count(stats.wins)} / ${count(stats.draws)} / ${count(stats.losses)}`],
    ['主动击杀', count(stats.activeKills)],
    ['自杀', count(stats.suicides)],
    ['决策超时', count(stats.decisionTimeouts)],
    ['故障场次', count(stats.faults)],
  ];
  for (const [label, value] of summaryValues) {
    const cell = element('div');
    cell.append(element('dt', '', label), element('dd', '', value));
    summary.append(cell);
  }
  const tabs = element('div', 'detail-tabs');
  tabs.setAttribute('role', 'group');
  tabs.setAttribute('aria-label', '交手统计模式');
  const description = element('p', 'detail-description');
  const tableContainer = element('div', 'opponents-scroll');
  let detailMode = selectedBoard === 'ffa' ? 'ffa' : 'duel';
  const auxiliary = element('p', 'detail-auxiliary');
  function selectDetailMode(mode) {
    detailMode = mode;
    for (const tab of tabs.children) {
      const selected = tab.dataset.mode === detailMode;
      tab.classList.toggle('selected', selected);
      tab.setAttribute('aria-pressed', String(selected));
    }
    const records = entrant[detailMode];
    auxiliary.textContent = `本选手${detailMode === 'duel' ? '单挑' : '混战'}统计：${count(records.games)} 局，胜 ${count(records.wins)} / 平 ${count(records.draws)} / 负 ${count(records.losses)}；局时到 ${count(records.matchTimeouts)} 局，无胜者 ${count(records.noWinnerGames)} 局，全员故障 ${count(records.allFaultGames)} 局。主动击杀不含自杀；故障计入负场与评分分母。`;
    renderOpponentTable(entrant, detailMode, data, tableContainer, description);
  }
  for (const [mode, label] of [['duel', '单挑交手'], ['ffa', '混战同场']]) {
    const tab = element('button', '', label);
    tab.type = 'button';
    tab.dataset.mode = mode;
    tab.addEventListener('click', () => selectDetailMode(mode));
    tabs.append(tab);
  }
  panel.append(heading, summary, tabs, description, tableContainer, auxiliary);
  selectDetailMode(detailMode);
  return panel;
}

function entrantRows(entrant, data) {
  const complete = data.status === 'complete';
  const row = element('tr', 'entrant-row');
  const rank = complete ? entrant.ranks[selectedBoard] : null;
  const rankCell = element('td', `rank-cell${rank !== null && rank <= 3 ? ' top-rank' : ''}`, rank === null ? '—' : String(rank));
  const nameCell = element('td', 'entrant-cell');
  const name = element('div', 'entrant-name');
  const dot = element('span', 'entrant-dot');
  dot.style.backgroundColor = entrant.color;
  name.append(dot, document.createTextNode(entrant.name));
  const metadata = element('div', 'entrant-meta');
  metadata.append(element('span', '', entrant.codename), commitLink(data, entrant.commit, `版本 ${entrant.version}`));
  nameCell.append(name, metadata);
  row.append(rankCell, nameCell);
  const values = complete ? entrant.scores : entrant.provisionalScores;
  for (const mode of ['overall', 'duel', 'ffa']) {
    const cell = element('td', `score-cell${selectedBoard === mode ? ' active-score' : ''}${values[mode] === null ? ' no-score' : ''}`, score(values[mode]));
    cell.dataset.label = `${labels[mode]}${complete ? '' : ' · 暂定'}`;
    row.append(cell);
  }
  const games = element('td', 'games-cell', progressText(completedGames(entrant, selectedBoard), plannedGames(entrant, selectedBoard)));
  games.dataset.label = `${selectedBoard === 'overall' ? '全部' : selectedBoard === 'duel' ? '单挑' : '混战'}已完成`;
  const detailsCell = element('td', 'details-cell');
  detailsCell.append(element('div', `row-status${complete ? ' finished' : ''}`, complete ? '已完成' : '评测中'));
  const detailToggle = element('button', 'detail-toggle', '交手详情 ＋');
  detailToggle.type = 'button';
  detailToggle.setAttribute('aria-expanded', 'false');
  detailToggle.setAttribute('aria-controls', `detail-${entrant.id}`);
  detailToggle.setAttribute('aria-label', `查看${entrant.name}交手详情`);
  const detailRow = element('tr', 'details-row');
  detailRow.id = `detail-${entrant.id}`;
  detailRow.hidden = true;
  const detailCell = element('td');
  detailCell.colSpan = 7;
  detailRow.append(detailCell);
  detailToggle.addEventListener('click', () => {
    const expanded = detailToggle.getAttribute('aria-expanded') !== 'true';
    detailToggle.setAttribute('aria-expanded', String(expanded));
    detailToggle.textContent = expanded ? '收起详情 −' : '交手详情 ＋';
    detailToggle.setAttribute('aria-label', `${expanded ? '收起' : '查看'}${entrant.name}交手详情`);
    detailRow.hidden = !expanded;
    row.classList.toggle('expanded', expanded);
    if (expanded && !detailCell.firstChild) detailCell.append(renderEntrantDetail(entrant, data));
  });
  detailsCell.append(detailToggle);
  row.append(games, detailsCell);
  return [row, detailRow];
}

export function renderStandings(data, mode = selectedBoard) {
  selectedBoard = mode;
  const complete = data.status === 'complete';
  setText('board-title', boardCopy[mode][0]);
  setText('board-description', boardCopy[mode][1]);
  const notice = $('ranking-notice');
  notice.classList.toggle('complete', complete);
  notice.textContent = complete
    ? '本季完整统一赛程已完成，以下为正式积分与名次。各榜单独排名，同分并列。'
    : '统一赛程尚未完成，全部选手均为「评测中」，暂不发布正式名次。以下分数为已完成对局的暂定统计，样本可能不均衡；缺失分项显示「—」。选手按赛季名单顺序展示。';
  for (const tab of document.querySelectorAll('[data-board]')) {
    const selected = tab.dataset.board === mode;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
  for (const header of document.querySelectorAll('[data-score-header]')) {
    header.classList.toggle('active-score', header.dataset.scoreHeader === mode);
    header.textContent = `${labels[header.dataset.scoreHeader]}${complete ? '' : '（暂定）'}`;
  }
  const entries = complete
    ? [...data.standings].sort((a, b) => a.ranks[mode] - b.ranks[mode])
    : data.standings;
  const fragment = document.createDocumentFragment();
  for (const entrant of entries) fragment.append(...entrantRows(entrant, data));
  $('standings-body').replaceChildren(fragment);
}

export function renderSeason(data) {
  seasonData = data;
  const { season, progress, status } = data;
  setText('season-name', season.label);
  const badge = $('season-status');
  badge.textContent = statusLabels[status];
  badge.classList.toggle('evaluating', status !== 'complete');
  setText('season-updated', `${season.id} · 更新于 ${dates.format(new Date(data.updatedAt))}（北京时间）`);
  const percent = progress.total ? (progress.completed / progress.total * 100).toFixed(1) : '0.0';
  setText('total-progress', `${progressText(progress.completed, progress.total)} 局 · ${percent}%`);
  $('progress-bar').max = progress.total;
  $('progress-bar').value = progress.completed;
  setText('entrant-count', `${count(data.standings.length)} 名`);
  setText('duel-progress', progressText(progress.duel.completed, progress.duel.total));
  setText('ffa-progress', progressText(progress.ffa.completed, progress.ffa.total));
  setText('rules-summary', `${season.rules.powerups ? '有道具' : '无道具'} · ${season.rules.timeout} 秒 · ${season.rules.physicsHz} Hz · ${season.rules.decisionMs} ms`);
  const timing = $('timing-note');
  timing.hidden = !data.timing || data.timing.estimatedRemainingMs === null || status === 'complete';
  if (!timing.hidden) timing.textContent = `按本季已完成对局估算剩余约 ${duration(data.timing.estimatedRemainingMs)}；该估算会随赛程样本与实际运行速度变化。`;
  renderSpecification(data);
  renderStandings(data);
}

function showLoadError(error) {
  const message = $('load-message');
  message.hidden = false;
  message.classList.add('error');
  message.textContent = `官方榜单暂时无法加载：${error.message}。请稍后刷新，或切换其他赛季。`;
}

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`数据请求失败（HTTP ${response.status}）`);
  return response.json();
}

async function loadSeason(record) {
  $('season-content').hidden = true;
  $('load-message').hidden = false;
  $('load-message').classList.remove('error');
  setText('load-message', '正在读取官方评测数据…');
  $('season-select').disabled = true;
  try {
    const data = await readJson(new URL(record.url, window.location.href));
    renderSeason(data);
    $('load-message').hidden = true;
    $('season-content').hidden = false;
    const url = new URL(window.location.href);
    url.searchParams.set('season', record.id);
    window.history.replaceState(null, '', url);
  } catch (error) {
    showLoadError(error);
  } finally {
    $('season-select').disabled = false;
  }
}

async function initialize() {
  for (const button of document.querySelectorAll('[data-board]')) button.addEventListener('click', () => renderStandings(seasonData, button.dataset.board));
  $('season-select').addEventListener('change', () => loadSeason(seasons.find((season) => season.id === $('season-select').value)));
  try {
    const manifest = await readJson(new URL('./data/seasons.json', import.meta.url));
    seasons = manifest.seasons;
    if (seasons.length === 0) {
      setText('load-message', '首个官方赛季正在准备中，公开数据发布后将在此展示。');
      $('season-select').replaceChildren(element('option', '', '暂无已发布赛季'));
      return;
    }
    $('season-select').replaceChildren(...seasons.map((season) => {
      const option = element('option', '', `${season.label} · ${statusLabels[season.status]}`);
      option.value = season.id;
      return option;
    }));
    const requested = new URL(window.location.href).searchParams.get('season');
    const initial = seasons.find((season) => season.id === requested) || seasons[0];
    $('season-select').value = initial.id;
    await loadSeason(initial);
  } catch (error) {
    showLoadError(error);
  }
}

initialize();
