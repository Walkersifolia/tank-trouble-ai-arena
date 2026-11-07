// 借鉴 PR 的独立随机流：地图、出生、结算顺序、道具和每位 AI 互不消耗对方的序列。
function mix32(value) {
  let x = value >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export function deriveSeed(seed, streamName) {
  const name = String(streamName);
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) hash = Math.imul(hash ^ name.charCodeAt(i), 0x01000193);
  return mix32((seed >>> 0) ^ mix32(hash));
}

// seed 是 uint32。返回 [0, 1) 的 sfc32 随机函数；函数自包含，
// 沙箱将同一实现传入 Worker，无需新增模块加载权限。
export function createRng(seed) {
  const mix = value => {
    let x = value >>> 0;
    x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
    x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
    return (x ^ (x >>> 16)) >>> 0;
  };
  let a = mix(seed ^ 0x9e3779b9), b = mix(seed ^ 0x243f6a88), c = mix(seed ^ 0xb7e15162), d = 1;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 0x100000000;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}
