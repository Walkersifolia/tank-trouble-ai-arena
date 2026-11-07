import { MatchReplay } from '../engine/arena/replay.js';
import { ArenaRenderer } from '../engine/arena/render.js';
import { exportRecordingMp4, supportedMp4Type } from './video-export.js?v=arena-native-1';

const format = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '未记录';
const signed = value => Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(3)}` : '未记录';
const direction = (value, threshold) => Math.abs(value) <= threshold ? 0 : Math.sign(value);

export function downloadRecording(record) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(record)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `tank-match-${record.seed ?? record.mapSeed ?? record.id ?? 'recording'}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 旧录像没有方向统计时，也只根据录下来的真实位移计算，不运行运动核心。
function actualDirections(tank) {
  const movement = tank.movement;
  const middleAngle = tank.angle - tank.dAngle / 2;
  const forwardDistance = tank.dx * Math.cos(middleAngle) + tank.dy * Math.sin(middleAngle);
  return {
    move: movement?.actualMoveDirection ?? direction(forwardDistance, 0.01),
    turn: movement?.actualTurnDirection ?? direction(tank.dAngle, 0.001),
  };
}

function countDirections(states) {
  const totals = new Map(), previous = new Map();
  return states.map(state => {
    for (const tank of state.tanks) {
      if (!totals.has(tank.id)) {
        totals.set(tank.id, { move: 0, turn: 0, actualMove: 0, actualTurn: 0 });
        previous.set(tank.id, { move: 0, turn: 0, actualMove: 0, actualTurn: 0 });
      }
      if (tank.actionApplied === false || !(state.dt > 0 || state.phase === 'step')) continue;
      const actual = actualDirections(tank);
      const directions = { move: Math.sign(tank.action?.move ?? 0), turn: Math.sign(tank.action?.turn ?? 0),
        actualMove: actual.move, actualTurn: actual.turn };
      const total = totals.get(tank.id), last = previous.get(tank.id);
      for (const key of Object.keys(directions)) {
        const value = directions[key];
        if (value && last[key] && value !== last[key]) total[key]++;
        if (value) last[key] = value;
      }
    }
    return new Map([...totals].map(([id, total]) => [id, { ...total }]));
  });
}

export class ReplayPanel {
  constructor({ notice }) {
    this.notice = notice;
    this.dialog = document.createElement('dialog');
    this.dialog.className = 'replay-panel';
    this.dialog.setAttribute('aria-labelledby', 'web-replay-title');
    this.dialog.innerHTML = `
      <header class="replay-heading">
        <div><h2 id="web-replay-title">回放与诊断</h2><p data-ref="meta"></p></div>
        <button type="button" class="text-button" data-ref="close" aria-label="关闭回放">关闭 ✕</button>
      </header>
      <p class="replay-note" data-ref="status"></p>
      <div class="replay-layout">
        <div class="replay-player">
          <div class="replay-stage"><canvas data-ref="canvas" aria-label="比赛录像画面"></canvas></div>
          <div class="replay-transport">
            <button type="button" data-ref="previous" title="上一物理 Tick（约 16.7ms）">−1 Tick</button>
            <button type="button" class="primary" data-ref="play">播放</button>
            <button type="button" data-ref="next" title="下一物理 Tick（约 16.7ms）">+1 Tick</button>
            <label class="replay-speed">速度<select data-ref="speed" aria-label="回放速度">
              <option value="0.25">0.25×</option><option value="0.5">0.5×</option>
              <option value="1" selected>1×</option><option value="2">2×</option>
            </select></label>
          </div>
          <input class="replay-seek" data-ref="seek" type="range" min="0" max="0" step="1" value="0" aria-label="回放时间轴">
          <output class="replay-clock" data-ref="time"></output>
        </div>
        <aside class="replay-diagnostics" aria-label="运动诊断">
          <label>观察坦克<select data-ref="tank" aria-label="选择诊断坦克"></select></label>
          <p class="replay-frame-label" data-ref="frame"></p>
          <h3>当前物理 Tick</h3>
          <dl data-ref="current"></dl>
          <h3>最近 1 秒</h3>
          <dl data-ref="window"></dl>
          <h3>全局摘要</h3>
          <dl data-ref="summary"></dl>
          <p class="replay-explanation">控制是实际提交的连续 move / turn；位移、转角来自真实状态。反向次数跨过零输入继续计数。实际移动方向按位移在车身前向的投影计算，忽略 ≤0.01px 的变化；转角忽略 ≤0.001rad 的变化。</p>
          <p class="replay-explanation">反复换向、低位移和墙面接触只说明同一时间发生的事实，不能单凭这些数据判定 AI 意图或碰撞错误。画面直接显示记录位置，不叠加显示平滑。</p>
        </aside>
      </div>
      <div class="replay-transport">
        <button type="button" data-ref="exportVideo">导出 MP4</button>
        <button type="button" data-ref="cancelVideo" hidden>取消导出</button>
        <progress data-ref="videoProgress" max="1" value="0" aria-label="视频导出进度" hidden></progress>
      </div>
      <p class="replay-note" data-ref="videoStatus" role="status"></p>
      <footer class="replay-bottom">
        <p>回放读取现场状态，不运行 AI 或重新计算物理；录像不含 AI 源码。</p>
        <button type="button" data-ref="download">下载录像</button>
      </footer>`;
    document.body.append(this.dialog);
    this.ui = Object.fromEntries([...this.dialog.querySelectorAll('[data-ref]')].map(el => [el.dataset.ref, el]));
    this.fileInput = document.createElement('input');
    this.fileInput.type = 'file';
    this.fileInput.accept = '.json,application/json';
    this.fileInput.hidden = true;
    document.body.append(this.fileInput);
    this.fileInput.onchange = async () => {
      const file = this.fileInput.files[0];
      if (!file) return;
      try { this.open(JSON.parse(await file.text())); }
      catch (error) { this.notice(`无法打开录像，请选择本游戏下载的 JSON 录像。${error.message}`, true); }
      this.fileInput.value = '';
    };
    this.renderer = new ArenaRenderer(this.ui.canvas);
    this.ui.close.onclick = () => this.dialog.close();
    this.dialog.addEventListener('close', () => {
      cancelAnimationFrame(this.animation);
      if (this.replay) this.replay.playing = false;
      this.cancelVideoExport();
    });
    this.ui.play.onclick = () => {
      if (this.replay.position >= this.replay.totalTicks) this.replay.seek(0);
      this.replay.playing = !this.replay.playing;
      this.refresh();
    };
    this.ui.previous.onclick = () => this.step(-1);
    this.ui.next.onclick = () => this.step(1);
    this.ui.seek.oninput = () => {
      this.replay.playing = false;
      this.replay.seek(Number(this.ui.seek.value));
      this.refresh();
    };
    this.ui.speed.onchange = () => { if (this.replay) this.replay.speed = Number(this.ui.speed.value); };
    this.ui.tank.onchange = () => { this.lastDiagnosticIndex = -1; this.refresh(); };
    this.ui.download.onclick = () => downloadRecording(this.record);
    this.ui.exportVideo.onclick = () => this.exportVideo();
    this.ui.cancelVideo.onclick = () => this.videoExport.abort();
  }

  openFile() { this.fileInput.click(); }

  open(record) {
    cancelAnimationFrame(this.animation);
    this.cancelVideoExport();
    this.record = record;
    this.replay = record.states?.length ? new MatchReplay(record) : null;
    this.lastDiagnosticIndex = -1;
    this.directionCounts = this.replay ? countDirections(record.states) : [];
    const duration = record.summary?.durationSeconds ?? record.result?.ticks / record.physicsHz;
    this.ui.meta.textContent = `${format(duration, 1)} 秒 · 种子 ${record.seed ?? record.mapSeed ?? '旧录像未记录'}`;
    this.ui.status.textContent = !this.replay
      ? '此录像只有摘要，没有逐帧状态，无法播放。仍可查看统计或下载原始录像。'
      : record.detailTruncated
        ? `逐帧记录已达到体积上限，回放截至 ${format(this.replay.totalTicks / record.physicsHz, 1)} 秒；全局摘要仍涵盖整局。`
        : '可拖动时间轴或逐 Tick 定位偶发抽动，右侧对照当时的指令与真实运动。';
    this.ui.tank.replaceChildren(...record.players.map(player => new Option(player.name, player.id)));
    this.ui.canvas.parentElement.hidden = !this.replay;
    for (const name of ['previous', 'play', 'next', 'seek', 'speed']) this.ui[name].disabled = !this.replay;
    this.ui.seek.max = this.replay?.totalTicks ?? 0;
    this.mp4Type = supportedMp4Type();
    this.ui.exportVideo.disabled = !this.replay || !this.mp4Type;
    this.ui.cancelVideo.hidden = this.ui.videoProgress.hidden = true;
    this.ui.videoStatus.textContent = !this.replay
      ? '导出视频需要逐帧状态。请在下一局开始前勾选“详细录制”；已有摘要无法补出画面。'
      : !this.mp4Type
        ? '当前浏览器不支持 MP4 录制，请换用支持 MP4 录制的浏览器打开这份 JSON。'
        : `导出竞技场及选手姓名：按地图原生尺寸 ${record.initialState.map.width}×${record.initialState.map.height}、30fps、无声 MP4，不含场地外留白。目标约 7.5MB/分钟（实际大小以浏览器编码为准）。按原速生成，耗时约 ${format(this.replay.totalTicks / record.physicsHz, 1)} 秒。${record.detailTruncated ? '仅导出已记录的部分。' : ''}导出期间可继续查看回放；切换标签页会暂停导出，关闭回放会取消。`;
    if (this.replay) this.replay.speed = Number(this.ui.speed.value);
    if (!this.dialog.open) this.dialog.showModal();
    this.lastTime = performance.now();
    this.refresh();
    this.animate = now => {
      if (!this.dialog.open) return;
      const seconds = (now - this.lastTime) / 1000;
      this.lastTime = now;
      this.replay?.advance(seconds);
      this.refresh();
      this.animation = requestAnimationFrame(this.animate);
    };
    this.animation = requestAnimationFrame(this.animate);
  }

  step(delta) {
    this.replay.playing = false;
    this.replay.seek(Math.floor(this.replay.position) + delta);
    this.refresh();
  }

  cancelVideoExport() {
    this.videoExport?.abort();
    this.videoExport = null;
  }

  async exportVideo() {
    const controller = new AbortController();
    this.videoExport = controller;
    this.ui.exportVideo.disabled = true;
    this.ui.cancelVideo.hidden = this.ui.videoProgress.hidden = false;
    this.ui.videoProgress.value = 0;
    this.ui.videoStatus.textContent = '正在准备 MP4…';
    try {
      const blob = await exportRecordingMp4(this.record, {
        mimeType: this.mp4Type,
        signal: controller.signal,
        onProgress: (value, paused) => {
          this.ui.videoProgress.value = value;
          this.ui.videoStatus.textContent = paused
            ? `导出已暂停（${Math.round(value * 100)}%），返回此标签页后继续。`
            : `正在导出 MP4 · ${Math.round(value * 100)}% · 可继续查看回放，关闭回放将取消导出。`;
        },
      });
      if (this.videoExport !== controller) return;
      if (blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `tank-match-${this.record.seed ?? this.record.mapSeed ?? this.record.id ?? 'recording'}.mp4`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.ui.videoStatus.textContent = `MP4 已生成并开始下载（竞技场及选手姓名，${this.record.initialState.map.width}×${this.record.initialState.map.height}、30fps、无声）。`;
      } else {
        this.ui.videoStatus.textContent = '已取消导出。';
      }
    } catch (error) {
      if (this.videoExport === controller) this.ui.videoStatus.textContent = `MP4 导出失败：${error.message}`;
    } finally {
      if (this.videoExport === controller) {
        this.videoExport = null;
        this.ui.exportVideo.disabled = false;
        this.ui.cancelVideo.hidden = this.ui.videoProgress.hidden = true;
      }
    }
  }

  refresh() {
    const replay = this.replay;
    if (replay) {
      this.renderer.recordedEffects(replay.world, replay.recentEvents(2), replay.time);
      this.renderer.draw(replay.world, 0, true);
      this.ui.play.textContent = replay.playing ? '暂停' : replay.position >= replay.totalTicks ? '重新播放' : '播放';
      this.ui.seek.value = Math.floor(replay.position);
      this.ui.time.textContent = `${format(replay.time, 3)} / ${format(replay.totalTicks / this.record.physicsHz, 3)} 秒 · Tick ${replay.world.tick}`;
      this.ui.previous.disabled = replay.position <= 0;
      this.ui.next.disabled = replay.position >= replay.totalTicks;
    } else {
      this.ui.time.textContent = '无逐帧状态';
    }
    const index = replay?.index ?? 0;
    if (index !== this.lastDiagnosticIndex) {
      this.lastDiagnosticIndex = index;
      this.renderDiagnostics();
    }
  }

  rows(element, rows) {
    element.replaceChildren(...rows.flatMap(([label, value]) => {
      const term = document.createElement('dt'), description = document.createElement('dd');
      term.textContent = label; description.textContent = value;
      return [term, description];
    }));
  }

  recentCounts(id) {
    const index = this.replay.index, states = this.record.states;
    const boundary = states[index].tick - this.record.physicsHz;
    let before = index;
    while (before >= 0 && states[before].tick > boundary) before--;
    const current = this.directionCounts[index].get(id);
    const previous = this.directionCounts[before]?.get(id);
    return Object.fromEntries(Object.entries(current).map(([key, value]) => [key, value - (previous?.[key] ?? 0)]));
  }

  renderDiagnostics() {
    const id = this.ui.tank.value, frame = this.record.states?.[this.replay?.index];
    const tank = frame?.tanks.find(t => t.id === id);
    const stats = this.record.summary?.players.find(p => p.id === id);
    if (tank) {
      const dt = frame.dt ?? 1 / this.record.physicsHz;
      const stepped = tank.actionApplied !== false && dt > 0;
      const contacts = tank.movement?.contacts;
      const contactText = contacts == null ? '旧录像或此帧未记录'
        : [contacts.wall && '墙面', contacts.tank && '坦克'].filter(Boolean).join('、') || '无';
      this.ui.frame.textContent = `Tick ${frame.tick} · ${tank.alive ? '存活' : '已出局'}${stepped ? '' : ' · 本帧未执行运动'}`;
      this.rows(this.ui.current, [
        ['move / turn', `${signed(tank.action?.move)} / ${signed(tank.action?.turn)}`],
        ['真实坐标', `${format(tank.x)}, ${format(tank.y)} px`],
        ['dx / dy', `${signed(tank.dx)} / ${signed(tank.dy)} px`],
        ['dAngle', `${signed(tank.dAngle)} rad`],
        ['实际速度', stepped ? `${format(Math.hypot(tank.dx, tank.dy) / dt)} px/s` : '—'],
        ['实际角速度', stepped ? `${format(tank.dAngle / dt)} rad/s` : '—'],
        ['请求 / 实际位移', `${format(tank.movement?.expectedDistance, 3)} / ${format(tank.movement?.distance, 3)} px`],
        ['低位移 / 接触', `${tank.movement?.lowDisplacement ? '是' : '否'} / ${contactText}`],
      ]);
      const recent = this.recentCounts(id);
      this.rows(this.ui.window, [
        ['move / turn 指令反向', `${recent.move} / ${recent.turn} 次`],
        ['实际移动 / 转动反向', `${recent.actualMove} / ${recent.actualTurn} 次`],
      ]);
    } else {
      this.ui.frame.textContent = '没有逐帧运动数据';
      this.rows(this.ui.current, [['运动状态', '未记录']]);
      this.rows(this.ui.window, [['反向次数', '未记录']]);
    }
    this.rows(this.ui.summary, stats ? [
      ['实际路程', `${format(stats.distanceTravelled, 1)} px`],
      ['move / turn 指令反向', `${stats.moveReversals} / ${stats.turnReversals} 次`],
      ['实际移动 / 转动反向', stats.actualMoveReversals == null ? '旧录像未记录' : `${stats.actualMoveReversals} / ${stats.actualTurnReversals} 次`],
      ['低位移时长', `${format(stats.stationaryMoveTicks / this.record.physicsHz)} 秒`],
      ['击杀 / 发射', `${stats.kills} / ${stats.shotsFired}`],
    ] : [['全局摘要', '未记录']]);
  }
}
