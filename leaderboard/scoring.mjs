const AUXILIARY_FIELDS = ['activeKills', 'suicides', 'decisionTimeouts', 'faults'];
const OUTCOME_FIELDS = { win: 'wins', draw: 'draws', loss: 'losses' };
const RANK_TOLERANCE = 1e-10;

function emptyStats() {
  return { games: 0, plannedGames: 0, wins: 0, draws: 0, losses: 0, points: 0,
    activeKills: 0, suicides: 0, decisionTimeouts: 0, faults: 0,
    matchTimeouts: 0, noWinnerGames: 0, allFaultGames: 0 };
}

function emptyMode() {
  return { ...emptyStats(), opponents: {} };
}

function addResult(stats, player, match, allFault, points) {
  stats.games++;
  stats[OUTCOME_FIELDS[player.outcome]]++;
  stats.points += points;
  for (const field of AUXILIARY_FIELDS) stats[field] += player[field];
  stats.matchTimeouts += Number(match.reason === 'timeout');
  stats.noWinnerGames += Number(!match.winnerId);
  stats.allFaultGames += Number(allFault);
}

function rankStandings(standings, mode) {
  const ranked = standings.filter(row => row.scores[mode] !== null)
    .sort((a, b) => b.scores[mode] - a.scores[mode]);
  let previousScore;
  let previousRank;
  for (let index = 0; index < ranked.length; index++) {
    const score = ranked[index].scores[mode];
    const rank = index > 0 && Math.abs(score - previousScore) <= RANK_TOLERANCE ? previousRank : index + 1;
    ranked[index].ranks[mode] = rank;
    previousScore = score;
    previousRank = rank;
  }
}

export function aggregateSeason(manifest, records, { status = 'evaluating', updatedAt = new Date().toISOString() } = {}) {
  const standings = manifest.roster.map(entrant => ({ ...entrant, status: 'evaluating',
    ranks: { overall: null, duel: null, ffa: null },
    scores: { overall: null, duel: null, ffa: null },
    provisionalScores: { overall: null, duel: null, ffa: null },
    duel: emptyMode(), ffa: emptyMode(), totals: emptyStats() }));
  const byId = new Map(standings.map(row => [row.id, row]));
  for (const row of standings) {
    for (const opponent of standings) {
      if (opponent.id === row.id) continue;
      for (const mode of ['duel', 'ffa']) row[mode].opponents[opponent.id] = { ...emptyStats(), score: null };
    }
  }
  const progress = { completed: records.length, total: manifest.schedule.matches.length,
    duel: { completed: 0, total: 0 }, ffa: { completed: 0, total: 0 } };

  for (const match of manifest.schedule.matches) {
    progress[match.mode].total++;
    for (const id of match.entrants) {
      const row = byId.get(id);
      const mode = row[match.mode];
      mode.plannedGames++;
      row.totals.plannedGames++;
      for (const opponentId of match.entrants) {
        if (opponentId === id) continue;
        const opponent = mode.opponents[opponentId];
        opponent.plannedGames++;
      }
    }
  }

  for (const match of records) {
    progress[match.mode].completed++;
    const allFault = match.players.every(player => player.faults > 0);
    for (const player of match.players) {
      const row = byId.get(player.id);
      const mode = row[match.mode];
      // The runner explicitly marks forfeits as losses, including a match in
      // which every entrant forfeited. winnerId alone cannot establish a draw.
      const points = player.outcome === 'win' ? 100 : match.mode === 'duel' && player.outcome === 'draw' ? 50 : 0;
      addResult(mode, player, match, allFault, points);
      addResult(row.totals, player, match, allFault, points);
      for (const opponentId of match.entrants) {
        if (opponentId !== player.id) addResult(mode.opponents[opponentId], player, match, allFault, points);
      }
    }
  }

  const complete = progress.completed === progress.total;
  for (const row of standings) {
    for (const mode of ['duel', 'ffa']) {
      for (const opponent of Object.values(row[mode].opponents)) {
        opponent.score = opponent.games ? opponent.points / opponent.games : null;
      }
    }
    const playedOpponents = Object.values(row.duel.opponents).filter(opponent => opponent.games > 0);
    const duel = playedOpponents.length
      ? playedOpponents.reduce((sum, opponent) => sum + opponent.score, 0) / playedOpponents.length : null;
    const ffa = row.ffa.games ? row.ffa.points / row.ffa.games : null;
    const overall = duel !== null && ffa !== null ? duel * 0.5 + ffa * 0.5 : null;
    row.provisionalScores = { overall, duel, ffa };
    if (complete) {
      row.status = 'complete';
      row.scores = { overall, duel, ffa };
    }
  }
  if (complete) for (const mode of ['overall', 'duel', 'ffa']) rankStandings(standings, mode);

  const { roster, schedule, ...season } = manifest;
  return { schemaVersion: 1, season: { ...season, schedule: schedule.summary },
    updatedAt, status: complete ? 'complete' : status, progress, standings };
}


