// Opus Gen2「衔尾」OUROBOROS
// Tank Trouble 竞技 AI：自包含单文件，只使用 API.md 的公开状态。
// 每 Tick 流程：观测入账 → 威胁表 → 战术计划 → 候选轨迹评估 → 开火/布雷判定。
// 运动模型按公开物理常量实现车身与炮管 OBB、厚墙和接触转动，弹道逐 Tick 外推。
// 候选轨迹除当前来弹外还看退路：走到中途再分支，数还有多少路躲得过，以及对手此刻开火躲不躲得掉。
// 离线自我对弈得到两部分，比赛时不再学习；对局覆盖单挑、多人混战，有道具和无道具，内墙不可破坏：
//   1. TUNE：候选打分权重与开火门限，用进化策略按对局名次优化；
//   2. 价值网络：估计候选 0.4 秒后局面的阵亡与击杀概率，用对局结局在 GPU 上训练，权重内嵌于本文件。
// 局内自我迭代（每局从零开始，没有跨局记忆）：
//   1. 运动预测竞选：多个预测器 0.5 秒后对答案，用误差最小者算提前量；
//   2. 闪避账本：预计命中却落空的炮弹抬高对手的闪避估计，从而收紧开火条件；
//   3. 弹道校准：实测弹道预测误差，放大躲弹安全边距；
//   4. 路线纠错：实际卡住的边临时加权，改走其他路；
//   5. 算力调节：实测耗时超标就缩小搜索规模，防止慢设备超时。

const TUNE = {
  baseMargin: 2.9523,            // 躲弹基础安全边距，单位：逻辑像素。
  maxMargin: 10,
  hitCost: 1000,            // 轨迹被真实弹体命中的代价。
  shieldedHitCost: 174.0254,     // 护盾有效期内的命中代价。
  softCost: 46.5679,             // 擦边代价。
  virtualCost: 36.3382,          // 站在敌方炮口当前瞄线上的代价。
  laserCost: 346.4873,           // 站在持激光敌人瞄线上的代价。
  trampleCost: 15.8895,          // 踩到会覆盖更好武器的道具。
  calmCost: 5.8608,              // 计划风险低于此值时不进入闪避。
  commitBonus: 28.146,           // 保持上一 Tick 的候选，避免左右摇摆。
  progressWeight: 14.3875,
  aimWeight: 7.8772,
  waypointReach: 22,
  reverseAngle: 2.1,        // 目标方向偏后超过此角度时倒车，单位：弧度。
  closeRange: 176.7405,          // 瞄准时继续逼近到此距离。
  quickShot: 0.7369,           // 可在此时间内完成的射击优先于拾取，单位：秒。
  aimCommit: 1.3686,           // 超过此时间的射击方案不值得停下来转向。
  aimRays: 120,
  aimTolerance: 4.0785,          // 瞄准解要比碰撞半径更深入的像素数。
  fireLadder: [0.580202202, 0.671651327, 0.701638307, 0.910553079, 0.952914249], // 按本车在场弹数给出的开火门槛，最后一发留给必中。
  dodgePrior: 0.7979,
  dodgeLearn: 0.1816,
  dodgeForget: 0.0008,
  lootLaser: 13.7302,            // 各道具的价值，与路程一起决定值不值得去捡。
  lootShield: 8.8364,
  lootScatter: 4.8173,
  lootMine: 2.4849,
  lootRange: 8.5088,             // 单位：格。
  lootContested: 0.3675,      // 对手更近时的价值折扣。
  blockedEdgeCost: 6,
  minePathCost: 8,
  targetStickiness: 85.5062,
  stuckSeconds: 0.5,
  stuckDistance: 7,         // 这段时间内位移不足此值即判定卡死，单位：像素。
  fireCloseRange: 109.0937,      // 这个距离内开火门限封顶为 closeNeed。
  closeNeed: 0.7225,
  lastShotOdds: 0.7019,        // 打出最后一发所需的命中估计：打空要裸奔到弹体消失。
  evadeFaceReload: 0.6969,     // 下一发还要等这么久时，逃跑不再要求炮口朝向对手。
  boredDistance: 14,        // 1 秒内位移不足此值且未开火，视为模式活锁。
  boredHunt: 1.5521,           // 活锁后强制追击的时长，单位：秒。
  unstickSeconds: 0.4,
  softBudgetMs: 6,
  keepAway: 134.739,            // 敌人有弹时保持的车心距离；瞬杀圈约 58。
  keepAwayWeight: 7.745,
  zoneCost: 257.1769,            // 进入有弹敌人瞬杀圈的代价。
  zoneRadius: 58.7059,
  chargeRange: 55.1793,          // 对手没弹时冲到此距离。
  duelRange: 290.7359,           // 这个距离内有射击解就优先转身开火，而不是逃。
  duelTime: 1.1843,            // 转向加飞行不超过此秒数才算对决。
  duelThreatScale: 0.0762,    // 对决时炮口线与瞬杀圈的代价折扣；真实来弹不打折。
  duelAimWeight: 63.3886,
  lastShotRange: 70.9764,        // 最后一发只在此距离内用：飞行不足 8 Tick，对手来不及躲。
  reserveBullets: 1,
  escapeAt: 12,             // 沿候选走到这一步再分支检查退路（步）。
  escapeCost: 128.3347,          // 退路被来弹封死的代价。
  shotEscapeCost: 65.7783,       // 对手此刻朝我开火时躲不掉的代价。
  duelEscapeScale: 0.4621,     // 对决时对“躲不掉对手下一枪”的折扣。
  valueDie1: 481.747,           // 价值网络：1 秒内阵亡概率的代价权重。
  valueDie2: 214.5332,           // 价值网络：2 秒内阵亡概率的代价权重。
  valueKill: 825.0918,           // 价值网络：2 秒内击杀概率的收益权重。
  valueCalm: 0.0257,          // 计划的 1 秒阵亡概率超过此值时展开候选。
  stuckRatio: 0.3,          // 实际位姿变化不足要求的这一比例，判定被顶住。
  planFreeRatio: 0.5,       // 模型预测的计划位姿变化不足此比例，展开候选。
  pressSteps: 6,            // 计划前段炮管顶墙超过此 Tick 数，展开候选。
  pressCost: 22.6688,            // 炮管顶墙的代价：引擎里顶墙的炮管会按 30 Hz 抖动。
  freedomCost: 60.8151,          // 脱困时位姿不变的代价。
  steerHysteresis: 0.35,    // 进退切换的回滞，避免在门限上来回翻。
  escapeCommit: 150,        // 脱困机动的优先级：高于普通权衡，低于真实来弹。
  escapeDistance: 22,       // 挪开这么远就算脱困，提前结束。
  flipCost: 5.5888,              // 与上一 Tick 反向的代价：逐 Tick 换向就是抽搐。
  lockCost: 26.9754,             // 炮口隔着墙对准近处敌人的代价：打不到，还暴露了意图。
  lockRange: 220,
  aimPatience: 0.4072,         // 对准后这么久还不开火就放弃这个瞄准解，单位：秒。
  idleGrace: 1.0968,           // 既没开火也没走动超过此时间，视为僵持。
  idleSpan: 1.8593,              // 僵持压力从 0 涨到满的时长。
  idleFireDrop: 0.5568,        // 僵持满压时开火门限的降幅。
  idleCost: 88.2283,             // 僵持时原地候选的代价。
  idleFearDrop: 0.6221,        // 僵持满压时价值网络阵亡估计的折扣：双方都怕先动就是死局。
  assaultSeconds: 1.0737,      // 僵持到满压后主动出击的时长，这期间只躲真实来弹。
  idleMoved: 28,            // 离开僵持锚点这么远才算走动。
};

const STEP_TICKS = 2;       // 轨迹采样粒度：1 步 = 2 Tick。
const HORIZON = 36;         // 威胁视野：36 步 = 1.2 秒。
const SHOT_STEPS = 90;      // 开火评估的最长飞行：90 步 = 3 秒。
const PRED_STEPS = 120;     // 敌人轨迹预测长度：120 步 = 4 秒。
const AIM_SAMPLE_TICKS = 4;
const AIM_SAMPLES = 40;     // 瞄准搜索看 40 × 4 Tick。
const LASER_STEPS = 15;     // 敌方激光威胁只看近 0.5 秒。
const LAG_TICKS = 30;       // 预测器对答案的延迟。
const LAG_STEPS = LAG_TICKS / STEP_TICKS;
const CALIBRATE_TICKS = 16; // 弹道校准周期，对应采样下标 7。
const VALUE_STEP = 12;      // 价值网络在候选第 12 步（0.4 秒后）的状态上打分。
const VALUE_LOOK = 18;      // 炮弹危险向前看 18 步（0.6 秒）。
const FEATURES = 65;
const CTX_SIZE = 18;
const TRAIL_TICKS = 64;
const BORED_TICKS = 60;
const CONTACT_FRICTION = 0.2; // 对照 Box2D 拟合：0.2 时 12 Tick 位置误差 p90 从 3.9 降到 1.3 像素。
const BLOCK_STEPS = 8;      // 用计划前 8 步判断转向或前进是否被墙顶住。
const PRESS_STEPS = 16;     // 炮管顶墙只看前 16 步。
const EXPERT_COUNT = 5;
const MAX_TRACKED = 4;
const MAX_THREATS = 48;
const MAX_CANDIDATES = 128;
const MAX_PELLETS = 4;
const MAX_LASER_SEGMENTS = 40;

// 敌人的闪避动作库：[move, turn, 转向持续步数]。
const MANEUVERS = [
  [1, 0, 0], [-1, 0, 0], [0, 0, 0],
  [1, 1, 6], [1, -1, 6], [-1, 1, 6], [-1, -1, 6],
  [1, 1, 12], [1, -1, 12], [-1, 1, 12], [-1, -1, 12],
];
const WEAPON_RANK = { laser: 3, scatter: 2, mine: 1 };
// 脱困动作：[move, turn, 转向持续步数]，直退优先。
const ESCAPES = [[-1, 0, 0], [1, 0, 0], [-1, 1, 6], [-1, -1, 6], [1, 1, 6], [1, -1, 6]];
// 退路分支：[move, turn, 转向持续步数, 之后的 move]。
const BRANCHES = [
  [1, 0, 0, 1], [-1, 0, 0, -1],
  [1, 1, 10, 1], [1, -1, 10, 1], [-1, 1, 10, -1], [-1, -1, 10, -1],
  [0, 1, 7, 1], [0, -1, 7, 1], [0, 1, 7, -1], [0, -1, 7, -1],
];

// 只记 ID 与数值，不保留某 Tick 的对象引用。
const mem = {
  scale: 1,
  tracks: new Map(),
  mines: new Map(),
  shots: [],
  pendingShot: null,
  margin: TUNE.baseMargin,
  modelError: 0,
  snapshot: null,
  targetId: null,
  lastCandidate: -1,
  contOn: false,
  contM1: 0,
  contT1: 0,
  contHold: 0,
  contM2: 0,
  lastMove: 0,
  lastTurn: 0,
  lastFireTick: 0,
  huntUntil: -1,
  unstickUntil: -1,
  lastStuck: -9,
  stuckStreak: 0,
  needEscape: false,
  watchFrom: 0,
  stuckKind: '',
  banMove: 0,
  escM: 0,
  escT: 0,
  escHold: 0,
  escX: 0,
  escY: 0,
  steerDir: 1,
  aimIdle: 0,
  assaultUntil: -1,
  idleSince: 0,
  anchorX: 0,
  anchorY: 0,
  pathEdge: -1,
};

const world = { S: 96, cols: 0, rows: 0, n: 0, hw: null, vw: null, penalty: null, edgeUntil: null,
  wallCount: -1, rect: null, seg: null, tankNear: null, bulletNear: null };
const queue = { items: null, inside: null };
let fieldMe = null, fieldTarget = null, fieldLoot = null, fieldTmp = null;
let directionDelta = [0, 0, 0, 0];

// 每 Tick 刷新的物理量。
let P = null, dt = 1 / 60, moveStep = 4, turnStep = 0.1, tankR = 16, tankR2 = 256;
let nowTick = 0, workScale = 1;

// 模拟器寄存器：避免在热路径里分配对象。
let sx = 0, sy = 0, sa = 0;
let bx = 0, by = 0, bvx = 0, bvy = 0, bulletBounced = false;
let touchD2 = 0, touchX = 0, touchY = 0;
let hitAxis = 0, segT = 0;
let cDepth = 0, cNx = 0, cNy = 0, cPx = 0, cPy = 0;
let bodyHX = 17, bodyHY = 16, barrelC = 22.75, barrelHX = 5.75, barrelHY = 2.5, inertia = 181.67, bodyReach = 31;
let steerMove = 0, steerTurn = 0;
const bounceAt = new Int32Array(8);
let bounceN = 0;

const thX = [], thY = [];
for (let i = 0; i < MAX_THREATS; i++) {
  thX.push(new Float64Array(HORIZON));
  thY.push(new Float64Array(HORIZON));
}
const thFrom = new Int32Array(MAX_THREATS), thTo = new Int32Array(MAX_THREATS);
const thVirtual = new Uint8Array(MAX_THREATS);
const thAge = new Float64Array(MAX_THREATS);
const thOwner = new Array(MAX_THREATS).fill(null);
let threatCount = 0;

const rollX = new Float64Array(MAX_CANDIDATES * HORIZON), rollY = new Float64Array(MAX_CANDIDATES * HORIZON);
const rollA = new Float64Array(MAX_CANDIDATES * HORIZON);
const candMove = new Float64Array(MAX_CANDIDATES), candTurn = new Float64Array(MAX_CANDIDATES);
const candEndAngle = new Float64Array(MAX_CANDIDATES), candCost = new Float64Array(MAX_CANDIDATES);
const candRisk = new Float64Array(MAX_CANDIDATES), candHit = new Int32Array(MAX_CANDIDATES);
let candCount = 0, candidatesReady = false;
const rankCost = new Float64Array(MAX_CANDIDATES), rankOrder = new Int32Array(MAX_CANDIDATES);
const specM1 = new Float64Array(MAX_CANDIDATES), specT1 = new Float64Array(MAX_CANDIDATES);
const specHold = new Float64Array(MAX_CANDIDATES), specM2 = new Float64Array(MAX_CANDIDATES);
const specKnown = new Uint8Array(MAX_CANDIDATES);
const candPress = new Int32Array(MAX_CANDIDATES);
let tipPressed = false, pressCount = 0, planWantPx = 0, planWantRad = 0, steerDir = 1, stepVX = 0, stepVY = 0;
let contIndex = -1;

const shotX = [], shotY = [];
for (let i = 0; i < MAX_PELLETS; i++) {
  shotX.push(new Float64Array(SHOT_STEPS));
  shotY.push(new Float64Array(SHOT_STEPS));
}
const shotFrom = new Int32Array(MAX_PELLETS);
let shotPredicted = false, shotSteps = 0;

const rayX = new Float64Array(AIM_SAMPLES), rayY = new Float64Array(AIM_SAMPLES);
const laserX = new Float64Array(8), laserY = new Float64Array(8);
const laserSegs = new Float64Array(MAX_LASER_SEGMENTS * 5);
let laserSegCount = 0;

const pathX = new Float64Array(10), pathY = new Float64Array(10);
const rawX = new Float64Array(10), rawY = new Float64Array(10);
let pathN = 0;

const trailX = new Float64Array(TRAIL_TICKS), trailY = new Float64Array(TRAIL_TICKS), trailA = new Float64Array(TRAIL_TICKS);
const cmdMove = new Float64Array(TRAIL_TICKS), cmdTurn = new Float64Array(TRAIL_TICKS);
const gotStep = new Float64Array(TRAIL_TICKS), gotSpin = new Float64Array(TRAIL_TICKS);
const mineHazards = [];
const zoneEnemies = [];
const trampleSpots = [];
let tracked = [];

const clock = typeof performance !== 'undefined' && performance.now
  ? () => performance.now()
  : typeof Date !== 'undefined' ? () => Date.now() : () => 0;

function clamp(value, low, high) {
  return value < low ? low : value > high ? high : value;
}

// 把角差折回 [-π, π]，从最短方向转向；正值表示顺时针。
function wrap(angle) {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function urgency(state) {
  const limit = state.rules && state.rules.timeout;
  return limit > 0 ? clamp((state.time / limit - 0.6) / 0.4, 0, 1) : 0;
}

// ---------- 地图 ----------

function wallV(i, r) {
  return r >= 0 && r < world.rows && i >= 0 && i <= world.cols && world.vw[r * (world.cols + 1) + i] === 1;
}

function wallH(i, c) {
  return c >= 0 && c < world.cols && i >= 0 && i <= world.rows && world.hw[i * world.cols + c] === 1;
}

// cells 随破墙更新，是墙体的唯一来源；横墙按 y 线索引，竖墙按 x 线索引。
function buildWorld(map) {
  const cols = map.cols, rows = map.rows, n = cols * rows;
  world.S = map.cellSize;
  if (world.n !== n || world.cols !== cols) {
    world.cols = cols;
    world.rows = rows;
    world.n = n;
    world.hw = new Uint8Array((rows + 1) * cols);
    world.vw = new Uint8Array(rows * (cols + 1));
    world.penalty = new Float64Array(n);
    world.edgeUntil = new Int32Array(n * 4);
    queue.items = new Int32Array(n);
    queue.inside = new Uint8Array(n);
    fieldMe = new Float64Array(n);
    fieldTarget = new Float64Array(n);
    fieldLoot = new Float64Array(n);
    fieldTmp = new Float64Array(n);
    directionDelta = [-cols, 1, cols, -1];
  }
  world.hw.fill(0);
  world.vw.fill(0);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = map.cells[r][c];
      if (cell.top) world.hw[r * cols + c] = 1;
      if (cell.bottom) world.hw[(r + 1) * cols + c] = 1;
      if (cell.left) world.vw[r * (cols + 1) + c] = 1;
      if (cell.right) world.vw[r * (cols + 1) + c + 1] = 1;
    }
  }
}

// 车体接触用有厚度的墙矩形（圆头近似为沿长度外扩半厚度），炮弹用中心线；逐格邻近表保持引擎的墙序。
function buildContacts(map) {
  const walls = map.walls, count = walls.length;
  if (count === world.wallCount) return;
  world.wallCount = count;
  world.rect = new Float64Array(count * 4);
  world.seg = new Float64Array(count * 4);
  for (let i = 0; i < count; i++) {
    const w = walls[i], h = (w.border ? P.borderWallThickness : P.wallThickness) / 2;
    const x0 = Math.min(w.x1, w.x2) - h, x1 = Math.max(w.x1, w.x2) + h, y0 = Math.min(w.y1, w.y2) - h, y1 = Math.max(w.y1, w.y2) + h;
    world.rect[i * 4] = (x0 + x1) / 2;
    world.rect[i * 4 + 1] = (y0 + y1) / 2;
    world.rect[i * 4 + 2] = (x1 - x0) / 2;
    world.rect[i * 4 + 3] = (y1 - y0) / 2;
    world.seg[i * 4] = w.x1;
    world.seg[i * 4 + 1] = w.y1;
    world.seg[i * 4 + 2] = w.x2;
    world.seg[i * 4 + 3] = w.y2;
  }
  const S = world.S;
  world.tankNear = [];
  world.bulletNear = [];
  for (let cell = 0; cell < world.n; cell++) {
    const c = cell % world.cols, r = (cell - c) / world.cols, tank = [], bullet = [];
    const px = (c + 0.5) * S, py = (r + 0.5) * S;
    for (let i = 0; i < count; i++) {
      const gx = Math.max(0, Math.abs(px - world.rect[i * 4]) - world.rect[i * 4 + 2] - S / 2);
      const gy = Math.max(0, Math.abs(py - world.rect[i * 4 + 1]) - world.rect[i * 4 + 3] - S / 2);
      const gap = Math.hypot(gx, gy);
      if (gap < bodyReach + 2) tank.push(i);
      if (gap < 12) bullet.push(i);
    }
    world.tankNear.push(Int32Array.from(tank));
    world.bulletNear.push(Int32Array.from(bullet));
  }
}

function cellIndex(x, y) {
  const c = clamp(Math.floor(x / world.S), 0, world.cols - 1);
  const r = clamp(Math.floor(y / world.S), 0, world.rows - 1);
  return r * world.cols + c;
}

function centerX(cell) {
  return (cell % world.cols + 0.5) * world.S;
}

function centerY(cell) {
  return (Math.floor(cell / world.cols) + 0.5) * world.S;
}

// 方向 d：0 上、1 右、2 下、3 左。
function isOpen(c, r, d) {
  if (d === 0) return r > 0 && !wallH(r, c);
  if (d === 1) return c < world.cols - 1 && !wallV(c + 1, r);
  if (d === 2) return r < world.rows - 1 && !wallH(r + 1, c);
  return c > 0 && !wallV(c, r);
}

// 从 src 向外松弛出到各格的路程（单位：格），地雷格和受阻边额外加价。
function flood(src, out) {
  const n = world.n, cols = world.cols, items = queue.items, inside = queue.inside;
  out.fill(Infinity);
  inside.fill(0);
  out[src] = 0;
  items[0] = src;
  inside[src] = 1;
  let head = 0, tail = 1 % n, size = 1;
  while (size > 0) {
    const u = items[head];
    head = (head + 1) % n;
    size--;
    inside[u] = 0;
    const c = u % cols, r = (u - c) / cols;
    for (let d = 0; d < 4; d++) {
      if (!isOpen(c, r, d)) continue;
      const v = u + directionDelta[d];
      const cost = out[u] + 1 + world.penalty[v] + (world.edgeUntil[u * 4 + d] > nowTick ? TUNE.blockedEdgeCost : 0);
      if (cost < out[v]) {
        out[v] = cost;
        if (!inside[v]) {
          items[tail] = v;
          tail = (tail + 1) % n;
          size++;
          inside[v] = 1;
        }
      }
    }
  }
}

function lowestNeighbor(field, cell) {
  const c = cell % world.cols, r = (cell - c) / world.cols;
  let best = -1, bestValue = field[cell];
  for (let d = 0; d < 4; d++) {
    if (!isOpen(c, r, d)) continue;
    const v = cell + directionDelta[d];
    if (field[v] < bestValue) {
      bestValue = field[v];
      best = d;
    }
  }
  return best;
}

function goalDist(field, goalX, goalY, x, y) {
  const cell = cellIndex(x, y);
  if (!(field[cell] < Infinity)) return Math.hypot(goalX - x, goalY - y) + world.S * 4;
  const d = lowestNeighbor(field, cell);
  if (d < 0) return Math.hypot(goalX - x, goalY - y);
  const next = cell + directionDelta[d];
  return field[next] * world.S + Math.hypot(centerX(next) - x, centerY(next) - y);
}

function clearSegment(x0, y0, x1, y1, radius) {
  const dx = x1 - x0, dy = y1 - y0, length = Math.hypot(dx, dy);
  if (length < 1) return true;
  return castRay(x0, y0, dx / length, dy / length, radius, length) >= length - 1e-6;
}

// 沿路程场下降取格子中心作路径，再拉直：直接走向仍有车体余量的最远点。
function buildPath(field, goalX, goalY, x, y) {
  const start = cellIndex(x, y);
  let cell = start, count = 0;
  mem.pathEdge = -1;
  while (field[cell] > 0 && count < 8) {
    const d = lowestNeighbor(field, cell);
    if (d < 0) break;
    if (cell === start) mem.pathEdge = cell * 4 + d;
    cell += directionDelta[d];
    rawX[count] = centerX(cell);
    rawY[count] = centerY(cell);
    count++;
  }
  if (field[cell] === 0 || count === 0) {
    rawX[count] = goalX;
    rawY[count] = goalY;
    count++;
  }
  let first = 0;
  for (let i = count - 1; i > 0; i--) {
    if (clearSegment(x, y, rawX[i], rawY[i], tankR + 2)) {
      first = i;
      break;
    }
  }
  pathN = 0;
  for (let i = first; i < count; i++) {
    pathX[pathN] = rawX[i];
    pathY[pathN] = rawY[i];
    pathN++;
  }
}

// ---------- 几何与运动模型 ----------

// 从 (x,y) 沿单位向量前进，返回触到“外扩 r 的墙”前的距离。
// hitAxis：0 未碰，1 竖墙，2 横墙，3 角落同时反射。
function castRay(x, y, dx, dy, r, maxLen) {
  const S = world.S;
  let best = maxLen;
  hitAxis = 0;
  if (dx > 1e-9 || dx < -1e-9) {
    const dir = dx > 0 ? 1 : -1;
    for (let i = dx > 0 ? Math.floor(x / S) + 1 : Math.ceil(x / S) - 1; i >= 0 && i <= world.cols; i += dir) {
      let t = (i * S - dir * r - x) / dx;
      if (t >= best) break;
      if (t < 0) t = 0;
      const yy = y + dy * t;
      if (wallV(i, Math.floor(yy / S)) || wallV(i, Math.floor((yy - r) / S)) || wallV(i, Math.floor((yy + r) / S))) {
        best = t;
        hitAxis = 1;
        break;
      }
    }
  }
  if (dy > 1e-9 || dy < -1e-9) {
    const dir = dy > 0 ? 1 : -1;
    for (let i = dy > 0 ? Math.floor(y / S) + 1 : Math.ceil(y / S) - 1; i >= 0 && i <= world.rows; i += dir) {
      let t = (i * S - dir * r - y) / dy;
      if (t > best + 1e-6) break;
      if (t < 0) t = 0;
      const xx = x + dx * t;
      if (wallH(i, Math.floor(xx / S)) || wallH(i, Math.floor((xx - r) / S)) || wallH(i, Math.floor((xx + r) / S))) {
        if (hitAxis === 1 && Math.abs(t - best) <= 1e-6) hitAxis = 3;
        else if (t < best) {
          best = t;
          hitAxis = 2;
        }
        break;
      }
    }
  }
  return best;
}

// 单 Tick 弹体：与引擎同序逐墙检测，圆心距中心线不足半径时推出并沿法线反射。
function stepBullet() {
  const S = world.S, radius = P.bulletRadius, limit = radius * radius, seg = world.seg;
  bx += bvx * dt;
  by += bvy * dt;
  bulletBounced = false;
  const c = Math.floor(bx / S), r = Math.floor(by / S), lx = bx - c * S, ly = by - r * S;
  if (lx >= radius && lx <= S - radius && ly >= radius && ly <= S - radius) return;
  const list = world.bulletNear[clamp(r, 0, world.rows - 1) * world.cols + clamp(c, 0, world.cols - 1)];
  for (let i = 0; i < list.length; i++) {
    const w = list[i] * 4, x1 = seg[w], y1 = seg[w + 1], ex = seg[w + 2] - x1, ey = seg[w + 3] - y1;
    const len2 = ex * ex + ey * ey;
    let t = len2 > 0 ? ((bx - x1) * ex + (by - y1) * ey) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let nx = bx - (x1 + t * ex), ny = by - (y1 + t * ey);
    const d2 = nx * nx + ny * ny;
    if (d2 >= limit) continue;
    const d = Math.sqrt(d2);
    if (d === 0) {
      const len = Math.sqrt(len2) || 1;
      nx = -ey / len;
      ny = ex / len;
      bx += nx * radius;
      by += ny * radius;
    } else {
      nx /= d;
      ny /= d;
      bx += nx * (radius - d);
      by += ny * (radius - d);
    }
    const vn = bvx * nx + bvy * ny;
    bvx -= 2 * vn * nx;
    bvy -= 2 * vn * ny;
    bulletBounced = true;
  }
}

// 逐 Tick 外推弹道，每 stride Tick 记一个采样；bounceAt 记录每次反弹落在哪个采样下标。
function tracePath(x, y, vx, vy, stride, samples, outX, outY) {
  bx = x;
  by = y;
  bvx = vx;
  bvy = vy;
  bounceN = 0;
  const S = world.S, low = P.bulletRadius, high = S - low, span = dt * stride;
  for (let k = 0; k < samples; k++) {
    const lx = bx - Math.floor(bx / S) * S, ly = by - Math.floor(by / S) * S, fx = lx + bvx * span, fy = ly + bvy * span;
    if (lx >= low && lx <= high && ly >= low && ly <= high && fx >= low && fx <= high && fy >= low && fy <= high) {
      bx += bvx * span;
      by += bvy * span;
    } else {
      for (let t = 0; t < stride; t++) {
        stepBullet();
        if (bulletBounced) {
          if (bounceN < bounceAt.length) bounceAt[bounceN] = k;
          bounceN++;
        }
      }
    }
    outX[k] = bx;
    outY[k] = by;
  }
}

function firstBounce(steps) {
  return bounceN > 0 ? bounceAt[0] : steps;
}

// 激光从炮口出发，正好在墙线上反射（日志实测）。
function traceLaser(x, y, angle) {
  let dx = Math.cos(angle), dy = Math.sin(angle), remaining = P.laser.maxLength, n = 1;
  const out = muzzleDistance(x, y, dx, dy);
  x += dx * out;
  y += dy * out;
  laserX[0] = x;
  laserY[0] = y;
  for (let bounce = 0; bounce <= P.laser.maxBounces && n < laserX.length; bounce++) {
    const length = castRay(x, y, dx, dy, 1e-3, remaining);
    const axis = hitAxis;
    x += dx * length;
    y += dy * length;
    laserX[n] = x;
    laserY[n] = y;
    n++;
    remaining -= length;
    if (axis === 0 || remaining <= 0) break;
    if (axis & 1) dx = -dx;
    if (axis & 2) dy = -dy;
  }
  return n;
}

// 返回点到线段距离的平方；segT 为最近点沿线段的比例。
function segDist2(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, length2 = dx * dx + dy * dy;
  segT = length2 > 0 ? clamp(((px - x1) * dx + (py - y1) * dy) / length2, 0, 1) : 0;
  const ex = x1 + dx * segT - px, ey = y1 + dy * segT - py;
  return ex * ex + ey * ey;
}

// OBB 对墙矩形的分离轴检测，记录全局最深接触（法线指向车体）。
function contact(cx, cy, ux, uy, hx, hy, q) {
  const R = world.rect, qx = R[q], qy = R[q + 1], ex = R[q + 2], ey = R[q + 3];
  const vx = -uy, vy = ux, dx = cx - qx, dy = cy - qy;
  const ax = ux < 0 ? -ux : ux, ay = uy < 0 ? -uy : uy;
  const ox = ex + ax * hx + ay * hy - (dx < 0 ? -dx : dx);
  if (ox <= 0) return;
  const oy = ey + ay * hx + ax * hy - (dy < 0 ? -dy : dy);
  if (oy <= 0) return;
  const du = dx * ux + dy * uy, dv = dx * vx + dy * vy;
  const ou = hx + ex * ax + ey * ay - (du < 0 ? -du : du);
  if (ou <= 0) return;
  const ov = hy + ex * ay + ey * ax - (dv < 0 ? -dv : dv);
  if (ov <= 0) return;
  let m = ox, tx = dx >= 0 ? 1 : -1, ty = 0, face = false;
  if (oy < m) {
    m = oy;
    tx = 0;
    ty = dy >= 0 ? 1 : -1;
  }
  if (ou < m) {
    m = ou;
    const sign = du >= 0 ? 1 : -1;
    tx = ux * sign;
    ty = uy * sign;
    face = true;
  }
  if (ov < m) {
    m = ov;
    const sign = dv >= 0 ? 1 : -1;
    tx = vx * sign;
    ty = vy * sign;
    face = true;
  }
  if (m <= cDepth) return;
  cDepth = m;
  cNx = tx;
  cNy = ty;
  if (face) {
    // 法线来自车体面：接触点是墙矩形朝车的角。
    cPx = qx + (tx > 0 ? ex : -ex);
    cPy = qy + (ty > 0 ? ey : -ey);
  } else {
    // 法线来自墙面：接触点是车体最深的顶点，几乎平贴时取两顶点中点。
    const su = ux * tx + uy * ty, sv = vx * tx + vy * ty;
    const a = (su < 0 ? -su : su) * hx < 0.6 ? 0 : su > 0 ? -1 : 1;
    const b = (sv < 0 ? -sv : sv) * hy < 0.6 ? 0 : sv > 0 ? -1 : 1;
    cPx = cx + ux * hx * a + vx * hy * b;
    cPy = cy + uy * hx * a + vy * hy * b;
  }
}

// 位置级接触解算：等效 Box2D 的法向冲量，偏心接触同时产生平移和转动。
function resolveBody() {
  const S = world.S, near = world.tankNear, R = world.rect;
  tipPressed = false;
  for (let pass = 0; pass < 3; pass++) {
    const c = clamp(Math.floor(sx / S), 0, world.cols - 1), r = clamp(Math.floor(sy / S), 0, world.rows - 1);
    const list = near[r * world.cols + c];
    const ux = Math.cos(sa), uy = Math.sin(sa), tipX = sx + ux * barrelC, tipY = sy + uy * barrelC;
    const ax = ux < 0 ? -ux : ux, ay = uy < 0 ? -uy : uy;
    const reachX = ax * bodyHX + ay * bodyHY, reachY = ay * bodyHX + ax * bodyHY;
    const tipReachX = ax * barrelHX + ay * barrelHY, tipReachY = ay * barrelHX + ax * barrelHY;
    cDepth = 0;
    for (let i = 0; i < list.length; i++) {
      const q = list[i] * 4, qx = R[q], qy = R[q + 1], ex = R[q + 2], ey = R[q + 3];
      const gx = sx - qx, gy = sy - qy, hx = tipX - qx, hy = tipY - qy;
      if ((gx < 0 ? -gx : gx) < ex + reachX && (gy < 0 ? -gy : gy) < ey + reachY) contact(sx, sy, ux, uy, bodyHX, bodyHY, q);
      if ((hx < 0 ? -hx : hx) < ex + tipReachX && (hy < 0 ? -hy : hy) < ey + tipReachY) {
        contact(tipX, tipY, ux, uy, barrelHX, barrelHY, q);
        if (pass === 0 && cDepth > 0.02) tipPressed = true;
      }
    }
    if (cDepth <= 0.02) return;
    const rx = cPx - sx, ry = cPy - sy, rn = rx * cNy - ry * cNx, lambda = cDepth / (1 + rn * rn / inertia);
    sx += cNx * lambda;
    sy += cNy * lambda;
    sa += rn * lambda / inertia;
    // 库仑摩擦：切向冲量不超过法向冲量的 CONTACT_FRICTION 倍。墙角上它决定车头被别回去多少。
    const tx = -cNy, ty = cNx, rt = rx * ty - ry * tx, limit = CONTACT_FRICTION * lambda;
    const push = clamp(-(stepVX * tx + stepVY * ty) / (1 + rt * rt / inertia), -limit, limit);
    sx += tx * push;
    sy += ty * push;
    sa += rt * push / inertia;
  }
}

// 引擎顺序：线速度取本 Tick 开始时的朝向，位移与转向同时积分，再解接触。
function tickTank(move, turn) {
  const v = move * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt;
  stepVX = Math.cos(sa) * v;
  stepVY = Math.sin(sa) * v;
  sx += stepVX;
  sy += stepVY;
  sa += turn * P.turnSpeed * dt;
  resolveBody();
  if (tipPressed) pressCount++;
}

function stepCoarse(move, turn) {
  const v = move * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt * STEP_TICKS, spin = turn * P.turnSpeed * dt;
  const mid = sa + spin * (STEP_TICKS - 1) / 2;
  stepVX = Math.cos(mid) * v;
  stepVY = Math.sin(mid) * v;
  sx += stepVX;
  sy += stepVY;
  sa += spin * STEP_TICKS;
  resolveBody();
}

function stepTank(move, turn) {
  for (let t = 0; t < STEP_TICKS; t++) tickTank(move, turn);
}

function steer(targetX, targetY, quantum) {
  const distance = Math.hypot(targetX - sx, targetY - sy);
  let error = wrap(Math.atan2(targetY - sy, targetX - sx) - sa), direction = 1;
  // 回滞：门限上来回翻会让车在原地换向抽搐。
  if (Math.abs(error) > TUNE.reverseAngle + steerDir * TUNE.steerHysteresis) {
    direction = -1;
    error = wrap(error + Math.PI);
  }
  steerDir = direction;
  steerTurn = clamp(error / quantum, -1, 1);
  const size = Math.abs(error);
  const drive = size < 0.3 ? 1 : size < 0.8 ? 0.6 : size < 1.2 ? 0.25 : 0;
  steerMove = direction * drive * clamp(distance / moveStep, 0, 1);
}

// 炮口：常规偏移；车心到炮口之间有墙时，沿炮管压回到墙前 bulletRadius+1。
function muzzleDistance(x, y, dx, dy) {
  const toWall = castRay(x, y, dx, dy, 1e-3, P.muzzleOffset);
  return toWall < P.muzzleOffset ? toWall - P.bulletRadius - 1 : P.muzzleOffset;
}

// ---------- 观测与局内学习 ----------

function newTrack(enemy) {
  return {
    angle: enemy.angle,
    omega: 0,
    speed: 0,
    err: Float64Array.from([20, 18, 16, 19, 21]),
    pending: new Float64Array(LAG_TICKS * EXPERT_COUNT * 2),
    filled: new Uint8Array(LAG_TICKS),
    px: new Float64Array(PRED_STEPS),
    py: new Float64Array(PRED_STEPS),
    predicted: false,
    dodge: TUNE.dodgePrior,
  };
}

function learnEnemies(state) {
  const slot = state.tick % LAG_TICKS;
  for (const enemy of state.enemies) {
    let track = mem.tracks.get(enemy.id);
    if (!track) {
      track = newTrack(enemy);
      mem.tracks.set(enemy.id, track);
    }
    track.predicted = false;
    if (!enemy.alive) continue;
    track.omega += (wrap(enemy.angle - track.angle) / dt - track.omega) * 0.3;
    track.angle = enemy.angle;
    track.speed = enemy.vx * Math.cos(enemy.angle) + enemy.vy * Math.sin(enemy.angle);
    track.dodge += (TUNE.dodgePrior - track.dodge) * TUNE.dodgeForget;
    // 把 LAG_TICKS 前各预测器写下的答案拿出来批改。
    if (track.filled[slot]) {
      const base = slot * EXPERT_COUNT * 2;
      for (let i = 0; i < EXPERT_COUNT; i++) {
        const miss = Math.hypot(track.pending[base + i * 2] - enemy.x, track.pending[base + i * 2 + 1] - enemy.y);
        track.err[i] += (miss - track.err[i]) * 0.04;
      }
    }
  }
}

function settleShots(state) {
  const me = state.self;
  // 冷却被重置才算真的开了火；失败的尝试不入账。
  if (mem.pendingShot) {
    if (me.cooldown > P.fireCooldown * 0.5) mem.shots.push(mem.pendingShot);
    mem.pendingShot = null;
  }
  for (let i = mem.shots.length - 1; i >= 0; i--) {
    const shot = mem.shots[i];
    const enemy = state.enemies.find(item => item.id === shot.targetId);
    const track = mem.tracks.get(shot.targetId);
    const landed = !enemy || !enemy.alive || (shot.shielded && !enemy.shield);
    if (!landed && state.tick < shot.dueTick) continue;
    if (track && shot.predicted) {
      track.dodge += ((landed ? 0 : 1) - track.dodge) * TUNE.dodgeLearn;
    }
    mem.shots.splice(i, 1);
  }
}

function calibrateBullets(state) {
  if (state.tick % CALIBRATE_TICKS !== 0 || !mem.snapshot) return;
  for (const bullet of state.bullets) {
    const predicted = mem.snapshot.get(bullet.id);
    if (!predicted) continue;
    mem.modelError += (Math.hypot(predicted[0] - bullet.x, predicted[1] - bullet.y) - mem.modelError) * 0.1;
  }
  mem.margin = clamp(TUNE.baseMargin + mem.modelError * 1.2, TUNE.baseMargin, TUNE.maxMargin);
}

// 比较“要求的位姿变化”和“实际的位姿变化”。原地转向被墙顶住时 move 为 0，
// 只看前进指令永远发现不了；顶住时还常在两个指令间翻转，这也算卡住。
function detectStuck(state) {
  const me = state.self, slot = state.tick % TRAIL_TICKS, ring = TRAIL_TICKS * 4;
  const window = Math.min(Math.round(TUNE.stuckSeconds / dt), TRAIL_TICKS - 1);
  const old = (state.tick - window + ring) % TRAIL_TICKS;
  const second = (state.tick - BORED_TICKS + ring) % TRAIL_TICKS;
  const roamed = Math.hypot(me.x - trailX[second], me.y - trailY[second]);
  if (me.cooldown > 0) mem.lastFireTick = state.tick;
  // 瞄准与追击可能互相否定：在原地抖动却一枪不开。
  if (state.tick > BORED_TICKS && roamed < TUNE.boredDistance && state.tick - mem.lastFireTick > BORED_TICKS && state.time >= mem.huntUntil) {
    mem.huntUntil = state.time + TUNE.boredHunt;
  }
  const previous = (slot + TRAIL_TICKS - 1) % TRAIL_TICKS;
  gotStep[previous] = Math.hypot(me.x - trailX[previous], me.y - trailY[previous]);
  gotSpin[previous] = Math.abs(wrap(me.angle - trailA[previous]));
  cmdMove[previous] = mem.lastMove;
  cmdTurn[previous] = mem.lastTurn;
  trailX[slot] = me.x;
  trailY[slot] = me.y;
  trailA[slot] = me.angle;
  if (state.tick === 0 || mem.lastFireTick === state.tick || Math.hypot(me.x - mem.anchorX, me.y - mem.anchorY) > TUNE.idleMoved) {
    mem.idleSince = state.tick;
    mem.anchorX = me.x;
    mem.anchorY = me.y;
  }
  // 僵持满压：主动出击，否则两边都等对方先动，一局就耗到超时。
  if (idlePressure(state) >= 1 && state.time >= mem.assaultUntil) {
    mem.assaultUntil = state.time + TUNE.assaultSeconds;
    mem.huntUntil = mem.assaultUntil;
    mem.idleSince = state.tick;
    mem.anchorX = me.x;
    mem.anchorY = me.y;
  }
  if (state.time < mem.unstickUntil) {
    if (Math.hypot(me.x - mem.escX, me.y - mem.escY) > TUNE.escapeDistance) mem.unstickUntil = state.time;
    mem.watchFrom = state.tick;
    return;
  }
  // 窗口只看脱困之后：脱困时的倒车不能算成新的卡死。
  if (state.tick - mem.watchFrom < window) return;
  let wantPx = 0, wantRad = 0, flips = 0, moveSign = 0, turnSign = 0, gotPx = 0, gotRad = 0;
  for (let i = 1; i <= window; i++) {
    const at = (slot - i + ring) % TRAIL_TICKS, move = cmdMove[at], turn = cmdTurn[at];
    wantPx += Math.abs(move) * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt;
    wantRad += Math.abs(turn) * P.turnSpeed * dt;
    gotPx += gotStep[at];
    gotRad += gotSpin[at];
    const m = Math.abs(move) > 0.05 ? Math.sign(move) : 0, t = Math.abs(turn) > 0.2 ? Math.sign(turn) : 0;
    if (m && moveSign && m !== moveSign) flips++;
    if (t && turnSign && t !== turnSign) flips++;
    if (m) moveSign = m;
    if (t) turnSign = t;
  }
  // 用路程和累计转角比较：主动折返不是卡死，净位移会把它算错。
  const pushed = wantPx > 24 && gotPx < wantPx * TUNE.stuckRatio;
  const spun = wantRad > 0.7 && gotRad < wantRad * TUNE.stuckRatio;
  const chatter = flips >= 3 && Math.hypot(me.x - trailX[old], me.y - trailY[old]) < TUNE.stuckDistance;
  if (!pushed && !spun && !chatter) return;
  // 现实比模型可信：推不动就别再往这个方向推，上一招没用就换一招。
  mem.needEscape = true;
  mem.stuckKind = pushed ? 'pushed' : spun ? 'spun' : 'chatter';
  mem.banMove = pushed ? moveSign : state.time - mem.lastStuck < 2.5 ? mem.escM : 0;
  // 刚脱困又卡住：说明这一招不够，下次走得更久。
  mem.stuckStreak = state.time - mem.lastStuck < 2.5 ? Math.min(mem.stuckStreak + 1, 3) : 0;
  mem.lastStuck = state.time;
  mem.unstickUntil = state.time + TUNE.unstickSeconds * (1 + mem.stuckStreak * 0.5);
  if (mem.pathEdge >= 0) {
    const cell = mem.pathEdge >> 2, d = mem.pathEdge & 3;
    const expires = state.tick + Math.round(3 / dt);
    world.edgeUntil[mem.pathEdge] = expires;
    world.edgeUntil[(cell + directionDelta[d]) * 4 + ((d + 2) & 3)] = expires;
  }
}

// 僵持压力：既没开火也没走动的时间越长越高，取值 0 到 1；出击期间保持满压。
function idlePressure(state) {
  if (state.time < mem.assaultUntil) return 1;
  return clamp(((state.tick - mem.idleSince) * dt - TUNE.idleGrace) / TUNE.idleSpan, 0, 1);
}

// 记住已见地雷：过了渐隐时刻才从列表消失的是隐形雷，提前消失的是炸了。
function trackMines(state) {
  const mine = P.mine, fadeAt = mine.armDelay + mine.visibleTime + mine.fadeTime;
  for (const view of state.mines) {
    let record = mem.mines.get(view.id);
    if (!record) {
      record = { x: view.x, y: view.y, bornTick: state.tick - Math.round(view.age / dt), seenTick: 0, hidden: false };
      mem.mines.set(view.id, record);
    }
    record.seenTick = state.tick;
    record.hidden = false;
  }
  for (const [id, record] of mem.mines) {
    if (record.seenTick === state.tick) continue;
    if (!record.hidden) {
      if ((state.tick - record.bornTick) * dt < fadeAt - 0.1) {
        mem.mines.delete(id);
        continue;
      }
      record.hidden = true;
    }
    // 隐形雷已布防，活坦克走进触发圈却仍活着，说明它早已不在了。
    const reach = mine.triggerRadius - 2;
    const walked = tank => tank.alive && Math.hypot(tank.x - record.x, tank.y - record.y) < reach;
    if (walked(state.self) || state.enemies.some(walked)) mem.mines.delete(id);
  }
}

function buildMineHazards(state) {
  const mine = P.mine, stepTime = dt * STEP_TICKS;
  mineHazards.length = 0;
  world.penalty.fill(0);
  for (const record of mem.mines.values()) {
    const armIn = mine.armDelay - (state.tick - record.bornTick) * dt;
    const contested = state.enemies.some(enemy => enemy.alive
      && Math.hypot(enemy.x - record.x, enemy.y - record.y) < mine.triggerRadius + 40);
    const trigger = mine.triggerRadius + 2, blast = contested ? mine.blastRadius + 2 : 0;
    mineHazards.push({
      x: record.x, y: record.y, armStep: Math.max(0, Math.ceil(armIn / stepTime)),
      trigger2: trigger * trigger, blast2: blast * blast,
    });
    const home = cellIndex(record.x, record.y), c0 = home % world.cols, r0 = (home - c0) / world.cols;
    for (let r = Math.max(0, r0 - 1); r <= Math.min(world.rows - 1, r0 + 1); r++) {
      for (let c = Math.max(0, c0 - 1); c <= Math.min(world.cols - 1, c0 + 1); c++) {
        const cell = r * world.cols + c;
        if (Math.hypot(centerX(cell) - record.x, centerY(cell) - record.y) < mine.triggerRadius + 12) {
          world.penalty[cell] += TUNE.minePathCost;
        }
      }
    }
  }
}

function pickTarget(state) {
  const me = state.self;
  let best = null, bestScore = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    const steps = fieldMe[cellIndex(enemy.x, enemy.y)];
    let score = (steps < Infinity ? steps * world.S : 1500) + Math.hypot(enemy.x - me.x, enemy.y - me.y) * 0.5;
    if (enemy.id === mem.targetId) score -= TUNE.targetStickiness;
    if (enemy.shield) score += 150;
    if (score < bestScore) {
      bestScore = score;
      best = enemy;
    }
  }
  mem.targetId = best ? best.id : null;
  return best;
}

// 预测器沿最短路逼近“我”，用 fieldMe 下降，不受转向约束。
function chaseStep(meX, meY) {
  const cell = cellIndex(sx, sy);
  const d = fieldMe[cell] > 0 ? lowestNeighbor(fieldMe, cell) : -1;
  let goalX = meX, goalY = meY;
  if (d >= 0) {
    goalX = centerX(cell + directionDelta[d]);
    goalY = centerY(cell + directionDelta[d]);
  }
  const dx = goalX - sx, dy = goalY - sy, distance = Math.hypot(dx, dy);
  if (distance < moveStep || (d < 0 && distance < tankR * 2.5)) return;
  sx += dx / distance * moveStep;
  sy += dy / distance * moveStep;
  resolveBody();
}

// 五种预测器：静止 / 匀速 / 匀角速度 / 减速 / 追击。
function runExpert(enemy, track, expert, steps, outX, outY, meX, meY) {
  const h = dt * STEP_TICKS;
  let vx = enemy.vx, vy = enemy.vy;
  sx = enemy.x;
  sy = enemy.y;
  sa = enemy.angle;
  for (let k = 0; k < steps; k++) {
    if (expert === 1) {
      sx += vx * h;
      sy += vy * h;
      resolveBody();
    } else if (expert === 2) {
      sa += track.omega * h;
      sx += Math.cos(sa) * track.speed * h;
      sy += Math.sin(sa) * track.speed * h;
      resolveBody();
    } else if (expert === 3) {
      vx *= 0.9;
      vy *= 0.9;
      sx += vx * h;
      sy += vy * h;
      resolveBody();
    } else if (expert === 4) {
      chaseStep(meX, meY);
    }
    if (outX) {
      outX[k] = sx;
      outY[k] = sy;
    }
  }
}

function predictEnemies(state, target) {
  const me = state.self;
  const alive = state.enemies.filter(enemy => enemy.alive);
  alive.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
  tracked = target ? [target] : [];
  const limit = workScale < 0.5 ? 2 : MAX_TRACKED;
  for (const enemy of alive) {
    if (tracked.length >= limit) break;
    if (enemy !== target) tracked.push(enemy);
  }
  const slot = state.tick % LAG_TICKS, base = slot * EXPERT_COUNT * 2;
  for (const enemy of tracked) {
    const track = mem.tracks.get(enemy.id);
    let best = 0;
    for (let i = 0; i < EXPERT_COUNT; i++) {
      runExpert(enemy, track, i, LAG_STEPS, null, null, me.x, me.y);
      track.pending[base + i * 2] = sx;
      track.pending[base + i * 2 + 1] = sy;
      if (track.err[i] < track.err[best]) best = i;
    }
    track.filled[slot] = 1;
    runExpert(enemy, track, best, PRED_STEPS, track.px, track.py, me.x, me.y);
    track.predicted = true;
  }
}

// ---------- 威胁表 ----------

function addRealBullet(bullet, me) {
  const j = threatCount++, stepTime = dt * STEP_TICKS;
  tracePath(bullet.x, bullet.y, bullet.vx, bullet.vy, STEP_TICKS, HORIZON, thX[j], thY[j]);
  thFrom[j] = 0;
  thTo[j] = clamp(Math.floor((P.bulletLifetime - bullet.age) / stepTime), 0, HORIZON);
  thVirtual[j] = 0;
  thAge[j] = bullet.age;
  thOwner[j] = bullet.ownerId;
  // 自己未反弹且 age 未到豁免时长的弹不伤自己，一反弹立即解除。
  if (bullet.ownerId === me.id && bullet.bounces === 0 && bullet.age < P.selfHitGrace) {
    thFrom[j] = Math.min(firstBounce(HORIZON), Math.ceil((P.selfHitGrace - bullet.age) / stepTime));
  }
}

function addVirtualShot(enemy, angle) {
  if (threatCount >= MAX_THREATS) return;
  const j = threatCount++, dx = Math.cos(angle), dy = Math.sin(angle);
  const out = muzzleDistance(enemy.x, enemy.y, dx, dy);
  tracePath(enemy.x + dx * out, enemy.y + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, STEP_TICKS, HORIZON, thX[j], thY[j]);
  thFrom[j] = 0;
  thTo[j] = HORIZON;
  thVirtual[j] = 1;
  thOwner[j] = enemy.id;
}

function addLaserFan(enemy) {
  const fan = [0, 1, 0.12, 0.7, -0.12, 0.7, 0.3, 0.4, -0.3, 0.4];
  for (let f = 0; f < fan.length; f += 2) {
    const n = traceLaser(enemy.x, enemy.y, enemy.angle + fan[f]);
    for (let i = 0; i + 1 < n && laserSegCount < MAX_LASER_SEGMENTS; i++) {
      const base = laserSegCount++ * 5;
      laserSegs[base] = laserX[i];
      laserSegs[base + 1] = laserY[i];
      laserSegs[base + 2] = laserX[i + 1];
      laserSegs[base + 3] = laserY[i + 1];
      laserSegs[base + 4] = fan[f + 1];
    }
  }
}

function buildThreats(state) {
  const me = state.self;
  const horizonTime = HORIZON * STEP_TICKS * dt;
  const reach = (P.bulletSpeed + P.moveSpeed) * horizonTime + tankR + P.bulletRadius;
  threatCount = 0;
  laserSegCount = 0;
  const near = state.bullets.filter(bullet => Math.hypot(bullet.x - me.x, bullet.y - me.y) < reach);
  if (near.length > MAX_THREATS - 8) {
    near.sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
    near.length = MAX_THREATS - 8;
  }
  const remember = state.tick % CALIBRATE_TICKS === 0;
  if (remember) mem.snapshot = new Map();
  for (const bullet of near) {
    addRealBullet(bullet, me);
    if (remember) mem.snapshot.set(bullet.id, [thX[threatCount - 1][7], thY[threatCount - 1][7]]);
  }
  zoneEnemies.length = 0;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    if (armedWithin(enemy, state, 0.5)) zoneEnemies.push(enemy);
    if (enemy.laserShots > 0) {
      addLaserFan(enemy);
      continue;
    }
    if (enemy.cooldown > 0.3 || Math.hypot(enemy.x - me.x, enemy.y - me.y) > reach) continue;
    const track = mem.tracks.get(enemy.id);
    const lead = track ? clamp(track.omega, -P.turnSpeed, P.turnSpeed) * 0.1 : 0;
    if (enemy.scatterShots > 0) {
      for (let p = -1; p <= 1; p++) addVirtualShot(enemy, enemy.angle + lead + p * P.scatter.spreadAngle);
    } else if (enemy.bulletsActive < P.maxBullets) {
      addVirtualShot(enemy, enemy.angle + lead);
    }
  }
}

// ---------- 战术计划 ----------

// 对手在 horizon 秒内能否开火：弹数上限是公开的，普通弹满额时最早一颗消失才解禁。
function armedWithin(enemy, state, horizon) {
  if (enemy.laserShots > 0 || enemy.scatterShots > 0 || enemy.bulletsActive < P.maxBullets) return true;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === enemy.id && P.bulletLifetime - bullet.age < horizon) return true;
  }
  return false;
}

function heldRank(me) {
  return me.laserShots > 0 ? 3 : me.scatterShots > 0 ? 2 : me.mineCharges > 0 ? 1 : 0;
}

function lootOf(type) {
  return type === 'laser' ? TUNE.lootLaser : type === 'shield' ? TUNE.lootShield : type === 'scatter' ? TUNE.lootScatter : type === 'mine' ? TUNE.lootMine : 0;
}

function pickLoot(state) {
  const me = state.self, rank = heldRank(me);
  let best = null, bestScore = 0;
  trampleSpots.length = 0;
  for (const powerup of state.powerups) {
    const weapon = WEAPON_RANK[powerup.type] || 0;
    if (weapon > 0 && weapon < rank) {
      trampleSpots.push(powerup);
      continue;
    }
    if (powerup.type === 'shield' && me.shield && me.shieldTime > 2) continue;
    const cell = cellIndex(powerup.x, powerup.y), mine = fieldMe[cell];
    if (!(mine < Infinity) || mine > TUNE.lootRange) continue;
    flood(cell, fieldTmp);
    let rival = Infinity;
    for (const enemy of state.enemies) {
      if (enemy.alive) rival = Math.min(rival, fieldTmp[cellIndex(enemy.x, enemy.y)]);
    }
    const value = lootOf(powerup.type) * (rival + 0.5 < mine ? TUNE.lootContested : 1);
    const score = value / (mine + 1.5);
    if (score > bestScore) {
      bestScore = score;
      best = powerup;
      fieldLoot.set(fieldTmp);
    }
  }
  return best;
}

// 枚举炮口朝向，含跳弹，找到最快打到预测位置的方向。
// 射线以当前朝向为 0 号，无需转动的解自然排在最前。
function searchAim(me, track) {
  const count = Math.max(24, Math.round(TUNE.aimRays * workScale));
  const laser = me.laserShots > 0;
  const tolerance = laser ? tankR - 2 : tankR + P.bulletRadius - TUNE.aimTolerance;
  const tolerance2 = tolerance * tolerance;
  const selfR = tankR + P.bulletRadius + 2, self2 = selfR * selfR;
  const graceSamples = Math.ceil(P.selfHitGrace / (dt * AIM_SAMPLE_TICKS));
  const readyTicks = Math.ceil(me.cooldown / dt);
  let best = null, bestScore = 0;
  for (let i = 0; i < count; i++) {
    const relative = (i & 1 ? -1 : 1) * Math.ceil(i / 2) * (Math.PI * 2 / count);
    const angle = me.angle + relative;
    const waitTicks = Math.max(readyTicks, Math.ceil(Math.abs(relative) / (P.turnSpeed * dt)));
    const dx = Math.cos(angle), dy = Math.sin(angle);
    if (laser) {
      const index = clamp((waitTicks >> 1) - 1, 0, PRED_STEPS - 1);
      const tx = track.px[index], ty = track.py[index];
      const n = traceLaser(me.x, me.y, angle);
      for (let s = 0; s + 1 < n; s++) {
        if (s > 0 && segDist2(me.x, me.y, laserX[s], laserY[s], laserX[s + 1], laserY[s + 1]) < self2) break;
        if (segDist2(tx, ty, laserX[s], laserY[s], laserX[s + 1], laserY[s + 1]) < tolerance2) {
          const score = 1 / (0.15 + waitTicks * dt + 0.05 * s);
          if (score > bestScore) {
            bestScore = score;
            best = { angle, wait: waitTicks * dt, flight: 0 };
          }
          break;
        }
      }
      continue;
    }
    const out = muzzleDistance(me.x, me.y, dx, dy);
    tracePath(me.x + dx * out, me.y + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, AIM_SAMPLE_TICKS, AIM_SAMPLES, rayX, rayY);
    const safeUntil = Math.min(firstBounce(AIM_SAMPLES), graceSamples);
    for (let k = 0; k < AIM_SAMPLES; k++) {
      const ticks = waitTicks + (k + 1) * AIM_SAMPLE_TICKS;
      const index = Math.min(PRED_STEPS - 1, (ticks >> 1) - 1);
      const ex = rayX[k] - track.px[index], ey = rayY[k] - track.py[index];
      if (ex * ex + ey * ey < tolerance2) {
        let bounces = 0;
        for (let b = 0; b < bounceN && b < bounceAt.length; b++) if (bounceAt[b] <= k) bounces++;
        const flight = (k + 1) * AIM_SAMPLE_TICKS * dt;
        const score = 1 / (0.15 + waitTicks * dt * 0.8 + flight + 0.25 * bounces);
        if (score > bestScore) {
          bestScore = score;
          best = { angle, wait: waitTicks * dt, flight };
        }
        break;
      }
      if (k >= safeUntil) {
        const mx = rayX[k] - me.x, my = rayY[k] - me.y;
        if (mx * mx + my * my < self2) break;
      }
    }
  }
  return best;
}

// 对手隔着墙时不隔墙瞄它：朝去它那里的路线上还看得见的最远格子，
// 它露头时炮口已经对着门口，也不会贴墙跟着它转。
function peekAngle(x, y, ex, ey) {
  if (clearSegment(x, y, ex, ey, P.bulletRadius)) return Math.atan2(ey - y, ex - x);
  let cell = cellIndex(x, y), gx = ex, gy = ey;
  for (let i = 0; i < 6; i++) {
    const d = lowestNeighbor(fieldTarget, cell);
    if (d < 0) break;
    cell += directionDelta[d];
    const cx = centerX(cell), cy = centerY(cell);
    if (i > 0 && !clearSegment(x, y, cx, cy, P.bulletRadius)) break;
    gx = cx;
    gy = cy;
  }
  return Math.atan2(gy - y, gx - x);
}

function followField(plan, field, goalX, goalY, me) {
  buildPath(field, goalX, goalY, me.x, me.y);
  plan.kind = 'path';
  plan.field = field;
  plan.goalX = goalX;
  plan.goalY = goalY;
  plan.startDist = goalDist(field, goalX, goalY, me.x, me.y);
}

// 没弹时逃：在自己先到的格子里选离对手路程最远、出口多的，等炮弹消失再打。
function planEvade(plan, me) {
  let best = -1, bestValue = -Infinity;
  for (let cell = 0; cell < world.n; cell++) {
    const mine = fieldMe[cell], theirs = fieldTarget[cell];
    if (!(mine <= 5) || !(theirs < Infinity) || mine >= theirs) continue;
    const c = cell % world.cols, r = (cell - c) / world.cols;
    let exits = 0;
    for (let e = 0; e < 4; e++) if (isOpen(c, r, e)) exits++;
    const value = theirs - mine * 0.3 + exits * 0.25;
    if (value > bestValue) {
      bestValue = value;
      best = cell;
    }
  }
  if (best < 0) best = cellIndex(me.x, me.y);
  flood(best, fieldLoot);
  followField(plan, fieldLoot, centerX(best), centerY(best), me);
  plan.mode = 'evade';
}

function makePlan(state, target) {
  const me = state.self;
  const plan = {
    kind: 'aim', mode: 'hold', move: 0, faceAngle: me.angle, aimAngle: null, aim: null,
    field: null, goalX: me.x, goalY: me.y, startDist: 0, keepAway: 0, keepX: 0, keepY: 0, charging: false, duel: false,
    foeSeen: false, foeX: 0, foeY: 0, peek: me.angle,
  };
  pathN = 0;
  mem.pathEdge = -1;
  const armed = me.laserShots > 0 || me.scatterShots > 0 || me.bulletsActive < P.maxBullets;
  const track = target ? mem.tracks.get(target.id) : null;
  if (target) flood(cellIndex(target.x, target.y), fieldTarget);
  if (track && track.predicted) {
    plan.foeSeen = true;
    plan.foeX = track.px[5];
    plan.foeY = track.py[5];
    plan.peek = peekAngle(me.x, me.y, plan.foeX, plan.foeY);
  } else if (target) {
    plan.peek = peekAngle(me.x, me.y, target.x, target.y);
  }
  const aim = target && track && track.predicted && armed ? searchAim(me, track) : null;
  const aimTime = aim ? aim.wait + aim.flight : Infinity;
  if (aim) {
    plan.aim = aim;
    plan.aimAngle = aim.angle;
  }
  const loot = pickLoot(state);
  if (loot && aimTime > TUNE.quickShot && urgency(state) < 0.7) {
    followField(plan, fieldLoot, loot.x, loot.y, me);
    plan.mode = 'loot';
    return plan;
  }
  if (!target) return plan;
  const distance = Math.hypot(target.x - me.x, target.y - me.y);
  // 对手没弹且赶到之前不会解禁：冲到瞬杀圈内一枪解决。
  const enemyArmed = armedWithin(target, state, distance / P.moveSpeed + 0.3);
  plan.charging = !enemyArmed && armed;
  if (enemyArmed) {
    plan.keepAway = TUNE.keepAway;
    plan.keepX = target.x;
    plan.keepY = target.y;
  }
  if (!armed) {
    planEvade(plan, me);
    plan.aimAngle = reloadIn(me, state) < TUNE.evadeFaceReload ? plan.peek : null;
    return plan;
  }
  followField(plan, fieldTarget, target.x, target.y, me);
  plan.mode = plan.charging ? 'charge' : 'hunt';
  const reserveOnly = !plan.charging && me.laserShots === 0 && me.scatterShots === 0 && me.bulletsActive >= P.maxBullets - 1;
  plan.duel = !plan.charging && aimTime <= TUNE.duelTime && distance < TUNE.duelRange;
  const bored = state.time < mem.huntUntil;
  if (aimTime <= TUNE.aimCommit && !bored) {
    plan.kind = 'aim';
    plan.mode = plan.charging ? 'charge' : 'aim';
    plan.faceAngle = aim.angle;
    // 正对路线且还远时边靠近边校准，否则站定转向；敌人有弹且太近就倒车拉开，炮口不离开它。
    const heading = pathN > 0 ? Math.abs(wrap(Math.atan2(pathY[0] - me.y, pathX[0] - me.x) - me.angle)) : Math.PI;
    const closeTo = plan.charging ? TUNE.chargeRange : TUNE.closeRange;
    if (enemyArmed && distance < TUNE.keepAway) plan.move = -1;
    else plan.move = distance > closeTo && heading < 0.6 && !reserveOnly ? 1 : 0;
  } else if (reserveOnly && !bored) {
    // 只剩保命弹时不主动找人，原地朝向对手等待。
    plan.kind = 'aim';
    plan.mode = 'guard';
    plan.faceAngle = plan.peek;
    plan.aimAngle = plan.faceAngle;
    plan.move = distance < TUNE.keepAway ? -1 : 0;
  }
  return plan;
}

// ---------- 价值网络 ----------

// 价值网络权重：GPU 上由对局结果训练（Float32 按 w1,b1,w2,b2,w3,b3 拼接后 base64）。
// 输入 FEATURES 维局面特征，输出 1/2 秒内阵亡、1/2 秒内击杀的 logit 与折扣结局。
const NET_SHAPE = { h1: 64, h2: 64, out: 5 };
const NET_BASE64 = 'FIPoP5hvZr/Fr4u+yR8YPuNjHD49RSy+NB8hPtyRkb/GDQs/2ehLP2m2Uz9uAI0++MBKvv1mEr6jxzA+IGj3Pf/oMr4CAGm7xfOqPvsEEjwODSG9gk/MPfVN+D1cGiw+i+c5PgkhjD7N4ZY9rsiEvjrSQr6Jp6e+hoqDvdZy5r2dEhU9qhNyPA+BSj5m72A+CR6EvTHteLxLkFA8lUZpPRTjtD60yBA95JzrPDS4Az14xzO+m5oMvck1Cr/Ty4I/XfYUPylV1b/OvWM/xF+pv5Y1oL9J5WA/graiP7aUqr3fuMc+uxRkvj7GGr51/4k9v/CJvjOLqz5hXzS+j3mSwAIm9b0Quz6+flQmP0Adir4FJnW/WsMHP5cQ3L5l5R67mbcsvobv670JZC0+hw4rQJ9o274q9Rm/o9YFvFm9pT7Pn8u9p4cBPukZZzxDW8K8Siv6vVCiFz1ryrC9LJuwPUQKcby3WRM9INezPZcnRb7O5CQ+ytFnPs4F2LwMBFQ9RN6kva2ksryNdLq6YDynvfg2Hj6XgES9EV+YPET0Kz32sdO8MfmsvfJo2r3RfIE87RQXPHD5V71e31i+hH0qPnvFyj0HZKk9DGhbQMBplz1mLUY/HVVhwFbdSL8sMyO+f46DP5WbrT4c0M29mUBcvr4lAb+RzyE/nKoZPvgzgD/j6jlAQB2AvhJITT+yGna/sH+HPpV1tT6dgOU+VnoSvtKahb3Bdt8+wmh5vOVORz6YMZy/qVy2vlv+dL0wImk+nvOcvgdYML037hE+C+62PfyFlL71S5e+KZRSvSIMC75t2rI98wyVPUolVT5HfQo+1Q6WPfVZIr5042m+mVZdvvS9YT2gnMA9Y+J8PYWUA73vQDS+5CZRvZtyBr2x2su8c6KaPBl5Ar046XU+yCmzvGX3FLzrTs49jvLCveV9Lj4txdu+GxAUwIjCYMCjw5O/DV1Uv43Zdj/XMIG/2yf/vo4np8BB2w6+muB3v3nM7T6VgU++Eq1wwNR0s733wW++3zTLPclvTj+7zYk9MRf0PeS4pb+QNgw/Pe9Bv2HDU79kr6A+PhBrPgWsh7+4YbI+veYUvXyrBEBn9we/wWoSvffpxL1BjZ8+yuZyvoW3jT6I4Fu+pt3lPQw59D36zYC9lNarvfPiBD9F6L295XDAvSSjxL4ADjS+AWWWPhImyr6fvZ8+2FaVPREzpD3XJ9A7MFeTPWf8aTsraLq7X9CGvR8kBz29pv48ccOBPQ7Ulz5B8yM+dBqSPeGhBj1zEDM87eudvQeYqr7C8KC9pkejPhQKbr/OW9Y/RAy+wI6mQ8ArbxrAKjSbwAKoPj9DXvM+BXMtv+G5Ej6vATm+f8rRvVaU0z5G0Hy8cQdIQMb7oD89tFA+yr2uP1nX1rzB0vi+rTh0vv5oyj2yMoS+ocUKwOvWMT8twKK9+d/PvUFx8L5X+Y0+OdL8vbidrDxqlnG+VwyjPnk49r035J+9A/uIvqKgK70RoG0+QdKFPTdFob692Za+ED5OPRfL0DxY3c2+V2sMP2QXsz34C2u+6mk4PmbbA76lqOq+r0SWPuZZgL4Bgls+vNqAvKiAVb6AtXE9ZNpbvZa3TjzMVM47ByAPvcM2gbzA5Ky+e8LCvso9WL8oau4/GAAZQDBimL6BqZc+GrOgP5g6+78qtajA11Y7P7GSmzyu7RY8cIjovdSBl74Qdy2/HI+SvlsI9L7Uyp0/QhIdv1E3nL6t/co9gzPfvkA2xr+/NYI7DBxKPg5BQr6AgEA+5YswP3zSSb+2ioO/q3V4vq1qT70rDOA8p32UP1MCQ76jd/Q8hxvtPnWQ2r5lVLI+Q8OMPJeI07zl0J29zeTJvBVRnD7UQT2+5Aonvjfu4L0Zp4w+WP7pvZNfKb6rGfs8RisFPTkH/DyNUXq9JN6evTMQOb21YH07fy4tPYlW9bsmIP+9y36zvJgkRrwYk509Uk6nvasxgz2KjYK+zSOdvQTlZMCBF9O/bWcfv/pGDL7XFb5ADY1MPsVQyb+89Ne+NLRxvYEhmL4tfxa+Tz36vTwwXrvzXNg+aRScvtlONz8wxYw/P7yePqGOBjwAPZG9ItGpPmRXcz5WmVw+YyShvY71Gj9papA/t5orPwc/w7+0JrM+yYovPhwRub6h3Bm+nqSjvdYHxT1T7C49g02vPacuAr41nJ89OAc5PrCa9T1nNb09q5L3PQ5Bijtn9hK9sIyuPSvmgj6OXTQ+rc22vXlE8juzqLE8Tp4cPfz3uzwIOV++jxXyvf/IALysAg68z3movUJKjb7Y9pC9sL0pPE7K4TzCtBS+iFd+vjwq9D+lBhi++vsywDHgQkArhli/AhHVvk6bKsCewpS+0jiOvynxO8C2C+w+Y3s1P7wOST8dGwq/NPItPTPijL72ww2+/44awJ/Hkr/HLKm+4k6wP5yzer6BtIo7GOfHv+HmvL7yVv2+/6h+v6jwPb9LYpS/t09Cvt8iT79EBFC+ob6dPv59PT3IPRG+zlDNPe2/K75j9BG+KiaqPthxjL7D7PG+RmYqvvMlrb2zXgq8woYZvC6rH7+mI5E+ISoIPlP4Sr51KEM+UP1TvSFU+z0nLgO+ZsLPPMLh1D1rcps8S+4XvbMKgr14cQs+XqWlPuxMIj7e3a88O+scPcVuK77AJV8+RiDtvmooWr8w7ka/QbTTv2fXjz+ZRVw/fsohwCzJW8DK6YW9ampTv/jPrT5QzLO9se+GP5AzUT+cBPE+E5qavRzVu7uZFww/39uAv0CmEz8Crjk/KsjlvAqv3z7cWt+/nfZcPQU4Xj5WWr6+2k8UP90aST96Rec+2r3aPnxUhz+2LFG/aJRMvmtVlL7D2CC8Mp6LPN1nfj7kd5W9LKQFvj+EML7E2j6+hcqlvtLGiL3Eyeo+HrVwPhJW4D3Qbbs9WXVePQDKGL80Uju9nkNcvoRkhD1J07G+eisbv7mLQb632fm9EGXsPFAqm77OBr6+1rUhvnGRt70ToYm9kuNtviKkiD33EWm/d5Duv92fbL/4ZzTAu72jvjA+wMD7a7e/y+gFQD9j8z+SGkQ+rtUhv2v/Yz5LXtw+ToEAv0TJLT7/Gv6+KTgmvQv17T/RTnW/XG2KPv2SEj73MJe+6NgsP6b4uD7dJUC+ruDmvoyWqr/ADPW+2scivDi59r6ICTo/xaD1PYcKpL7ToZ08LRdAviDJR73UkjO9Hv2IP7ZSgL4vbya/YuogPa7ceT6ikZA+ParQPsV4PD4/uJS9Pfmdvnabpz40mD6/Xi3Dvf4Ixz2rYxG9wS4jvDgxj75E/lC8iHBSPFd8h71GvZK925sMvoZhFz7pRzk99ZGBvZxdPz3lhJe9c7PhvWykDb2kN649MXoowAH0e79McUU/0Dd/wPQpNsBk+ek/AVigP5wWZb+IpSm/s6sDvzT/XL+Yfq29AOOpPvDfN763UbU+81WWP6sa4z9TTrk+PRDyP/9DRL76cpK+DHXJP/MHRr56mf++EH8yP1AViL+00nK+6uQ8v6cfEL9Tt1c+gm7MviBiNz39Eru7UAtGvjA0oT38s5M+NeotvoVGfz7+OcA9HSvjPriqeD3PhzO+7B7AvtdApr4my6G8JWsQPxPpWz6Ut0k+rXBbPtN1Pj2MR/g8IzrLviyuFL71LiG+nh4evdST3r3+NSu+FapJPggFzD0MeVE9w/qcOwWDhr6HI6O9mRw1vyPFAD+F6fE+zzQDv67VJrunDFrANyG1v3Ozyz/XfZi+n1mYvn4erDxdjo6+vqUov6sJz75nbEE/MaaMPcRlQb3ODR4+JGi3PtUb0j4YYPI+z885P+8jUr4WNZ++vpBQviGqv75jfu0+/qY/Pxh/ED+gNQq+RzGqPxp2mTy7tpE+h0jHPbkxmz0dAd28JSHXvalriT2mcM27ONyPvR7MnLsrz5i+WP6ivjemLD4zMoO+UIT0vgYgpD4sMbC8IAmtPTbXfL1Wvcm9lVkdPUKCrrzFNli+NjVOu4WnBT1StUC9dfVHvc+gIb1BlMs9bWpAPTjiJD3b4Y091hV3vU0jBL9Wu1a+R7QCwEfR7j98G8Q/fDXZveOZtL6cV+6/Cn5MwKCuHkApLdS/yJQ4P+bHgL+EPr08VS+qPuWUnj1paoE+oVsePvArkr/CAxM/Hm9zP3DmHD85St++htcHP+Ech787CiQ/38QVvpFHRz9dCt+8vzA8P24drL7qiXS/G3CNPlJDzD4ukQo/83M9vtS6Cz7n5/K9BFqQPpK39L33z08+dDB1vgvbBb4YgPa7rlINvuzCnD4y3x4+5D0Gvvahx74SOZg+q3EdvdlWijsYQI48RNciveMtBz5Qvmg9FOARvgb8Vr31cF89bvKAPbWzkD4S2JO8qBA/PIZzAz2b5sS9rvobPlK4Cz5B8jVAVmq1wBc1i8A+2PQ/3lJCwBVf+T/ZcipANK8fwFq1PL/sdHs9ptImPjgq+r1yHp2/LunuvoGMlj5zSdu9jDseP//NU7+azuM9WHM/PaM7rr4r84u/JgIHP/yCCz8829U+/fk0vis8C70JC4O9OW+NP+TbWL+s00Q+4/khPoOrzLu2Bu09O5RRPadHhb10sZs+f9MGP8gEo75lrRM+ehL1Pt1TEj+VRcs+tuj1vWZufz6nPQG/cKi9vsTVBT761rU9+fTXvSUVsL1BwV07WjomvazEuj6Q014+a2fEvLE0DT1uZeU9YhSJOh/LP71pkaE8ojHQPGZqsDxR/du+0G/lPma8kT9tKRw/qeh0wBr8Nb+6HE/AJ44rvhVW2MAXQJ1AD+KkPizbET8ThO++zMSEPpiMuL/E0Fc/tOLgvllpVj9Z8Mc+5gYdPqUymL90/kO/AWJ1PnSHlr6pGN8+kkrkPi0lbj01usq/RwYXP3O/3L7gt8q9xgvNvoO1qjy0LQA/aFSuPmATQ76Dmsw9YeQXvS5wDr7mnNI+kO34PTEPnDx01pE+5oKrPi2mRz7Hb289Lwe1vSIz7b51oB+/l6KLvmnCXD2nAQ4+BCldvQqi3jszVgU+UB/BPgGI3T0DwgW8XvatuXkfjzwRZZA+VN8aPmWY6rtQamw92nAhvXp9vL5JbJ0/NFZHPOABaT+CIG4+BL6Mvm3YOT+bQ2jA4Bu9Pl5VJ8ASH/i/nSamP9Vq576riCs/+UpSvgTpZj18uug9/8D6veQb7T+0DQHAl5MCP0kZ7T7Szcw9udwXP/2Bn72erju+2Xj+PiVu5T1HcMA+vOMwvxn+Oz8iRbE/mP76PRcjFj6L14Q+k/i1voKShj763hu+WXwLPiAE5r0/qcK9GaEWvgMJRj5bpAE+DNskPMnvS76gZNU9G/BGvknFIz8EGf29yHynvY7YWL3otug94hrXOxOdkTxdMZ89A/QHPaiVfT2TQJi9MLzLvOdiI73AQoS9rGEyPSfbibzf/OQ98dSRPNR/v74ZA/g/nZymv36UBD/WnuO/yCxfv7j8Ej/+M4I/RcaswEsSbb+F/aW+sM0rv+M1hj/Sy6u+z8s+vcOgoD5m3RU+zr5OPewluz+feZ49VQ36PpgDmb56gkC/X/+Uvh4jmr40hpC+GSvpPerSL7+auvG8ibI+v0pyY76ZZ/m+8WtbvXzyqj1yU0g+D6RsvSWJ+L1S4BO/K25nvngjiD64HxY++PisPh88kT0/gBI+srCpvkufAr5yfgW/RuU1viK8oL4w7vi8mXRjvPFxaDzh9ho+LSTzPeYEDb5lkGS9FsaOPTtCa7vHJak7GyUZvpAUZb1L/OM90ziTvGsvmT1xSrm+rU7tvjt/6D2WfeS/1TDwvrVAiD5Zero/KQcoQP5EOMDyzF4/P5ANQFnsST/jkhS/VGXjPkNYNT5A6le/yQQYPqagLz/xfms/lVeZvRlSR79YPp0/zsFsPjvuhj6q1Y4/RccOPeF6+j0fs4q/RDSZPqx3KL3aJAW/FuDnv0+G0sB+slA9Mnszvdw9gr47in2+26tBvspl0b6sadQ96hSqPaCRiLziD9u7krAVvdJU6D1srUw9IEokvUWGs72g+pI87n4TPMrkfr4smvu9Up5SveZ8AD3jLVY+JVY8vmZz6rx0kP68piUjvZ6aarwNll29vFIWPErZBb0vxPy7ABNcvGYArr4VPkU+WiMJQDWrgsAjlP6/de+5vZk7+b+vy3bAshJ+wCMOIMACWxk+5T8xPs6EQL0MB248KucovN4RSj2aE7a+gAB1vaHMKz/9+yo//GGuvw6Qcz9KhDq914z3PaPYUD7AVqw85QqpPjL8Cb4H97Y+wHRAvlTpFb/+mQw87HZDPjuYTT3xK1k9x8vLPU5m3TzBRcG950AdPtJ/Lb45kDa+FJo6vmhExb3mgqq9f/PnvQ1zsDwCTw0/9KBTPmSM1b1ik4i+DQZCvgVEJL4aJLi8sRByOwZZzTyLsf68S5J0vexFd714BVY86RlyPaHDx7zkN7s7WCvMvApDdz1MRkU9W7kJPc3AgD+hzRlAuLWCwGc/J8AmDz8/XRNIv+I/QL8iIga/1JKvQHOHLcDeHiu9QaW8PhNjjz0CsWM+xYsiv5smxz3g3xm+FTliQM0XvT6eTAM/usxFv/C/JT5greO9Tyy/PwgVJr0PjZa9dcQoP/hRnT0/4GY+gX2Gv715Mb/wu+29xKTYvtGdEz6yMy++Ax6CPltX3L2zsim+ID1hPlSD5z2W7Dm+Ml3qPgD2nj7AfzE+h/PIvUCn/T6rjLw+F1QaPvEhTb/OHUM+2nZlPqaXIr5+LvK72+ZuP3R1aj5MqDM+D43Nvd7qcD37Mq8+NwgpP6Z3Tj43JI+9UE2SPRdkaz6dvsA9pqQiPhR9o7+lhKe+YaEmwOzUDkDaciS9EponwBf7rr/VeQVAYhiuPtQzFb34eI6+zKwhPkKhYz/ve9e+8r0LPdo/sL7zFtM/eP8UQOYlCz8t8E4/SE0pP/MjfL47RT4+uxYtvlKIi74lVdW/H2mBP334dj7XjXi+MhmXv+7Alz414eG+BPfvPljdgL0nu6g95FgTu+xlNT77kMO+D8DiPB74qb1SRfg9M/IcvhIrhL6gzC2+XMtqvnvecDuoKyQ9a9lvvmGjBb2cOFa+s5hHPlulgz2pj6q98ogRvEhhlTv1HN28PINsO+61t7w98Os8gutFPREhiL3EA5w9UJFGvJAo2r2DGXi+Jz6ZPw4K6T87i02/MC31vyZOxz32pzfAyvEIP5ouXECiFtw/xyBoPlytcz5OvCG+zeKeu69U9j4Pr58+4aYWPvWYJT+eP6I/+soJPtpVrb5Adhq/DzGyPY2qTby3vJy9xS0SPtJ96D8jarQ+703PvSfleb8oemS+fHPPPvrMaj0ZLoq90SQhPr1gSb5AyH2+8dP9Pno8Sb77r1W9FR/jPLdQ5L6jv3e+nmXevUc5uj71xhs+Yclqvlvf/L43+Gg+cXcNvkp6QL4eTFW9CbZ1PW/tjTwCsMQ9FgYVPd3ygD0tbpw9QN7ZPF26wrxgYF68o23RPMTTjD16fGg9JNFFvucRgz1iKUG/8jsLwH23xb8A8DTA0lTTP8o0I8AEXIi9stelP061kr56VA4++H8Pv+QrPz48ndm9Y/cov1htBb4ns7E+NdUlP4EdBkBToge+3bkuv9tNA78D2nA/MXgDv1xnjz41C1k+Vbz1PjX2kb+ZCCA+i1MbQAzLKcBTPNG+CaiHvcZ3Db8+qYG9G0DAvLkauD1M+qu+0xZRvKU+wz7uuc68wX1mvpQTn71ihQS+sEkoPu7zWL4CFkk92UBavUr55T05SAM+HGPNPa2DYr1H4zO8EiZbPZccKD2VIDo93uNcPcqtmbxx/aa9kfocPXuIQrxqOjY9Mz/BvN/Oc70GA6s+z1eNvq7pUL4drUu/0KQLwN7qgr9hLcq/Zw5GvtgyQb98MjNADYxgP6dwvT3njXc8yyMZPox3Ab5FncU+41kWP0LuYb/egJy/TA7Av8+0sL/W61s/Dvg+PaHrNz1/C5dAuGzfvn15qT4/fj6/kN59vbzf/D8pWWe/gmtiP98dxj45vCC+qbCtPczmPr5ju/c9R0bWvCwbuz51AaQ+3OE0PVFC1b3VW4m+2qLMvcSzKL6zPNG9pHHsvZxJmb1nMcq8foNavmnrhr7t03+96VxgvYOqjjuQ8+++L06OvuT3hr2cfAS9JnxrPdvcZL4zRyo9UQ2rvAOPmTzEmJs9h6e/vcIZ2b19UZM/TgTLvvx+nsB3SDe/a5FMvgCior9Vetu+d0d9PwWx/sDLEBa+3YNnP6BlFT46w7m9ZXGkvt+BhT4qB/G6PJ9TPa+KOL/R1h0+nvNRPjXqiD8Bsyg/k2D/vvLYfT+zQd09Awq4PuaEFz8sK40/QVIlvl8tED8uRAY/zsnAvsV6Gb5UAxw80fkcPdXfhj5js+I8Umcqv+u5gD7WC4Y+ylMGPsMuG79gTdg+/lgLPhJi0r0bqLE9xtRQPo5eVL5rlK++08HaPbFPd74UaMK9MXeCvZ+fHL7N9C89dycPPQvEUby5Ff28t9i+PJE9hL3JEGI8oJaOOgMW8zzHTrG8orAvPfXQgT4JeDu/qPxpwOjcir+GqbG/PlzIPpEWicD9wxc/1NnJP7f/k79Z94A+H2UqPyDwiz7voYE/nOijPq8DcT74VD6+SFuCPo7M1L6FaWs/7ok6Pu5+iz6fsri+nRQIwNgH0z3pzxA/0suAvuevhD7Vhnu/qvWSPppqZj+uc5q+y2l6vh+iDb5+BwA+tfTtvd3MCj0ABR8+OKQCvGCADz72p34+hVUzvn4Wujxx4Zc+YZzLPiLq3r2do4c8ERiAPLC2vT5Zo049SGVEPWpcRTzwxgG+HLJPPSWwur1d1fO8x5HdPCSnBj0VdeG80X02vr1T47wjdpy8BMQ5O5ctDrtDHZ2+kxAhPjhgwz8TIP4+9Z0RP9fpib40wO2/Hlrpv3opVL9anp+/TN6+vvPgt7wvc6A+5lWmPc+h+r4YxYa+D2L/vn+0O707DkK9gs0/uqGmoL5Ul1Q+RZsdvtB26r2Y3/Y+TMoGvvm2WLxNeiE/z+Ydv24e67+Deg2/LLJovo32ST7iOQ69o5k2Pf0fpL1x3J49NG6tOxFIST5z/YQ+PEkXPe5TZD7rLS69cq06Pvz6+LzMBxy+fojJPEWTEL18GBa+0NXxu6xBlb3qc9W9EukjPO3gsDxWFQo+TY6TPVcCDrsLfFU8AIqKPKEyST2BN5i9LoovvQiKFTyoL3g8zroVPokON77rgA7At/AJwHHZgsASfYc+m4spvwIFNUCmrwS/TXPMvgtnpL/4TgXAbF+tPpbMr76tTEs+DDE5v1erVj9XOSg+l6iBPIwqZL8PExHARCj9Psr1qj5+yia/hygUP8AZkL1bl1m86ERju0pO9b5dr+6+asEiPlAIxb8l5vY/Do1BPaX+ZL44IvG9lFjOOyE+zL36pJQ9Pz3hPk1x5b7h9VG9jVw3vYUAMj7Q+MA9U5qjvdz8VT6wfzO+hpIwPrHAab4+5Lm9rSHGvMNmBT5XuXi8ja2gvCNzG774tOk7GIbDPKXHpbwxfAW82meSPY4w17p7NuW8BWADPSwfQzwVYoI9Bt5HPgET8L34izq/UA4XwJc0M8BCMlC+bPZ4wDh5k76BVzHAwhsxP1x4Wz6hfwQ/Qu5zPQGREb1HsPM/dOq3PhOW3j3nTUS+CnuBPcE6vr1Lvgs/AWo+vh5QgT+bMYQ+twW2vhR02b2VSC6+UFWQPSFMxj4qWws8Q+Nfv4geTEBOkX0+inXPvgpBgL4Lj7k8uWQlvVNrSjx2/sO+z0o3vZywTj448Si9M3j7Pc7SZL1LKj+9PosQPrygFr4kwdM7KHZrvhZJU71xvkm+PyQBvQCDlLwhIdO8BUicvL2TQjwQHUK7Q145urKn9jxlZxy9/CqtPVVfWD28xsk8bdRfPBOrs714U8882Em3PcsBKj6yezrA9nyJwHWcpTyu1Py/PsKOwE34mD+9Dag/BqmMvfG/gj4XhPA9bvKpu4IFJLxYGZm80MM/v8BJbr7T1ktAJ3UHvy4rqT6pFdY9AbhlvkRrgzqwAZA/w6ozv8sL7b4VBAU+GlmbP042iD4HYr8+CyQWQCgdJj66tNq+qj8GPXtqhb13vAe7W14tvStnQT4AwdA99HI2PuGOKT6AmAs9FogdPvE1Lj5uSA69s55CvieCTTya4qI++iouPi95LT2Ln1E9zZzrPMtuD71paKa8Cs+KvT1w97zk9cG8lRv3vRwbFr6BoV++FizHvGviuLysg3K9UUKPvb6lLL5D52U8U73WPn17WsBCy9u94++DwCHBFsAqbZM/x6XQvtzRWb4T3I8/XfoOP2yAUD+tVMu+LnK4vcOh3zyHCfg9GSdwPXv63D6k90PA5Ij0P78Knj4Mr78+gt2Jvvd9KsAIToS99LAfvp6Qgb2Hy6Q+IMpCPgv+CUDSA7I8uqa1PaHtWz8+t84+SydkvsSJ5z3cFVc9dGXxPVLz7D0kvjY9UUF/Pn2BiD7btr+9GCD8vcQcTz7nD5U+RqWvPWMIWT4fmmY+f+elPeQVgj2S/6m8pFSCPJaUBD4zQj6+0BYYPQv49Lz0ibe9udp5vVq6n75+Bse9Sjz8u+8MdT1/Z6G9vszUvRBw5j6cI4g/7W9YwIGV1T/yAfi+63AkQI8i8b+XR54/TPI/wJqFCj6asIU9G7L5PTQ6mL7y3T0+z5gTvqdNX70NKkg8wPQnP163Dj7Bax89tpWLPnamRj9d8Po9EKxlPze52D3K+OG+0fHwvivbuL0GbZw/QMG5P98b477uBaM+6VTHO7jQc7yPn6y8gOr1PUXudb15FqW9mrmCvZeehr1YFQi+qudbvjvPk708Jdm8dwbevd5sWr7MCLu9cwMgP2oIRz4U2+c9ZbjjPSKMwD3zcNA7YFKAvnY1c71ag9E8pJWKPbx4tzytVRO9PGWVPmyZbj3qYSY92BdWPcpJPb0Vz5A+Yec2P1KSqD0rznS+q11OwAQnBL9opRpATy9wvaNkB8Dyv4k+I3ftv2a2e76FW4E/uy0lvs+dnb61uyQ+s7iKveKoAz40tiM/iDW0vz+g6r79gt8+o51ePs/xmj7aagw+6YqXvT7L/TxhQha+5YqWvKz2ED8u5Js+oDiBvtaFDz7a+/E9LwFevDzcDz3Nzz29EdJQPM9Ceb4yG2c+CG2FPBp+Lb6Nm769LlSQvdaSjr1k89k9qEPDvQVCXb2RrzE9eEStPeK3FL3EZsu7QlIjOr5gdb3kFG295WOGPXxiFz1ZyJE8BHoRPTsNzD3tA2i9+jhBPN2XxrwJQwE7u056PXwIhz2Ly6C+xziXwDDHA8CPxKa/pgeOPbizu7+T9L4/29aOPi8LRz8v/hbA6PHfvsZ+nb48ZxW+3ob2varmtr7ohQu+kr6nvdu57r7TDM0/Snm4v10Sor6prYQ76n+PvX9bJz9kOBU+qvodP2PP/7/u14S/IdGyPvDCoz4gmdM/fovbPsbpFL5Ytji9rcK0vcAJ2r1PUMm9uUcyvvLzDL7EP5e9JMoKvi+blr4uSRu+lO+PvonwQj5c464+m6FtPS8/J72haNU9obZQvIqTcD2xCwi8cqKxveKgST33WOA9xSEaPVzFRb3sIRi9jarBPRNUQz5nfr89U0zzOQjv4Ly1aLA8fACuPZ3YGb+Tve29rb6JwJLPtb8Bbp8/GfVLv3C4Yj6FZSs/xcPiP5mQkr8pshG/7VT4PVpmXb7f7sA+FgOPvoVae75PgEa8o2aFvx4cQT8sA4W+YW+PvnIymL6hqEy/Ap2yvmEp9z2c9he9QU9/vgIsmz/YLwk/4DajPsLBTj5y+cK79FcIvaS0bryU3fK9HsW+PY/h1T3214o91PKKPnTApbsE3a09LnykvlPNi75LIFy9WtSdvRkQSj0EsZI+OqSZvvPxMr6E2WA9p6H1Pcg4Hr3onMo8ntxWPSRF8z1RXwg+/obwu/TejDvORzA90ZtoPuSUGj3E2S69eRWiO2vz3DwJ8L0+rQTfP/e2jL6e/I4/awTKvlhI2b6s6jjAJC8owBQjGsAlHlw+UIf6vzgGCz+odoy/a/9Xv2nyUT78o8G+FgUAvjGFsD49ClK/9JNfP35bNT80GQ4/46lXvshBC78/KvC/7aoyvoeXNL7kumc/hQvcPhzz0L+VVYG+hJpSPhGn5L6TD68+JhgsPpX/ID0Fc3S93C1AvZJEdL9LH1m/7urTvjQIor4PyBS9QgOIvs1Iz715cNK+S5L3vVAn6b0xsLi9khybvjrZlj5ovas9Mh+2PeLH+rxXP5098SNLPgru2j1Km/Q95QIWPfJYar16B6U9pV0pPW4BZj2Z9129FVn2vbE7Rj8L5C+/8j4QP4RKbECRpkG+K+XeP+76GL45Q1O/BkaJP3e/pL7b4Ru//goVP2iJET7bBBO/JtJQvgH9pj74Yxa+0O/cPlnnzz6+S2u+kkYtP0ggCcBDEkk/nHEYvtyF0L8y22u8H1qQPUpqeD70+nk/u98Gv0nHwL9Zvy7Axa/6vpqJSz8d1G4+OhMbPkMt6rw/mUK91sbkPu8BHT2XB6O8jxnOvZUlpT0ekA29pMK1vTh3rD0c0u8+qez8PQReqL0wTe+8e3M2PnDtgT0Q1W48uYmyPABiNj41kps94TiAve5MLDx4dJe791GiPSRLpb4ypyi+Kc/3PPGbnzw23OE9zslwvm5ZwT2fawe9b5/sQP5LzL+SyKm+8GWzQO111T56z07A3SyYwD5kbr4rxHG+nRwBP/+kV74icLU8LXQQPlX6aD3mTiE+XU+6PeRoWb+1NtE+OBosPhiKkz6fDaU/Ty9GvhICrr451lc9FzILP4A34L5rrCI8XJZuPnAJHDt9k3c+wMiLvquwWL+536i9JUwlvH9eg758BrK+OUK3O+wvtz5KmEk+tphhPl0d0r2f4SG+CkUpPpRaAb95CBE/k8TBPovvUL9a5SW+n/oVPbV3xb2R/IA7PsduPbhBMT51Q2o9z5/APGOXxTwmeIo8YthFvtLIVT3SAAG7sws8PDZJabt3qWQ+5SeRPwn+Xz82AGXAk22Fv3VJGr8cvSrAof0hwHTwLcDt5HFAzUaOvhaNeT6hKt+9P6DvvaZCWj6uDyc/y+5svvGXpL7pzJi9aRwYQIX1XD8dYJ+/m9XFvUpnDT0cZMC+PASYPQ3k47tu3ja/YVODv6rSq7//hzS9hYcsPltW27075i09TbefvaAIwbxRhe084uc1vU3QKb5altE91n3lPSNZDr1MYDg+eFk4vQ7jrb27LKE8LT2YvBuSlz1U6uw+Tvh0vcgc+j1B6ES945cUvOJjx7uji929BqOXPXaiLjuM/au8fkB7vDKcnb0cxcm9F20evS8Burw1feU7VdYxvoaIwT6XF0TAJSgbQL7Rp77MC4A/5wS/vuvjMj8cRq8//7Cgv5gEZD+VRK6/TxoxP7SJaL1cHUI/0uXivvaGjj8alUo+q1W6vfEYPT9w26o+3fnbPtY317+kWXS+SpWXvLX3KMDfi1s+2SBZvWgvgMDVlKM+qDSAPYE0lj9zCii/1ZvlvEke5D40qbs90P8EPs/zlL0MTgI9jTzTPcJOLT7n9Bk+V8dfvbsoUT3hjjm+ap7aPOymkz5pPb89vGH+PNLXnL58sfk9TPQTPtwbAD6+P8k9pGCgvP2cYj2+Eny+UywGPT1kmz221AO9VmemPI5GkrzIvO48VaktPYFwPbtqXag8rt/Tvn98ur7t+qg9C0yXQKzAQT97HS+/QPriP2QYqT7OCus8PVc4wRAZIDujLii/Q435PjfP973gJqE9QNqIPhv86jwSer08sGiSPyS1MT7dy8A/wE1sP87hA73VvLU9WL8yP6AqPb85VSK/lYWEv+GiTj+7Sce+te15v3Yjb7+OQRw+E0suvUqAqr+ImCG+ilEyPliJmDxXqci9ZwievXSTOb6Yy/Q9JuzcvbAW6L31twE+qj3VvfF8ab6VsAA/7o7KvlQElD04yJK927pqPZ0ixzxkWbI9djSbPWBt8Lw+JWM751CiPPeBjTwQbIG9dpXcPW5x5zwpMc28c2MXvE6Xh71iI0C+ynUzPRgLdz+CR1XAXrrPP5L+Qz8Iag0/+scmwBBTUD9WM/q/9CIKu70ypz5i6xI9eoZHvsDHiz4hMM++HlOSPvB2HD0il5NABV3LvyvMrj5YfCE+308Sv/tZ4j73tyE/0UIvvjuGhT1iD2E+xj9WPz/wjj9uO3i+Sd+svkna4Dz31S2+w2RLPmw7DT70WKW9l+ygvbteFL5TUA69r35rPO7rsb2BSSk+bnmkPdj/O77tKMy9VLZdvY0WFL5WxIg+C1qNPkYFXj4CJ1m8ByijPYFPpby+85O9qV1BPu+IjL0Xr7A7NnMUvMhrTz1FAA2962aavCl75jxsXUS9DXPjvIGs1D1XQB9AUG0GP6fsEEDJL72+J2mBPypRV0BOnShAsOBMP1lcRj9qEjvA9mycPlj3ar9Y3Y08xCiAPnMjr72gYMs+o1Mlvqs5cT6KN75ALXiXP/c7oT9vIZk+IqTXPQN2Cz/xuwA+fYj5PYD5270I4Z6/XeH/vs5rET+opt0/dfU/vQ7l376Rg7o+Kv0TPikKqb5dqQ29k19ovaXBaLvDb7q+T/BPvuzG/r182/q9rPYcvlXbib7Mlus97KbAvVWavL44LhO+Ci4MPgk4AT7Cm5A7m2krO5vFkj0u1K89z0GOPQ+q/DwqN5W8/KKfvbV5bz6mJec9lz0BPJNPzLwBpPW8tNUYP8agB78tGQY/ZlyPwCM0kz+O0gxAaOl/QLBipL8MmIC/IkNKQNR+zj/Cg4I+SZ65Pj4amD2XxQ2/MGtLPltY5b6PMgg6xGkKwD24Cj/AZvs+oL9kvyRdIr8tmSs9Ub6sv40gtT5/0QK/t2VDP8O+gr7ImZy+wkqOP/ZtBD/43ei9zDpJvYS5VjxjIUU+K12dvl0Rw706Rzw/k2nlPgW63L2qdoG+mfIePmZid769Nk850FAoPiQqCD92Go6+OyCbPqzsPL5aCkM8Ou4LPhy0IL0lWJ+8uMPzvV0cuL0PZro8SHmBvWw0Bb29c6E90Gv1vFCVnjw5oXK8jDJQPDiJv7ySWtq+nCPzvndROcB7+Nw/hewOwPpbPj87ErQ+jSByQNrrm0AXjmw/RgrDvTYQuT0UA/Q93S+GvDW9Zr8RXzq+vQcLPRis4LxAx3BAEn90QCV7LD/IUj3ATh/cPSwWgT72b6q/n6wCP5FdQL7dA6I/X2INPhCkgj42xlU/RAuUPl76Or/ADCo/zn+7PgZTlr6hD1g+bDc1Pqbh6L2BDKu91wUKPnP6b76yJxI+xe7hPXiRVD6JWWG9mi1OP8SevL1Up5S+g+HCvJGtIb5KMAY9F5FcPQyKET1BSLY9wJ7NPGfc7Lwfhki94WNFPEmqKT7jBAw9iF74u5VTuj2spok8C2WVPdxC/7zLOmU/wRV/P22FmD+Z7+Q/JAd/v3W+HcB/0UTA87dKv6oBJsBts+c/b1IUPwMDkD59Q8a+QVwaP5v6ib8Q44K8NRfDO1+0Yz/PqCZAeX0fP7Xsnb+pJEA8mJBbv/dtWL8ikmu+jsSdvl93/j451aS/fu+tvmozoD+J4IM+UmfYvVWQgj2GBVk9FZJaPa7BXD3Vb0u8Io3lPZz2Bb1nQ6q+C2oJvjgywL58Zwq+a8/8u/ohD78B9sQ+s3yQPlCodD11l5a+7DENvsiuZb1yg389NnTbPYvO173VHjI9Kl3FPDbvD7zGDd68XmYjPolGAz3OHrw9OawHvC9gGT2vIZ898Es7vhmoIL7dbtM9nGQzwNbTbEAgbaO+Qg3mv1aOo8ARi2m/bjgYv7XfgL4zo4k+P804PnUzKr0V5Qy+4QIAv1yy6r2Oi3G9KXktP5l52b0UdNs/XsHAP12fFj80K0e7omQ/vXWII7+Kg7M+472NPU9NCT987NY/sAuxveqLBb9qYIo+FLFLv0CBU75BITU9NNdLPZ4QJD2iGPa8C6O8PYzu470deEm+VgUbPtdpnz2P4C+9Zf9Rvvqu2D06fVA9w2vKPgN1p76ZQKu9+D0vPZV5Ur2eZ7A9YQWmPbZ4C76Obpi9zuUgPOOJEj3hLIY93c4MvmJsDb6AmhQ9syN7vHh3DDvU4yW+pdoFvolOvjtzblPA9x5TwLbTUL9VaDLAUSn8QCJBrL+FRSFAFIsQPwr/WT2WIgG+jwYbPd3xAj616s89OfghPXG3Sz3FwCu/EaN9v3D+iT9HMYY+m0w5v0xJs773HYs/UDwAPx8S0r4bQiq/qAJ1vwmfHz9mB7u/Cnqkvwz/z7xhPV2+JZB9u3o0cj2c62C+M0OpPctTaD82LlI9NkJfvtlznj4Rcze9GXACvlFl6L7EZLu8qSTCPW9ZIL27j0q+mHCgvesiDL4WUXa8TQkXvZqCjDwZVWG+9UCxvWXZEbvP/JW7KNNfPQWihb0c9oW9TawePkuXIb37CYW96iMjPQrJ374soAc+ZjoIPj8g5r8lsIG/o9chvl7oDb5Ef76+6PpTwIR1WUCUGA0/UbvovAbAxj1gyAk/pb0gv2iBGL6FJGQ9tR/Bvjn/7b5Q2d8/JfqUv6OnOz/Spfy+Vv9XPrOBpT/SOZw9PgnCPgOpyL4khKq/FmJ9vq0GGr8sSO4+2F6yPYg9DL6Y+DQ9URInvfmEWj3bjRS9BYg0PVpzP74H9OK9lBCmPStnGT41KBc7Z5MxPdcTPb1jXZ09kPQqPcdQjLsLjsO93tyhPJXsCT4sMPq85HQ2PRe4qj3zzsw7aiJHvZm3zTvheh48oNY2Pqvz0z0sLxw9c5WUu/amxj0rvJY937/0vX3CtL757SbAE4hgwNBN6T/TPmc/8c8MwLZSNz+/Aue+PbmsPw5aiz8Tp5U/01jIPnKkTz5Zu7G+cpNzvYCetT1Ffoi+bIQpvwH1WD9+CIw+txrLP5rChr9Omsk+zC7ZPoej7z4KPZc8BZuOv/dFfT7GGJ8+mR+nOtNbpL/aNsI+oRYuvshihz9Qjnq94Laju8qZOT4Z5qE7B83hPk+NtL4M25O9966rPlORbT7nM+e+R5wtvt+0I77JYbw8c3pWvpBGjT5cS5I+AUasPdydEb4R10G9Zmt7PnHkZz4LUQG+TXCePSpaN757zsU8+PdwP7qZqD0511s9CHTJvea+nD6Xfno+VFqqvpAwgL7mig1AjSF0P8lEAz7XEYu/dVWEPxhuoz/L7li8ZtimP0VsoD66jhK+/sjAvb4TyT2WzJQ+wjOJvgQ3/b6XEUxAruUpvyyAnz8mANe+Ts9pvjyzZb8Rquc/EErAP3D7Tz5as2u/REA0Pz+rHr9moxu/pFZcP80enL4XkMo96aULPjDkHT454em9tBXUvVo3nz0gXge9A01tvpFYwz2uBGQ9B2kEPk5RrL7rEcW8Np+nPqym4r7w35U+yWTDPemS4D08I4i8L153PsrB/z3O/p++1PBcvGwja73Cle49Dw0yvMjxkL6NHPO9YbXYvW1kpT3PC5y9HnNZviXNWT6zMRc/u9WhP5Y0pr+Jn4rAa+P+v/h5+D6ydizAPrQgwBKLsb9vThW+RV1XvvlHk77yNj8+PVImvwwz5D6+dem+TWJOPznWbT9AAgTA1+5XP22WfD/cJ7g9oaKQPYxqhrwRDbG+Ns3AvgMWFT+oUCI/Akz0vicYUL9DcOC+4Bu2PqHDrz4kDfG6LLh7PQzyPT68Mxy9ZKuTverncj6+Zkw+y5EXvmyTpb1ERS8+H4xPPhfn1rwc6x++rHNgPhv/Tz75CTI+g7RSPqrCbD1IGeK8xyARPS/1Aj6mim2+a7qRvMTSkrtG1Wo9k3EXPigEZb2HQfM9OHqBvGh2sL0gqoc8MXIbPfothr6Glh4/5haNQLCchL8e78c/CnYlQBwTwD/AW3LAC3QPQKFiAD+ozac+JR+XvkAHzDxDyMk70nIAv7DMAb/1ZT2+/ynxv9tVK0DorHA/3XZNvl2bPT/zKYu/Y5aePyOsBz9zupk+B241Pg62Kr9MYR6/d4rEPu2jmD6Q092+5PSKvl7y0D6Mmy6+7c2sPaleWrxfbsA+tAHqPdz/rjxDxVg+i7WYvgYNVT6R0fI+WnZkPI83Hr9e92Q9AFGjva4rbT5YVtg9nUHRveJCkDxEOBq+69k5PvwZMT7bSha9G7WCPcIgBb7MPAA+6W8Lvp4Xp71Mn/E9GzayvQRiTj0LgHi+q4aovYraab/WeFvAWalUvQOqLcCGNlDAxgLWvigR5b55KC6/fiSivoHdD78ffPq+PlIYPoY4Hr6kznE+Qqa4Ph8pAz/bixg/1fJIvzpBXj6dsq0+wpE7vrw/+j2b0cU9OidCvlnFsjwxb+29l5SXPsl6Nj8ZZCm/O+CUu9IP/LwHeBy+FhGQvbNDY73Gn348Qzc7vWtMaz3tTei920SZvSq9E73iO0W+DgHlvay1SL0fksa9DFcRvsQvsT3i/ak+UDGvO9tSvzz6Boa9i+c+PeAjNL2Lj3G9m2BmuvFYr70AjsG7EXYoPbYH2j2H/Cy+zkicvUuEBD1VFyM9uKFAPZW9Ob06qYc/7Kq1QAQJgr/1+gm/WhArv/qc6T/1cdi+Li/mvqbC2r8vcpRA631GPumLtb6TRe29BZmtPqUOIT+Gs8A8H31SvVTT4L0tuYdAJZkOvu9xzL6dkYS+B7l7Po3iQz962qu9qpPhu5P0yj04s6I73MUsPwwSFcBVVCJAgaOcPqe7Vj3djYC+zxajvRpW6j1FV5S92KcBP2hOxL2kshQ+2quQPjdxiTtWJLW8pYGxPiy1oj46d0O+rtzRvBE8ib5W/r6+s9JiPsIhaLkYcDq9R7tdPS/mvD1X7fM+0k8FvQxjCT37u968zgtEPR8/BD+QOMs6mHgNPZRSEj37zYW8+m6bPnQlxj0O/RlAmNORwMyTq79Z4Uu9Mea3v0aZjkBzIFDAI3CGQOEV5j1G/OA+lwoRPlNfgb38kUO+ECiNPivg+z1BcjK+izkWPS/UGcANtQPADR40vv4Yfz76mB2+zUNOPDap5D2q/LM+34WCv2qk7z6rWBm/S29fPvAB5r+IN8s9VcDBPp2OSj7hJEM+ieD6PWbivrw3izE9xipkvByG1r4Uh4S9mSddvuRK3jwMX2i9aaIzvaR8bT8SiGG86MS3Patehr4NIz2+figvviSupL2eR568V8YPPq115r0JCYO8AcenvRPWLL0qIhQ+s7Nyvlw3iLzt+DO9l/x0PPdOTT0KMCS+lhzCvXPY9L7gMaRAInMVv88NOj8VSos/I6ITv/rXTL9U44e/tbLPP/4EKD8S9M++nqKJPa6Brr7JYGu+NzgHPhVajryldBJAJEyIv6MKhD4U8NI/yoTIPpVaPz9ypys/eRiMvp8Nh70MLIM+FARqP1pP1b6EuTy/n6jlvzFDrz3ss1u+GDYEv7EtgD2yvtA9aSDVPFyl5j3LDkk9VE4LPqTLKz0A2+A+2y5Nu+7qwr4+5Qo+b9jXPuNhe755hLC9pdmsvtZ7KL48bDm9EyNMvd/tdT0+sSs9X2IWPaeRo70OEtO8pXb1uqDe373ge8U9U15iviOZhD0KeKw8q3aCvpn1ZT55EaE93egqwDKaYD+GMLA+Rzkdv9JRgT/yHwI+pNjwPh2Yxz92akg/UjGFvZAYVT3t+uO+g7YBPmhHAr6a2Io+b1sgv+HwQECiH7xAV9RkPVIMCD/+Exs+DP50P4Z6Cz8PzbG9FHmWvjjYTr9D9Lq+7MQBP0c5jj9gEKw/OBrsvYEmuL5tOUm+83RIPtbKq74Qug++X3oWPYXDmb4Oz1W+bxPFPemkAj+uRQa+fhvSvAHcir7MGuQ+OK16PmoiBz8sptm+L/8GuxPILb0KrQu+KfgdPvlTvD0PGik/1wKevCdWkjxqJg69J0YqvqCSuT5t7FG9UTenvYQGF7yAquG9TnTJvs8GkT4lKfW+WkMnwPL/BUDD+qi9oc0AwV5mqL/NIQ+/tjkoQGQPir7b4ZQ+RoC4voSQ7T5b2hC/V47hvsfF6j1hfy2/iHGqPyNoJcBIB3Y/ZJFCv1YmDT/1XF6/aWvGvUKRO74tqVW+IjGBvGpT6D5ispG+xg8JwHVpdz9Lg0Y/YTVpvuXHFjxQAbO9pDJ5vjOMuz1KyPm+kW2fPorPKr2Oh/29XspWPzmDVr2FgI29DZMFv6scnr5Ih0Q+r2NbPYB4aT24WYm9vlnTPZbFoTpZnE08IUanPVSttb3g8iI9KTcePTr5GryDYHc9aXC9vK9/g7yvCcg8M2e/uw0VAD24t5W+3gjoPgIEkb/l4GvAJIanvjZNBr8jZrQ+vLS2PpV6uL/x4X4/By/iPidrhTxcrnU/Kn2gvsF1E74+xKo99EMEPwrixz7t1wy+3RfKvnit8T4Znw4+yhfhvKzjr7tbuMg+T6ggOxftAL4b+cbAXGhNuhTq8jyzR8i+glvauxDvSb4kfLC9Pbm6vGEZWb1R2149vQUevJb0x7zzhaC9PSvBPBKIObsMfZq9yiw8vdOm7jyIFA29/AAxvcdwtTyxyAO8H3/lPLcLJjtFiIs79zvGPFjRqLx47s87q/niO89ouTo6BKU8UPtTvMsrczxQEKq8MbduvE6X2jvkC4y8U9V6vJb/IrwaIJY9eqIfPuvBFL7xvQ2+3n9fvW33rj7cu+9AA6ptvov2ej5p6Ne937Q+vmZXFDv9Cpq6Rsy8PG9EYz17pHO9a66ru1/o2z6kuho+A3XdPo84AT9uqK0+mO5uPypuEr9RlJk/uiHcvq0NLL/ZwtM+5YvPPJdPXb42z5q/6bj6PS93kb6HBcQ+uHlbvrKiWT52iSQ9UApCv/C2Gr+Oq+a9guxTPjxF472a7gg+97XCPn//xD6m01A+g0uyvunjLT78jWI/nbnYvBc3WL0+HFA88xAzvnK2F75GdUu+co6qPQa8YrwARLg8Pv8uPiZBsb5+hjw7xCgMvbInKL3bgMe7o87uvshMb77PNRq/P3v1wG6wH0CIgg8/sDrJv/lb78D7iKy/LzTNv1b5nb5CDPU+tJ4XuyCwCj6VrsY+mLeGvT9wzj6TS8w9zX9zP4XOjT+tEZM/oxDrP4L49r73hBg+m8R2v+BsNr8+xoW+VAObvap5mT577nQ+GXhYvyOCZb9nUik+0SoKv6aRiD7fOYa9PZTMu65/tD01fBW9r2U/PdjPmTw89jw+aDQNPqi/Hb3Qjgs9j0W9vPPjnr//bkA9TreuPVbVAD1ftAa+tWIhvlJ18b2XUis91SEXPhF+jz6bOr28XIbbvJoCQj0fMza7LX0lvlyDM76BO+u7k+YjPIlc1T1Ygkc9DPKzvC7dFz70yx3Aey5WwHe3LcA1c94/GAJhv4CdDL2fKZi/A/KavtFQlb4hQb+8JPJfPTz2HMBpP0k++H/+PqlYK754MA9AI71Mv6u3qr89nKk+9jKZPo0YHD5R2vy9hkdEvtJkK76PjI2+j9eevyhHPj8ESIQ/FBkOvzIlKL3XTo4+MJpIPgnBeT0vL8y98/d9vb54mb1Q0gW+HeIWvreifL25VUU9cRBUvmZIP74YHdG9M/0Lv606ub0rV0W/WdapPQzimL1gTgq9FApZPWyhcb0xI5M+1sMnvtX4QD27Ies8yCs8vUZY+T1LMYK+ffKEvBmETz2He0e9Fpz+PKNpjr6T0ki/zJHqP7UZhD3eqKO/xvR6P8WV6r/ko5XATqNdP/HuiL0Xgx8/d6jVvr+AUj4TkaM9Tj3Bva9qhD9m1Sa+dwfrvMOF0T9VJ+E/z/ESP/ic6b5Y6E4+0n79PsdGJz9gNoY8p2qqPsp5G8CK5Jw97nCCP+P8Yj9WXcY+1FoPv6ckwj7HXVm+dtMAvE4ErL0GHE28ziamveMlpr7lP8W+oYV9vc7guj2f3pC9iAO3vk3hKr4kaY4+eMzePei2y73HmV6+ebPvvQGx9rwYcd68C0ZLvVKO2D5i7y+8sb9kPfaAYL0QE/G8fLBGPgvsi75HRBw93FdQvd5w0bxuGiE+a93DPs/N1z/gNrW+RVk+wDPOeb+dpvQ/I2KDQFfLE8DAUFrAXKTlPpGxqL+kuH0+ABkuPhUUvz7fBYC/OeeVPfEHJL4alLe+vqUhP4MtB0CCCwZA++6nwAlaEkAcfIvAHo/YPgys6L5uk7E/xQgyQPjjUEB1yvC/pKlrwGNNh7/lbnG/Knt/wMME7r/C/wrAaTrVPc4T3r+HB3fA/iL7wAXHXMCo6wbAF4l7QFmLs8BO0E/AdY+MP4z2jEA1N4e/SUxEwH5Gjr/hxJe/QlaTv0tFdj8VSD9A+p2vv8bSCECsvVRAcoiDwN2Ztj7ig39ATf+cwCqUHMF/XDK/yKiswKFDH8BU9fc/r3jMv00X07+hPvS/EdDIwDQwA78t8jfAkmmAv2Bg78BJ+ci//aMePsjYLsFzo8m/FcwUPneFDD8Htdq/nyK8v6HKA75BpE7Avp9IPnTJWr3bVoY96/v0PfH8nT3JWim9uvNHPBKN6D3NhoI8QJe3vU+IQb69bkA9vlY8vQj0Jz4glSc8Mw8Cv7W94b4odh+9Fl7PvcB+Rr1wiLU+RpnwPeNNtjwJ8Bs+wbIAPuTQq76HDTc+oJs9Pl4Q3r2VeJq+EKI+PGIaJ76r/zu+r9esvvx0970KNYA+SDEEvpFQVz3An1q+R3RNvtMWDD7/aM29UVeIvKAktj3zwcC+yAwavpeBR75olxm+rieGPna7Kr4fQpA+cg6JvigoSz7XDSi91wGRveyZ/L223JG+10+QPnmMlb2a31++NLIOvgrm1z0qCZe9gXwyv+5Kb77mrXi76Ic8PgS2IL2KtEk9zvhJPXbfmrxXnKc9Ksb8PTr2ET2QvJk9psWsvSG3Jr2z+Qo+DAt7vpWmJz6S/sI9v+oLPjFDrj0HNsA9eioVu2/TIT6/Bz47kmEUvvcdir30dxw+yASVPd6qCz4ap2E+Ze+OvdHHDT3vmFu9q36CvX9dBz5Eywc+DPiUvSZQOL5qF2S9fRBtPTYTSr59UiE+NstbvEMBIj4sjXU8F82mPWnT+j047j8+TwPmPKqX9L0JyQ4+6S2xPULyuj06E14+ZiWsvcenAT0XXoW+/J20vVLG/D3j7948OtkRv/4Ej7wPXFw++3GTvB8Yfz4NsAU+MwUHPFSybb2nczU+K53iPVFv4b0jibe+us3cvb8boT13LYU80SFfvaSR171id/A9NJ0Dv9S9fr7N84k+11/jPVkMM77AIfw84gcVPjWXfb3uJUC+Nw+rPYFUOT4ev6w9kiCwvCrQGT0sl+g8WevovMaVvb3yFTa+0lJEvhzXgT0sMdE9xHnKvDHM5rzJe2A8hHoTvmPJ8D15nz0++q2WPSDNCL6vuvY9zDAJPtWTLL2zIis+E7YRPs3fHry/w++92z0hvoozZz6JKys9S4tEPmgfQjuDZ1a++WAPPgo0Tb62ogG87DiZvGU6p71qqFQ9qhY4vbVCu70qXsm9iq66vXYS+D0IZPs9lTqJPepAcD0x6RE9bRMMveVAmTxtPeg9cUdlPZ7MPj1a1MG9zf1yPEz657zeYhK+bsTGvasXqb3z4AQ+YKWsPdIUAb0HPgQ+HFuRPRoFSz61sHa9xl4MPTiQwj2WYCc9c/PhPVBEib1KQxS90dgWvmg+Ej3PgDi+khW+PD9zlj1HzhU9nMXVPf2Z0T1otm89AypOvqB5ST0PiNe9R+BSPF/1lD1CoyU9PtsNPBkdsz3nLps9O/7wPIuzAz1b5Yw9s73yvYG6jbzUdPG9LGDFuwKmfL7jIGc94uePvPvLBj7Uy/e+gExAPnLcCT00PcW8sfzCPD6sjz5TalA+wDVDPj1iYD7tW3a8Rs2nvnQWQD61PJ+9CJmtvZT8nj3AZX4+FagQvr6Wcz2yhuw7FClxPvLNUj2+ZgC+LdB2vN4TK71hh+Y8UphLvVKMDT0Mqv69CL85PU4jgT4c9i69UzgnvlfCij63NnS+hIGtvJNba70Jkro9kZ9xPmoFYL666bk9qhitvun95D1G5Zy99jrDvHjCIT7R5uK8FHcKvhNyiz5NtDY+KIdMvlEzor3a7Jk8QzVVO0d1r7yDq42+EPv8PQeNVjykqmy9auuEPjixJ708L18+rLcNvgFGMj7aJXM9vKykvfTfFL3ACVI9jkE2PtXaG768g+o7QKPZvRgZ8TzG3CS7NFUcvemeJDuC7oG9ko0wvRzIJD6T0cS8+xbWPeBOPb2aQKY9P1a5vTgSYL66HmI9nojpvaoJB7uyvYO8s9oRPh5AGT6Vps89e31GPsZyLj5uA089F57suRpQMb2FeFM9j7OTPUOZpbzabKa9l3MaPjZKDb7HxI09Q7KUPY9av7wkueQ9gZyBPc6G+T2mVnK+ifsmPvXTuz290eM9C0LfPGcMLD4xyhk+50A0uJeOF71yDPW9E0TAPXmlDT6Ofgo+L3N0ve3637y2z509oNimvYK8ib2YPlI+ZMFSPmEUzL3rTrg8q7cMvVChprwRdlG9xfpDvkRZFL7DY0s9LBevPPDMXrwV7Uo+Cxa7vLqcdD0tEsg8BBi1Pbk9sTsGYIs+08OEPhJvYT5yNuy8wyFDPraY5b2dFkK9KktpvjLnNT13ke48iLJ5PcnbD76hUAo+wxNrvL42N76Idek9OgVKvtv1Xz5Pm9c8g8UDP3VrvrxZ9i29CmSqPrqohLxvazI+6Jz9vSVvhD1GhdI9Bvw6vmBqIj6duKk9fotpvhDzPL13y8S91tMXvrbFkj7IpDY9l6SgPU1nIj7xmSS+KhtJPG1OTb2lRrk9pv46PqL/cr4Psdc9IjK1PXz+ob41t+A9h67bPdLAB74zbZC+30qyu2k/IT2rWDw+HLNbu/KXID1pg+m8Y26hvfwtCb0lFRg+gtZ/vVjvHr0tefo8622jPUQihb2n7k89YrdJvedmFz1ZjvY6TNAqPlG9DL3FWGQ+0GARPpX8trwKtby8heGYvlaV5D3i2XU9H/mSPY5m/Dx6+3s9onpYuz4XsTx3afM9B6skvbTDEr5EYhE+PZMIvTq6eL1ctoe9NbuNPD6ugz1BKiE+bhFSvS9sRj7PyQU+l+ohPmc2zj05eAI+o1g+PRJUiL4NjW69H573veanUz6bYRq8sDEVPhOinTwIp4q9tfUhPowTVz42jHA8AK7XvsvgQT2r8C+9xe/FPId59D3kktU9qtE7vgq3fT0jcN09OFpjPqtv/r36rGo+uLpevlKV5TxSIgg+2KBdvHuAmz4Os6s93DoQvtwGm72O/Jm+HnVRuHamWz5PcqC+VlPEPbJgR76GBgQ958VSvXQPCb5bmwE+RY9xvQkOAb6tTU497aurvag0wj2MNz2+GCKxPW5R373/QRK+iZbEPHNg37zDWnu9pJ7Vu2hDgT4vrDQ8DjYqvf62EL61YfK+5+tGve6PFj7yrmk97jr+PWYYqjy1Ywe+OMTpPb1O/z3FcOS9Vg+NvsjTxr4DlqO9XtRcvT1BJb7nKNa8PUggPnhJCL4aNNG9ncKaPRqMHb4XbgC+EpouvrXarT1Nm8E9jPXPvZqi0D3CW+G8OjntuHYXsz0XpnK8GvgOPtVuCD3IKIO8CJAYPkmWjb3hQqc7MwwUPXBqKT1Ix+o8hOM4Pa3vBD6GIeg7YREIPnKldT1EzrQ9xQMovvckGD3nzG28LlCPPeuS1DyIGKS9eyHwPTz9vbwDZWC9yZKEPIvUZjwGNx+9/CWOPRW2Vz26MyU8g1NdvoTQBT6m5pi8XzS2uovSfj2ggiS+YWkIPu93Lr07QZc90OKJO6ZNN7tNBfE8xgkcPqnWe73PnlC9J4gHu/4f2z0ob6O8ugGzvZpKw7zfpF48OcUqPMvHOb2V9UM94WXvvUeDdb3m8xM+oDiaPhMNgL1+WTQ+k/dAPkbQhL3f2IA9qp1DvocuJr0ymi4+kudOvTIpgz0pROi95AGdvYoSgT2BeAK+Y1ycPh8Kib02wrW8iExjPnRnMz6nYnc+Btufvbuhkj2Cem69tQRFPupOmj21o8E+b6tMvtw3dL6JBBG+iU4Gvmjt2L1S/Uw9KWiQvjwWuD1g+mW9c/rKvT5Erb7oN8M+wmUZvWkNjT1ayoM+m3INPnNmA709ohk8COACPuDLCr6+jTo++hMgPpi8VD6KddI9XrpEPXZngr2AkGi+ZuVUvho7qT1OAHk9iR6Cv5JJBT7isk0+3qiQvJr4rj3/TSi+r8WQPh9HAT7zpPw9BV+aPXtqrD7ZZjm93TyHPpSimLyMN6S8GYB5vtnDCb5wp4o9qXDtPBIkizsOPng9PTz5vU3NxD1o6wI97KlBvTSxaz66ZZi88RwqPXvtk73wYS89xF0Ovh/oHD40Eqk9OzjlPqL/hLw0dTM+eSonvsbMCr69Y4w+piiIPdzo272EL4E9OvJdvsP8A775wsu+7VhBPjf32L2eyV2+laWDPSDbWb7a/ti9hlvmPbjD4z3wZRy+BG8zPfUrlT1kJoY+W8HzPF6hAj5z7LS9DAOpvjbaTLuGHyw+1N0bPRaLDL8yLTc+7IF+Pf241b22sjw+q5fRu17P175Po9Y9+3RTPJ1MjD0RlYK9EKZcvU5fqb3yzRE+mpX5PQXLvb0SYhC+RIaqvj4eBr1f7xK7+f+TPZ3of724Bcm9TIFfPuwqjj63yq09DgjCvXb/mj0mXkc+xjBmPYCdH74p3Ie+MGyYvWHsFT4FCoW8fonHPQ+/wL5TkEw+jMBEPZJATL0J7ia8bZGfvX8Zdr3ICxY+D2IrPbcQmb7mXoa9mfn8vGkYrD1VLDK+YHpIPWx9hT4JpjA9lr0eO7yZpT0Qi+Y9HgHGu8i7fDuRnUO8BgNvPmjtbL0FdgE+3yi8vTPCBTwHXjY9wp6yvHg/rDyLe8k9HPMgPZgdpL1CJ8u8LEdsvRfYiT47Kj+9FokLvvxluz0Yd+E9C8aFvbN6Pb5RE5m9AIGlvYDwG71O2wS+kTwzO+xf7L6OSDk+pC0vvXiYoj0zA+W9cm6oPRRKJz1XHkm+daKhPTHX8DwpjYM7uaCBPtjSej22vRi+QvaKPM98wj3DwTY7gZ+CviFlF75diAK+HZkPvkCYSL4ZJuG+S9R5PguDyz3sfmS9dN7uPT2RDjvZwsy82981vrwylD1Nav897oslPQmehb3ThRo9nMJNPi+9QjykvI+9ZIyCPCYuPjz43Ts+mV6uPMEXFD6Mu6M64+9aPtveV7pTZi++eL+gPYarfb2QP2y9rcLnPRA7BD7Yc9C9UGPHvHmQ1zyzV7u8VoyUPQa1ZjsPLXc99TP+vN19rbyknhE9uhhEvXUtLL1HCDs+az9fvXaW7T1e29o8QybAvWzDmj3cS+O88lcyvirJ5T15FQo+tmHePSKm1j3coIc9dSMjPrVvcDxpJZS9RmeMPaduobvyuDA+44W4O4EFsT3RCZI9lrefvY4xlbv0r769s+23PXh4qz2x9pw8nMdCvYR7mL3qUr69dWH/PWQwGj74gzM9EkeAPWe8zzwsYYq9Xcs4PiW/xj2zq709hqt/vgUFyDzC51M9wEQ7vCbWn7246LU9eCQ6vc5io7xb8oK78ioQvmhSBj75wAI+0LLePIqGNr2F2gw+S6OAPb7Kcj0cz52+PtCEPZukrr0meDU9W6YtPpd00T2W7va9swdYPGBVfLxAz30+BVO0vegmST4CxQE+WKGRu9DRYD5daca8BrT/PDlppb07zmS9YzNUPQI7Xz5L6rq7I+TSPSAWgzwZrtG77KYSPiqPFrxCUH29k84FPirDwTz2qp+9vO43vj8OJj5OWGm9Mbz/ver84LtuVW09rPuyPXCpEz4wie89pLUSPTbKdD1MkrS9awsCvRvZqDytrka9tCnWvWyNNL5jEUK+7NDvPbCTEb4FLqK+RX3xvLhxkr3wkiO+INcZPsnsBT3xYeO9YymVvP4hxL2rFM69QuCIPZlq5L2sYSY98F3ePZNtxz0k/wI+anqDPLbEorzoS4e8ca78OyXJFj5v0247tqBkvee3Cj3PoOU84WVgPI4y7jyjvpG8h80TPis7t7x04jc+LjnuvBHD4D1gTOM8aXs7Palttbwtf+y7mQGpvdEY7z3vvtW86AWdvYVbAT4W+j49DKg7u2035L3y8+894e5pPf7EdL1nYrG9f7UHPhYlsD3u7Tg+Fq8IPkmmGj5squ09HtIGvSKsST1S+ys+9sAPvex8Xj66iCy+4+E3volJqj0KQ5Y9Rg/NPQoCrT0LyJE9y1FWvZqdjT1e+yI9A6gOvnPhej5MGQo+rn2MO+yGrb5tWia+aPmyPThUOD2tJiC+9iN3Pu2Y1DyNJpK9ieouvoh0fT5A8s89rK+Kvm4SVbtRflU+Ze2wPNOLNb4KXAe+Cm+uvs5QDL7UKAk+2bedvddK8j48v7c9TtPUPWSDdb0/Ajq+uBAnvvlLyT79QIg8PdXLPp+MmD6m7+49flkNv77tzL4QBaM+8mcIvZj9erxRGa++BuxWPrblcb4iEra+T2x1vQUeSr4TcpG8PYo6PsCmyT0mCCW+6hefvgAsvD60DJK8470BPk96ebxrYS8+XdDxvT/6AT7+wdk9Vxa7PWHMjL0vsRe+mA4YPt1H9b3GbOu8QhOrPQYSiL3bBNa8e2uAvVit9r1WEUQ+CN6NvQnLSrzvs5Y9nyCWvaLhAb3fl4c9LQMMvdqIxj2RnVq+rFILPrAEdj1X2Ga+ppdKvXBWab6PjQk9uflPvrke470pRcG9h0JrPZAOdrxMYHc+tFM4vsf2hD73Px8+yLdXPdR/tr0MfwE+MJSQvaaHE74eKzA+lP20vXBliryuZVG+7FxBPfBnMb73eOu7ZuVAvWHQO72Pttc9CIWtPW/UYT2f+AS+M9f8PM/goL2hfb49c66ovXUv1D3HAY46isLbvJxQQj3Im4E+ec2SPQr2y70bmdY8a6grvc68wLu+A8I8WK9CvGVl4D1RFY29Hs6svMIlvjy9O4w+dSsAPmb1C75yngm+qAYPPs2Qzry7FGQ+yFSBvlICBT3wkkW9YQCEvToPwb0drcw9MsCtvaUqzr21ljI+sd+QPUaciT1B1qk8+TkRPq93BD3ZguY83Vazu+U9RT0f/se9k7eCPCchc71oFhs7kUs7Pr7mr72obUi+H7GiO21qvj2Q6zK+51BcveuR0b7tLzA99KwPvqMqDL6y5mY9sCJKPr2WHj2YY7C9tU6ZPf+h/rto+hw94sOOvmlWCz4rkra8Kjs9vplppj328Uo+uLIRPqE5sL2hNBa+zCxDvh6ZW72YO/o8SqHWvbmR+LwxtjM+SPgevtf7KL4xYAg+H66RPWL1Ej20e1q9TA83PkYaCz7B2gu9RGgJvmyFFz4cWrY9etDivcPBUr3y0m29eqydPfGykz0DnwE+TvxbvJUCNzu2d0k+l0OAvhF6KL55lkQ9NQg3PLlQl75+Dx29WIZIPo6eWr7PTzY9I/y0vUbaw72b0IM+GIfLvAY82juyKmI+I9i3PTheDT5SBIM9f/XlOuqTqr1gpBi++y0APZqsrzxfhgS+NtZFvTkvz7n4pBA98mKCvkZU+Lyv1ZW9ZdLEPCQ7ML1YRGw82mkNvdJAvb62Wu689TYnPlSEdT0IzvU9a887vscP2LyjlCW+ZGVcvKMKwj0Ngn28gOmOPECIaTwV1b89QbNBPfrQrLx841A+bpiQO3qqE71bDlY+vRzvvNexI72/h5a9gCxpvqLYBz64WjQ+KrkSvdaLRj6ab9I9kbgwvlM4+b3h6Jk+bFeLu+m6sTuxNpY+o6Mxvk4MQb7MHGC+WpjLPZzRtT3vsNE9R/KzPS5fSr0rThy+otMivoZC/j02Qqo9jx8TvtWJQz79glG9URravckDs77fCcK82GoZvgKYF75wnZw9i2O1PY0hOb3fW7g9eBu2u867gj3C+G+8LXA8vpsgjb173Jm+VSx1vajqob7RBXe9jvNFPi/bkL0Yy5I8vKOHPS9N1T2VAsA9bS2FvdWXqL3t3+q69/eRvbqynT1EnI89/G9nvRRtKb0yfJK99oKRPWA9hb195Co+0m1WvRLzo737WpU9G8esPUd8cDxy5fk91jZNPKlXBj4TBd09K44PPf/wOT7WssM91FsZvXvlgz2Dywu8aArcPU0/Qr1B/Ck98FqFPWOPMz6GYII7dTcrPc8Yjr335vq72jQXPjyBK71A4dI9tpCXPdZnoT3Ae9c84wWuPW0Zl71paZO8j5QSvYPX/jzYsZY9N0c3PFVkz7yHKKE8R9faPbcjoT3279M9wRzrPKvqFD5B6J89LrCvvedf0D0lAX0+glHZvCSQEL7Yw6I8T3gZPT8CwDvG3R49LJtWvg0QBr2R8hE8iCPePcAQxr0Rj/+9P8IOPiCfuL2U1MC9zwQZvvjUfryfVZo+tqLIOw3xKL4jkQ6+qM94viWAJT4fQvY93XAPvX5KBD1keaw8DvmYvW6lQr7hFTU+54OOPHWhML4BSAs9lsmlPSOm1z2Srd492RCHPENctD56y3I+cpOgPDg7F77TXDe+CjXgOVqRlL4R1888HsePPb0zl72Tbi2+FJJNvIEmJT0ZGMO9q2sNvk52DT0R8/49Sj5avubINj1KX7M9qyM+PhX3pT10nLo9RdBbvOvYtz4y7GC+YHI/PvZMqT3Cocg9zsKwPZduBz6QmNa8yp16vbM0Abu1w5Y9KC+pvUoAGz5PwYi9vMEnPct49D1VPgK+RIrpPf+/eb0qMJA9t4K4vbaz0Lu5gmI9N4AXPkePv7vRvJy9nX4BPpadnj2H/Yo91OVmPXLVi7uYRuu938ayPIUtjDzMqAO9kQxEvk8Hlz3Aavu8KuYyvh2J2r39nu291jVmvr/gvz2wkd28YtOyPRf39z25Hxe9/KzVPZ87KD50chS98orOvLndNj04t+694gsXPjjWoT25IAc+bxuNvYAr0T2ZVqU8isqKPvKFNz5S/bG+1fiuPaqFmjxMCcA9Bz1ePHHJ3z5yIaA+yjxaPd1nE7zo85u9wkWXvvTZOj5a6p+9FAOhvuPSob5DPJ8+5uRzPtqSOr7dlAI9O3CrPcOSxj0yqjO88sSdvpr6Bj6sRA8+xLqgva4TDT5523Q+UGOJvjUHZD29Dq09Jj8UvnF2LD0llCG/TMJZPXoqrL5JCrw+5LBEvvVV/jlfNRc+J2EzvTh/vD0/+aK7babyPYB7qD6XsTS+QMaqvWMQbT61U/w929x+PamObL03Zx29VakIvYV8QL6dwYG+eBIcPeItdz5NEBI9gyunvktF8b476Lo+nGkHPup58D0His69Q14KP8bBkL7D258+6UJrPlxzT71MYCW8vGfdPOMGDj4qkFo+GK4fPi9zpryf+RM8JlDavVMFbr6hw0M+zomrPIf6gzua8Pa9QdddvhvuyT00qOu8NV0QPsvcpL1WDik+b9lAPoTYgrwRX7O8zFBKPiq30T1cwlI9ISIPPiYjuT0QysO9bSeyPPjhuT3FWIy8GAbAPQ2+Lr0ffSC+DC1iPf3dA7wNcc89EMSKPcySDb75TIy9cDkAvcMjIj5nucW9LZ7WPNqWIj65C3y9vCaevaycaD2ZTBk9ZV4rvt0zaT7Uow09/KSdPS3rmD7TMoa+lAPKPforkL1tQhW+YZWzPcL0x72bR8E8MJUFPlTSP77sY9G8qTzCvjR5i75gfDW+zl0yvpgpHDtaJNu+Yb3wu8sGTz0hXRy+94r1PaWIaD6Fhmw+1zgZPbsirryR1hO9IvYLvY9ee7z4zNO9lWCEvcCo4z1+So49Nb7sPR1/7r5h0A69EBgAPoq7dz7+YK6+Qs6kvv2LBb6xuNe+WSyovFlSAT6F4d69cdw6vUffzj1DRKc9v6qevkRbijswYZM+bkGWPmg7nD7jQDI94+hkvrnTkb5W/H0+c6KuOlFwCTzIDxa9Bk/4PgafIj75VVY8VfmePVasjj7ad368dR+BvudkOj0ASwI+bX2qPawL5bxyzaY+yUypvPEihz6+CLS9rI1IPn2n2b1wSkY+ynUYvZv0uLzHkSO9Wji2Pfzinj3B4Q0+WI5qPR0umD2gz4Y7ImeSvUjndDsYD0o8gfOHvfk+zz0Z2v49QXAHPeMhJL4pY7a8XqAivFCQzjtOlAu7PAfpPEaZML30+L09EjTcPWz4Lz6wOOS8nNN+vWlv3DwWwjw9Adr5PRZDUDzB1MM9t9bEPSaCC7sTlkA+lh0wu5/rRj2mhSk+8E2OvOgAt70h0Em9LBAaPudGEL2/9QU+8uTzPdn5FLy8ZyY+Zr0NPiIDGb3sKco9Klfwu28qFb5ccYQ9sMeMPYAVmTti+yo+jbMJvp7rLb0ymwk9NWzivfPiYb0tGei9VnhfPX4W6j2cxKK997QfPkB6UztQQgo+QCmYPVcJhL3hosU9b9u7vGlmyD1Ej789uFl5PHKhpDw4Wp88ENWJvdoQHz7OU1a+/SLcPeBWMb1/NTE+KE5KPRPLJrv4sgY+CJHNParwpj0vTCq74bnXPT1Q4j3iffu8oqy6PZSbtr39/v29AxgQPd8Jzz3N8EC9MrKgPXeOazwG7Ji+gaSeOyask73kAQk9e1aqPRwCC71fyfo9ur1Uvapxur0jkpM9YSi+O/g/AT6tryU+t0bOPSdUxLyL0E2+O+G7vZTRKL4BFwM9IGlzPZ4kj765zUQ9rf16vGSLT71dYa07oyEYvo48ZT7T7rG9YdMBviJ8BD4OXT0+meYCPUL/uz2BTcE8csOWvKgPpz1vuBa+xLLvOhW7ej28q6y9mD8xPVvEKr68nUu9LTcEvPvfGr0rQKI9O12SvVf3rrz65lE9T14bPuhX4jmnxSY+DoUDPiK6FT74J8K9KJeMvS27Ij3wjrO97WFuu5JZYjzGLka+jPgVPl8l+r33+tg8/f/AvK7mZD2GBLa9oF2KvU5C+z3b8FS+oV8jvWMf2D0magc+lbTuvZ8/iL3pGeQ9VZmaPRwrhj1ORVS6bEvOvRTeXD1hEc+8AsLhPRrRXj4qy0Q9O5LdPFafBD7re4A9m3fMPTh+Wb3NKAE9Q4umvekRQT7aNsI97Gatum1Qdr1TiSw87IaUvVYLLjvto0c9pLVaPfvHJT2chjw9PLPtvXvyBD5YapU9wSQGPiVpCL5yARo9ktwoPvpPPD0qMgi9SW4PvAV3kz3xPiA+GOG1PQXRxryKggI+Wq49Pfk/Uj09eg29/bd5PboMq73Rj449dxSDPV6oIz0v2bs9QFMhPdsjkr3tFAS8swoTPigXHz5BZNi81Vr1PUuWYjupYjY+qSztPKWCar32WnC9sdkBvX7ewb3GWaQ9MvpMvqjMNL3sKkm9U1iTumHAxj31XI89+BNdvWLUIb0KM088A5s9vsd3Dj6diW08gGhJPvlgFT4tGuI9eiSzPZ0tkD2m+e+9pRjkvawL7r3cyMS6mMngvLRocD2kOug9Ia6ju4WqOD39RqG9VFiguw150j2oCte9YCzXvRNnJD57an490LcfPvJRpL1/Mng9x28SPnONZj2Lulg95IADPuLGmL20YPQ9/g9dvDko2L2Wvaw7R+zYPXD50r3DkEs+kSmPPXV5qL1wwuS8iWIePc1YQD0aIY49+qJTPWOSpLwOxF+8pMtPPDFYvz1pBBW+o8NjvZlv+z0hlhc+k2VXvVC6BD4/nra8ZOe3vQnovD17Psy9Elm3vQfGir71Dxk+mQmGvNK+Z72YbIC9lBs7vhq+Pz4tjhk+VrzFPQaWmjxNeZ89oI6gPRKj1r1n1La9oF0aPoS/OT05FIS9kz04PsigSbyRHiO9lyzPPBlzhT3fIzw+pTZnvd2j3j3NKfs9azzIPSD8Yz45USI+BaO8PNflND3TU/S9tQEMPMrpAz5AkIE8A5UfPZvXHj2Xp3I99ZxuPHGxEz5yVQW+HlX9PV4sp72MhZy9mJYFvnSKGz2uwte8EIwFvj+uvz1NR8k8KEorPhH9bT3vAJA8y+6CPc+BGT6if5y9nQwlvEggVLw6FEg9F2bsO5G5h76ytES+z/ZFveHwDr176A++8poIPthxFj4nToU8z6ASPlLFOb6ruPS9K17Qvni+Ij3kvF29wSSLvv3SP76TA3E90tShvsvKbj4jI6o9uR7yvbwb8D0qPA++uSFIPsG21L29aG2+Fv2Zu8gNQz5L85C6LjIdvR8je702fCg9L0fTPbIOOL71fIa+RDN5PtIkZL51X1A+llAdvA9K173+cxA+b01vPpAqFb0io6S+IeUevnx3sj0WfX89kczdvfxfJT4xHVA98cCzviaHCj54iDI+WbM4PZRmij4X0RU+1yooPdlwmb7pJRO9noGEvH8f4T1FRkw9MskPPryRNT4F9d497XMfvTFVhL2uaRK+9RpxPGgjDr3DOAc++7Q7PY6DOL1agiW+EvfoPUYbhDzuHeQ9K8sIPlCsn72Kw9k96SmDPEx7wjysnZY9PS15vGsAAzy9MM89dKTiPdEz7L1uwQo9SKDEPadX6LsnaFK+Vya6POlM0T0RT1k+rOymPZhvnz30gBQ73ZwZvR/V1L2B8+A8SQndPHKtqz343FC9QDc4PuzFer2h+9G6DRIVPmGztL1WXmy+p5osPQlCbz2a0cG9hXVjPNIJWDwLfDc9kCcHPl8znrsgXxm9tZjMvV6tVD0r2BI+ogKXvUR9sbx9uGK9K+QHPmxWlz2XcI885eVVvm0nir3kRuq8d5cRPv56qbydPiE+nOS3PVzzWT15stY93ds6PoCM+L3YiBS+QE1ePba5tL2hXQm+hni2PVrzE75TypO9HScVPvKBjr00HDA9dcPiPfUBlr0Te2k91IG2PZE9N747PmG+VWp3vlTPgD06Yvk7vfaxOxyW8zxTk7q9UFZoPGbzAT68Bos9CaLavOyvrLx2UL69RrqYPRNT6r2eXTq9pgbZvGyMpT7W+lm9SGOHvs8Yrzzadgy+tjsXv+bhFr5A2VS9MAMivr/zFL6Yhyo+KdTUvQeLY76hMbK+zVQNPqIWDLrSFwo+rwEzPjVf97wcTBa9PZBEvn4hoL70+i8+afMwPcStnj1f0R09AXAOPtXRLj57UCK9TbgePuAFsLt+x4A9lLvIvPm9XL3AkyO9eidUPQiclbxooSE+ZZlcPVkpvDu2YH49swrDPTL2qjy6Bow9DPOrvV9dDr0JfLc9XPPdPUJaZbydTW08uVnhvavl9jt76j0+lKC5vRJ7jb13sCo+wp3luiYS1j1Xt2U+yOOcPb5lJz3XBQ68nZlCvVgOkLxzBJU992OfPSDSDj0RKhW9/YUMvqE4Iz6JOik+EaTmvLa+gL0vfCs+QzUZPo1fXD0nkoM9oIk/PZXuNzxDgRc+QlzkPV3fAT6MRry8UWQYPUYE9b3LoxW+DqgGvhRp0z2SmKa9B2WLvl7nEDrAaJg9o5hTvJW09D10qEE77Q4xvHsMVj57pQA9joKLPRiPNz28rnU84m9mPq594D2DEU++EFj2vbloQz5rawE+02HbPRQCqL7RbAU9zilhPVqljz1XfmS+ovfSvbXYGD2PPNa9ifW2PT9bCr8mgIA+WkyTvTPynb67Vc09l+5kPOJUfr7adZg8BucKvhuSNL4j2vo8pATrva+4+r30s7A9DdhOvnckbD5biky+Sp3dPTnIIb4Ji969c9Q9vZtkvb1zVDU+PgkSvpji2LvdZMw9WMj9vQp3Kj5FeYY8mLeSPS2qPD61eq67l6RRvmeyEb7v7N49KceCvboIkb0aRte+VPWnvXGO271ILh89dkUqvZT9dD1eykI+rWqfvhwCj72YJwi+5MKoPTfjqL1emJc9KWlCuwvcQz4q3ry8RX8KPu8iUT74brW9vLsFPUK3Hj74CYE96AUXvqQNh7zWjIS913h7PWSW3L16qhi+w3wpPrOqAD2+k2Q6p4S3Pc00HT6TMbU7hdRlPqdczb0mR1E+kdR3PtMfDb3g9xc+7Nb4vJcVBr5QSRS+jPizvX/R9T02M629aLChPTkHgjx2aD8+7Cq+PHLqkj17Rbq85KyzOtheRr6h/yE9PDyRPV4UET6+WT0+JkCLvBVZ973rJLW9PaZmPbQUhz2cKCA+XNlRvpHIpTvSvP29lk+4PO9/KL5qEPu+11lOvVL4Dr6uw9293MnPPfAmaD3Ex669VDSzPdYiEr6GRH08eMEHuqIN9760yH0+vqUCvVm1gb2jqds9Ka+OvKsYhzs4FCk8EX7KPdyx3z2ks5S+1h2WPabHEj1EXmm+8UN4vVnBTb4lfiQ+3iSDvLmXp738Pzg9UqSuPcHOdz7JyOk9RWWSPp0t0b4ZZ/m9x4GdvF6/hz7Pdq29iBqAvdYIgj1yFYi+GCCsvYD8AL7u1e6+SM3Cvkv+Gz7D7hk+HrwWvssakb4lnUs9CVNTPju+UTuxvQQ9pAG6PahBuj4Z+jW+8qrHPmJhPLw6REu+9rMUvnlUpTpULze+wqhmPRNHmj2Ar7i9Cp4+PrvKxD3XUAe9uJ/GPeqXSr0VqpQ9cQCOvCo4zr3dbfI9vE5HvEwYD70hnLI9nFyLvQSDQz29vLo9mp91PeIyDD00AeE9QrkwvPdmBD4EOTy9cvOWPb8e8z3D4YA9xO9kPdRshj2qqJU9eM7Kvb81F7x5hsu8vFgLuzyhCb39OPk9JYokvSHo6zwIO5o9L+Rgu9JSnLx00p+7x9PzO5HC/T1EPvU9wzpPPIRGXL20wiG9Byj0vJqO9z0zaJY9E6fFPVfylj0vLls9xCfXvQFX5zyIGNq9BEYMPTH3+r3qku496ZoMPv/dNjxilH89UhuAvsOMwj27rFC8EmChPb4mCr7ZA2c9bdDqPaSxGT4xo7Q9tkKdvRf34D3+bbE9pJe7vAah2bsuQTI+9/rlPAbJlr3nyIG9qNaHvMS6Cj1Fx5a8ArsXPsnVObz0WBo7F4nNvUhPWL31nyk94TdGvLeqaT7k9Y091mEaPhpQ3z0DyLm8zv5nPABkiLwy6YM9RwK0PTloJj5t6nC9KHPJvTxi/z06nXG9tzbHO33nqz0q+dg8eRwdPjz0qLwx9xg9l6nwPTi2Ej0jozc9ndzwPU8jwr0GC2a9T5DJvKbLxz23FLK9i6SKPXnjwb2x/8K94qEOPsqfFD2GIEG9sYDaPG/xET3FQPE7dO6mvbepgb2TbF09/0auPbbpgz1lPOs9SVqvPMk3vr3KpvI8iCKivf54hL2fRzS+frEUvXupST1/aSq+wybhu8BHkj25wKy81okHvhbNnb1yDxq+Tu2ePeObHLtG6389PAlOPYBjgL2WWmi9d0GDvEl+qb1CKbY6uEZsvVam1737f8U9fLytuO38kb3Jjsu9qw2pvWkq+Ty7Crk9JaK4vfM8QTzJiAa+tue6PY9Mt7zug7e9YQTUPbN8Jz60OyS+mPOWvbm1fjy154S8d0Covdx8uL23zgg9H3YDux9sCD7iPIA9GqBNPrBjQb3L0zy9tno7vvDOQj3lmQM+ZQAlPTUB6DwlUpO95c39vXd2Pr1C9PK93T3RPVKFKL4MVXk7aTdhPajagjxu2zw9ZVcGvhPV6zxO70G96KrbvcMAhz3w2pu9q6WuvJqzFr7sXB88ZiDjPamvn7xPate9TAh1vrwze72LJoo94wMGvqe8Cb5nTRQ+Y/+iu6Rd+D1RGE4+810MvUQ1r722NHC8ELLsuz84FLyRYyM+ZjPHPEzpGD25vEm+SL15PLM05T0M9f+9314XvRChlD1ddYU+RXnfPHae5Tyc7Aa908AUvVY3UD2HJVq9ln/cuhlDOz7juis+5u2uvfsxbj4R1HU9VFmmPfzYpTrWIEG9+y6ZvVoMtz0fJA2+1QqPPPz+zz0FxEm9klOXPU3JrT0zsKq8CuwYPsmGyz3X2R2+6rcmPvMSsz25bvK8VNByPhwWl71yP6490WqMPRwlGDxnMM+9OPKCPuzSTT5+0M68vvn4PBXV3ryThzS+EaFXvNh4Zz14dSS+XTZYPaNU2j1HHKm+9yvJvOD9kj0/Czq91BqJPkvyoL0lGPQ9FHPXvcXwnj0DApy9rZDevQiCFr5zgmY+dM//Pdgx0L2HPUg+dY6/vcto0r2vO+c8kNgWPjksJz01fXO+bLE7PnGjC761GUC+Ex/ovIiN8DtRADC+ZnWMPfjCrDyneeo9eQF4vv/v7r05dng8aVZTPt9zB74cdVA+MdfBPU8vuT0zQ+Y9VSfPPMr+zTn1v2W9a9O+PHVy+byxYKK9cjuvvUsbVj0gCp097uz4Pe8O472oIJw9a7/vPdtf5Tw6gIs97lJTPbabAb75GWs9ThSoO7sE+T36tWo+GH8Avsb8vTx7COK52wblvU+Tqr0YMdk9DBMUvokpDb7PwJc9D5TFuwKMvb7Yeda9FjW6Ow5sJz32IyA+wjaJPbXBoL2iqeI870/bPTTM0T0Hqqg90LLIvWZLlj26m5k99RiGvJE4pD0Kw5899VZhvY4gxTzPCA+9o5AtvgSsCb3ZqLE9b7CiPI9yUzyUsL29nUKlPHUkJL4lGSg9opcWvrc77j0p0K88dz4GvgKcSb6J/dE7zgfdvSv5Ij7WyY69xjPZPR6bqj1DYBy+FfQdvDFOrz3afm+9X20tvgkAED6Ks/C7N8qIPeFpgz2Apgi+lbVevtH0+T2opwk+8h16PntmXz3SyrE92mOyPWHKFT6ZJaI8l5wUPlQVJz0frsg95LfZPTOEcr7896A9yjXjPeq2Mj6iSas9+T2vPZ4ENr4lih08gsQlPTbqID5mivo8lHX7PTcoK76He+o9bfgTPnwUt77hCrE9wRqAPA2o9T1q65e7im0GvGhsbLzwDQY9xt5lPWUjSL5jAOE9jRbjvXg5ILw2RVE9DOBPvqdroT6QdfM9bevtPVHnvj1E3/Q9xz6SvrKGB70oTso7GUmGPrPwgT3ZcAG/d9aVvVpAgD3gvIS++J1KPseXPr6YD4O8uYlxvZAcHj6DCQM9xqMnvpjalb2/3So+VS4vPfaXmT10+lo95ukkO9jAcD6eT8W+rR7gvIy07b4XZrw9oPTePe5ZXD4lH9e93ICPvv1s4T0iCAY+23DQPT/TmT3SmnS+tIOoPQedQD3FkcC9twJKPqNEobyTpcA8zPdvvqqO7j04H4i+AV8qvlivxr5Zko6+jd05vbhc4L4iJ1q+o/0lvio4MT0PWE++o/mDPG0gsz2zmHo92rP0PdvYVD4Xbn89dc+SPYKmJL4VPVA9cpnFuzQgHb6SmLg5j+GivYPGmD6I1Fo9xsChvrNXTjtiYJe+kNaKPpnqdb1z2129728FPu1bFL637Bk+gOSJughgyj0+aJy9UM3gPS/3+75xyHY9WjJ3vvwvCj3PY2o8LeK1Pqygur2mVmm9wVuDPeSMH75r3Cc9qwNpPqH7nT4TaXK9C3yRPZRPNz23eQI+toocvnK/er4yhWO+QF6PvmcUAD2d9wI91kG5PMnt3z0Cp9W97Fzzv/PC476brmC9q0YDvUtYQrsqiU4+jiGwvjcFqL5iNRw8PrMiv8tTrD35ykc9AblBPvResD23HNW9dqEOPjtFCrz5bx08JvITPr7ZoL1lbkw8cAkhPoWOu70yb7e99z0yvobHgz0m0bk9cygivkpw7r3jMgo+svYhvc5rwb3N+DU9Jf4SPNBw27zKR+69rJSavUVDXr2w0Zw90k9xPjo8GTyVqTe+JCW4PLdfOT33mcG7DvmSO+rz/DwnGtI9zXamPcCn9jw1xgG9Vo6pPJCrGL0ldJ48RJItPuR0AjyFr288VjsOPGg9V70OmEo9zpkNvVf2FT7m8iG9LCR/vHcB+TxM8YS91cAePgT+sr0Jlda8toLePAxuoL27sAc+eUW2Pd2Ppj2MmFE8odhHPR4mDz4nT6g9rWZbPsJDvTyS5wu9kZD2POhsuz35KT6+FBYNPRzmzbyY9kq9DTqkPVyvBL16Df48jQ/CPf2T4j0XnbM9HYI5vZFkub2UslI+vieuvSJHez27ya69NXuMvTFNGz6LgGK8PoE0PldqQD62mCk9GfOmvXdvsryih/g9YuM8vi0i7j33BF+98s2jPS3viT1uJOi6L5qfPZak/jx2nCa+nC0XPj42xz2zD6K8H1HhvN2Hjbx3nVQ9ZVquvS+HYz3Iqfq7ghyAPbw5iD1Quwo91m+QvU9LAL5xD8u8rBEKvfuglj387wO/36SLPQN4hLzVYYi93QC+PRAEhD1F54A+YU+pvWPGBD4VBsg9wBd1PXc8Bz40EeO9x1SZvbkpwT26UqQ9hNc3PS3e1j1DW8I9uuTSu9Jtib1LgMo6sVbnPbaSAT4lKGi9IIAoPs0BhD7ojF8+Ao/tvfRq8jxWpgS9XLslvWGQKTxYNaw9TD7AOmlYLb7RpGM9hZVzPYjnj76LTIY8jYMdPb0ocbzpe7Q8XbuHva2Ivr3BrzE+ErYqvVjWSz5digA+aLhyPfe1zrt2NXK9xHTpPYDPI74slGM9HYeNPMx4lj3d5ja72kTUvWg6OT32VwW+bmAhvmq1Gz5jDcQ9tED4vnUDAj5X9fk9ZihOPn7RMD0K5hC9pCOivEqT0L1ijKi9K2yKPaMtNDu3vRE/M/A/vfEaAb51s6q9s4gSvqvBlL2xSPG8TgghPUjjiD5WOEa970SMvZUafrxuA2k+y6cePv9thbuSXUA8JUvGvBkobj4H8i49KZrevGJ+Kb/NLzg9hQAEPAFyOT2k2Lc9yR1PPtxEd71dvia+AHLCPpfkK7yIR8A97+jDPfwIDb+7uWC96fUoPWbtJT8y71C+/OTkvJzMwb1pnEc9nUKdPBiXzLl3CcC+0cexvJHmHzzv4eS9+TaYPdKoJr8yBQK9usM0vl8xSr3F5Q49fA8lPq8H4TyIzG+82/iXPY6NK74N7IA+Ow2fPahDAD3QKsO9xhQePg5Gk717UPm9rHVCPYBcSz27NSE9tRQIvRZWqD3A6nG9BK/2PV6FYD3Bu6a9gt99PRF54T3njHC9308hvq7yRr1BD6A8rG/KuxKugb3zZYO9mOqUPS/ABz56fC69I4XTPeAUID40D1g9dVLZPUllDD7CiOy9a/tSvZJJCb3bDRC+eeuNPVjogLy0b4s9c/fWvNb/lz1SlWa9cxQvPbBPLz5kTsq9w6j2PagWQb2btFS98MswveU/Oz7tZrw9M1kAPqwWkL1KECq9X+15PbzpNr7Z65u8Hcy0PUMhlj3lyES9Xqk4POfcDD55Z6q8CmUDPv81vD0MPmU9rIQEvir40D33WM08WhCDPaMvuTw0oti8QiyZvsk9Dj72Abs95ZUdvgwotbydn0w9/0HRPg79vzwd1w++fDirvoRMabyT5Mm92qI8vvZllL1qN5w9tZc3vmRPuj3bMce9ytqIvstcoL2qzze/TDC6vHoUnb7CtNI84XDgvbLWgz4j6669n7p7PR+D7D3zt6c9EUXtPVldpD3NgKe9RePYvS1zjD3XEaM+LF8zvDXsIL68irO9EsaevbZTx71Hlca+3JTZvqN+0L0T+FA8LVQaPAhFMr+y1GQ8lcJzPVa5VzySRsW961wsPlZ+Jr5U3Iu9c7l/PtxRqb3aRhu9DGIxPiGa9T31ome9qB7bvWhwxzy+uDi96xe1PWNIVL1kf569SGKtvJLXyj1j5L898tKCvGd/WL1uUhu7R5y+vUouCD4vJbE9v5IHPn8LsD2cEa09IiIRPnts6L3spMG9RhmaPegu2j3D3009aLgUPrL69b10HS+9rKvcPXrwEr0HuQ0+UiyovGrBJrzn2yU99VUZPp0iJb3/XSQ9qSXvPKwxJDwKiPu8CzXBPZ4k2z03gSE+sqYNPgpxnj3Mdkq9oakXvECk+jrihKy7ZLcBvUj65L2WjiS+OGQkvVRykrud53s9ytjLveFLjD1760Y9QYaFvLhFhj2Ls588BRFEvWKCRD2MoE89ckQSPheu/z34+cG9IYG3PeGEfT2yN4I9S7dIPuzAuDxpcRQ9/f+OPEUKCr7hSge+AJMDPtIKjb0GrMC7ghCJvDA0HrzHN1c8EI+uPSSxNzmMSoC9ihIRPrNlkbnwIhk+Eo0TPRUiGj0uu+I9CeYsvfK1ED5Ctxo+gtzHvesmsb0R4b29JZM4PkWDGT5bOeS9xZANPA+MFD1r1eK9P19rPPmGx7sXdwK+/lLkvZA4br3RJAm+5lXePPZXTz2TjyE+lLCLPVsGbb6+F6w9KVxjvULooT1jaNI9LhuWvTS8772fN0y+GaMLPZSR2bwi8Xo8ZWECPcaSXT3D5QG+HyupvSshwTyfzhm9NuqWvi4Uiz6Rh4I7LG6TvYVwqD2qbpc9TtHNPQ4BQr37QqQ9R102Phz8Vz5yCz491FkGPfc/uz6gBhW+TzxpviMdFL+SBB69V4UXvi1f/b0ib1G+fgcNPtHXVLzvTYy9JrnNugG1Er34NCc9OalrPrhStzwCD6c+sXmPvo/oTDw+wHa+N0IRvTiU8T1EAQm+eiTtvipEWb3U+0E+vvf8vsF68L5yDy++z7DHvQDW6T0Au3a+Ln9IviN5Dr09Y4e+dZ8yPpNPob1/LTW8RcSIPIBtgj2VTga+KB1JvUFDKD66yyc+jHkFPr7SjD1d7Qy9MRI+vSzdMTxPABw9/v5GPRIFp7zX+EY9c3YVPnIYfz2KcQk9y0r6Pd4Kvr3pHts9Ag8pPhnHn73peQW++E0sPvNJhD6qwNo7EfrVPEq+r73a5j29ndsHviNR+L1tHtY9ARGavfCqH7yXlYg9yUVoPVeb+DyDo888gqQ4viWVFD03BKe+QKgyPaXhfTyAeD4+M+D3vWXDTr44hdM8Q5CvPTdugT2SeAM+gWtbPchSD72SQKQ8GRgGN32EIT4PK/u8Nne0PTP+mT1sP487zRd0u2vL9rx4Aca9NZf+vTOTqj3oJ/i9Yw3fvdLn7r5WNME9pimwPaFr7LxTcra9p8B0OxcIZj0VYZe99PCSvECHsz3zzwm8+8EHP0zTqby5Kn+9pZKQvZg2r70oRo29FNDGvcOwOr3sITE+UHMTvE5W8byHzqO9ZgqIPoyFbD46HHG9rcurvLZuRrxVXWw+eczsPecb/Lwv5XW/ehiOvLZ2qbxSNii9IrUEPZnTXT6nPji+28hovu+8lT47nQ2+QzALPprZaz2zdkK/4SuVvXwcgT3wJho//G5UvlwjxbwaTGq8xRw+Ozzg/TzBkX09VA3lvq1iwL1pzgQ+hGULvg2hoD2CAu6+FPSDvSG27b1ZIx++IiKgPVegTz6eLd47+PUOvZHwgT18+v29sh89PnB1/76jmAw91z7ZuwNVv77XPpK9QsA+PRH19j1g98a9pwkzvctGZT2bU0g8QT2YPVPyLr2Fbgs+zaNhvoVZxDx7yug75mpBPTHknT4/WZQ+pmh1vNlReD3pKFE+mwiSPhUCn73L1mi+SRJTPahLA77TSkM9rGWnPsPg6L3c0gi+yhZPPtXeGr65Bwu+482fvSdQVL1ZgV6+ndakvc6hZb4vaqy+0zWFt5Ht3r4iFSS+pvOnvqtP5r7aYtG+8TW9PcCwCT7wR3W9+1hivtTjEr4IhiQ+fpU5PobzgrwbRim+DsQhPvEb4DwsPS8+GhOTPn18Kz0wvaa+iFEZPnMSQL7NB/K8FI1oPmiOaT3RFhU+RELmPcWcJr7I4gm+g/LQPfMqnL4pH4G+frQuPZqzq7xLgpW9nsHbPVU5vb3LMNO9UEhKPnrSyz0jO7O9xhXoPMolfT55qp28x8H/N0dYpzwgOuU9VDhwvd2oRD5NEoA9qpoCPtfhTb6wp2++Y8ojvWF0Jj1HsFS9sJvTPdfYmL0LNW0+Zyp0vnAPAr3Vjug9PAEdPjPCc75C00I+e/9TPnvUIbzk6Sw+YL2DPlvXi726BjW+uCR4vhlzjr7HnJO83yslvbGsE77DB0O+RNSavZJMET6bcbY+yhygPdfF8b5raRw+zr/RPXeN7z3mfNY9HfGSvSeZgT3G5cM9/Q1+PInVizw6o4k81vMNvRZWIT7umx29EYScvAqdoz2BDdM9ECMzuxsQLjxHfM89aDCDPWtlRD0eLhU9QuWKvYIooz0l2OM9kAPXui/tkDqjJmQ9330FPlv51D2PY1G9aBfAOt40Xjv+q849ODhSvTwNkb1WBYi9uHGUvUbIW7039YE9zmvzu9JkQj5/8sw99mIVPaF3xD0n3gg+8KDbPbRMXL0DBYM8wwZ/PWxhP7pQO1w9OIKovWAycj2bgvM9lD1ZPKL/XDsV0oM8UYKgvScUCLzPZYQ8p5iXPYKVoT1NZAu+WuVDPlUOWz1pnNY9NH3sPQehgb0Ux2A+YZHLvWibMT6z64++2hM+vXpF9j0UQT8+b43hvRviFj5NkF4+w/7kPSjaPj2Lrsa8IdEBPSO+Yz7kGa89Fp11PJYV9T0RYPY9tV9cPtndEL0bZJE9xqcUPhM8BT5oCCO+OUztPd2UNr2yrDo+LMtAPshXyT3FAHQ8aB8kPga4wTy9cNK8lywAvfPJPj2Cl+49RTkUPpv9lT25ztq8Oz8DPU+F77yy0MA9aotmPffm8T2U3Sg+vQmJvVjHJr0zSpO+IVuBPQnpzTzBJ+W8gtQRvr4/Jz4bnUE9Pw0GPoz8Lz7ze/E8Xvn5O6W7rb75jLI+Ki8zPhbh+z0kAkW+aUxevrcYXT7Zm3++jFf4vtr5yDxy/oA+E8RdvlDbVj5Uvws8EPm2vvIhsr0xDVg+UVsNvvMoM768rLi9BfebuiWOhb6y5Bo+AYofPqtVdr4TjJQ+0oo3vhjESL3orIO+SfSXvgoQmL0/KxE/aU7LvQ/cbr03xYm+57IGvp6+Vb7hHg6+kdy2PhKBKr7zk9Q9R6ZJvs0yGD8Pq7S8swwoP+GXL76LUJA9NU8sPl2sVz35r1Q927aNvXdmCbx+6i4+L/yXPb1+BL6vd0a+DdWQvqEYB77/NM+9m2bRvVtpm72Pive9lOz3vbG2bL5Tays+SXFdPxF9ub6UGZ+9xALfvl0eaLzR5JU+4jTdO+Puhr7Sp2S+FbCLPh0VC74G/O0++ZsQvvLAGL53bJq+TXZ9PiomBb5lzM88KWnHOx0IOz1BuIm++pNlPixwPj4+iAS91UiSPpj1gL0UJQ6+KviJvjevtb46Uti9uFoGP4hEyL00SQG+G/9KvnaHr7yASa69YmE4vgDF5j5J+rG9uwBtPqQGmr2pegg/2wJtvtRCLj9VC4q9iK3kvWb6Cj2Pfa49niPWvYBaK77JmVi9ZZBTPqs8Or67TsW9vnakvTaLd75v9rm9Yzocvr5DB74OGji8wDcmvh0Bi75lU5A9w3gPPvFsLz9BT7K9u+IHvoKnpT0Mn+q9eJpsvdCNf74OVMs+obFBObyeIb8BFOi8soQnvnYc672C73m+WQiWvr8+G74yitc9qFSjvS2Mqb4Y7NG9V1CpPn+J9r2FXi6+P0DZvaVxNTwAnYq8V6CFPUjEYb1TrKo+n5RyPfjF1D7Goy2+HW0YvuTL071zP/69c4KBvmm2p77RxTK+4v9+viAlmT7sGTG+b1LWPFlo7L5hIgC/1MsbvrODDL6kL+E9YMdavEuQ0jt5v2I6lG0GvkC2Wr69aYk+I6BBPYFf9L0ro7C9LpqYPXd7Cr4RxAc+qkdJve2TO76ni6I9BbI9viERib0hVjo+xBnMvDinLL4MXa4+zfj0PcJxyL3vC/89z0OEPpNGJD257aa+fc+XvWv/M73Zyim+jEWLvtiAV73o80e+H6YDPgMVGL72CD2+y7oDvcSBpT5W/Di9hN06vldR2ztUuwC+mNpKvagoDz2UxI49zq+fPlgdQbvAocY+UWLnPDdPNb49fdi9RtJrPfXBp7yc6ou+kWb9vdVtUL5RVhE+SakRvoBqAj7X6hO/k8HMvqRpOD3FL6K92L1UPbuXrb0qhQu+h+/dvaA0h76Pi7y+Fd19Pj0RH769y6i++GQEvmnNMj7I5v+9PCupPrzsJL4BvT09RatXPsL8Gz4uDAm+rH//O7KSzL2LhPe9kxa7PlavHj2VXx6+YV0LPekpWr3C/QM+pajlvJWqD7s0rp++hgu5PBBFrTuKdj8804AEvmVfUD4ykRw8U8EiPHqunD3MhBQ+tcwZvoeLJr5Glpw9Z3Y2vjVX5Ly/9kk+daKYPVb2xT3wHAk+0syKvVhQYr3ytDc9Cd4lPQjfIbxCAWq9L6WMvYu5Xr6Zcm47PdRqvrEnvDxWUz6+6PUPvbg/T75S3hy8HD0ouzQCDr7N/gq+4konPjFtkT3ac++9VpuSvg2UqD4Yfxw9cL6Lvb+web36bR4/IkGDPfuGVz5jtl08dnY0vKA+kD6hb1y9UjsIvzw8aL59UW28quA3vU1t7r0YmJc7QvZjvWgmK7yqfRg9';

// 自带解码：比赛环境只承诺纯 JS，不依赖 atob 或 Buffer。
function decodeNet(text, inputs) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const lookup = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) lookup[alphabet.charCodeAt(i)] = i;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(text.length / 4 * 3 - padding);
  for (let i = 0, out = 0; i < text.length; i += 4) {
    const a = lookup[text.charCodeAt(i)], b = lookup[text.charCodeAt(i + 1)];
    const c = Math.max(0, lookup[text.charCodeAt(i + 2)]), d = Math.max(0, lookup[text.charCodeAt(i + 3)]);
    const word = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < bytes.length) bytes[out++] = (word >> 16) & 255;
    if (out < bytes.length) bytes[out++] = (word >> 8) & 255;
    if (out < bytes.length) bytes[out++] = word & 255;
  }
  const floats = new Float32Array(bytes.buffer);
  const { h1, h2, out } = NET_SHAPE;
  let at = 0;
  const take = size => floats.subarray(at, at += size);
  return { h1, h2, out, inputs, w1: take(h1 * inputs), b1: take(h1), w2: take(h2 * h1), b2: take(h2), w3: take(out * h2), b3: take(out) };
}

const VALUE_NET = decodeNet(NET_BASE64, FEATURES);

const feat = new Float64Array(FEATURES + 1);
const netHidden1 = new Float64Array(128), netHidden2 = new Float64Array(128), netOut = new Float64Array(8);
const context = new Float64Array(CTX_SIZE);
let contextView = context;
const topMiss = new Float64Array(3), topTime = new Float64Array(3), topCos = new Float64Array(3), topSin = new Float64Array(3), topMine = new Float64Array(3);

// 敌方多久后才有下一发：普通弹满额时取自己最老一颗的剩余寿命。
function reloadIn(tank, state) {
  if (tank.bulletsActive < P.maxBullets) return Math.max(0, tank.cooldown);
  let wait = P.bulletLifetime;
  for (const bullet of state.bullets) {
    if (bullet.ownerId === tank.id) wait = Math.min(wait, P.bulletLifetime - bullet.age);
  }
  return wait;
}

// 全部取本车坐标系，泛化到任意朝向与地图。ammo* 取打分所依据的时刻（可能早于当前位姿）。
function fillFeatures(x, y, a, forward, ex, ey, rawAngle, evx, evy, k, minAge, ownId, myActive, foeActive, foeReload, myReload, foeCool, time) {
  const dx = ex - x, dy = ey - y, d = Math.hypot(dx, dy) || 1, ux = dx / d, uy = dy / d;
  const bearing = Math.atan2(dy, dx), back = bearing + Math.PI;
  // 敌人朝向外推：假定它在 VALUE_STEP 内朝我转，受转速限制。
  const budget = P.turnSpeed * VALUE_STEP * STEP_TICKS * dt, err = wrap(back - rawAngle);
  const ea = rawAngle + clamp(err, -budget, budget);
  const rel = bearing - a, foeRel = back - ea;
  let i = 0;
  feat[i++] = Math.min(d, 600) / 300;
  feat[i++] = Math.min(d, 150) / 150;
  feat[i++] = Math.cos(rel);
  feat[i++] = Math.sin(rel);
  feat[i++] = Math.cos(foeRel);
  feat[i++] = Math.sin(foeRel);
  feat[i++] = clearSegment(x, y, ex, ey, P.bulletRadius) ? 1 : 0;
  const path = fieldTarget[cellIndex(x, y)];
  feat[i++] = path < 12 ? path / 12 : 1;
  feat[i++] = (P.maxBullets - myActive) / P.maxBullets;
  feat[i++] = (P.maxBullets - foeActive) / P.maxBullets;
  feat[i++] = Math.min(foeReload, 3) / 3;
  feat[i++] = Math.min(myReload, 3) / 3;
  feat[i++] = Math.min(foeCool, P.fireCooldown) / P.fireCooldown;
  feat[i++] = (evx * ux + evy * uy) / 150;
  feat[i++] = (-evx * uy + evy * ux) / 150;
  const mx = Math.cos(a) * forward, my = Math.sin(a) * forward;
  feat[i++] = forward / 150;
  feat[i++] = (mx * ux + my * uy) / 150;
  feat[i++] = (-mx * uy + my * ux) / 150;
  for (let r = 0; r < 8; r++) {
    const angle = a + r * Math.PI / 4;
    feat[i++] = castRay(x, y, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  for (let r = 0; r < 4; r++) {
    const angle = ea + r * Math.PI / 2;
    feat[i++] = castRay(ex, ey, Math.cos(angle), Math.sin(angle), tankR, 160) / 160;
  }
  // 站着不动时最紧迫的三颗炮弹：擦身距离、到达时间、来向、是否己方。
  topMiss.fill(Infinity);
  topTime.fill(1);
  topCos.fill(0);
  topSin.fill(0);
  topMine.fill(0);
  const last = Math.min(HORIZON - 1, k + VALUE_LOOK);
  let close = 0, count = 0;
  for (let j = 0; j < threatCount; j++) {
    if (thVirtual[j] || thAge[j] < minAge) continue;
    count++;
    let best = Infinity, at = k;
    const px = thX[j], py = thY[j], from = k < thFrom[j] ? thFrom[j] : k, to = last < thTo[j] ? last : thTo[j] - 1;
    for (let q = from; q <= to; q++) {
      const gx = px[q] - x, gy = py[q] - y, g2 = gx * gx + gy * gy;
      if (g2 < best) {
        best = g2;
        at = q;
      }
    }
    if (best === Infinity) continue;
    const miss = Math.sqrt(best), urgency = miss + (at - k) * 3;
    if (miss < 60) close++;
    let slot = -1;
    for (let t = 0; t < 3; t++) {
      if (urgency < topMiss[t] + (topTime[t] * VALUE_LOOK) * 3) {
        slot = t;
        break;
      }
    }
    if (slot < 0) continue;
    for (let t = 2; t > slot; t--) {
      topMiss[t] = topMiss[t - 1];
      topTime[t] = topTime[t - 1];
      topCos[t] = topCos[t - 1];
      topSin[t] = topSin[t - 1];
      topMine[t] = topMine[t - 1];
    }
    const nextQ = at + 1 < HORIZON ? at + 1 : at, prevQ = nextQ - 1;
    const heading = Math.atan2(py[nextQ] - py[prevQ], px[nextQ] - px[prevQ]) - a;
    topMiss[slot] = miss;
    topTime[slot] = (at - k) / VALUE_LOOK;
    topCos[slot] = Math.cos(heading);
    topSin[slot] = Math.sin(heading);
    topMine[slot] = thOwner[j] === ownId ? 1 : 0;
  }
  for (let t = 0; t < 3; t++) {
    feat[i++] = topMiss[t] === Infinity ? 1.5 : Math.min(topMiss[t], 120) / 80;
    feat[i++] = topTime[t];
    feat[i++] = topCos[t];
    feat[i++] = topSin[t];
    feat[i++] = topMine[t];
  }
  feat[i++] = close / 4;
  feat[i++] = count / 10;
  feat[i++] = Math.min(time, 60) / 60;
  // 道具与多人：双方武器与护盾、场上人数、第二名敌人、去对手那里的门口方向、最近的道具和地雷。
  const c = contextView;
  for (let q = 0; q < 7; q++) feat[i++] = c[q];
  feat[i++] = Math.min(c[7] - 1, 3) / 3;
  if (c[8] > 0) {
    const qx = c[9] - x, qy = c[10] - y, qd = Math.hypot(qx, qy) || 1, qa = Math.atan2(qy, qx) - a;
    feat[i++] = Math.min(qd, 600) / 300;
    feat[i++] = Math.cos(qa);
    feat[i++] = Math.sin(qa);
    feat[i++] = clearSegment(x, y, c[9], c[10], P.bulletRadius) ? 1 : 0;
    feat[i++] = Math.min(c[11], 3) / 3;
  } else {
    feat[i++] = 2;
    feat[i++] = 0;
    feat[i++] = 0;
    feat[i++] = 0;
    feat[i++] = 1;
  }
  const door = peekAngle(x, y, ex, ey) - a;
  feat[i++] = Math.cos(door);
  feat[i++] = Math.sin(door);
  feat[i++] = c[12] > 0 ? Math.min(Math.hypot(c[13] - x, c[14] - y), 300) / 300 : 1;
  feat[i++] = c[15] > 0 ? Math.min(Math.hypot(c[16] - x, c[17] - y), 200) / 200 : 1;
  return i;
}

// 候选之间相同的局面信息，每 Tick 算一次。
function captureContext(state, target) {
  const me = state.self, k = VALUE_STEP - 1;
  context.fill(0);
  context[0] = me.laserShots > 0 ? 1 : 0;
  context[1] = me.scatterShots > 0 ? 1 : 0;
  context[2] = me.mineCharges > 0 ? 1 : 0;
  context[3] = me.shield ? Math.min(me.shieldTime / P.shieldDuration, 1) : 0;
  if (target) {
    context[4] = target.laserShots > 0 ? 1 : 0;
    context[5] = target.scatterShots > 0 ? 1 : 0;
    context[6] = target.shield ? Math.min(target.shieldTime / P.shieldDuration, 1) : 0;
  }
  let alive = 0, second = null, gap = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive) continue;
    alive++;
    if (enemy === target) continue;
    const d = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (d < gap) {
      gap = d;
      second = enemy;
    }
  }
  context[7] = alive;
  if (second) {
    const track = mem.tracks.get(second.id), known = track && track.predicted;
    context[8] = 1;
    context[9] = known ? track.px[k] : second.x;
    context[10] = known ? track.py[k] : second.y;
    context[11] = reloadIn(second, state);
  }
  gap = Infinity;
  for (const powerup of state.powerups) {
    const d = Math.hypot(powerup.x - me.x, powerup.y - me.y);
    if (d < gap) {
      gap = d;
      context[12] = 1;
      context[13] = powerup.x;
      context[14] = powerup.y;
    }
  }
  gap = Infinity;
  for (const mine of mineHazards) {
    const d = Math.hypot(mine.x - me.x, mine.y - me.y);
    if (d < gap) {
      gap = d;
      context[15] = 1;
      context[16] = mine.x;
      context[17] = mine.y;
    }
  }
}

function netForward(net) {
  const n1 = net.h1, n2 = net.h2, w1 = net.w1, b1 = net.b1, w2 = net.w2, b2 = net.b2, w3 = net.w3, b3 = net.b3, inputs = net.inputs;
  for (let h = 0; h < n1; h++) {
    let sum = b1[h];
    const row = h * inputs;
    for (let f = 0; f < inputs; f++) sum += w1[row + f] * feat[f];
    netHidden1[h] = sum > 0 ? sum : 0;
  }
  for (let h = 0; h < n2; h++) {
    let sum = b2[h];
    const row = h * n1;
    for (let f = 0; f < n1; f++) sum += w2[row + f] * netHidden1[f];
    netHidden2[h] = sum > 0 ? sum : 0;
  }
  for (let o = 0; o < net.out; o++) {
    let sum = b3[o];
    const row = o * n2;
    for (let f = 0; f < n2; f++) sum += w3[row + f] * netHidden2[f];
    netOut[o] = sum;
  }
}

const sigmoid = v => 1 / (1 + Math.exp(-v));

// 候选在 VALUE_STEP 处的状态上估值；输出为代价（越高越差）。
let valueDie = 0, valueFear = 1;
function valueRisk(ci, state, target, track) {
  const me = state.self, at = ci * HORIZON + VALUE_STEP - 1, k = VALUE_STEP - 1, h = dt * STEP_TICKS;
  const x = rollX[at], y = rollY[at], a = rollA[at];
  const forward = ((x - rollX[at - 1]) * Math.cos(a) + (y - rollY[at - 1]) * Math.sin(a)) / h;
  fillFeatures(x, y, a, forward, track.px[k], track.py[k], target.angle, (track.px[k] - track.px[k - 1]) / h, (track.py[k] - track.py[k - 1]) / h,
    VALUE_STEP, 0, me.id, me.bulletsActive, target.bulletsActive, reloadIn(target, state), reloadIn(me, state), target.cooldown, state.time);
  netForward(VALUE_NET);
  valueDie = sigmoid(netOut[0]);
  return valueFear * (TUNE.valueDie1 * valueDie + TUNE.valueDie2 * sigmoid(netOut[1])) - TUNE.valueKill * sigmoid(netOut[3]);
}

// ---------- 候选轨迹 ----------

function objective(ci, plan) {
  const last = ci * HORIZON + HORIZON - 1;
  let value = 0;
  if (plan.field) {
    const end = goalDist(plan.field, plan.goalX, plan.goalY, rollX[last], rollY[last]);
    value += TUNE.progressWeight * (plan.startDist - end) / (HORIZON * moveStep);
  }
  if (plan.aimAngle !== null) {
    value -= (plan.duel ? TUNE.duelAimWeight : TUNE.aimWeight) * Math.abs(wrap(plan.aimAngle - candEndAngle[ci])) / Math.PI;
  }
  if (plan.keepAway > 0) {
    const gap = Math.hypot(rollX[last] - plan.keepX, rollY[last] - plan.keepY);
    if (gap < plan.keepAway) value -= TUNE.keepAwayWeight * (plan.keepAway - gap) / plan.keepAway;
  }
  return value;
}

// 走到候选中途再分支：还有多少条路躲得过场上来弹；若对手此刻朝我开火，又有多少条路躲得掉。
let escapeReal = 1, escapeShot = 1;
function escapeOdds(ci, foe) {
  const k0 = Math.min(HORIZON - 8, Math.max(2, Math.round(TUNE.escapeAt))), at = ci * HORIZON + k0 - 1;
  const x0 = rollX[at], y0 = rollY[at], a0 = rollA[at];
  const hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  const stride = P.bulletSpeed * dt * STEP_TICKS;
  let shotOn = false, ex = 0, ey = 0, ux = 0, uy = 0, reach = 0;
  if (foe) {
    const track = mem.tracks.get(foe.id);
    ex = track && track.predicted ? track.px[k0 - 1] : foe.x;
    ey = track && track.predicted ? track.py[k0 - 1] : foe.y;
    const gap = Math.hypot(x0 - ex, y0 - ey);
    if (gap > 1 && clearSegment(ex, ey, x0, y0, P.bulletRadius)) {
      shotOn = true;
      ux = (x0 - ex) / gap;
      uy = (y0 - ey) / gap;
      reach = gap + hitR + stride;
    }
  }
  let real = 0, shot = 0;
  for (let b = 0; b < BRANCHES.length; b++) {
    const branch = BRANCHES[b];
    sx = x0;
    sy = y0;
    sa = a0;
    let alive = true, dodged = true;
    for (let k = k0; k < HORIZON && alive; k++) {
      const i = k - k0;
      stepCoarse(i < branch[2] ? branch[0] : branch[3], i < branch[2] ? branch[1] : 0);
      for (let j = 0; j < threatCount; j++) {
        if (thVirtual[j] || k < thFrom[j] || k >= thTo[j]) continue;
        const dx = sx - thX[j][k], dy = sy - thY[j][k];
        if (dx * dx + dy * dy < hit2) {
          alive = false;
          break;
        }
      }
      if (shotOn && dodged) {
        const flown = P.muzzleOffset + stride * (i + 1);
        if (flown < reach) {
          const dx = sx - ex - ux * flown, dy = sy - ey - uy * flown;
          if (dx * dx + dy * dy < hit2) dodged = false;
        }
      }
    }
    if (alive) {
      real++;
      if (dodged) shot++;
    }
  }
  escapeReal = real / BRANCHES.length;
  escapeShot = shot / BRANCHES.length;
}

function escapeRisk(ci, plan) {
  if (candHit[ci] < HORIZON || escapeFoe === undefined) return 0;
  escapeOdds(ci, escapeFoe);
  const shut = 1 - escapeReal, exposed = 1 - escapeShot;
  return TUNE.escapeCost * shut * shut + TUNE.shotEscapeCost * exposed * exposed * (plan.duel ? TUNE.duelEscapeScale : 1);
}

function scoreCandidate(ci, me, plan) {
  const base = ci * HORIZON;
  const hitR = tankR + P.bulletRadius + 0.5, softR = hitR + mem.margin;
  const hit2 = hitR * hitR, soft2 = softR * softR;
  const laserR = tankR + 3, laser2 = laserR * laserR;
  const lootR = tankR + P.powerupRadius + 1, loot2 = lootR * lootR;
  const shieldSteps = me.shield ? me.shieldTime / (dt * STEP_TICKS) : 0;
  const zone2 = TUNE.zoneRadius * TUNE.zoneRadius;
  let hitStep = HORIZON, soft = 0, virtual = 0, laser = 0, trample = 0, zone = 0;
  for (let k = 0; k < HORIZON && hitStep === HORIZON; k++) {
    const x = rollX[base + k], y = rollY[base + k], fade = 1 - k / (HORIZON * 2);
    for (let j = 0; j < threatCount; j++) {
      if (k < thFrom[j] || k >= thTo[j]) continue;
      const dx = x - thX[j][k], dy = y - thY[j][k], d2 = dx * dx + dy * dy;
      if (d2 >= soft2) continue;
      if (thVirtual[j]) {
        // 炮口线越快打到越危险：0.3 秒内几乎来不及躲。
        const urgent = k < 10 ? fade * (1 + (10 - k) * 0.6) : fade;
        if (d2 < hit2 && urgent > virtual) virtual = urgent;
      } else if (d2 < hit2) {
        hitStep = k;
      } else {
        const graze = (softR - Math.sqrt(d2)) / mem.margin * fade;
        if (graze > soft) soft = graze;
      }
    }
    for (let z = 0; z < zoneEnemies.length; z++) {
      const dx = x - zoneEnemies[z].x, dy = y - zoneEnemies[z].y;
      if (dx * dx + dy * dy < zone2 && fade > zone) zone = fade;
    }
    for (let m = 0; m < mineHazards.length; m++) {
      const mine = mineHazards[m];
      if (k < mine.armStep) continue;
      const dx = x - mine.x, dy = y - mine.y, d2 = dx * dx + dy * dy;
      if (d2 < mine.trigger2) hitStep = k;
      else if (d2 < mine.blast2 && fade > soft) soft = fade; // 敌人随时引爆：要逃，但不算必中。
    }
    if (k < LASER_STEPS) {
      for (let s = 0; s < laserSegCount; s++) {
        const b = s * 5;
        if (laserSegs[b + 4] > laser && segDist2(x, y, laserSegs[b], laserSegs[b + 1], laserSegs[b + 2], laserSegs[b + 3]) < laser2) {
          laser = laserSegs[b + 4];
        }
      }
    }
    for (let t = 0; t < trampleSpots.length; t++) {
      const dx = x - trampleSpots[t].x, dy = y - trampleSpots[t].y;
      if (dx * dx + dy * dy < loot2) trample = 1;
    }
  }
  const threat = plan.duel ? TUNE.duelThreatScale : 1;
  let risk = soft * TUNE.softCost + virtual * TUNE.virtualCost * threat + laser * TUNE.laserCost + trample * TUNE.trampleCost + zone * TUNE.zoneCost * threat;
  if (hitStep < HORIZON) {
    risk += (hitStep < shieldSteps ? TUNE.shieldedHitCost : TUNE.hitCost) * (2 - hitStep / HORIZON);
  }
  candRisk[ci] = risk;
  candHit[ci] = hitStep;
  candCost[ci] = risk - objective(ci, plan);
}

function storeStep(base, k) {
  rollX[base + k] = sx;
  rollY[base + k] = sy;
  rollA[base + k] = sa;
  if (k === PRESS_STEPS - 1) candPress[(base / HORIZON) | 0] = pressCount;
}

// 既定计划：闭环跟随路径或转向瞄准，首步转向按单 Tick 量化。
function rolloutPlan(ci, me, plan) {
  const base = ci * HORIZON;
  let waypoint = 0;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  pressCount = 0;
  planWantPx = 0;
  planWantRad = 0;
  steerDir = mem.steerDir;
  for (let k = 0; k < HORIZON; k++) {
    const quantum = k === 0 ? turnStep / STEP_TICKS : turnStep;
    let move, turn;
    if (plan.kind === 'aim' || pathN === 0) {
      move = plan.move;
      turn = clamp(wrap(plan.faceAngle - sa) / quantum, -1, 1);
    } else {
      while (waypoint < pathN - 1 && Math.hypot(pathX[waypoint] - sx, pathY[waypoint] - sy) < TUNE.waypointReach) waypoint++;
      steer(pathX[waypoint], pathY[waypoint], quantum);
      move = steerMove;
      turn = steerTurn;
    }
    if (k === 0) {
      candMove[ci] = move;
      candTurn[ci] = turn;
      mem.steerDir = steerDir;
    }
    if (k < BLOCK_STEPS) {
      planWantPx += Math.abs(move) * (move < 0 ? P.reverseSpeed : P.moveSpeed) * dt * STEP_TICKS;
      planWantRad += Math.abs(turn) * turnStep;
    }
    stepTank(move, turn);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
}

// 模型看到计划走不动：转向或前进被顶住，或炮管一路顶着墙。
function planBlocked(me) {
  const at = BLOCK_STEPS - 1, ratio = TUNE.planFreeRatio;
  const gotPx = Math.hypot(rollX[at] - me.x, rollY[at] - me.y), gotRad = Math.abs(wrap(rollA[at] - me.angle));
  return (planWantPx > 12 && gotPx < planWantPx * ratio) || (planWantRad > 0.35 && gotRad < planWantRad * ratio) || candPress[0] > TUNE.pressSteps;
}

// 候选结束时炮口是否隔着墙对着近处的敌人。正在执行跳弹瞄准解的不算。
function wallLocked(ci, plan, track) {
  const at = ci * HORIZON + VALUE_STEP - 1, k = VALUE_STEP - 1;
  const x = rollX[at], y = rollY[at], a = rollA[at], dx = track.px[k] - x, dy = track.py[k] - y, gap = Math.hypot(dx, dy);
  if (gap > TUNE.lockRange || Math.abs(wrap(Math.atan2(dy, dx) - a)) > 0.25) return false;
  if (plan.aim && Math.abs(wrap(plan.aim.angle - a)) < 0.06) return false;
  return !clearSegment(x, y, x + Math.cos(a) * gap, y + Math.sin(a) * gap, P.bulletRadius);
}

// 候选前 0.4 秒的实际位姿变化，0 表示一动不动。
function candShift(ci, me) {
  const at = ci * HORIZON + VALUE_STEP - 1;
  return clamp(Math.hypot(rollX[at] - me.x, rollY[at] - me.y) / 30, 0, 1);
}

function candFreedom(ci, me) {
  const at = ci * HORIZON + VALUE_STEP - 1;
  return clamp(candShift(ci, me) + Math.abs(wrap(rollA[at] - me.angle)), 0, 1);
}

function addManeuver(me, plan, m1, t1, hold, m2) {
  if (candCount >= MAX_CANDIDATES) return;
  const ci = candCount++, base = ci * HORIZON;
  candMove[ci] = hold > 0 ? m1 : m2;
  candTurn[ci] = hold > 0 ? t1 : 0;
  specKnown[ci] = 1;
  specM1[ci] = m1;
  specT1[ci] = t1;
  specHold[ci] = hold;
  specM2[ci] = m2;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  pressCount = 0;
  for (let k = 0; k < HORIZON; k++) {
    if (k < hold) stepTank(m1, t1);
    else stepTank(m2, 0);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
  scoreCandidate(ci, me, plan);
}

function addAimManeuver(me, plan, move, angle) {
  if (candCount >= MAX_CANDIDATES) return;
  const ci = candCount++, base = ci * HORIZON;
  specKnown[ci] = 0;
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  pressCount = 0;
  for (let k = 0; k < HORIZON; k++) {
    const turn = clamp(wrap(angle - sa) / (k === 0 ? turnStep / STEP_TICKS : turnStep), -1, 1);
    if (k === 0) {
      candMove[ci] = move;
      candTurn[ci] = turn;
    }
    stepTank(move, turn);
    storeStep(base, k);
  }
  candEndAngle[ci] = sa;
  scoreCandidate(ci, me, plan);
}

// 含“先转后走”：履带只能沿车头动，垂直弹道前往往要先转向。
function generateCandidates(me, plan) {
  if (candidatesReady) return;
  candidatesReady = true;
  const turns = workScale >= 0.5 ? [1, -1, 0.5, -0.5] : [1, -1];
  for (const move of [1, -1, 0]) addManeuver(me, plan, move, 0, HORIZON, move);
  for (const turn of turns) {
    for (const hold of [5, 12]) {
      addManeuver(me, plan, 1, turn, hold, 1);
      addManeuver(me, plan, -1, turn, hold, -1);
      addManeuver(me, plan, 0, turn, hold, 1);
      addManeuver(me, plan, 0, turn, hold, -1);
    }
  }
  if (plan.aimAngle !== null) {
    for (const move of [0, 1, -1]) addAimManeuver(me, plan, move, plan.aimAngle);
  }
  if (plan.foeSeen) {
    for (const move of [0, 1, -1]) addAimManeuver(me, plan, move, plan.peek);
  }
  // 上一 Tick 选中的机动继续走它的剩余部分：规划的轨迹才是实际执行的轨迹。
  if (mem.contOn) {
    contIndex = candCount;
    if (mem.contHold > 0) addManeuver(me, plan, mem.contM1, mem.contT1, mem.contHold, mem.contM2);
    else addManeuver(me, plan, mem.contM2, 0, HORIZON, mem.contM2);
  }
}

// 脱困：选一个模型认为挪得开的方向，然后坚持走完，不再每 Tick 重选。
// 每 Tick 重选正是抽搐的来源：墙角上一步前进把车头撞回去，下一步又转回来。
function addEscape(me, plan) {
  if (mem.needEscape) {
    mem.needEscape = false;
    let best = -Infinity;
    for (let e = 0; e < ESCAPES.length; e++) {
      const move = ESCAPES[e][0], turn = ESCAPES[e][1], ci = candCount;
      if (move === mem.banMove || ci >= MAX_CANDIDATES) continue;
      addManeuver(me, plan, move, turn, ESCAPES[e][2], move);
      const score = candShift(ci, me) - (candHit[ci] < HORIZON ? 1 : 0) - e * 0.01;
      if (score > best) {
        best = score;
        mem.escM = move;
        mem.escT = turn;
        mem.escHold = ESCAPES[e][2];
      }
    }
    mem.escX = me.x;
    mem.escY = me.y;
  }
  const ci = candCount;
  addManeuver(me, plan, mem.escM, mem.escT, Math.ceil(mem.escHold), mem.escM);
  mem.escHold = Math.max(0, mem.escHold - 1 / STEP_TICKS);
  return ci;
}

let escapeFoe;
function generateRescue(me, plan) {
  for (const turn of [1, -1]) {
    for (const hold of [2, 3, 4, 7, 9]) {
      addManeuver(me, plan, 1, turn, hold, 1);
      addManeuver(me, plan, -1, turn, hold, -1);
      addManeuver(me, plan, 0, turn, hold, 1);
      addManeuver(me, plan, 0, turn, hold, -1);
      addManeuver(me, plan, 1, turn, hold, -1);
      addManeuver(me, plan, -1, turn, hold, 1);
    }
  }
}

function chooseMotion(state, plan) {
  const me = state.self;
  let foe = null, nearest = Infinity;
  for (const enemy of state.enemies) {
    if (!enemy.alive || !armedWithin(enemy, state, 0.6)) continue;
    const gap = Math.hypot(enemy.x - me.x, enemy.y - me.y);
    if (gap < nearest) {
      nearest = gap;
      foe = enemy;
    }
  }
  if (nearest > 340) foe = null;
  let realThreats = 0;
  for (let j = 0; j < threatCount; j++) if (!thVirtual[j]) realThreats++;
  escapeFoe = foe || realThreats > 0 ? foe : undefined;
  candCount = 1;
  candidatesReady = false;
  contIndex = -1;
  specKnown[0] = 0;
  rolloutPlan(0, me, plan);
  scoreCandidate(0, me, plan);
  const planEscape = escapeRisk(0, plan);
  candRisk[0] += planEscape;
  candCost[0] += planEscape;
  const unsticking = state.time < mem.unstickUntil;
  const valueTarget = VALUE_NET && mem.targetId !== null ? state.enemies.find(enemy => enemy.id === mem.targetId) : null;
  const valueTrack = valueTarget ? mem.tracks.get(valueTarget.id) : null;
  const useValue = !!(valueTrack && valueTrack.predicted);
  const pressure = idlePressure(state), assault = state.time < mem.assaultUntil;
  valueFear = 1 - TUNE.idleFearDrop * pressure;
  let planValue = 0, planDie = 0;
  if (useValue) {
    planValue = valueRisk(0, state, valueTarget, valueTrack);
    planDie = valueDie;
  }
  let chosen = 0;
  const blocked = planBlocked(me);
  const calm = candHit[0] >= HORIZON && (assault || (pressure === 0 && candRisk[0] < TUNE.calmCost && planDie < TUNE.valueCalm));
  if (unsticking || blocked || !calm) {
    generateCandidates(me, plan);
    let anySafe = false;
    for (let ci = 0; ci < candCount && !anySafe; ci++) anySafe = candHit[ci] >= HORIZON;
    if (!anySafe) generateRescue(me, plan);
    const escapeCi = unsticking ? addEscape(me, plan) : -1;
    if (unsticking) candCost[0] += TUNE.hitCost;
    const spur = !unsticking && blocked ? TUNE.freedomCost : 0, idle = pressure * TUNE.idleCost;
    const lastMove = mem.lastMove, lastTurn = mem.lastTurn;
    for (let ci = 0; ci < candCount; ci++) {
      let cost = candCost[ci] + TUNE.pressCost * Math.min(candPress[ci] / (PRESS_STEPS * STEP_TICKS), 1);
      if (ci === contIndex || (ci === 0 && mem.lastCandidate === 0)) cost -= TUNE.commitBonus;
      if (ci === escapeCi) cost -= TUNE.escapeCommit;
      if (spur > 0) cost += spur * (1 - candFreedom(ci, me));
      const move = candMove[ci], turn = candTurn[ci];
      if (move * lastMove < 0 || (turn * lastTurn < 0 && Math.abs(turn) > 0.3 && Math.abs(lastTurn) > 0.3)) cost += TUNE.flipCost;
      if (idle > 0) cost += idle * (1 - candShift(ci, me));
      if (useValue && candHit[ci] >= VALUE_STEP) {
        cost += ci === 0 ? planValue : valueRisk(ci, state, valueTarget, valueTrack);
        if (wallLocked(ci, plan, valueTrack)) cost += TUNE.lockCost;
      }
      rankCost[ci] = cost;
      rankOrder[ci] = ci;
    }
    // 插入排序：候选不足 64 个，且大多已近乎有序。
    for (let i = 1; i < candCount; i++) {
      const ci = rankOrder[i], cost = rankCost[ci];
      let j = i - 1;
      while (j >= 0 && rankCost[rankOrder[j]] > cost) {
        rankOrder[j + 1] = rankOrder[j];
        j--;
      }
      rankOrder[j + 1] = ci;
    }
    let best = Infinity;
    for (let i = 0; i < candCount; i++) {
      const ci = rankOrder[i];
      let cost = rankCost[ci];
      if (cost >= best) break;
      if (ci !== 0) {
        const extra = escapeRisk(ci, plan);
        candRisk[ci] += extra;
        cost += extra;
      }
      if (cost < best) {
        best = cost;
        chosen = ci;
      }
    }
  }
  mem.contOn = specKnown[chosen] === 1;
  if (mem.contOn) {
    mem.contM1 = specM1[chosen];
    mem.contT1 = specT1[chosen];
    mem.contHold = specHold[chosen] - 1 / STEP_TICKS;
    mem.contM2 = specM2[chosen];
  }
  return {
    ci: chosen,
    move: candMove[chosen],
    turn: candTurn[chosen],
    doomed: candHit[chosen] < 12 && !me.shield,
  };
}

// ---------- 开火 ----------

// 对手全部闪避动作里，有多少逃不过这一发（含场上已有的弹）。
function caughtFraction(enemy, pellets, limit) {
  const hitR = tankR + P.bulletRadius, hit2 = hitR * hitR;
  let caught = 0;
  for (let m = 0; m < MANEUVERS.length; m++) {
    const move = MANEUVERS[m][0], turn = MANEUVERS[m][1], hold = MANEUVERS[m][2];
    let hit = false;
    sx = enemy.x;
    sy = enemy.y;
    sa = enemy.angle;
    for (let k = 0; k < limit && !hit; k++) {
      stepTank(move, k < hold ? turn : 0);
      for (let p = 0; p < pellets && !hit; p++) {
        const dx = sx - shotX[p][k], dy = sy - shotY[p][k];
        if (dx * dx + dy * dy < hit2) hit = true;
      }
      if (k < HORIZON) {
        for (let j = 0; j < threatCount && !hit; j++) {
          if (thVirtual[j] || thOwner[j] === enemy.id || k >= thTo[j]) continue;
          const dx = sx - thX[j][k], dy = sy - thY[j][k];
          if (dx * dx + dy * dy < hit2) hit = true;
        }
      }
    }
    if (hit) caught++;
  }
  return caught / MANEUVERS.length;
}

// 命中率 =（不躲时）预测轨迹是否被打中 与（会躲时）无处可逃比例 的加权，权重由闪避账本学习。
function shotOdds(enemy, track, pellets, steps) {
  const hitR = tankR + P.bulletRadius - 1, hit2 = hitR * hitR;
  let hitStep = -1, near = Infinity, nearStep = 0;
  for (let k = 0; k < steps && hitStep < 0; k++) {
    for (let p = 0; p < pellets; p++) {
      const dx = shotX[p][k] - track.px[k], dy = shotY[p][k] - track.py[k], d2 = dx * dx + dy * dy;
      if (d2 < near) {
        near = d2;
        nearStep = k;
      }
      if (d2 < hit2) {
        hitStep = k;
        break;
      }
    }
  }
  shotPredicted = hitStep >= 0;
  shotSteps = (hitStep >= 0 ? hitStep : nearStep) + 8;
  if (hitStep < 0 && near > 2500) return 0;
  const limit = Math.min(steps, shotSteps);
  let odds = (1 - track.dodge) * (shotPredicted ? 1 : 0) + track.dodge * caughtFraction(enemy, pellets, limit);
  if (enemy.shield && enemy.shieldTime > limit * STEP_TICKS * dt) odds *= 0.6;
  return odds;
}

function shotHitsRollout(ci, pellets) {
  const base = ci * HORIZON, hitR = tankR + P.bulletRadius + 1, hit2 = hitR * hitR;
  for (let k = 0; k < HORIZON; k++) {
    for (let p = 0; p < pellets; p++) {
      if (k < shotFrom[p]) continue;
      const dx = rollX[base + k] - shotX[p][k], dy = rollY[base + k] - shotY[p][k];
      if (dx * dx + dy * dy < hit2) return true;
    }
  }
  return false;
}

// 开火后必须至少还有一条既躲得开场上来弹、也躲得开这发回弹的路。
function canSurviveShot(me, plan, motion, pellets) {
  if (!shotHitsRollout(motion.ci, pellets)) return true;
  generateCandidates(me, plan);
  for (let ci = 0; ci < candCount; ci++) {
    if (candHit[ci] >= HORIZON && !shotHitsRollout(ci, pellets)) return true;
  }
  return false;
}

function laserVictim(state, x, y, angle) {
  const n = traceLaser(x, y, angle), hitR2 = (tankR - 1) * (tankR - 1), selfR2 = (tankR + 2) * (tankR + 2);
  for (let i = 0; i + 1 < n; i++) {
    let first = null, firstT = Infinity;
    for (const enemy of state.enemies) {
      if (!enemy.alive) continue;
      if (segDist2(enemy.x, enemy.y, laserX[i], laserY[i], laserX[i + 1], laserY[i + 1]) < hitR2 && segT < firstT) {
        firstT = segT;
        first = enemy;
      }
    }
    // 第一段忽略射手，反弹段可自伤。
    if (i > 0 && segDist2(x, y, laserX[i], laserY[i], laserX[i + 1], laserY[i + 1]) < selfR2 && segT < firstT) return state.self;
    if (first) return first;
  }
  return null;
}

function fireThreshold(state, scatter, victim) {
  const ladder = TUNE.fireLadder, me = state.self;
  let need = ladder[Math.min(me.bulletsActive, ladder.length - 1)];
  const distance = Math.hypot(victim.x - me.x, victim.y - me.y);
  const scarce = !scatter && me.laserShots === 0 && me.bulletsActive >= P.maxBullets - TUNE.reserveBullets;
  // 保命弹只留给近身：对手一旦贴到瞬杀圈，先开火的人赢。
  if (scarce) return distance < TUNE.lastShotRange ? TUNE.lastShotOdds : 2;
  if (distance < TUNE.fireCloseRange) need = Math.min(need, TUNE.closeNeed);
  if (scatter) need *= 0.8;
  return need * (1 - 0.4 * urgency(state)) * (1 - TUNE.idleFireDrop * idlePressure(state));
}

function chooseFire(state, plan, motion) {
  const me = state.self;
  // 冷却在移动阶段先扣减，剩余不超过一个 Tick 时本 Tick 就能打。
  if (me.cooldown > dt) return false;
  const laser = me.laserShots > 0, scatter = !laser && me.scatterShots > 0;
  if (!laser && !scatter && me.bulletsActive >= P.maxBullets) return false;
  // 射击发生在本 Tick 转向和移动之后。
  sx = me.x;
  sy = me.y;
  sa = me.angle;
  tickTank(motion.move, motion.turn);
  const fireX = sx, fireY = sy, fireAngle = sa;
  if (laser) {
    const victim = laserVictim(state, fireX, fireY, fireAngle);
    return victim !== null && victim !== me && !(victim.shield && victim.shieldTime > 0.2);
  }
  const pellets = scatter ? Math.min(P.scatter.pellets, MAX_PELLETS) : 1;
  const steps = Math.max(30, Math.round(SHOT_STEPS * workScale));
  const graceSteps = Math.ceil(P.selfHitGrace / (dt * STEP_TICKS));
  for (let p = 0; p < pellets; p++) {
    const angle = fireAngle + (scatter ? (p - (pellets - 1) / 2) * P.scatter.spreadAngle : 0);
    const dx = Math.cos(angle), dy = Math.sin(angle), out = muzzleDistance(fireX, fireY, dx, dy);
    tracePath(fireX + dx * out, fireY + dy * out, dx * P.bulletSpeed, dy * P.bulletSpeed, STEP_TICKS, steps, shotX[p], shotY[p]);
    shotFrom[p] = Math.min(firstBounce(steps), graceSteps);
  }
  let odds = 0, victim = null, predicted = false, flight = 0;
  for (const enemy of tracked) {
    const value = shotOdds(enemy, mem.tracks.get(enemy.id), pellets, steps);
    if (value > odds) {
      odds = value;
      victim = enemy;
      predicted = shotPredicted;
      flight = shotSteps;
    }
  }
  if (!victim || odds < fireThreshold(state, scatter, victim)) return false;
  // 反正躲不掉时换命，否则先保证自己不被这发回弹打死。
  if (!motion.doomed && !canSurviveShot(me, plan, motion, pellets)) return false;
  mem.pendingShot = {
    targetId: victim.id,
    dueTick: state.tick + flight * STEP_TICKS,
    predicted,
    shielded: victim.shield,
  };
  return true;
}

// ---------- 布雷 ----------

function chooseMine(state, motion) {
  const me = state.self, mine = P.mine;
  if (me.mineCharges <= 0 || me.deployCooldown > dt) return false;
  const tail = 29;
  const tailX = me.x - Math.cos(me.angle) * tail, tailY = me.y - Math.sin(me.angle) * tail;
  for (const hazard of mineHazards) {
    if (Math.hypot(hazard.x - tailX, hazard.y - tailY) < mine.triggerRadius) return false;
  }
  // 布防时自己必须已离开爆炸圈。
  const armStep = Math.min(HORIZON - 1, Math.ceil(mine.armDelay / (dt * STEP_TICKS)));
  const at = motion.ci * HORIZON + armStep;
  if (Math.hypot(rollX[at] - tailX, rollY[at] - tailY) < mine.blastRadius + 4) return false;
  if (me.mineHoldTime < 0.6) return true;
  // 敌人预计在布防后经过这里才值得放。
  for (const enemy of tracked) {
    const track = mem.tracks.get(enemy.id);
    for (let k = armStep; k < PRED_STEPS; k++) {
      if (Math.hypot(track.px[k] - tailX, track.py[k] - tailY) < mine.triggerRadius - 4) return true;
    }
  }
  return false;
}

// ---------- 入口 ----------

function prepare(state) {
  P = state.physics;
  dt = state.dt;
  nowTick = state.tick;
  moveStep = P.moveSpeed * dt * STEP_TICKS;
  turnStep = P.turnSpeed * dt * STEP_TICKS;
  tankR = P.tankRadius;
  tankR2 = tankR * tankR;
  const shape = P.tankCollision;
  bodyHX = shape.bodyLength / 2;
  bodyHY = shape.bodyWidth / 2;
  const tip = shape.barrelEnd + shape.barrelRadius;
  barrelC = (bodyHX + tip) / 2;
  barrelHX = (tip - bodyHX) / 2;
  barrelHY = shape.barrelRadius;
  inertia = (shape.bodyLength * shape.bodyLength + shape.bodyWidth * shape.bodyWidth) / 12;
  bodyReach = tip + 3;
  // 开局函数未经 JIT 优化：前 40 Tick 逐步放开搜索规模，避开首 Tick 超时。
  workScale = Math.min(mem.scale, 0.2 + state.tick / 40);
  buildWorld(state.map);
  buildContacts(state.map);
}

function decide(state) {
  const started = clock();
  prepare(state);
  learnEnemies(state);
  settleShots(state);
  calibrateBullets(state);
  detectStuck(state);
  trackMines(state);
  buildMineHazards(state);
  flood(cellIndex(state.self.x, state.self.y), fieldMe);
  const target = pickTarget(state);
  predictEnemies(state, target);
  buildThreats(state);
  captureContext(state, target);
  const plan = makePlan(state, target);
  const motion = chooseMotion(state, plan);
  const fire = chooseFire(state, plan, motion);
  const special = chooseMine(state, motion);
  // 对准了却迟迟不开火：这个瞄准解不值得站着等。
  const me = state.self;
  if (plan.mode === 'aim' && plan.aim && !fire && me.cooldown <= dt && Math.abs(wrap(plan.aim.angle - me.angle)) < 0.1) mem.aimIdle++;
  else mem.aimIdle = 0;
  if (mem.aimIdle * dt > TUNE.aimPatience) {
    mem.aimIdle = 0;
    mem.huntUntil = state.time + TUNE.boredHunt;
  }
  mem.lastMove = motion.move;
  mem.lastTurn = motion.turn;
  mem.lastCandidate = motion.ci;
  const spent = clock() - started;
  if (spent > TUNE.softBudgetMs) mem.scale = Math.max(0.3, mem.scale * 0.85);
  else if (spent < TUNE.softBudgetMs * 0.4) mem.scale = Math.min(1, mem.scale * 1.02);
  return { move: motion.move, turn: motion.turn, fire, special };
}

function sanitize(action) {
  return {
    move: Number.isFinite(action.move) ? clamp(action.move, -1, 1) : 0,
    turn: Number.isFinite(action.turn) ? clamp(action.turn, -1, 1) : 0,
    fire: action.fire === true,
    special: action.special === true,
  };
}

module.exports = {
  update(state) {
    // 异常或非法动作会本局判负，宁可这一 Tick 不动。
    try {
      return sanitize(decide(state));
    } catch (error) {
      return { move: 0, turn: 0, fire: false, special: false };
    }
  },
};
