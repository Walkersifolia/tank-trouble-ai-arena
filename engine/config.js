// ============================================================
// config.js — 全局常量与配置
// 所有"魔法数字"集中在此，方便调参。改这里不改逻辑。
// ============================================================

// 画布尺寸（逻辑像素，实际渲染会按地图缩放居中）
export const CANVAS = {
  width: 960,
  height: 720,
};

// 迷宫格子边长（像素）。格子越大，坦克活动空间越开阔。
export const CELL_SIZE = 96;

// 地图档位（tier）→ 尺寸（列数 cols × 行数 rows）。
// 三档全是矩形（非正方），尺寸递增；具体墙体布局仍由 generateMaze 随机生成。
//   small  7×5 = 672×480  比 medium 小一圈，1v1 更紧凑、贴脸快
//   medium 9×7 = 864×672  阶段 0-4 的原始尺寸，刚好放进画布不缩放
//   large 13×8 = 1248×768 明显更大更扁（贴近横屏原版），超画面 → 触发自适应缩放
// 像素 = cols/rows × CELL_SIZE(96)。
export const MAZE_TIERS = {
  small: { cols: 7, rows: 5 },
  medium: { cols: 9, rows: 7 },
  large: { cols: 13, rows: 8 },
};

// 对战模式 → 可抽取的地图档位池。每回合 setupRound 从对应池随机抽一档。
//   pvp(1v1) / pve(人机)：small / medium 二选一，回合间换图增加变化
//   wave(波次生存)：不随机抽——由 waveSpec(n).tier 确定性给（前两章 medium、
//     第 11 波起 large），池子只用于 smoke 断言「产出的档位在册」
//   3p / 4p：归入联机 v2，档位已就绪（medium+large / large），本地版暂不可达
// 注意：3p/4p 模式尚未实现；large 曾长期抽不到，阶段 24 起由高波次消费。
export const TIER_POOL_BY_MODE = {
  pvp: ["small", "medium"],
  pve: ["small", "medium"],
  wave: ["medium", "large"],
  "3p": ["medium", "large"],
  "4p": ["large"],
};

// 内部每条格子边放墙的概率（稀疏格栅的核心参数）。
// 越小越空旷、越适合追逐跳弹；越大越接近走迷宫。0.25~0.35 比较像原版。
export const WALL_DENSITY = 0.28;

// 生成结果的**退化下限**（阶段 28.1）：内墙数 / 内部边总数 低于 minDensity 就重抽一张，
// 最多重抽 tries 次（有界，绝不死循环；抽满仍不达标就交付——地图必须有，宁空旷勿无图）。
// 为什么需要它：放墙是概率的、而 ensureConnected 与 enforceSymmetry 只删不加，
// symmetric 在 small 档（7×5，58 条内部边）上这两步的删除会复利——单边敲墙后镜像边
// 也得敲——于是尾巴能一路薄到 **0 堵内墙**（10 万张实测：0 墙 3 张、2 墙 66 张，
// 合计 0.069% 落在 0.05 以下）。那不是「开阔」是空箱子：小图 pvp 里两辆车从第一帧
// 起互相全见、子弹只在外框上跳，没有任何掩体。重抽是最省的根治手法——它交付的仍是
// 一张走完整流程的图，连通性/对称性/hp 继承那些不变量全部原样成立（若改成事后补墙，
// 加墙可能切断连通，就得重跑修复，反而把「只删不加」这条安全性质弄丢）。
// **顺带把一条概率性断言去随机化**：smoke 的密度护栏原先硬编码 0.05 下界，于是它有
// 约 2% 的概率在没人改错任何东西的时候变红（30 张 symmetric×small 采样命中上面那条尾巴）。
// 一个 1/50 会误报的回归门只会教人反复重跑，比没有更糟；现在下界由生成器**保证**，
// 断言改成引用这个常量。
export const MAZE_FLOOR = {
  minDensity: 0.05,     // 内墙密度下限（与 smoke 的密度护栏共用同一个数）
  tries: 12,            // 最多重抽次数：单次不达标概率 ≤0.07% ⇒ 12 次全败约 1e-38
};

// 地图风格（阶段 21）：每回合从池里随机抽一种，与 tier 抽取正交。
//   sparse    经典稀疏格栅（原版风）
//   symmetric 180° 中心对称竞技场——两侧地形镜像，绝对公平；
//             现有出生点（左上/右下角）恰好互为中心对称，天然配合
//   rooms     房间+走廊——简化 BSP 递归二分，切缝放墙 + 相邻房间开门
export const MAZE_STYLES = {
  // 稀疏格栅的密度**读 WALL_DENSITY 这个唯一来源**（maze.fillSparse 读本字段）。
  // 原先这里写死一个 0.28、而生成器读的是顶层 WALL_DENSITY，于是本字段是个
  // **死旋钮**：改它零效果，改 WALL_DENSITY 又看不到本表跟着动。见阶段 28.6
  sparse:    { label: "稀疏格栅", density: WALL_DENSITY },
  symmetric: { label: "对称竞技场", density: 0.30 },
  rooms:     { label: "房间走廊", roomMin: 2, roomMax: 3, extraDoorChance: 0.5 },
};
export const STYLE_POOL_BY_MODE = {
  pvp: ["sparse", "symmetric", "rooms"],
  pve: ["sparse", "symmetric", "rooms"],
  wave: ["sparse", "symmetric", "rooms"], // 档位定死、风格随机——每章换图有花样
  "3p": ["sparse"], // v2 预留保守，先只用经典风格
  "4p": ["sparse"],
};

// 坦克参数
// 外观模仿 Tank Trouble 原版：俯视角，上下两条履带夹着车体，中央圆炮塔伸出圆头炮管。
// 坐标约定：车体朝向 +x（炮管指向右），渲染时已 rotate 到 angle。
//   长(length) = 沿炮管方向(x)的尺寸；宽(width) = 垂直方向(y)的尺寸。
export const TANK = {
  radius: 16,            // 武器命中/拾取半径；运动接触使用下方画面轮廓

  moveSpeed: CELL_SIZE * 1.595,    // 前进153.12px/s，原版1.595格/s
  reverseSpeed: CELL_SIZE * 1.28,  // 倒车122.88px/s，原版1.28格/s
  turnSpeed: 5.0,                 // 弧度/秒；连续输入直接缩放，无驾驶惯性

  // 车体（中间的彩色方块）
  bodyLength: 26,        // 沿炮管方向
  bodyWidth: 20,         // 垂直方向（不含履带）

  // 履带（上下两条深色横条，比车体略长、两端探出）
  treadLength: 34,       // 沿炮管方向，比车体长 → 两端露出
  treadWidth: 7,         // 单条履带的厚度
  treadInset: 1,         // 履带内缘与车体边缘的重叠/间隙微调

  // 炮塔（中央圆盘）
  turretRadius: 8,

  // 炮管（从炮塔伸出的圆头短管）
  barrelLength: 18,      // 从炮塔中心向前伸出的长度
  barrelWidth: 5,        // 炮管粗细
};

// 运动接触轮廓跟随现有美术：含履带车身、圆头炮管；武器命中圆不变。
export const TANK_COLLISION = {
  bodyLength: TANK.treadLength,
  bodyWidth: TANK.bodyWidth + 2 * (TANK.treadWidth - TANK.treadInset),
  barrelStart: 0,
  barrelEnd: TANK.turretRadius + TANK.barrelLength,
  barrelRadius: TANK.barrelWidth / 2,
};

// 子弹参数
// 数值取向：还原原版 Tank Trouble 的"小黑点 + 暴躁跳弹"手感。
// 限流不靠冷却，而靠 maxAlive（同屏子弹上限）——这是原版的核心机制。
// 消亡只靠 lifetime（时间）这一道闸门：原版子弹无限反弹，纯靠寿命到点消失。
// cooldown 仅压到极小值防手滑狂点，几乎无感（≈ 模型 A）。
export const BULLET = {
  radius: 3,            // 直径 6px，约车体宽的 1/4~1/5，贴合原版小黑点比例
  speed: 180,           // 像素/秒（子弹变小后视觉显慢，略提一点补手感）
  maxBounces: Infinity, // 无限反弹（还原原版：子弹不因反弹次数消失，只因寿命到点）
  lifetime: 10.0,       // 寿命（秒）（原版实测值，时间是唯一的消亡闸门）
  cooldown: 0.15,       // 开炮微冷却（秒），仅防手滑狂点，真正限流靠 maxAlive
  maxAlive: 5,          // 单个玩家同屏最大子弹数（原版核心限流，去冷却后唯一闸门）
  selfHitGrace: 0.25,   // 子弹出膛后这段时间内不会打中发射者（防贴墙自爆）
};

// 玩家颜色（按索引）
// 浅色场地配色：原 青/黄 在白底上偏淡，加深到中明度，保证坦克在浅灰场上够跳。
export const PLAYER_COLORS = [
  "#1ba39c", // P1 青绿（加深，白底显形）
  "#e63946", // P2 红（加深，更沉稳）
  "#e9a200", // P3 橙黄（黄在白底几乎隐形，换暖橙）
  "#7c4dff", // P4 紫
];

// 波次敌人配色（阶段 28）。**为什么不共用 PLAYER_COLORS**：那张表编码的是玩家身份
// （菜单键位卡、计分条、matchScores[winner.index]、v2 的 3p/4p 池都按它的索引说话），
// 而波次敌人是投放物、不是玩家。阶段 24~27 向它借槽位的副作用是「同屏上限 = 色数 − 1 = 3」，
// 于是一条配色事故成了唯一结构上无界那层难度的硬顶（见 waves.js 的 concurrent 段）。
// 前三个**刻意与 PLAYER_COLORS[1..3] 逐字节相同**：波次 1~35 与挑战关的每一帧渲染
// 因此完全不变，新增的只有第 4/5 辆（smoke 有逐值全等断言钉住这点）。
// 选色只有一条硬要求：与玩家的 #1ba39c 一眼可分、且在浅灰场地（THEME.arenaBg）上够跳。
// 敌人之间**不需要**互相分辨——玩家要回答的只有「哪辆是我」，「哪辆带激光」由阶段 25
// 的头顶武器图标回答。新增两色避开蓝：THEME.accent 是守点圈外环色，蓝车会读成地形。
export const ENEMY_COLORS = [
  "#e63946", // 红（= PLAYER_COLORS[1]）
  "#e9a200", // 橙黄（= PLAYER_COLORS[2]）
  "#7c4dff", // 紫（= PLAYER_COLORS[3]）
  "#3f8f2e", // 草绿（新，落在青绿↔橙黄之间）
  "#b0338a", // 玫紫（新，落在紫↔红之间）
];

// 多套键位：每个玩家一组。值为 KeyboardEvent.code。
// forward/back/left/right/fire/special（special=道具键：部署类道具用，如布雷；
// 开火键=射击，道具键=部署，语义分离。P1 取 E 贴 WASD 手位、P2 取右 Shift 贴方向键手位）
export const KEY_BINDINGS = [
  { forward: "KeyW", back: "KeyS", left: "KeyA", right: "KeyD", fire: "Space", special: "KeyE" },
  { forward: "ArrowUp", back: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", fire: "Enter", special: "ShiftRight" },
  { forward: "KeyI", back: "KeyK", left: "KeyJ", right: "KeyL", fire: "KeyU", special: "KeyO" },
  { forward: "Numpad8", back: "Numpad5", left: "Numpad4", right: "Numpad6", fire: "Numpad0", special: "NumpadAdd" },
];

// 键位黑名单在 UPGRADE 之后定义（它要读 UPGRADE.offers 算抽卡数字键），见文件下方。

// 回合结束到下一局重开的延迟（秒）
export const ROUND_RESTART_DELAY = 1.5;

// 局胜制：先到这个胜场数赢得整场（MATCH_OVER 大结算，可再来一场或回菜单）。
// 同归于尽不加分，所以整场时长有自然上限但无固定局数。
export const MATCH_TARGET = 5;

// 无尽波次生存（阶段 24）：曲线参数全集中在此，改数值不必翻 waves.js。
// 语义见 waves.js 的 waveSpec——那边只做算术，这边只放旋钮。
export const WAVE = {
  gap: 1.5,             // 波与波之间的空场喘息（秒）：**不冻结**——玩家保有控制权，
                        //   可趁空场捡补给、挪到有利位置。冻结的是它前面的抽卡浮层
                        //   与章界换图的 3-2-1，喘息本身刻意留给玩家动
  concurrentCap: 5,     // 同屏敌人硬上限。必须 ≤ ENEMY_COLORS.length（smoke 钉死这条
                        //   不变量——它替代了阶段 24~27 那条「PLAYER_COLORS 只有 4 色」
                        //   的隐式耦合）。阶段 28 从 3 抬到 5：同屏身体数是六层难度里唯一
                        //   结构上无界的一层，而它原先卡在配色事故上
  concurrentEarlyCap: 3, // **早期台阶的天花板**（阶段 28 新增）。它才是保住波次 1~35
                        //   逐字节不变的那道闩：硬顶抬到 5 之后，若让 concurrentEvery
                        //   自己往上爬，第 4 辆会落在第 16 波、第 5 辆第 21 波——那是中段，
                        //   阶段 26 花一整期把那段铲成单调不增、单步跌幅 ≤1.2s，
                        //   且 CLAUDE.md 记的每条基线会同时失去「回归护栏」的身份
  concurrentLateFrom: 36, // 第 4 辆登场的波次（阶段 28 新增）。**为什么是 36 不是 31**：
                        //   第 31 波已经踩着 eliteStep 的 stepCap（激光配额 2→3），
                        //   把一具身体压在同一波 = 双重计数 = 阶段 26 拆掉的那种断崖。
                        //   36 是下一个章节第一波（shouldRemap(36) === true，台阶落章界
                        //   这条既有规则照旧），而第 32 波起装备/倍率/配额/mix/档位全部
                        //   已封顶，所以那一波**只有这一件事发生**，读数可直接归因
  concurrentLateEvery: 10, // 之后每这么多波 +1（第 5 辆 = 第 46 波）。**为什么 10 不是 5**：
                        //   第 32 波之后没有任何别的东西在涨，这条台阶是尾段的全部增量，
                        //   踩 5 会让「五波加一辆」成为尾段唯一的节拍、两级之间全是纯平台；
                        //   10 波给每辆新车留出被学会的时间。推理定的，跑分只用来否证
  concurrentEvery: 5,   // 每这么多波，同屏上限 +1（1→2→3，被 concurrentEarlyCap 收住）。
                        //   刻意与 remapEvery 同值：每换一张图恰好加一辆，压力台阶与地形
                        //   换新对齐，一章一个主题（第 1 章单挑 / 第 2 章两辆 / 第 3 章起三辆围攻）
  quotaCap: 12,         // 单波敌人总数上限（再多一波要打太久）
  quotaSlope: 0.7,      // 配额斜率：quota = 1 + floor(n × slope)，到 cap 为止
  easyFade: 7,          // easy 权重从 1 线性归零所用波数（阶段 26：5 → 7，把新手期从
                        //   「第 6 波一刀切」摊成第 6~7 波还掺 29%/14% 的 easy。
                        //   替身跑分看不出差别（mix 里只有 easy→normal 这一档是大跨度，
                        //   而替身在 1v1 里对 easy 的优势远小于人类），这一条是给人类的：
                        //   easy 档 AI 根本不躲弹，对新手是「能打中的靶子」）
  hardFrom: 4,          // 第几波开始掺 hard
  hardRamp: 8,          // hard 权重从 0 爬到 hardCap 所用波数
  hardCap: 0.8,         // hard 权重上限——留 0.2 给 normal，避免后期清一色
  remapEvery: 5,        // 每这么多波换一张新图（章节分隔；破洞/雷阵在章内累积）
  largeFrom: 11,        // 第几波起升 large 档（必须落在换图边界上，否则换不了图）
  supplyBonusEvery: 3,  // 每这么多波，开波强制补给给 2 个而不是 1 个
  spawnSafeCells: 2.2,  // 新敌人刷点与玩家的最小格距（不许贴脸空降）
  spawnIdealCells: 9,   // 新敌人刷点与玩家的**理想**格距——刷点贴住这个距离而不是
                        //   「越远越好」。原规则取最远三分之一，而 large 图对角 15 格、
                        //   medium 只有 11 格，于是换 large 图那一章白送 3 秒走位时间：
                        //   实测第 11/16/21 波 medium 7.4/6.7/7.1s vs large 9.8/10.2/10.9s，
                        //   地图档位成了方向朝反的难度旋钮。贴住理想距离后两档交战延迟对齐。
                        //   9 格（=864px）是扫出来的，不是猜的：理想距 6/8/9 格在第
                        //   6/11/16/21/26 波实测 `5.3/5.2/4.2/4.1/2.2`、`7.5/6.8/6.0/5.4/3.9`、
                        //   `7.9/8.0/6.7/6.4/4.3`s——6 格全线砍掉 2~3.4s（第 26 波塌到 2.2s
                        //   显然过头），9 格既补掉 large 图的退款又保住原有绝对水位。
                        //   9 格恰好略小于 medium 图对角（11.4 格）而明显小于 large（15.3 格），
                        //   所以它对 medium 几乎无感、只把 large 的空场跑位削掉——正是想要的
};

// 守点波（阶段 27，只作用于 wave 模式）：章尾 boss 波把「打光敌人」换成「站住区域」。
// 语义与判定在 zone.js / objectives.js，波号相位与秒数曲线在 waves.js，这里只放旋钮。
// 设计要点写在旋钮旁边，因为每一条都能用一个数字改坏：
export const HOLD = {
  from: 5,              // 第一个守点波
  every: 5,             // 每这么多波一次。**刻意 = WAVE.remapEvery**：守点波于是恒落在
                        //   每章最后一波（第 5/10/15/20/25/30），流程天然是「守住过关 →
                        //   抽卡 → 换图进新章」，boss 波与章节收束同一拍。守点波是**替换**
                        //   该波的普通规则而不是插入额外一波，所以波号仍等于「打到多深」，
                        //   waveBest 语义不变
  radius: 0.95,         // 区域半径（格）。略小于 1 格 = 一个路口大小：站得住，但不能一边
                        //   绕大圈风筝一边攒进度——「不许风筝」正是这个波的全部新意
  needBase: 12,         // 首个守点波要累计的秒数
  needStep: 1.5,        // 每个后续守点波 +N 秒
  needCap: 18,          // 秒数上限。**曲线的重量压在敌人侧不压在秒数上**：同一个「守 12 秒」
                        //   在第 5 波是站着打一辆 easy、在第 30 波是三辆带激光的 hard 围攻
                        //   （concurrent/mix/词条照常爬）。秒数再陡就是双重计数，
                        //   而双重计数就是阶段 26 那些断崖的来源
  minCells: 3,          // 区域离玩家最近多少格（太近 = 白送）
  maxCells: 6,          // 最远多少格（太远 = 先跑一段空场，阶段 26 花一整期铲的就是白送）
};

// 波间强化（阶段 25，只作用于 wave 模式）：每波清完抽 offers 张选 1，本 run 永久生效。
// 卡面语义与「为什么没有某张卡」的理由全在 upgrades.js，这里只放旋钮。
// 上下文一次性提示的旋钮（阶段 28.5）。文案表在 hints.js（内容随玩法演进）、
// 这里只放时长与队列上限（手感旋钮）——与 UPGRADE / UPGRADES 同一分工。
export const HINT = {
  duration: 4.5,        // 一条提示显示多久（秒）。用**真实 dt** 推进，不跟慢镜一起拉长
  maxQueue: 3,          // 同时最多排几条。同一帧可能触发两条（捡到武器顶掉旧的 + 第一次持激光），
                        //   排队逐条显示；超过就丢最新的——教学信息迟到不如不到
};

export const UPGRADE = {
  offers: 3,            // 每波抽几张（可选卡不足就出剩下的，一张都没了静默跳过）
  speedMul: 1.08,       // 履带强化：每层移速倍率（cap 3 → 1.26×，须远低于 BULLET.speed，
                        //   见 ai.js interceptTime 的唯一正根前提：坦克极速必须 < 弹速）
  turnMul: 1.15,        // 转向伺服：每层转速倍率（cap 2 → 1.32×）
  ammoAdd: 1,           // 弹仓扩容：每层同屏子弹上限 +1（这是玩家真正的火力闸门）
  erodeAdd: 1,          // 破障弹头：每层子弹每次反弹多削 1 点墙耐久
  scatterAdd: 2,        // 散射扩容：每层拾取散射时多给 2 发
  laserAdd: 1,
  mineAdd: 1,
  shieldAdd: 2,         // 护盾强化：每层拾取护盾时多持续 2 秒
  supplyAdd: 1,         // 补给增量：每层开波补给 +1，**同时**把场上道具上限 +1——
                        //   否则 PowerupSpawner 的 maxOnField 硬门会让多刷的补给静默失效
  salvageAdd: 0.25,     // 战场回收：每层 +25% 击杀掉落概率
  salvageSlack: 2,      // 掉落绕开 maxOnField 的软顶余量（防一波 12 个配额铺满一地）
};

// 不许绑成玩家键位的键，**两类**（原先只有第一类，那正是这个缺陷的根因）：
//   ① 外壳/系统语义键：Esc=暂停·取消、F11=全屏（主进程消费）
//   ② 界面快捷键：游戏自己在状态机里硬编码消费的键。少了这一类会出静默事故——
//      KeyR 是四个终局态（ROUND_OVER/MATCH_OVER/LEVEL_OVER/WAVE_OVER）的「重开」：
//      把任一移动键绑到 R 之后，结算横幅一出来、手上再点一下前进，刚打完的整场
//      大比分就被静默清零重开，没有确认、玩家也无从得知原因。
//      Escape 一直安全纯属巧合——它同时是系统键而被 ① 收进去了，这层意外覆盖
//      恰好把 KeyR 这个缺口藏住了。
// **两条路径都要用这张表**：改键面板的捕获校验（拒绝 + 错误音），以及
// settings.initSettings 的加载过滤——只堵捕获的话，已经把 R 绑上去的存量存档
// 重启后照旧中招，而那批玩家恰恰是唯一会踩到的人。
// Digit1..N 由 UPGRADE.offers **算出来**而不是写死三个：抽卡浮层的消费处是
// `isJustPressed(`Digit${i+1}`)`（模板串，grep "Digit1" 搜不到），上界跟着 offers 走。
// 硬编码的话 offers 调到 4 时黑名单会静默脱钩（smoke 有一条断言钉住这个联动）。
export const RESERVED_KEYS = Object.freeze([
  "Escape", "F11",
  "KeyR",
  ...Array.from({ length: UPGRADE.offers }, (_, i) => `Digit${i + 1}`),
]);

// 敌人词条（阶段 25，只作用于 wave 模式的投放敌人）。
// 只复用已有机制（护盾 / 武器改装槽 / 坦克物理倍率），**ai.js 一行不改**——
// AI 读的是状态而非事件（`self.laserShots`/`self.mineCharges`/对手 `shield`），
// 所以发下去的装备它会自动正确使用。
// 档位白名单是刻意的，理由见 waves.js 的 eliteSpec。
export const ENEMY_TRAIT = {
  from: 6,              // 第几波起有词条（落在章界上：每换一张图升一档）
  every: 5,             // 每这么多波升一档（= WAVE.remapEvery，与同屏台阶同相位）
  stepCap: 6,           // 档位上限（1 盾 / 2 加武器 / 3 武器加量 / 4 加量翻倍+第一把激光 /
                        //   5 两把激光 / 6 三把激光）。台阶落在 6/11/16/21/26/31 波
  laserFrom: 4,         // 第几档起场上有激光兵（4 档 = 第 21 波）
  laserQuota: [1, 2, 3],// 从 laserFrom 起，每档的**同屏已上膛激光兵上限**。阶段 28 起硬顶抬到 5，
                        //   于是 laserCapAt 里那道 min(q, concurrentCap) 成了空操作，**真正的上限
                        //   从此只由这个数组自己给**（护栏改挂在 smoke 的「全档 ≤ 3」断言上）。
                        //   第 46 波是「5 辆里 3 把激光」，比例反而降了——这是想要的方向：
                        //   第 4 位同屏 hitscan 狙击手正是阶段 26 拆掉的那道断崖。
                        //   阶段 26 把激光从「档位开关」改成「数量配额」，是实测结论不是口味：
                        //   原规则第 26 波起**每一辆** hard 都持激光，而 hardCap 0.8 × 同屏 3
                        //   ≈ 同屏 2.4 把 hitscan 狙。第 26 波中位存活 5.6s 还不是最糟的，
                        //   最糟的是**技术档差塌了**——normal 替身 5.6s vs hard 替身 5.7s
                        //   （同参数第 11 波两者差 6.3s）。技术不再影响结果，那就不是难，是不讲理。
                        //   配额化后同一条增量拆成三级（21 波 1 把 / 26 波 2 把 / 31 波 3 把），
                        //   最陡的一档仍留在最后，但每一档都还给玩家「躲得好就能活」的空间
  shieldTiers: ["easy", "normal"], // 带盾的 AI 档——**hard 不给盾**：ai.js 的 berserkMode
                        //   在自己有盾时直接放弃躲弹冲锋，而躲弹正是 hard 最强的资产
                        //   （dodgeHorizon 1.1 / dodgeMargin 16），给 hard 发盾等于削它
  laserTiers: ["hard"], // 带激光的 AI 档——只有 hard 的 bounceAim 认全路径反弹解，
                        //   低档持激光是「随机方向的瞬时狙」，对玩家不可读
  scatterBonus: 3,      // 散射发数增量的**单位**：第 3 档 +3（3→6 发）、第 4 档 +6（→9 发）
                        //   老实说：这两档实测**量不出来**（第 16/21 波中位存活 7.2/7.3s，
                        //   与关掉词条的 7.4s 同噪声内）。原因与被否掉的玩家「减冷却」卡同类
                        //   ——AI 的出手节奏闸门是 cfg.fireCooldown(0.55~1.1s)，一场遭遇战
                        //   总共开不了几炮，弹药从 6 发加到 9 发根本不是约束。留着是因为它
                        //   免费且方向正确（对人类玩家的压制感与对替身不同构），但**别把
                        //   曲线的重量压在它身上**——那是下面 creep 的活
  creepFrom: 8,         // 连续倍率从第几波开始爬（阶段 26：11 → 8）。为什么提前 3 波：
                        //   第 6→11 波这一章原本**毫无增量**——同屏 2→3 实测≈0、large 图
                        //   的退款已被 spawnIdealCells 掐掉、第 2 档装备只是给盾档发散射，
                        //   于是 creep=0 的那一段就是一段躺平。刻意**不落在章界上**：
                        //   装备与同屏都在 5 的倍数上跳，物理倍率错开相位连续爬，
                        //   两者叠起来才不会「五波不动、一波暴涨」
  creepRate: 0.045,     // 每波爬多少进度（0~1）。0.045 → 第 31 波打满（= creepFrom +
                        //   ceil(1/rate)，smoke 那条断言按这个式子算，改 rate 不用改断言）
  // 移速/转速倍率是**整条曲线真正的承重墙**：装备阶梯只有四级、其中三级量不出来，
  // 而这两个是物理量——永远在生效，不经过任何 AI 决策。所以给得比第一版狠
  // （0.25/0.3 → 0.4/0.5）：那一版从第 26 波到第 31 波只买到 0.6s，在 1.2s 的噪声底下。
  speedCap: 0.4,        // 满进度时的移速倍率增量 → 1.40×（= 168 px/s，须 < 弹速 180：
                        //   ai.js 的 interceptTime 要求坦克速 < 弹速才有唯一正根，
                        //   smoke 有一条断言把这个前提钉住）
  turnCap: 0.5,         // 满进度时的转速倍率增量 → 1.50×（转得快=瞄得快，
                        //   这是不碰 ai.js 就能给的最真实的强化）
};

// 回合开场倒计时（3-2-1-GO）：倒计时期间双方全冻结——包括跳过 AI 的
// getControls（否则 AI 开火冷却在玩家不能动时被烧掉，GO 瞬间枪已就绪=抢先手）。
export const ROUND_INTRO = {
  beat: 0.45,  // 每拍时长（秒）：3/2/1 各一拍，总冻结 1.35s
               //   （0.7 实测嫌等——回合本就短，冻结要压到"手指归位刚好"）
  goHold: 0.4, // "GO!" 余像显示时长（此时已解冻，纯视觉）
};

// 击杀慢动作：终杀瞬间时间放慢（1v1 任何击杀都终结回合，直接挂在击杀点）。
// duration 按真实秒计（自身衰减用真实 dt，否则慢动作把自己也拖慢 1/scale 倍）。
export const SLOWMO = {
  scale: 0.35,    // 游戏时间倍率
  duration: 0.55, // 持续真实秒：覆盖爆炸碎片飞散最精彩的前半段
};

// 坦克被击破的爆炸效果（参考原版：深色烟团 + 浅色碎片四散）。
// 时长须 < ROUND_RESTART_DELAY，保证结算横幅期间能播完整段动画。
// 联机 v2 同款复用：死亡有视觉反馈而不是凭空消失。
export const EXPLOSION = {
  duration: 0.9,         // 总时长（秒）
  shardCount: [6, 9],    // 碎片数量随机区间
  shardSpeed: [60, 200], // 碎片初速（像素/秒），随机
  shardSize: [5, 11],    // 碎片外接半径（像素），随机
  shardDrag: 3.0,        // 碎片线性阻尼（指数衰减系数/秒），飞出后迅速减速
  shardSpin: 6,          // 碎片最大自旋角速度（弧度/秒，正负随机）
  smokeCount: 3,         // 烟团数量（中心一大两小错位叠放）
  smokeRadius: [12, 22], // 烟团初始半径随机区间
  smokeGrow: 30,         // 烟团膨胀速度（像素/秒）
  fadeStart: 0.45,       // 动画进度超过此比例后开始整体淡出（0~1）
};

// AI 参数（阶段 6 基础 AI：会追人、会开枪、能被打死；不躲弹不预判）。
// 这里只放与难度无关的共享参数；随难度变化的旋钮在下方 AI_DIFFICULTY。
export const AI = {
  moveAngleGate: 1.0,       // 朝路点偏角小于此值才前进（边转边走，像人操作）
  closeCombatRange: 130,    // 近战反打距离（像素）：贴得比这近 + 有视线 + 枪已就绪时
                            // 反打优先于躲弹——近距必中角大、弹程短，干掉火力源
                            // 比躲单发子弹划算；枪没就绪才专心躲
  closeCooldownBoost: 4,    // 敌人进近战圈后开火冷却的流逝倍速：节奏门是远距防狙神的，
                            // 贴脸刀战谁都是倾泻——普通档 0.7~1.4s 实际变 0.18~0.35s/发；
                            // 也覆盖"远处刚开完炮、对方冲脸"时烧掉残余冷却
  hitSlack: 1.5,            // 几何必中角的半径余量倍数：以"偏角在敌人处的横向偏差
                            // ≤ (坦克半径+子弹半径)×此值"反推必中角，1.5 倍是给
                            // 对方挪动留的提前量。开火窗口 = 必中角 × 各难度 aimSkill
  leadSmooth: 0.35,         // 敌速度估计的指数平滑系数（逐帧差分太抖，平滑后≈半拍收敛）；
                            // 速度估计喂给拦截预判（leadFactor），让 AI 打"你将到的位置"
  dodgeCommit: 0.45,        // 闪避航向锁定时长（秒）：威胁评估逐帧重算会让 AI 左右抽搐，
                            // 锁住一条道闪到底；威胁中途消失也把机动做完（半途折返等于没躲）。
                            // 0.3 会被近战 gunReady 高频击穿（等于没锁）；0.55 互搏实测闪避
                            // 时间挤占开火窗口吃亏 5pt，0.45 折中（覆盖 ~77° 转向）
  dodgeClearance: 40,       // 闪避方向探测距离（像素）：朝墙里闪等于白闪，先探路再选
  dodgeWallPenalty: 1000,   // 朝墙航向的安全分罚没值：足够大保证只有八方皆堵才选朝墙的
  stuckWindow: 0.6,         // 卡住检测时窗（秒）
  stuckMinDist: 6,          // 时窗内想动却位移低于此值（像素）→ 判卡住
  unstickTime: 0.45,        // 脱困机动时长（秒）：倒车 + 随机方向转向

  // —— 敌方激光预瞄线感知（激光是 hitscan，杀伤线全程等危险，见 ai.js）——
  laserHazardStep: 40,      // 沿预瞄线采样危险圈的步长（像素）
  laserHazardRadius: 34,    // 采样危险圈半径（像素）；步长 < 2×半径保证沿线无缝
  laserMuzzleExempt: 1.2,   // 近炮口豁免半径（格）：这圈内采样不进寻路封锁——
                            //   交战终归要接近持枪人，封死其所在格会致全图不可达
  laserVirtualSpeed: 600,   // 预瞄线各段注入闪避评分的虚拟弹速（像素/秒）：
                            //   只用于给闪避航向提供"远离线"的梯度，非真实弹速
};

// AI 难度三档（菜单可选，默认 normal）。难度只调决策参数、不动坦克物理：
//   aimSkill       开火窗口倍数：开火条件 = 瞄准偏角 < 几何必中角 × 此值。
//                  必中角随距离变化（近大远小），所以贴脸大家都敢秒开、
//                  远距离都要求瞄正——这是"像人"的关键；倍数 >1 的档位
//                  接受脱靶提前开（糙），<1 的要求留命中余量（稳准狠）
//   fireCooldown   开火间隔随机区间（秒）。Tank 的 0.15s 微冷却挡不住逐帧
//                  fire=true 的连发，AI 必须自带节奏闸门
//   replanInterval BFS 重算路径间隔（秒），越小追人越紧
//   dodgeHorizon   躲弹预判窗（秒）：对子弹直线外推，最近逼近时刻落在窗内才视为
//                  威胁并闪避。0 = 不躲弹（简单档保持好欺负）
//   dodgeMargin    躲弹安全余量（像素）：在"坦克半径+子弹半径"外再加的提前量，
//                  越大躲得越早越稳
//   ammoBudget     同屏自留弹上限（发）：AI 的自我开火约束（远距生效，近战放开
//                  到 maxAlive-1），留弹防身/抓近身机会，不一照面倒光也不被饿死
//   leadFactor     拦截预判提前量比例：0 = 打当前位置（简单档老实人），
//                  1 = 全量提前（打"你将到的位置"）。这是"精密计算"的核心——
//                  打高速横移目标的当前位置是计算出的必失，AI 会忍住不浪费那发
//   powerupRange   道具感知半径（格）：只有这范围内、且对自己有用的道具才会去捡。
//                  优先级低于躲弹/反打（不为道具送命或放跑人头），高于纯追敌。
//                  简单档 0=完全不主动捡、普通 4=保守安全时捡、困难 7=激进主动抢
//   bounceAim      跳弹吊射开关：无视线时用镜像法找一次反弹解，停车转炮隔墙
//                  吊射（阵地射击）；持激光时同时解锁全路径反弹判定（反弹激光狙）。
//                  原版高手核心技能，仅困难档启用——这是三档的质变分水岭
export const AI_DIFFICULTY = {
  easy:   { label: "简单", aimSkill: 2.0, fireCooldown: [1.0, 1.8],   replanInterval: 0.7,  dodgeHorizon: 0,    dodgeMargin: 0,  ammoBudget: 2, leadFactor: 0,    powerupRange: 0, bounceAim: false },
  normal: { label: "普通", aimSkill: 1.4, fireCooldown: [0.55, 1.1],  replanInterval: 0.4,  dodgeHorizon: 0.4,  dodgeMargin: 5,  ammoBudget: 3, leadFactor: 0.75, powerupRange: 4, bounceAim: false },
  hard:   { label: "困难", aimSkill: 0.75, fireCooldown: [0.2, 0.45], replanInterval: 0.2,  dodgeHorizon: 1.1,  dodgeMargin: 16, ammoBudget: 4, leadFactor: 1.0,  powerupRange: 7, bounceAim: true },
};

// 墙体渲染 + 耐久
export const WALL = {
  color: "#2b2b33",       // 深炭灰细线，在浅灰场地上利落分明（原版风）
  thickness: 5,           // 内墙线宽
  borderThickness: 8,     // 外框线宽（比内墙粗，框住整个竞技场，贴近截图的醒目灰框）
  hp: 5,                  // 内墙耐久：被子弹撞击这么多次后碎掉（渲染按血量渐淡）；
                          //   外墙 border 不受侵蚀；地雷炸墙无视血量直接炸
};

// 竞技场自适应缩放的视口预留（逻辑像素）。
// 大图(large)超出画布时按比例缩到「可用区」内并居中；small/medium 放得下则 scale=1。
// 顶部留多些避开 HUD 计分条，其余三边留窄边距，外框不贴边。
export const VIEWPORT_PADDING = {
  top: 36,
  right: 18,
  bottom: 12,
  left: 18,
};

// 道具系统（菜单可按类型开关）。道具在地图随机刷新，坦克碾过即捡取。
// 种类：scatter 散射弹（一炮变扇形多发，给若干次开火机会）、
//       shield 护盾（挡一次致命伤害，或限时自动消失，先到先算）、
//       laser 激光（接下来几发开火变瞬时射线：沿墙反弹、命中即杀，
//         持有时炮口延伸预瞄虚线——威力大但意图外露，平衡设计）、
//       mine 地雷（道具键在车尾布雷，布防后近敌即炸，主人也会踩）。
// scatter/laser/mine 同属「武器改装槽」互斥：同类拾取叠次数、
// 异类拾取清旧换新；shield 独立并存。
// 效果全作用在 tank 状态上，控制指令 {turn,move,fire,special} 不变 → AI 自动受益。
export const POWERUP = {
  spawnInterval: [6, 10], // 距上次刷新多久再刷（秒，随机区间）
  maxOnField: 2,          // 场上同时最多几个道具
  radius: 16,             // 拾取圈半径（≈坦克半径，碾过即吃）
  types: ["scatter", "shield", "laser", "mine"], // 全部种类（实际启用集合由菜单选择）

  scatter: {
    shots: 3,             // 捡一次给几次「扇形开火」机会
    pellets: 3,           // 每次扇形几发（奇数才有正中那发）
    spreadAngle: 0.26,    // 相邻两发夹角（弧度，≈15°）
  },
  shield: {
    duration: 5,          // 护盾最长持续（秒），到点自动消失防一直龟
    // 「快到期」的闪烁阈值：**两处消费者共读这一个值**（tank.js 的车身护盾环、
    // ui.js 的 HUD 徽章）。原先两边各硬编码 1.5，而 ui.js 的注释还写着
    // 「与坦克自身护盾环一致」——注释承诺的同步靠人记，改一处必漂。见阶段 28.6
    blinkUnder: 1.5,
  },
  laser: {
    shots: 1,             // 捡一次给几发激光（瞬时射线命中即杀——稀缺大招定位）
    maxBounces: 4,        // 射线最多反弹几次
    maxLength: 960,       // 射线总长上限（像素，= CELL_SIZE×10，防无限折返）
    beamDuration: 0.25,   // 亮线特效淡出时长（秒）
    // 平衡设计：持有时预瞄虚线全程可见（含全部反弹段，与实弹完全一致）——
    // 威力不削但意图全暴露，对手可绕线走位，「暗杀」变「明枪」（原版同款哲学）
  },
  mine: {
    charges: 2,           // 捡一次给几次布雷机会（道具键消耗）
    armDelay: 1.0,        // 布防延迟（秒）：落地后过这么久才进入警戒（给主人逃逸时间，
                          //   坦克 120px/s × 1s = 120px，足够离开 40px 触发圈）
    triggerRadius: 40,    // 警戒后任何坦克圆心距小于此即引爆（含主人，雷不认人）
    blastRadius: 60,      // 爆炸波及半径（圆心距），圈内坦克有盾消盾、无盾即死
    discRadius: 9,        // 雷盘视觉/落点修正半径（像素）
    visibleTime: 2,       // 警戒后保持可见的时长（秒），之后开始淡出
    fadeTime: 1,          // 淡出时长（秒），结束后完全隐形——同屏约束下主人也看不见，
                          //   布雷位置靠记忆（原版同款设计）；隐形不影响引爆判定
    holdTimeout: 10,      // 持雷超时（秒）：拾取后一直不部署则存货作废（防捏着白占
                          //   武器槽），每次成功部署刷新计时
    wallBlastRadius: 60,  // 炸墙半径（圆心距，与 blastRadius 同值起步）：圈内内墙被炸碎
                          //   （外墙 border 永不破）；菜单「墙体破坏」开关可整体关闭
  },
};

// 墙碎裂特效（地雷炸墙）：沿被炸墙段撒碎片，比坦克爆炸更小更快更干脆。
// 独立于 EXPLOSION——坦克爆炸手感已调好不动它。
export const WALL_BREAK = {
  duration: 0.5,          // 总时长（秒）
  shardPerSeg: [5, 8],    // 每段墙的碎片数量随机区间
  shardSpeed: [40, 140],  // 碎片初速（沿墙法线 ± 随机散布）
  shardSize: [3, 7],      // 碎片外接半径
  shardDrag: 4.0,         // 线性阻尼（比坦克碎片停得更快）
  shardSpin: 8,           // 最大自旋角速度
  fadeStart: 0.4,         // 进度超此比例后整体淡出
};

// ============================================================
// 音效 spec 表（程序合成，零素材文件；接线在 audio.js，此处纯数据）
// 每个事件 = 层数组（1~3 层叠加出厚度），两类层：
//   振荡器层 { type:"tone", wave, freq:[f0,f1], dur, gain, attack?, delay? }
//     freq 从 f0 指数滑到 f1（Hz），滑音是"游戏感"的核心
//   噪声层   { type:"noise", dur, gain, attack?, delay?, filter?:{kind, freq:[f0,f1]} }
//     白噪声过 biquad 滤波，截止频率 f0→f1 指数扫频（爆炸的"轰隆收尾"）
// 公共字段：dur 时长(秒)、gain 峰值(主音量前)、attack 起音(默认 0.002)、
//           delay 层起播偏移(默认 0，错开即琶音)
// 音量层次：击杀/爆炸(0.5~0.6) > 激光(0.28) > 开炮(0.22~0.28) > 拾取/结算(≈0.2) > UI(0.1)
// ============================================================
export const SFX = {
  // 普通开炮：短促「砰」——方波下滑 + 一点噪声气声
  shoot: [
    { type: "tone", wave: "square", freq: [520, 160], dur: 0.09, gain: 0.22 },
    { type: "noise", dur: 0.05, gain: 0.1, filter: { kind: "lowpass", freq: [3000, 800] } },
  ],
  // 散射开炮：更低更长更「重」（一炮多发是一个音，不是 pellets 次 shoot）
  shootScatter: [
    { type: "tone", wave: "square", freq: [300, 90], dur: 0.16, gain: 0.28 },
    { type: "noise", dur: 0.12, gain: 0.18, filter: { kind: "lowpass", freq: [2500, 500] } },
  ],
  // 激光：能量 zap——锯齿大跨度下扫 + 高八度方波「电流嘶鸣」
  laser: [
    { type: "tone", wave: "sawtooth", freq: [1600, 220], dur: 0.35, gain: 0.28, attack: 0.01 },
    { type: "tone", wave: "square", freq: [3200, 440], dur: 0.25, gain: 0.1, attack: 0.01 },
  ],
  // 坦克击杀：噪声爆 + 正弦低频「胸腔感」轰
  kill: [
    { type: "noise", dur: 0.5, gain: 0.5, filter: { kind: "lowpass", freq: [4000, 200] } },
    { type: "tone", wave: "sine", freq: [220, 50], dur: 0.4, gain: 0.5 },
  ],
  // 破盾（护盾挡下=击破是同一事件，全游戏只此一音）：清脆下滑 + 高通噪声碎裂
  shieldBreak: [
    { type: "tone", wave: "triangle", freq: [2000, 500], dur: 0.28, gain: 0.3 },
    { type: "noise", dur: 0.15, gain: 0.13, filter: { kind: "highpass", freq: [2000, 2000] } },
  ],
  // 道具拾取：上行双音确认；四种道具靠 PICKUP_RATE 整体变调区分
  pickup: [
    { type: "tone", wave: "triangle", freq: [660, 660], dur: 0.07, gain: 0.2 },
    { type: "tone", wave: "triangle", freq: [990, 990], dur: 0.12, gain: 0.2, delay: 0.08 },
  ],
  // 布雷：低频闷「咚」+ 延迟短咔哒——与 mineBlast 同低频域（家族感呼应）
  mineDeploy: [
    { type: "tone", wave: "sine", freq: [180, 120], dur: 0.12, gain: 0.25 },
    { type: "tone", wave: "square", freq: [1200, 1200], dur: 0.03, gain: 0.07, delay: 0.05 },
  ],
  // 地雷爆炸：比 kill 更深更长（对应全场最大震动 addShake(6)）
  mineBlast: [
    { type: "noise", dur: 0.7, gain: 0.6, filter: { kind: "lowpass", freq: [2500, 120] } },
    { type: "tone", wave: "sine", freq: [120, 35], dur: 0.6, gain: 0.55 },
  ],
  // 墙被炸碎：高频碎裂补充层（同帧必有 mineBlast 轰底，这里只补"石屑"质感）
  wallBreak: [
    { type: "noise", dur: 0.22, gain: 0.22, filter: { kind: "highpass", freq: [1500, 3000] } },
    { type: "tone", wave: "triangle", freq: [900, 300], dur: 0.15, gain: 0.12 },
  ],
  // 回合胜利：C5-E5-G5 上行琶音
  roundWin: [
    { type: "tone", wave: "triangle", freq: [523, 523], dur: 0.12, gain: 0.22 },
    { type: "tone", wave: "triangle", freq: [659, 659], dur: 0.12, gain: 0.22, delay: 0.12 },
    { type: "tone", wave: "triangle", freq: [784, 784], dur: 0.3, gain: 0.22, delay: 0.24 },
  ],
  // 整场获胜（先到 MATCH_TARGET）：roundWin 的加长版——C5-E5-G5-C6 四音上行，
  // 末音拉长收尾，比单回合胜利更隆重（家族感：同波形同音区，只是更长更高）
  matchWin: [
    { type: "tone", wave: "triangle", freq: [523, 523], dur: 0.12, gain: 0.25 },
    { type: "tone", wave: "triangle", freq: [659, 659], dur: 0.12, gain: 0.25, delay: 0.12 },
    { type: "tone", wave: "triangle", freq: [784, 784], dur: 0.12, gain: 0.25, delay: 0.24 },
    { type: "tone", wave: "triangle", freq: [1047, 1047], dur: 0.5, gain: 0.25, delay: 0.36 },
  ],
  // 同归于尽：下行双音（低落感）
  roundDraw: [
    { type: "tone", wave: "triangle", freq: [440, 440], dur: 0.15, gain: 0.18 },
    { type: "tone", wave: "triangle", freq: [330, 330], dur: 0.3, gain: 0.18, delay: 0.16 },
  ],
  // UI：菜单/暂停点击轻 tick；改键冲突/保留键低沉 buzz
  uiClick: [{ type: "tone", wave: "triangle", freq: [700, 700], dur: 0.045, gain: 0.1 }],
  uiError: [{ type: "tone", wave: "square", freq: [220, 180], dur: 0.18, gain: 0.13 }],
  // 开场倒计时：每拍短 tick；GO 上扬双音（解冻信号）
  countTick: [{ type: "tone", wave: "triangle", freq: [880, 880], dur: 0.08, gain: 0.18 }],
  countGo: [{ type: "tone", wave: "triangle", freq: [988, 1319], dur: 0.18, gain: 0.25 }],
};

// 拾取音的道具变调（playbackRate 式整体倍率）：攻击性越强音越高，
// 地雷偏低沉与其音效家族一致（1 / 大二度 / 大三度 / 下小六度附近取值）。
export const PICKUP_RATE = { scatter: 1, shield: 1.125, laser: 1.25, mine: 0.84 };

// ============================================================
// 主题配色（浅色风，参考原版 Tank Trouble）
// UI 颜色集中此处，render 只引用、不写死，方便整体调色。
// ============================================================
export const THEME = {
  // 场地
  pageBg: "#e8e8ec",     // 画布外底色（窗口留白处）
  arenaBg: "#dcdce2",    // 竞技场地面（浅灰，让黑点子弹与黑墙都显形）
  arenaBorder: "#2b2b33",// 竞技场外框

  // 子弹
  bullet: "#1a1a1a",     // 纯黑点

  // 文字
  textMain: "#2b2b33",   // 主文字（深炭灰）
  textDim: "#9a9aa5",    // 次要/提示文字

  // 主题色（游戏感强调色）
  accent: "#2a5a8a",     // 深蓝（按钮选中、hover、强调元素）
  accentLight: "#4a7ab0",// 浅蓝（hover 时的渐变或边框）

  // 菜单
  title: "#2b2b33",      // 标题色
  btnFill: "#ffffff",    // 按钮底（白）
  btnFillHover: "#2a5a8a",// 悬停反色改用主题色
  btnTextHover: "#ffffff",
  btnBorder: "#2b2b33",
  btnDisabledFill: "#ededf0",
  btnDisabledText: "#b8b8c0",
  btnDisabledBorder: "#d0d0d6",

  // 结算遮罩
  overlay: "rgba(232,232,236,0.82)", // 浅色半透明压层（深色遮罩在浅底上太突兀）

  // 道具（地上的拾取物 + 坦克身上的护盾环）
  powScatterBg: "#e9a200", // 散射弹底色（暖橙，地面上够跳）
  powShieldBg: "#2bb3c4",  // 护盾道具底色（青蓝）
  powLaserBg: "#d0353f",   // 激光道具底色（深红，危险感）
  powIcon: "#ffffff",      // 道具图标线条（白，压在底色上）
  powRing: "#2b2b33",      // 道具圆底描边
  shieldRing: "#3ad4e8",   // 坦克护盾光环色（半透明在 render 里加）
  laserBeam: "#e63946",    // 激光亮线色（内芯，外圈光晕同色低透明）
  laserPreview: "rgba(230,57,70,0.45)", // 预瞄虚线（半透明红）
  powMineBg: "#5d6d7e",    // 地雷道具底色（灰蓝，低调中带危险感）
  mineBody: "#3a3a4a",     // 落地雷盘主体色（与履带同色系的深灰）
  mineBlink: "#e63946",    // 雷警戒指示灯（红，sin 闪烁）

  // 守点区域（阶段 27）——地面标记层，必须被子弹/坦克/道具全部盖在上面
  holdRing: "#2a5a8a",     // 区域外环（accent 深蓝：与四种道具底色都不撞，读作地形而非拾取物）
  holdFill: "#1ba39c",     // 进度扇形（**刻意等于 P1 青绿**：这条进度是「你的」。
                           //   不从 PLAYER_COLORS 取值是不想让 zone.js 认识玩家编号）
};
