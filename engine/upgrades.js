// ============================================================
// upgrades.js — 波次生存的玩家强化「波间三选一」（纯数据 + 纯函数）
// 零浏览器依赖（只 import config 常量），smoke 与 arena 可直接断言/跑分。
//
// 数值挂点是 tank.mods：中性初值一处定义（neutralMods），Tank 构造即中性，
// 所以 pvp / pve / challenge 三个模式一个字不用改——所有算式退化为原常量。
//
// 设计约束（想加卡之前先读完这段）：
// 1. **不做「多一条命 / 装甲挡两发」**。一发致死是全游戏最核心的规则，物理、
//    AI 决策、慢镜、结算全建立在它上面。红线，不是留白。
// 2. 卡面必须落在**真的有约束力**的旋钮上。三张已否掉的卡与理由：
//    - 「开火冷却 -x%」：BULLET.cooldown 只有 0.15s，config 里写明「仅压到极小值
//      防手滑狂点，几乎无感」；玩家真正的火力闸门是 maxAlive(5) × lifetime(10s)。
//      减冷却是一张空卡 → 换成 ammo（同屏弹上限 +1）。
//    - 「子弹寿命 +x s」：自己的弹活得越久，占着 maxAlive 的槽位越久，还更容易
//      反弹回来自杀——净负收益，不是取舍。
//    - 「每波开局白送护盾」：ai.js 的 avoidMode 在**对手**有盾时避战，于是每波
//      开场都有几秒空转，敌人趁这几秒去捡道具武装自己 → 换成 shieldUp
//      （拾取护盾时延长时间，只在玩家真的捡到盾时才生效）。
// 3. 敌人侧词条不在这里，在 waves.js 的 eliteSpec/applyElite（那是波次曲线的一部分）。
// ============================================================

import { UPGRADE, POWERUP } from "./config.js";

// 中性 mods 工厂。**加字段必须同时改这里**——smoke 有一条断言把
// 「满层后 tank.mods 的键集合」与本函数的键集合逐项对死，漏登记会红。
export function neutralMods() {
  return {
    speed: 1,        // 移速倍率（tank.js 消费）
    turn: 1,         // 转速倍率
    maxAlive: 0,     // 同屏子弹上限增量
    erode: 0,        // 子弹每次反弹的额外削墙点数（bullet.erodePower = 1 + erode）
    selfSafe: false, // 自己的跳弹不再伤害自己
    scatterBonus: 0, // 拾取散射时的额外发数
    laserBonus: 0,
    mineBonus: 0,
    shieldBonus: 0,  // 拾取护盾时的额外持续秒数
    supplyBonus: 0,  // 每波开局补给数 +N，同时场上道具上限 +N
    salvage: 0,      // 击杀掉落道具的概率
  };
}

// 强化卡池。requires(ctx) 为假的卡不进抽卡池——菜单里道具可以全关、地形可以关，
// 那时武器加成卡与破障卡是空卡，出了就是让玩家白抽一张。
// ctx: { types: Set<string> 玩家启用的道具类型, wallBreak: boolean }
export const UPGRADES = [
  {
    id: "ammo",
    label: "弹仓扩容",
    desc: `同屏子弹上限 +${UPGRADE.ammoAdd}`,
    cap: 2,
    apply: (m) => { m.maxAlive += UPGRADE.ammoAdd; },
  },
  {
    id: "turn",
    label: "转向伺服",
    desc: `转向速度 ×${UPGRADE.turnMul}`,
    cap: 2,
    apply: (m) => { m.turn *= UPGRADE.turnMul; },
  },
  {
    id: "speed",
    label: "履带强化",
    desc: `移动速度 ×${UPGRADE.speedMul}`,
    cap: 3,
    apply: (m) => { m.speed *= UPGRADE.speedMul; },
  },
  {
    id: "ricochet",
    label: "跳弹免疫",
    desc: "自己的跳弹不再打死自己",
    cap: 1,
    apply: (m) => { m.selfSafe = true; },
  },
  {
    id: "drill",
    label: "破障弹头",
    desc: `子弹每次反弹多削 ${UPGRADE.erodeAdd} 点墙`,
    cap: 2,
    requires: (ctx) => !!ctx.wallBreak,
    apply: (m) => { m.erode += UPGRADE.erodeAdd; },
  },
  {
    id: "scatterUp",
    label: "散射扩容",
    desc: `拾取散射时多给 ${UPGRADE.scatterAdd} 发`,
    cap: 2,
    requires: (ctx) => ctx.types.has("scatter"),
    apply: (m) => { m.scatterBonus += UPGRADE.scatterAdd; },
  },
  {
    id: "laserUp",
    label: "激光扩容",
    desc: `拾取激光时多给 ${UPGRADE.laserAdd} 发`,
    cap: 2,
    requires: (ctx) => ctx.types.has("laser"),
    apply: (m) => { m.laserBonus += UPGRADE.laserAdd; },
  },
  {
    id: "mineUp",
    label: "雷袋扩容",
    desc: `拾取地雷时多给 ${UPGRADE.mineAdd} 颗`,
    cap: 2,
    requires: (ctx) => ctx.types.has("mine"),
    apply: (m) => { m.mineBonus += UPGRADE.mineAdd; },
  },
  {
    id: "shieldUp",
    label: "护盾强化",
    desc: `拾取护盾时多持续 ${UPGRADE.shieldAdd} 秒`,
    cap: 2,
    requires: (ctx) => ctx.types.has("shield"),
    apply: (m) => { m.shieldBonus += UPGRADE.shieldAdd; },
  },
  {
    id: "supply",
    label: "补给增量",
    desc: `每波开局多刷 ${UPGRADE.supplyAdd} 个道具`,
    cap: 2,
    requires: (ctx) => ctx.types.size > 0,
    apply: (m) => { m.supplyBonus += UPGRADE.supplyAdd; },
  },
  {
    id: "salvage",
    label: "战场回收",
    desc: `击杀时 ${Math.round(UPGRADE.salvageAdd * 100)}% 概率掉落道具`,
    cap: 2,
    requires: (ctx) => ctx.types.size > 0,
    apply: (m) => { m.salvage += UPGRADE.salvageAdd; },
  },
];

// 卡池总层数（抽到这个数就没卡可抽了，之后静默跳过抽卡——
// 那之后的波次是刻意留的「只涨难度不涨强度」收尾段：一条命模式总得有个东西来终结这局）
export const TOTAL_STACKS = UPGRADES.reduce((s, u) => s + u.cap, 0);

const byId = new Map(UPGRADES.map((u) => [u.id, u]));
export const upgradeById = (id) => byId.get(id) || null;

// taken 可以是 Map 也可以是普通对象（arena 里图省事用对象）
const layersOf = (taken, id) => {
  if (!taken) return 0;
  const v = taken instanceof Map ? taken.get(id) : taken[id];
  return typeof v === "number" && v > 0 ? Math.floor(v) : 0;
};
const setLayers = (taken, id, n) => {
  if (taken instanceof Map) taken.set(id, n);
  else taken[id] = n;
};

// 某张卡此刻是否可抽：没满层 + requires 满足
export function isOfferable(card, taken, ctx = {}) {
  if (!card) return false;
  if (layersOf(taken, card.id) >= card.cap) return false;
  if (card.requires && !card.requires({ types: new Set(), wallBreak: false, ...ctx })) return false;
  return true;
}

// 抽 count 张不重复的可选卡。可选卡不足就返回剩下的（可能是空数组）。
// rand 可注入 → smoke 可断言确定性，arena 可复现。
export function pickOffers(taken, ctx = {}, count = UPGRADE.offers, rand = Math.random) {
  const pool = UPGRADES.filter((u) => isOfferable(u, taken, ctx));
  const out = [];
  // 部分 Fisher-Yates：每次从剩余池里等概率抽一张，抽出即移出（天然不重复）
  for (let i = 0; i < count && pool.length; i++) {
    const k = Math.min(pool.length - 1, Math.floor(Math.max(0, Math.min(1, rand())) * pool.length));
    out.push(pool.splice(k, 1)[0]);
  }
  return out;
}

// 施加一张卡到 tank.mods，并把层数记进 taken。已满层/无此卡返回 false（不抛——
// UI 与 arena 都可能重复点，静默拒绝比崩掉好）。
export function applyUpgrade(tank, id, taken) {
  const card = upgradeById(id);
  if (!card || !tank || !tank.mods) return false;
  const n = layersOf(taken, id);
  if (n >= card.cap) return false;
  card.apply(tank.mods);
  setLayers(taken, id, n + 1);
  return true;
}

// —— 下面两个是「供给类」卡的共同出口：main 与 arena 必须读同一份算式，
// 否则波次跑分跑的是一个不存在的游戏。
// 场上道具上限：PowerupSpawner 的 update/forceSpawn 两道门都读这个值。
// 没有它的话 supply 卡是一张静默空卡——场上已有 maxOnField 个未捡道具时，
// forceSpawn 直接 return false，多刷的补给凭空消失。
export const fieldCapOf = (mods) => POWERUP.maxOnField + (mods?.supplyBonus ?? 0);
// 开波强制补给数（spec.supply 来自 waveSpec）
export const supplyCountOf = (spec, mods) => (spec?.supply ?? 1) + (mods?.supplyBonus ?? 0);
