// Browser-local AI results from the shared arena engine's completed matches.
export function recordAIResult(stats, entrants, result, recording) {
  for (const entrant of entrants) {
    const player = result.players.find(p => p.id === entrant.id);
    const record = stats[entrant.recordId] ||= { name: entrant.name, played: 0, wins: 0, losses: 0, draws: 0, kills: 0, suicides: 0, timeouts: 0 };
    const outcome = player.forfeit ? 'losses' : result.winnerId === entrant.id ? 'wins' : result.winnerId ? 'losses' : 'draws';
    record.name = entrant.name; record.played++; record[outcome]++; record.kills += player.kills;
    record.suicides += recording.events.filter(event => event.type === 'death' && event.victimId === entrant.id && event.selfHit).length;
    if (player.forfeit?.timeout) record.timeouts++;
  }
}

function node(tag, text) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
}

export function renderLocalRanking(stats, sort, containers) {
  const rate = player => player.played ? player.wins / player.played : 0;
  const players = Object.values(stats).sort((a, b) => sort === 'rate'
    ? rate(b) - rate(a) || b.wins - a.wins : b.wins - a.wins || rate(b) - rate(a));
  for (const container of containers) {
    const table = node('table'), head = node('thead'), row = node('tr'), body = node('tbody');
    for (const label of ['选手', '局', '胜', '负', '平', '击杀', '自杀', '超时', '胜率']) row.append(node('th', label));
    head.append(row);
    for (const player of players) {
      const line = node('tr');
      for (const value of [player.name, player.played, player.wins, player.losses, player.draws, player.kills, player.suicides, player.timeouts, `${(rate(player) * 100).toFixed(1)}%`]) line.append(node('td', value));
      body.append(line);
    }
    table.append(head, body); container.replaceChildren(table);
  }
}
