const list = document.getElementById('candidate-list');
const number = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 4 });
const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const statuses = { pending: '等待预评测', running: '预评测中', paused: '预评测已暂停', complete: '预评测完成' };
const score = value => value === null ? '—' : number.format(value);
function node(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function renderCandidate(data) {
  const { evaluation, target, progress } = data;
  const card = node('article', 'panel');
  const heading = node('div', 'season-title');
  heading.append(node('h3', '', target.name), node('span', 'status-badge evaluating', statuses[data.status]));
  const version = node('a', '', `脚本版本 ${target.version}`);
  version.href = `${evaluation.source.repository}/commit/${target.commit}`;
  version.target = '_blank'; version.rel = 'noopener';
  const reference = node('p', 'hint', `参考 ${evaluation.referenceSeason.label} 的固定对手名单；更新于 ${date.format(new Date(data.updatedAt))}（北京时间）。`);
  const scores = node('div', 'overview-grid');
  for (const [label, value] of [['综合预评分', score(data.scores.overall)], ['单挑预评分', score(data.scores.duel)],
    ['混战预评分', score(data.scores.ffa)], ['已完成 / 计划', `${progress.completed} / ${progress.total}`]]) {
    const cell = node('div');
    cell.append(node('span', '', label), node('strong', '', value)); scores.append(cell);
  }
  const description = node('p', 'hint', `单挑 ${progress.duel.completed} / ${progress.duel.total} 局，混战 ${progress.ffa.completed} / ${progress.ffa.total} 局。${data.status === 'complete' ? '本次预评测已完成；分数独立展示，不参与旧季排名。' : '分数来自已完成样本，缺项显示 —；本次预评测尚未完成。'}`);
  const ffa = evaluation.schedule.ffa;
  const schedule = node('p', 'hint', `新 AI 混战四个出生位计划 ${ffa.targetSpawnGames.join(' / ')} 局；与每名旧选手同场 ${ffa.opponentMin}–${ffa.opponentMax} 次。`);
  for (const adjustment of ffa.adjustments) schedule.append(document.createTextNode(` ${adjustment}`));
  const details = node('details', 'schedule-details');
  details.append(node('summary', '', '单挑交手、混战同场与辅助统计'));
  for (const [mode, title] of [['duel', '单挑交手'], ['ffa', '混战同场（本选手在同场比赛中的成绩）']]) {
    const stats = target[mode];
    details.append(node('h3', '', title), node('p', 'hint', `胜 / 平 / 负：${stats.wins} / ${stats.draws} / ${stats.losses}；主动击杀 ${stats.activeKills}，自杀 ${stats.suicides}，决策超时 ${stats.decisionTimeouts}，故障 ${stats.faults}；局时到 ${stats.matchTimeouts}，无人获胜 ${stats.noWinnerGames}，全员故障 ${stats.allFaultGames}。`));
    const scroll = node('div', 'opponents-scroll'), table = node('table', 'opponents-table');
    const head = node('thead'), headRow = node('tr');
    for (const label of ['对手', '已完成 / 计划', '胜 / 平 / 负', '平均得分']) headRow.append(node('th', '', label));
    head.append(headRow);
    const body = node('tbody');
    for (const opponent of data.opponents) {
      const record = stats.opponents[opponent.id], row = node('tr');
      for (const value of [opponent.name, `${record.games} / ${record.plannedGames}`,
        `${record.wins} / ${record.draws} / ${record.losses}`, score(record.score)]) row.append(node('td', '', value));
      body.append(row);
    }
    table.append(head, body); scroll.append(table); details.append(scroll);
  }
  card.append(heading, version, reference, scores, description, schedule, details);
  return card;
}

async function readJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function loadCandidates() {
  const index = await readJson(new URL('./data/candidates/index.json', import.meta.url));
  if (index.evaluations.length === 0) {
    list.replaceChildren(node('p', 'hint', '暂无新 AI 预评测记录。新选手加入后将单独展示成绩，旧季分数与名次保持不变。'));
    return;
  }
  const reports = await Promise.all(index.evaluations.map(entry => readJson(new URL(entry.url, window.location.href))));
  list.replaceChildren(...reports.map(renderCandidate));
}

loadCandidates().catch(error => { list.replaceChildren(node('p', 'hint', `新 AI 预评测暂时无法加载（${error.message}），请稍后刷新。`)); });
