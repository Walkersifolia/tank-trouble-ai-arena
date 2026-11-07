const DEFAULT_CONFIG = { duelSeeds: 50, ffaGamesPerEntrant: 200, seedStart: 20261107 };

const rotate = (values, offset) => [...values.slice(offset), ...values.slice(0, offset)];
const serialId = (mode, index) => `${mode}-${String(index + 1).padStart(6, '0')}`;

// GF(4) = GF(2)[x] / (x² + x + 1); addition is bitwise XOR.
function multiply4(left, right) {
  let product = 0;
  while (right) {
    if (right & 1) product ^= left;
    right >>= 1;
    left <<= 1;
    if (left & 4) left ^= 7;
  }
  return product;
}

function affineLines16() {
  const lines = [];
  for (let slope = 0; slope < 4; slope++) {
    for (let intercept = 0; intercept < 4; intercept++) {
      lines.push(Array.from({ length: 4 }, (_, x) => x * 4 + (multiply4(slope, x) ^ intercept)));
    }
  }
  for (let x = 0; x < 4; x++) lines.push(Array.from({ length: 4 }, (_, y) => x * 4 + y));
  return lines;
}

// All cyclic shifts of one four-point block give every entrant four games,
// once in each seat. Compare all blocks containing 0, minimizing cumulative
// pair-count squares; rotate deterministically between equally good choices.
function cyclicBlock(size, round, distanceCounts) {
  let bestScore = Infinity;
  let bestBlocks = [];
  for (let first = 1; first < size - 2; first++) {
    for (let second = first + 1; second < size - 1; second++) {
      for (let third = second + 1; third < size; third++) {
        const block = [0, first, second, third];
        const increments = Array(distanceCounts.length).fill(0);
        for (let a = 0; a < 4; a++) {
          for (let b = a + 1; b < 4; b++) {
            const difference = block[b] - block[a];
            const distance = Math.min(difference, size - difference);
            increments[distance] += distance * 2 === size ? 2 : 1;
          }
        }
        let score = 0;
        for (let distance = 1; distance < distanceCounts.length; distance++) {
          const pairs = distance * 2 === size ? size / 2 : size;
          score += pairs * (distanceCounts[distance] + increments[distance]) ** 2;
        }
        if (score < bestScore) {
          bestScore = score;
          bestBlocks = [{ block, increments }];
        } else if (score === bestScore) bestBlocks.push({ block, increments });
      }
    }
  }
  const chosen = bestBlocks[round % bestBlocks.length];
  for (let distance = 1; distance < distanceCounts.length; distance++) {
    distanceCounts[distance] += chosen.increments[distance];
  }
  return chosen.block;
}

export function createSchedule(roster, configuration = {}) {
  const config = { ...DEFAULT_CONFIG, ...configuration };
  const ids = roster.map(entrant => entrant.id);
  const size = ids.length;
  if (size < 4) throw new Error('官方联赛需要至少 4 名公开选手，四人混战不会重复加入同一选手。');

  const duel = [];
  for (let seedIndex = 0; seedIndex < config.duelSeeds; seedIndex++) {
    for (let first = 0; first < size; first++) {
      for (let second = first + 1; second < size; second++) {
        const pair = [ids[first], ids[second]];
        for (let rotation = 0; rotation < 2; rotation++) {
          duel.push({ id: serialId('duel', duel.length), mode: 'duel',
            seed: config.seedStart + seedIndex, rotation, entrants: rotate(pair, rotation) });
        }
      }
    }
  }

  const actualGamesPerEntrant = Math.ceil(config.ffaGamesPerEntrant / 4) * 4;
  const adjustments = [];
  if (actualGamesPerEntrant !== config.ffaGamesPerEntrant) {
    adjustments.push(`每名选手请求 ${config.ffaGamesPerEntrant} 局混战；为使四个出生位均衡，实际向上调整为 ${actualGamesPerEntrant} 局（4 的倍数）。`);
  }
  const averagePairGames = actualGamesPerEntrant * 3 / (size - 1);
  if (!Number.isInteger(averagePairGames)) {
    adjustments.push(`${size} 名选手每人参加 ${actualGamesPerEntrant} 局混战，每局遇到 3 名对手，对其他每名选手平均同场 ${actualGamesPerEntrant}×3÷${size - 1}=${averagePairGames} 次；此数不是整数，无法让所有选手对的同场次数完全相等。保留每人场次与四个出生位均衡，实际配对次数公开为 pairMin / pairMax。`);
  }
  const ffa = [];
  let nextSeed = config.seedStart + config.duelSeeds;
  const fullCycles = size === 16 ? Math.floor(actualGamesPerEntrant / 20) : 0;
  for (let cycle = 0; cycle < fullCycles; cycle++) {
    for (const line of affineLines16()) {
      const group = line.map(index => ids[index]);
      const seed = nextSeed++;
      for (let rotation = 0; rotation < 4; rotation++) {
        ffa.push({ id: serialId('ffa', ffa.length), mode: 'ffa', seed,
          rotation, entrants: rotate(group, rotation) });
      }
    }
  }
  const remainderRounds = (actualGamesPerEntrant - fullCycles * 20) / 4;
  const distanceCounts = Array(Math.floor(size / 2) + 1).fill(0);
  for (let round = 0; round < remainderRounds; round++) {
    const block = cyclicBlock(size, round, distanceCounts);
    const seed = nextSeed++;
    for (let shift = 0; shift < size; shift++) {
      ffa.push({ id: serialId('ffa', ffa.length), mode: 'ffa', seed, rotation: 0,
        entrants: block.map(offset => ids[(offset + shift) % size]) });
    }
  }

  const pairCounts = Array.from({ length: size }, () => Array(size).fill(0));
  const indices = new Map(ids.map((id, index) => [id, index]));
  for (const match of ffa) {
    for (let first = 0; first < 4; first++) {
      for (let second = first + 1; second < 4; second++) {
        const a = indices.get(match.entrants[first]);
        const b = indices.get(match.entrants[second]);
        pairCounts[Math.min(a, b)][Math.max(a, b)]++;
      }
    }
  }
  const pairValues = pairCounts.flatMap((counts, index) => counts.slice(index + 1));

  // Proportional interleaving exposes both modes immediately while retaining
  // the fixed order, seed and seat assignment of every scheduled match.
  const matches = [];
  let duelIndex = 0;
  let ffaIndex = 0;
  while (duelIndex < duel.length || ffaIndex < ffa.length) {
    if (ffaIndex === ffa.length || (duelIndex < duel.length && duelIndex * ffa.length <= ffaIndex * duel.length)) {
      matches.push(duel[duelIndex++]);
    } else matches.push(ffa[ffaIndex++]);
  }

  return { matches, summary: {
    duel: { games: duel.length, seedsPerPair: config.duelSeeds, gamesPerPair: config.duelSeeds * 2 },
    ffa: { games: ffa.length, requestedGamesPerEntrant: config.ffaGamesPerEntrant,
      actualGamesPerEntrant, spawnGamesPerEntrant: Array(4).fill(actualGamesPerEntrant / 4),
      pairMin: Math.min(...pairValues), pairMax: Math.max(...pairValues), adjustments,
      design: size === 16 ? 'AG(2,4) 仿射直线完整周期；不足周期使用按配对距离均衡的循环移位四人组。'
        : '按配对距离均衡的循环移位四人组；每轮每名选手参加 4 局，四个出生位各 1 局。' }
  } };
}

