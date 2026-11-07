// Constructed three-player probes: original generated maze and physics; only
// starting poses/cooldowns and a held laser are assigned to create the situation.
import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { loadEntrant, runMatch, summarize, RULES } from '../../matches/run.mjs';

const args = process.argv.slice(2);
const value = (key, fallback) => { const i = args.indexOf(key); return i < 0 ? fallback : args[i + 1]; };
const candidates = [loadEntrant('candidate', 'bots/astra-g3-imperator.js'),
  loadEntrant('candidate', value('--candidate', 'bots/astra-g4-proteus.js'))];
const labels = ['Astra Gen3', 'Astra Gen4'];
const rivals = [loadEntrant('duelist', value('--mentor', 'bots/astra-g3-imperator.js')),
  loadEntrant('third-party', 'bots/opus-g1-prescience.js')];
const configs = [
  { name: 'side-intervention', firstAngle: 0, firstDistance: 112, thirdAngle: Math.PI / 2,
    thirdDistance: 200, thirdCooldown: 0.35, laser: false },
  { name: 'two-sided-crossfire', firstAngle: -Math.PI / 3, firstDistance: 150, thirdAngle: Math.PI / 3,
    thirdDistance: 150, thirdCooldown: 0.15, laser: false },
  { name: 'laser-intervention', firstAngle: 0, firstDistance: 112, thirdAngle: Math.PI / 2,
    thirdDistance: 220, thirdCooldown: 0.8, laser: true },
];

function clearance(p, walls) {
  let distance = Infinity;
  for (const w of walls) {
    const x = Math.max(Math.min(w.x1, w.x2), Math.min(p.x, Math.max(w.x1, w.x2)));
    const y = Math.max(Math.min(w.y1, w.y2), Math.min(p.y, Math.max(w.y1, w.y2)));
    distance = Math.min(distance, Math.hypot(x - p.x, y - p.y));
  }
  return distance;
}

function setup(config) {
  return world => {
    let poses;
    search: for (let r = 1; r < world.maze.rows - 1; r++) for (let c = 1; c < world.maze.cols - 1; c++) {
      for (const angle of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const self = { x: (c + 0.5) * world.maze.cellSize, y: (r + 0.5) * world.maze.cellSize, angle };
        const target = (offset, distance) => ({ x: self.x + Math.cos(angle + offset) * distance,
          y: self.y + Math.sin(angle + offset) * distance, angle: angle + offset + Math.PI });
        const proposed = [self, target(config.firstAngle, config.firstDistance), target(config.thirdAngle, config.thirdDistance)];
        const clear = proposed.slice(1).every(p => {
          for (let t = 0; t <= 1; t += 0.025) if (clearance({ x: self.x + (p.x - self.x) * t,
            y: self.y + (p.y - self.y) * t }, world.maze.walls) < 30) return false;
          return true;
        });
        if (clear) { poses = proposed; break search; }
      }
    }
    if (!poses) throw new Error(`No open placement in generated map for ${config.name}, seed ${world.seed}`);
    for (const [index, id] of ['candidate', 'duelist', 'third-party'].entries()) {
      const actor = world.actors.find(a => a.id === id);
      Object.assign(actor.tank, poses[index]);
      actor.tank.cooldown = index === 2 ? config.thirdCooldown : 0;
      if (index === 2 && config.laser) actor.tank.laserShots = 3;
    }
    return { ...config, note: 'Constructed starting state; original generated walls/physics/opponent scripts unchanged.', poses };
  };
}

const matches = [], seed = Number(value('--seed', '6102'));
for (const config of configs) for (const [index, candidate] of candidates.entries()) {
  const match = runMatch([candidate, ...rivals], seed, { setup: setup(config) });
  match.candidateVersion = labels[index];
  matches.push(match);
  console.log(JSON.stringify({ scenario: config.name, candidate: labels[index], winner: match.winnerId,
    reason: match.reason, candidateStats: match.players.find(p => p.id === 'candidate'),
    candidateDeath: match.events.find(e => e.type === 'death' && e.victimId === 'candidate') ?? null,
    faults: match.faults }));
}
const report = { protocol: { type: 'constructed three-player scenarios; not natural-match win-rate evidence',
  seed, rules: RULES, decisionMs: 50, physicsHz: 60, observation: 'unchanged public observe()',
  candidates: candidates.map(c => basename(c.filename)), opponents: rivals.map(r => basename(r.filename)) },
  matches, summary: Object.fromEntries(labels.map(label => [label, summarize(matches.filter(m => m.candidateVersion === label))])) };
writeFileSync(value('--out', 'local-data/scenarios.json'), JSON.stringify(report, null, 2) + '\n');
