// ============================================================
// maze.js — 随机地图生成（稀疏规整格栅）
// Tank Trouble 的"迷宫"不是标准迷宫，而是稀疏格栅：
//   - 规整网格，每条格子边界"可能有墙也可能没有"，墙都横平竖直、整格长
//   - 墙稀疏、大量缺口 → 空间开阔、四通八达，适合追逐和跳弹绕射
//   （标准 DFS 迷宫恰恰相反：墙密、通道窄、基本无环，像走迷宫而非打仗）
//
// 生成流程：
//   1) 从"全开放"起步（内部无墙），外边界封闭
//   2) 每条内部边按 MAZE_STYLES.sparse.density 概率放一堵墙
//   3) 连通性修复：泛洪检查，把被围出的孤立区域打通
//      （顺带消除"四面被围死"的格子）
//
// 坐标约定：格 (c, r) 的左上角世界坐标 = (c*CELL_SIZE, r*CELL_SIZE)。
// 每个格用四面墙的开关表示：top/right/bottom/left。相邻两格共享一堵墙。
// ============================================================

import { CELL_SIZE, WALL, MAZE_STYLES, MAZE_FLOOR } from "./config.js";
import { closestPointOnSegment } from "./collision.js";

// 四方向表：格间邻接 + 对应墙面名。maze 自用（泛洪/敲墙），ai.js 寻路也复用。
export const DIRS = [
  { dc: 0, dr: -1, wall: "top", opposite: "bottom" },
  { dc: 1, dr: 0, wall: "right", opposite: "left" },
  { dc: 0, dr: 1, wall: "bottom", opposite: "top" },
  { dc: -1, dr: 0, wall: "left", opposite: "right" },
];

// 生成地图，返回 { cols, rows, cells, walls, cellSize }
// cells[r][c] = { top, right, bottom, left }，true 表示该面有墙
// walls = 去重后的线段数组 [{x1,y1,x2,y2}, ...]，世界坐标
// style: MAZE_STYLES 键（sparse/symmetric/rooms），默认 sparse 向后兼容
// rng: 可选的 [0,1) 随机函数；不传时保持原有 Math.random 行为。
//
// 退化护栏（阶段 28.1）：放墙是概率的、连通修复与对称补齐又只删不加，所以尾巴上能抽出
// 「几乎没有内墙」的图（symmetric×small 实测 0.069% 落在 MAZE_FLOOR.minDensity 以下，
// 其中 3/10万 是一堵内墙都没有的空箱子）。低于下限就重抽，理由与取值见 config 的
// MAZE_FLOOR 注释。重抽走的是同一条完整流程，故其余不变量（双向一致/全连通/出生互达/
// 外框完整/hp 继承/对称镜像）逐条原样成立。
export function generateMaze(cols, rows, style = "sparse", rng = Math.random) {
  const innerEdges = rows * (cols - 1) + cols * (rows - 1);
  const floor = innerEdges * MAZE_FLOOR.minDensity;
  let maze = buildMaze(cols, rows, style, rng);
  // 抽满 tries 次仍不达标就交付手上这张：地图必须有，宁空旷勿无图（实际概率 ≈1e-38）
  for (let i = 1; i < MAZE_FLOOR.tries && innerWallCount(maze.walls) < floor; i++) {
    maze = buildMaze(cols, rows, style, rng);
  }
  return maze;
}

const innerWallCount = (walls) => walls.reduce((n, w) => n + (w.border ? 0 : 1), 0);

// 单次生成（无退化护栏）：generateMaze 的一趟，失败时由它重试
function buildMaze(cols, rows, style, rng) {
  // --- 1) 全开放起步，仅封闭外边界（风格无关的共同起点）---
  const cells = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        top: r === 0,            // 最上行的 top 是外墙
        bottom: r === rows - 1,  // 最下行的 bottom 是外墙
        left: c === 0,           // 最左列的 left 是外墙
        right: c === cols - 1,   // 最右列的 right 是外墙
      });
    }
    cells.push(row);
  }

  // --- 2) 按风格放内墙（都只写 cells，成对写共享墙两面）---
  if (style === "symmetric") {
    fillSymmetric(cells, cols, rows, rng);
  } else if (style === "rooms") {
    fillRooms(cells, cols, rows, rng);
  } else {
    fillSparse(cells, cols, rows, rng);
  }

  // --- 3) 连通性修复（风格无关兜底）---
  ensureConnected(cells, cols, rows);

  // --- 4) 对称风格补对称：ensureConnected 单边敲墙会破坏镜像，
  //        把「本边有墙但镜像边无墙」的也敲掉（删墙只增连通，绝对安全）---
  if (style === "symmetric") {
    enforceSymmetry(cells, cols, rows);
  }

  const walls = buildWallSegments(cells, cols, rows);
  return { cols, rows, cells, walls, cellSize: CELL_SIZE };
}

// —— 风格 1：稀疏格栅（原版风，独立随机每条内部边）——
function fillSparse(cells, cols, rows, rng) {
  // 密度从风格表读（与 symmetric 同一个来源），不直读顶层 WALL_DENSITY——
  // 那样会让 MAZE_STYLES.sparse.density 变成改了没反应的死旋钮
  const density = MAZE_STYLES.sparse.density;
  // 垂直内墙：格 (c,r) 的 right ↔ 格 (c+1,r) 的 left
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      if (rng() < density) {
        cells[r][c].right = true;
        cells[r][c + 1].left = true;
      }
    }
  }
  // 水平内墙：格 (c,r) 的 bottom ↔ 格 (c,r+1) 的 top
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      if (rng() < density) {
        cells[r][c].bottom = true;
        cells[r + 1][c].top = true;
      }
    }
  }
}

// —— 风格 2：180° 中心对称——放一条内墙就同时放它的镜像。
// 镜像映射：竖边 (c,r)（即格(c,r)右边）→ 竖边 (cols-2-c, rows-1-r)；
//           横边 (c,r)（即格(c,r)下边）→ 横边 (cols-1-c, rows-2-r)。
// 自映射的中心边只随机一次自然成立（放=两次幂等）。
function fillSymmetric(cells, cols, rows, rng) {
  const density = MAZE_STYLES.symmetric.density;
  const putV = (c, r) => { cells[r][c].right = true; cells[r][c + 1].left = true; };
  const putH = (c, r) => { cells[r][c].bottom = true; cells[r + 1][c].top = true; };

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const mc = cols - 2 - c, mr = rows - 1 - r;
      // 只处理「前半」代表边（字典序 ≤ 镜像），避免每对被抽两次密度翻倍
      if (r > mr || (r === mr && c > mc)) continue;
      if (rng() < density) { putV(c, r); putV(mc, mr); }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const mc = cols - 1 - c, mr = rows - 2 - r;
      if (r > mr || (r === mr && c > mc)) continue;
      if (rng() < density) { putH(c, r); putH(mc, mr); }
    }
  }
}

// symmetric 的对称修复：ensureConnected 敲墙后，凡「边有墙而镜像边无墙」
// 的把本边也敲掉。只删不加 → 连通性只会更好。
function enforceSymmetry(cells, cols, rows) {
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const mc = cols - 2 - c, mr = rows - 1 - r;
      if (cells[r][c].right && !cells[mr][mc].right) {
        cells[r][c].right = false;
        cells[r][c + 1].left = false;
      }
    }
  }
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols; c++) {
      const mc = cols - 1 - c, mr = rows - 2 - r;
      if (cells[r][c].bottom && !cells[mr][mc].bottom) {
        cells[r][c].bottom = false;
        cells[r + 1][c].top = false;
      }
    }
  }
}

// —— 风格 3：房间 + 走廊（简化 BSP：递归二分到边长 ∈ [roomMin, roomMax]，
// 切缝放满墙，相邻房间的公共缝开门）——
function fillRooms(cells, cols, rows, rng) {
  const { roomMin, roomMax, extraDoorChance } = MAZE_STYLES.rooms;
  const putV = (c, r) => { cells[r][c].right = true; cells[r][c + 1].left = true; };
  const putH = (c, r) => { cells[r][c].bottom = true; cells[r + 1][c].top = true; };
  const cutV = (c, r) => { cells[r][c].right = false; cells[r][c + 1].left = false; };
  const cutH = (c, r) => { cells[r][c].bottom = false; cells[r + 1][c].top = false; };

  // 1) 递归二分出房间矩形（格坐标闭区间）
  const rooms = [];
  const queue = [{ c0: 0, r0: 0, c1: cols - 1, r1: rows - 1 }];
  while (queue.length) {
    const b = queue.pop();
    const w = b.c1 - b.c0 + 1, h = b.r1 - b.r0 + 1;
    if (w <= roomMax && h <= roomMax) { rooms.push(b); continue; }
    // 沿较长边切；切点保证两侧都 ≥ roomMin
    if (w >= h) {
      const cut = b.c0 + roomMin - 1 + Math.floor(rng() * (w - 2 * roomMin + 1));
      // 沿竖缝 cut|cut+1 放满墙
      for (let r = b.r0; r <= b.r1; r++) putV(cut, r);
      queue.push({ c0: b.c0, r0: b.r0, c1: cut, r1: b.r1 });
      queue.push({ c0: cut + 1, r0: b.r0, c1: b.c1, r1: b.r1 });
    } else {
      const cut = b.r0 + roomMin - 1 + Math.floor(rng() * (h - 2 * roomMin + 1));
      for (let c = b.c0; c <= b.c1; c++) putH(c, cut);
      queue.push({ c0: b.c0, r0: b.r0, c1: b.c1, r1: cut });
      queue.push({ c0: b.c0, r0: cut + 1, c1: b.c1, r1: b.r1 });
    }
  }

  // 2) 每段连续墙缝开门：扫全图内墙，对每条「连续实墙段」开 1 扇门
  //    （BSP 切缝会被后续切割截断成多段，按段开门比按房间对开更均匀），
  //    extraDoorChance 概率再开第二扇（长缝双门增加环路，防纯树状单调）。
  const openDoors = (segs, cutFn) => {
    for (const seg of segs) {
      if (!seg.length) continue;
      const first = seg[Math.floor(rng() * seg.length)];
      cutFn(first.c, first.r);
      if (seg.length >= 3 && rng() < extraDoorChance) {
        const second = seg[Math.floor(rng() * seg.length)];
        cutFn(second.c, second.r);
      }
    }
  };
  // 收集竖向连续墙段（同一列 c|c+1 缝上连续的 r）
  const vSegs = [];
  for (let c = 0; c < cols - 1; c++) {
    let cur = [];
    for (let r = 0; r < rows; r++) {
      if (cells[r][c].right) cur.push({ c, r });
      else if (cur.length) { vSegs.push(cur); cur = []; }
    }
    if (cur.length) vSegs.push(cur);
  }
  // 横向同理（同一行 r|r+1 缝上连续的 c）
  const hSegs = [];
  for (let r = 0; r < rows - 1; r++) {
    let cur = [];
    for (let c = 0; c < cols; c++) {
      if (cells[r][c].bottom) cur.push({ c, r });
      else if (cur.length) { hSegs.push(cur); cur = []; }
    }
    if (cur.length) hSegs.push(cur);
  }
  openDoors(vSegs, cutV);
  openDoors(hSegs, cutH);
}

// 拆掉两相邻格之间的墙（cells 侧的原子操作：同时清共享墙的两个面）。
// 生成期的连通修复与运行期的破坏机制共用。
export function knockWall(cells, c, r, d) {
  cells[r][c][d.wall] = false;
  cells[r + d.dr][c + d.dc][d.opposite] = false;
}

// —— 运行期破墙（阶段 17：地雷炸墙）——
// 炸掉爆心 radius 内的全部内墙段，返回被炸掉的墙段数组（供特效/音效）。
// 双数据源原子同步：walls（物理/渲染消费）与 cells（AI BFS 消费）一起改，
// 否则会出现「看不见的墙」或「AI 不走破洞」。border 外墙永不破——
// 这是 border 标记预留至今的第一个消费方。
// 距离语义与地雷波及坦克一致：线段最近点圆心距，隔墙也炸。
// 删墙只会让连通性更好，无需重跑 ensureConnected。
// 注意：此函数整体替换 maze.walls 数组（filter 换新），必须在墙遍历之外调用
// （地雷结算处满足）；smoke 夹具 cells 可为 null，此时跳过 cells 同步。
export function destroyWallsInRadius(maze, cx, cy, radius) {
  const hit = maze.walls.filter((w) => {
    if (w.border) return false;
    const cp = closestPointOnSegment(cx, cy, w.x1, w.y1, w.x2, w.y2);
    return Math.hypot(cx - cp.x, cy - cp.y) < radius;
  });
  return destroyWallSegments(maze, hit);
}

// 删除指定内墙段集合（炸墙/子弹磨穿共用的删除口）：
// 标记 destroyed + cells 同步 + walls 数组 filter 换新。border 段直接跳过。
export function destroyWallSegments(maze, segs) {
  const S = maze.cellSize || CELL_SIZE;
  const destroyed = [];

  for (const w of segs) {
    if (w.border || w.destroyed) continue;
    w.destroyed = true;
    destroyed.push(w);

    // cells 侧同步：内墙段只可能是某格的 top（横墙）或 left（竖墙）——
    // buildWallSegments 里 right/bottom 特例只出现在最后一列/行，那些全是 border。
    if (maze.cells) {
      const c = Math.round(w.x1 / S);
      const r = Math.round(w.y1 / S);
      const horizontal = w.y1 === w.y2;
      const d = DIRS.find((dd) => dd.wall === (horizontal ? "top" : "left"));
      knockWall(maze.cells, c, r, d);
    }
  }

  if (destroyed.length) maze.walls = maze.walls.filter((w) => !w.destroyed);
  return destroyed;
}

// 从 (0,0) 泛洪，标记所有可达格
function floodReachable(cells, cols, rows) {
  const reached = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const stack = [{ c: 0, r: 0 }];
  reached[0][0] = true;
  while (stack.length) {
    const { c, r } = stack.pop();
    for (const d of DIRS) {
      const nc = c + d.dc;
      const nr = r + d.dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (reached[nr][nc]) continue;
      if (cells[r][c][d.wall]) continue; // 这面有墙，过不去
      reached[nr][nc] = true;
      stack.push({ c: nc, r: nr });
    }
  }
  return reached;
}

// 反复泛洪：每轮找一个"不可达但紧邻可达区"的格，敲掉中间墙打通，
// 直到全图连通。这样既保证连通，又只在必要处开口，保持稀疏。
function ensureConnected(cells, cols, rows) {
  // 上限防死循环（理论上每轮至少接通一格）
  for (let guard = 0; guard < cols * rows + 5; guard++) {
    const reached = floodReachable(cells, cols, rows);

    let opened = false;
    let allReached = true;
    for (let r = 0; r < rows && !opened; r++) {
      for (let c = 0; c < cols && !opened; c++) {
        if (reached[r][c]) continue;
        allReached = false;
        // 找一个已可达的邻居，敲掉中间的墙接通
        for (const d of DIRS) {
          const nc = c + d.dc;
          const nr = r + d.dr;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          if (reached[nr][nc]) {
            knockWall(cells, c, r, d);
            opened = true;
            break;
          }
        }
      }
    }
    if (allReached) break; // 全连通，收工
  }
}

// 把格子的墙转成世界坐标线段（去重）。
// 只在"本格"负责 top 和 left，外圈的 right(最后一列)、bottom(最后一行) 另算，
// 避免相邻格共享墙被画两次。
// border 标记：外边界墙（初始化后永不被敲）为 true——穿墙弹只穿内墙，
// 靠这个标记保证物理上不可能飞出场外。
function buildWallSegments(cells, cols, rows) {
  const segs = [];
  const S = CELL_SIZE;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const cell = cells[r][c];
      const x = c * S;
      const y = r * S;

      // 内墙带耐久 hp（子弹撞击侵蚀，归零碎掉）；外墙无 hp 字段（不可破坏）
      if (cell.top)
        segs.push(r === 0
          ? { x1: x, y1: y, x2: x + S, y2: y, border: true }
          : { x1: x, y1: y, x2: x + S, y2: y, border: false, hp: WALL.hp });
      if (cell.left)
        segs.push(c === 0
          ? { x1: x, y1: y, x2: x, y2: y + S, border: true }
          : { x1: x, y1: y, x2: x, y2: y + S, border: false, hp: WALL.hp });
      if (c === cols - 1 && cell.right)
        segs.push({ x1: x + S, y1: y, x2: x + S, y2: y + S, border: true });
      if (r === rows - 1 && cell.bottom)
        segs.push({ x1: x, y1: y + S, x2: x + S, y2: y + S, border: true });
    }
  }

  return segs;
}
