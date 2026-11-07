import { ChallengeGame } from './runtime.js';
import { HumanControls } from './controls.js';
import { ReplayPanel, downloadRecording } from './replay-panel.js?v=arena-native-1';
import { recordAIResult, renderLocalRanking } from '../leaderboard/local.js';

const $ = id => document.getElementById(id);
const STORAGE = 'tank-trouble-web-challenge-v1';
const COLORS = ['#b69aff', '#ffb86b', '#73b9ff', '#ef83aa', '#d8dd6d'];
const GROUPS = [
  { id: 'training', name: '新手练习' },
  { id: 'astra', name: 'Astra' },
  { id: 'chatgpt', name: 'ChatGPT' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'opus', name: 'Opus' },
];
const emptyStats = () => ({ played: 0, wins: 0, losses: 0, draws: 0, streak: 0, best: 0, opponents: {} });
let settings = {}, stats = emptyStats(), aiStats = {}, storageAvailable = true;
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE) || 'null');
  if (saved) { settings = saved.settings || {}; stats = { ...emptyStats(), ...saved.stats }; aiStats = saved.aiStats || {}; }
} catch { storageAvailable = false; }
let mode = settings.mode || 'human', sequence = 0, presets = [], seats = [], lastMatch = null;
let noticeTimer, starting = false, importTarget = null, replaceSeat = null, hudSignature = '';
let series = null, nextRoundTimer, latestRecording = null;
const recentResults = [];
const sourceCache = new Map();

function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
  $('notice').hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { $('notice').hidden = true; }, error ? 11000 : 6500);
}
function save() {
  try { localStorage.setItem(STORAGE, JSON.stringify({ settings, stats, aiStats })); }
  catch { if (storageAvailable) notice('浏览器未允许保存本地数据，本次游戏仍可继续；关闭页面后战绩不会保留。', true); storageAvailable = false; }
}
const replayPanel = new ReplayPanel({ notice });
function collectSettings() {
  settings = { mode, name: $('human-name').value.trim() || '挑战者', color: $('human-color').value,
    map: $('map').value, timeout: Number($('timeout').value), powerups: $('powerups').value === 'on',
    wallBreak: false, touch: $('touch-setting').checked,
    rounds: Math.max(0, Math.floor(Number($('rounds').value))), speed: Number($('speed').value),
    headless: $('headless').checked, detailRecording: $('detail-recording').checked, rankSort: $('rank-sort').value };
  save();
}
function node(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function addSeat(preset, source, imported = false, filename = '') {
  const seat = { id: `seat-${++sequence}`, recordId: imported ? `local:${filename}` : `preset:${preset.id}`,
    name: preset.name, color: preset.color || COLORS[sequence % COLORS.length], kind: 'ai',
    enabled: true, source, presetId: preset.id, imported, filename };
  seats.push(seat);
  renderRoster();
  return seat;
}
function setMode(next) {
  mode = next;
  $('human-mode').classList.toggle('selected', mode === 'human');
  $('ai-mode').classList.toggle('selected', mode === 'ai');
  $('human-settings').hidden = mode === 'ai';
  $('ai-settings').hidden = mode !== 'ai';
  $('start-match').firstChild.textContent = mode === 'human' ? '进入战场 ' : '开始观战 ';
  renderRoster();
  collectSettings();
}
function renderRoster() {
  $('roster').replaceChildren();
  for (const seat of seats) {
    const row = node('div', undefined, 'roster-row');
    const enabled = node('input'); enabled.type = 'checkbox'; enabled.checked = seat.enabled;
    enabled.setAttribute('aria-label', `${seat.name} 是否参赛`);
    enabled.onchange = () => { seat.enabled = enabled.checked; };
    const color = node('input'); color.type = 'color'; color.value = seat.color; color.setAttribute('aria-label', `${seat.name} 颜色`);
    color.oninput = () => { seat.color = color.value; };
    const name = seat.imported ? node('input') : node('span', seat.name, 'roster-name');
    if (seat.imported) {
      name.value = seat.name; name.maxLength = 24; name.setAttribute('aria-label', '自定义 AI 名称');
      name.onchange = () => { seat.name = name.value.trim() || 'AI'; };
    } else name.title = seat.name;
    const controller = node('select'); controller.setAttribute('aria-label', `${seat.name} 控制者`);
    controller.append(new Option('AI', 'ai'), new Option('真人', 'human')); controller.value = seat.kind;
    controller.onchange = () => {
      seat.kind = controller.value;
      if (seat.kind === 'human') {
        for (const other of seats) if (other !== seat) other.kind = 'ai';
        setMode('human');
        notice('你将操控这个席位，其余启用的席位由 AI 控制。名字和颜色使用该席位设置。');
      } else renderRoster();
    };
    const remove = node('button', '×'); remove.title = `移除 ${seat.name}`;
    remove.onclick = () => { seats = seats.filter(p => p !== seat); renderRoster(); };
    row.append(enabled, color, name, controller, remove);
    if (seat.imported) {
      row.classList.add('imported-seat');
      const replace = node('button', '替换', 'replace-script');
      replace.title = '替换脚本，保留名称、颜色与战绩身份';
      replace.onclick = () => { replaceSeat = seat; $('file-input').multiple = false; $('file-input').click(); };
      row.insertBefore(replace, remove);
    }
    $('roster').append(row);
  }
  $('roster-empty').hidden = seats.length > 0;
}
function renderPresets() {
  const availablePresets = presets.filter(preset => sourceCache.has(preset.id));
  $('preset-picker').replaceChildren(...GROUPS.map(group => {
    const options = node('optgroup'); options.label = group.name;
    options.append(...availablePresets.filter(preset => preset.group === group.id)
      .sort((a, b) => a.order - b.order).map(preset => new Option(preset.name, preset.id)));
    return options;
  }));
  $('preset-picker').disabled = availablePresets.length === 0;
  $('add-preset').disabled = availablePresets.length === 0;
  const makeCard = preset => {
    const available = sourceCache.has(preset.id);
    const card = node('article', undefined, `preset-card ${available ? 'available' : 'unavailable'}`);
    card.style.setProperty('--bot-color', preset.color);
    card.append(node('span', '▣', 'bot-icon'), node('h3', preset.name), node('span', preset.codename, 'codename'));
    if (preset.group === 'training') card.append(node('p', preset.description));
    if (preset.motto) card.append(node('p', preset.motto));
    const actions = node('div', undefined, 'card-actions');
    const challenge = node('button', available ? '挑战此 AI  ↗' : '本地导入', 'challenge');
    challenge.onclick = () => {
      if (!available) { importTarget = preset; $('file-input').click(); return; }
      seats = []; addSeat(preset, sourceCache.get(preset.id)); setMode('human');
      $('match-setup').scrollIntoView({ behavior: 'smooth', block: 'start' });
    };
    actions.append(challenge);
    if (available) {
      const add = node('button', '＋', 'add-seat'); add.title = '加入一个 AI 席位';
      add.onclick = () => { addSeat(preset, sourceCache.get(preset.id)); notice(`${preset.name} 已加入阵容。`); };
      actions.append(add);
    }
    card.append(actions); return card;
  };
  $('preset-list').replaceChildren(...GROUPS.map(group => {
    const entries = presets.filter(preset => preset.group === group.id).sort((a, b) => a.order - b.order);
    const section = node('section', undefined, 'preset-group');
    const heading = node('div', undefined, 'preset-group-heading');
    heading.append(node('h3', group.name));
    const row = node('div', undefined, 'preset-grid'); row.setAttribute('aria-label', `${group.name}选手`);
    row.append(...entries.map(makeCard)); section.append(heading, row);
    return section;
  }));
}
function renderStats() {
  $('stats').replaceChildren(...[['挑战', stats.played], ['胜利', stats.wins], ['失败', stats.losses], ['平局', stats.draws], ['最佳连胜', stats.best]].map(([label, value]) => {
    const el = node('div', undefined, 'stat'); el.append(node('strong', value), node('span', label)); return el;
  }));
  $('opponent-records').replaceChildren(...Object.values(stats.opponents).map(record => node('p', `${record.name}：${record.played} 次 · ${record.wins} 胜 / ${record.losses} 负 / ${record.draws} 平`)));
}
function recordResult(result) {
  const human = game.players.find(p => p.kind === 'human');
  if (!human) {
    recordAIResult(aiStats, game.players, result, game.recording);
    save(); renderRanking(); return;
  }
  const outcome = result.players.find(p => p.id === human.id).forfeit ? 'losses' : result.winnerId === human.id ? 'wins' : result.winnerId ? 'losses' : 'draws';
  stats.played++; stats[outcome]++;
  stats.streak = outcome === 'wins' ? stats.streak + 1 : 0;
  stats.best = Math.max(stats.best, stats.streak);
  for (const opponent of game.players.filter(p => p.kind === 'ai')) {
    const key = opponent.recordId;
    const record = stats.opponents[key] ||= { name: opponent.name, played: 0, wins: 0, losses: 0, draws: 0 };
    record.name = opponent.name; record.played++; record[outcome]++;
  }
  save(); renderStats();
}
function renderRanking() {
  renderLocalRanking(aiStats, $('rank-sort').value, [$('ai-ranking'), $('live-ranking')]);
}
function rememberResult(result) {
  latestRecording = game.recording;
  const winner = game.players.find(p => p.id === result.winnerId);
  recentResults.unshift({ label: `${winner ? `${winner.name} 获胜` : result.reason === 'all_forfeit' ? '全部故障判负' : '平局'} · ${(result.ticks / 60).toFixed(1)} 秒 · 种子 ${game.world.seed}` });
  recentResults.length = Math.min(recentResults.length, 10);
  $('recent-results').replaceChildren(...recentResults.map(result => node('p', result.label)));
  $('latest-recording').disabled = false; $('live-recording').disabled = false;
}
function showLatestRecording() {
  game.pause();
  if (latestRecording.states?.length) replayPanel.open(latestRecording);
  else downloadRecording(latestRecording);
}
function showResult(result) {
  controls.setEnabled(false);
  recordResult(result);
  rememberResult(result);
  series.completed++;
  if (series.active && (!series.total || series.completed < series.total)) {
    $('series-progress').textContent = `已完成 ${series.completed} / ${series.total || '∞'} 局 · 准备下一局`;
    nextRoundTimer = setTimeout(() => startMatch(true, false, true), game.headless ? 0 : 700 / game.speed);
    return;
  }
  series.active = false;
  const human = game.players.find(p => p.kind === 'human');
  const winner = game.players.find(p => p.id === result.winnerId);
  $('result-title').textContent = human ? winner?.id === human.id ? '胜利' : winner ? '失败' : '平局' : winner ? `${winner.name} 获胜` : '本局无胜者';
  const reason = { timeout: '达到单局时限', mutual: '全部坦克阵亡', all_forfeit: '全部 AI 故障判负', survivor: '最后一辆坦克存活' }[result.reason];
  const opponents = game.players.filter(p => p.kind === 'ai').map(p => p.name).join('、');
  $('result-summary').textContent = `${human ? `对手：${opponents}。` : `本赛程完成 ${series.completed} 局。`}历时 ${(result.ticks / 60).toFixed(1)} 秒 · ${reason} · 种子 ${game.world.seed}`;
  $('result-details').replaceChildren(...result.players.map(resultPlayer => {
    const player = game.players.find(p => p.id === resultPlayer.id);
    return node('p', `${player.name} · ${resultPlayer.kills} 击杀${resultPlayer.forfeit ? ` · 故障判负：${resultPlayer.forfeit.message}` : ''}`);
  }));
  $('view-replay').disabled = !latestRecording?.states?.length;
  $('download-recording').disabled = !latestRecording;
  $('download-recording').textContent = latestRecording?.states?.length ? '下载录像' : '下载日志';
  $('result-dialog').showModal();
}
const game = new ChallengeGame({
  canvas: $('battle-canvas'),
  onUpdate: ({ world, status, simRate }) => {
    controls?.setEnabled(status === 'running' && game.players.some(p => p.kind === 'human'));
    $('pause').textContent = status === 'paused' ? '继续' : '暂停';
    $('pause').disabled = !['running', 'paused'].includes(status);
    $('pause-overlay').hidden = !['paused', 'loading', 'error'].includes(status);
    $('pause-title').textContent = status === 'loading' ? '准备开战' : status === 'error' ? '对局已停止' : '已暂停';
    $('pause-message').textContent = status === 'loading' ? '正在加载 AI…' : status === 'error' ? '可返回调整选手，或重新开始。' : '点击继续对战，或按 Esc 返回。';
    $('resume').hidden = status !== 'paused';
    $('headless-overlay').hidden = !game.headless;
    if (!world) return;
    const seconds = Math.floor(world.tick / 60);
    $('clock').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
    $('alive-count').textContent = `${world.alive.length}/${world.actors.length} 存活 · ${world.maze.cols}×${world.maze.rows}`;
    const signature = world.actors.map(p => `${p.id}:${p.tank.alive}:${p.forfeit?.code}`).join();
    if (signature !== hudSignature) {
      hudSignature = signature;
      $('battle-roster').replaceChildren(...world.actors.map(actor => {
        const el = node('span', undefined, actor.tank.alive ? '' : 'dead');
        const dot = node('i', undefined, 'player-dot'); dot.style.background = actor.color;
        el.append(dot, document.createTextNode(`${actor.name}${game.players.find(p => p.id === actor.id).kind === 'human' ? ' · 你' : ''}${actor.forfeit ? ' · 故障' : ''}`)); return el;
      }));
    }
    const human = game.players.find(p => p.kind === 'human');
    const tank = world.actors.find(p => p.id === human?.id)?.tank;
    $('weapon-status').textContent = !tank ? '观战中 · 所有选手本地运算' : !tank.alive ? '你已阵亡 · 继续观战' : [tank.laserShots ? `激光 ×${tank.laserShots}` : tank.scatterShots ? `散射 ×${tank.scatterShots}` : '普通炮弹', tank.mineCharges ? `地雷 ×${tank.mineCharges}` : '', tank.shield ? `护盾 ${Math.ceil(tank.shieldTimer)}s` : ''].filter(Boolean).join(' · ');
    $('performance-status').textContent = `${simRate.toFixed(2)}× 实际速度 · 固定 60 Hz · 50 ms 决策预算`;
  }, onEnd: showResult, onNotice: message => notice(message, true),
});
const controls = new HumanControls({ joystick: $('joystick'), knob: $('knob'), fireButton: $('fire-button'), specialButton: $('special-button'),
  onAction: action => game.setHumanAction(action), onPause: () => togglePause(),
});

function togglePause() {
  controls.reset();
  if (game.status === 'paused') game.resume(); else game.pause();
}
function touchLayout() {
  $('battle').classList.toggle('touch-enabled', $('touch-setting').checked && game.players.some(p => p.kind === 'human'));
}
async function startMatch(repeat = false, sameSeed = false, nextRound = false) {
  if (starting) return;
  collectSettings();
  let players, rules;
  const seed = sameSeed ? lastMatch?.seed : undefined;
  if (repeat && lastMatch) ({ players, rules } = lastMatch);
  else {
    const selected = seats.filter(p => p.enabled);
    const chosenHuman = selected.find(p => p.kind === 'human');
    players = selected.map(p => ({ ...p, kind: mode === 'ai' ? 'ai' : p.kind }));
    if (mode === 'human' && !chosenHuman) players.unshift({ id: 'human', name: settings.name, color: settings.color, kind: 'human' });
    rules = { timeout: settings.timeout, powerups: settings.powerups, wallBreak: settings.wallBreak, map: settings.map,
      speed: settings.speed, headless: settings.headless, detailRecording: settings.detailRecording };
  }
  if (players.length < 2 || !players.some(p => p.kind === 'ai')) { notice('请至少启用两个参赛席位，其中至少一个为 AI。观战模式需要两名 AI。', true); return; }
  clearTimeout(nextRoundTimer);
  const aiOnly = players.every(p => p.kind === 'ai');
  if (!nextRound) series = { active: aiOnly && !sameSeed, completed: 0, total: aiOnly && !sameSeed ? settings.rounds : 1 };
  starting = true;
  $('result-dialog').close();
  $('lobby').hidden = true; $('battle').hidden = false; document.body.classList.add('playing');
  $('battle-mode').textContent = players.some(p => p.kind === 'human') ? 'HUMAN vs AI' : 'AI vs AI';
  $('series-toolbar').hidden = !aiOnly; $('live-ranking-panel').hidden = !aiOnly;
  $('series-progress').textContent = `第 ${series.completed + 1} / ${series.total || '∞'} 局`;
  $('live-speed').value = String(rules.speed); $('live-headless').checked = rules.headless;
  $('live-speed').disabled = rules.headless;
  hudSignature = ''; lastMatch = { players, rules }; controls.reset();
  try {
    const started = game.start({ players, rules, seed, round: series.completed + 1 });
    lastMatch.seed = game.world.seed;
    touchLayout(); await started; $('battle-canvas').focus({ preventScroll: true });
  }
  catch (error) { game.stop(); notice(`无法开始对局：${error.message}`, true); }
  finally { starting = false; }
}
function returnToLobby() {
  clearTimeout(nextRoundTimer);
  if (series) series.active = false;
  game.stop(); controls.setEnabled(false); $('result-dialog').close();
  $('battle').hidden = true; $('lobby').hidden = false; document.body.classList.remove('playing');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
async function importFiles(files) {
  const target = importTarget; importTarget = null;
  const replacement = replaceSeat; replaceSeat = null; $('file-input').multiple = true;
  for (const file of files) {
    if (!/\.(c?js)$/i.test(file.name)) { notice(`${file.name} 不是 JavaScript 文件。`, true); continue; }
    try {
      const source = await file.text();
      if (replacement) {
        replacement.source = source; replacement.filename = file.name;
        renderRoster(); notice(`${replacement.name} 的脚本已替换，名称、颜色与战绩身份保留。`);
        break;
      }
      const preset = target && files.length === 1 ? target : { name: file.name.replace(/\.(c?js)$/i, ''), color: COLORS[sequence % COLORS.length] };
      addSeat(preset, source, true, file.name);
      notice(`${file.name} 已读入本机。开始对局时会在隔离环境中加载；文件没有上传。`);
    } catch (error) { notice(`无法读取 ${file.name}：${error.message}`, true); }
  }
  $('file-input').value = '';
  $('match-setup').scrollIntoView({ behavior: 'smooth' });
}
$('start-match').onclick = () => startMatch();
$('add-preset').onclick = () => {
  const preset = presets.find(preset => preset.id === $('preset-picker').value);
  addSeat(preset, sourceCache.get(preset.id));
};
$('quick-start').onclick = () => { setMode('human'); startMatch(); };
$('watch-mode').onclick = () => {
  setMode('ai');
  if (seats.filter(p => p.enabled).length < 2) {
    const available = presets.filter(p => sourceCache.has(p.id));
    const preset = available.find(p => !seats.some(s => s.presetId === p.id)) || available[0];
    if (preset) addSeat(preset, sourceCache.get(preset.id));
  }
  $('match-setup').scrollIntoView({ behavior: 'smooth' });
};
$('human-mode').onclick = () => setMode('human'); $('ai-mode').onclick = () => setMode('ai');
for (const id of ['import-top', 'import-ai']) $(id).onclick = () => { importTarget = null; replaceSeat = null; $('file-input').multiple = true; $('file-input').click(); };
$('file-input').onchange = e => importFiles([...e.target.files]);
$('file-input').oncancel = () => { importTarget = null; replaceSeat = null; $('file-input').multiple = true; };
$('pause').onclick = togglePause; $('resume').onclick = togglePause;
$('restart').onclick = () => startMatch(true); $('again').onclick = () => startMatch(true);
$('same-seed').onclick = () => startMatch(true, true);
$('view-replay').onclick = () => replayPanel.open(latestRecording);
$('download-recording').onclick = () => downloadRecording(latestRecording);
$('latest-recording').onclick = showLatestRecording;
$('live-recording').onclick = showLatestRecording;
$('open-recording').onclick = () => replayPanel.openFile();
$('return').onclick = returnToLobby; $('change-opponent').onclick = returnToLobby;
$('result-dialog').addEventListener('cancel', () => returnToLobby());
$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await $('battle').requestFullscreen();
    try { await screen.orientation.lock('landscape'); } catch { notice('已进入全屏；若画面竖直，请手动将手机转为横屏。'); }
  } catch { notice('此浏览器未提供全屏，请将手机横屏使用。'); }
};
$('reset-records').onclick = () => {
  if (confirm('清除本浏览器的真人挑战战绩？此操作不可撤销，不影响 AI 排行榜。')) { stats = emptyStats(); save(); renderStats(); }
};
$('reset-ai-records').onclick = () => {
  if (confirm('清除本浏览器的 AI 排行榜？此操作不可撤销，不影响真人挑战战绩。')) { aiStats = {}; save(); renderRanking(); }
};
$('rank-sort').onchange = () => { collectSettings(); renderRanking(); };
for (const id of ['human-name', 'human-color', 'map', 'timeout', 'powerups', 'touch-setting', 'rounds', 'speed', 'headless', 'detail-recording']) $(id).addEventListener('change', collectSettings);
for (const id of ['live-speed', 'live-headless']) $(id).onchange = () => {
  const speed = Number($('live-speed').value), headless = $('live-headless').checked;
  $('speed').value = String(speed); $('headless').checked = headless; $('live-speed').disabled = headless;
  collectSettings(); lastMatch.rules.speed = speed; lastMatch.rules.headless = headless;
  game.setPlayback(speed, headless);
};
window.addEventListener('blur', () => game.pause());
document.addEventListener('visibilitychange', () => { if (document.hidden) game.pause(); });
window.addEventListener('pagehide', () => { clearTimeout(nextRoundTimer); game.stop(); });
window.addEventListener('keydown', event => {
  if (event.code === 'Escape' && !event.defaultPrevented && !event.repeat && !controls.enabled && ['running', 'paused'].includes(game.status)) { event.preventDefault(); togglePause(); }
});

$('human-name').value = settings.name || '挑战者'; $('human-color').value = settings.color || '#43dfbd';
$('map').value = settings.map || 'random'; $('timeout').value = String(settings.timeout || 60);
$('powerups').value = settings.powerups === false ? 'off' : 'on';
$('touch-setting').checked = settings.touch ?? matchMedia('(pointer:coarse)').matches;
$('rounds').value = settings.rounds ?? 10; $('speed').value = String(settings.speed || 1);
$('headless').checked = settings.headless ?? false; $('detail-recording').checked = settings.detailRecording ?? false;
$('rank-sort').value = settings.rankSort || 'wins';
setMode(mode); renderStats(); renderRanking();
$('quick-start').disabled = true; $('start-match').disabled = true;
try {
  const response = await fetch('./bots/roster.json');
  if (!response.ok) throw new Error(`预设清单 HTTP ${response.status}`);
  presets = await response.json();
  await Promise.all(presets.filter(p => p.script).map(async preset => {
    try { const response = await fetch(preset.script); if (!response.ok) throw new Error(`HTTP ${response.status}`); sourceCache.set(preset.id, await response.text()); }
    catch (error) { notice(`${preset.name} 加载失败：${error.message}。可导入本地脚本。`, true); }
  }));
  renderPresets();
  const initial = presets.find(p => p.id === 'sentry' && sourceCache.has(p.id)) || presets.find(p => sourceCache.has(p.id));
  if (initial) addSeat(initial, sourceCache.get(initial.id));
  if (mode === 'ai') { const other = presets.find(p => p !== initial && sourceCache.has(p.id)); if (other) addSeat(other, sourceCache.get(other.id)); }
} catch (error) { notice(`预设无法加载：${error.message}。仍可导入本地 JS。`, true); }
$('quick-start').disabled = false; $('start-match').disabled = false;
if (!storageAvailable) notice('浏览器未允许读取战绩，本次游戏仍可继续。', true);
