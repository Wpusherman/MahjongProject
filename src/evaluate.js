(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const E = (MJ.evaluate = { version: 'eval-v1' });
  const stats = (values) => {
    const n = values.length;
    if (!n) return { n: 0, mean: 0, sd: 0, se: 0, ci95: 0 };
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const variance = n > 1 ? values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
    const sd = Math.sqrt(variance), se = sd / Math.sqrt(n);
    return { n, mean, sd, se, ci95: 1.96 * se };
  };
  const rate = (rows, key) => {
    const n = rows.length, p = n ? rows.filter((r) => r[key]).length / n : 0;
    return { n, mean: p, se: n ? Math.sqrt(p * (1 - p) / n) : 0, ci95: n ? 1.96 * Math.sqrt(p * (1 - p) / n) : 0 };
  };

  // One seed = the same wall replayed with the candidate in each of the four seats.
  E.runSeed = async function (options) {
    const seed = options.seed >>> 0;
    const candidateLevel = options.candidateLevel || options.level || 'standard';
    const baselineLevel = options.baselineLevel || options.level || 'standard';
    const candidateWeights = options.candidateWeights || MJ.ai.weights;
    const baselineWeights = options.baselineWeights || MJ.ai.weights;
    const rankConfig = options.rankConfig || 'tenhou';
    const dealer = options.dealer != null ? options.dealer : seed % 4;
    const rows = [];
    for (let candidateSeat = 0; candidateSeat < 4; candidateSeat++) {
      const agents = [0, 1, 2, 3].map((seat) => MJ.ai.create(seat, {
        level: seat === candidateSeat ? candidateLevel : baselineLevel,
        weights: seat === candidateSeat ? candidateWeights : baselineWeights
      }));
      const game = new MJ.Game({ agents, rng: MJ.core.rng(seed) });
      const result = await game.playHand({ roundWind: 27, dealer, honba: 0, riichiSticks: 0,
        scores: [25000, 25000, 25000, 25000], hand: dealer, mode: 'tonpu' });
      const scores = game.players.map((p) => p.score);
      const settled = MJ.rank.finalResult(scores, rankConfig);
      let calls = 0, riichis = 0;
      for (const e of game.recording.events) {
        if ((e.type === 'call' || e.type === 'kan') && e.seat === candidateSeat) calls++;
        if (e.type === 'riichi' && e.seat === candidateSeat) riichis++;
      }
      const win = result.type === 'win' && result.winner === candidateSeat;
      const tsumoWin = win && !!result.tsumo;
      const ronWin = win && !result.tsumo;
      const dealIn = result.type === 'win' && !result.tsumo && result.loser === candidateSeat;
      rows.push({ seed, candidateSeat, rank: settled.ranks[candidateSeat], points: settled.points[candidateSeat],
        scores: scores.slice(), scoreDelta: scores[candidateSeat] - 25000, win, tsumoWin, ronWin, dealIn,
        called: calls > 0, riichi: riichis > 0, calls, riichis, result: result.type });
    }
    return rows;
  };

  E.runSeeds = async function (options) {
    const count = options.seeds != null ? options.seeds : options.count || 0;
    const base = options.seed || 0;
    const rows = [];
    for (let i = 0; i < count; i++) rows.push(...await E.runSeed(Object.assign({}, options, { seed: base + i })));
    return rows;
  };

  E.summarize = function (rows, options = {}) {
    const games = rows.length, seedGroups = new Map();
    for (const row of rows) {
      if (!seedGroups.has(row.seed)) seedGroups.set(row.seed, []);
      seedGroups.get(row.seed).push(row);
    }
    const bySeedPoints = [...seedGroups.values()].map((group) => group.reduce((n, r) => n + r.points, 0) / group.length);
    const bySeedPlacement = [...seedGroups.values()].map((group) => group.reduce((n, r) => n + r.rank, 0) / group.length);
    const distribution = [0, 0, 0, 0];
    for (const row of rows) distribution[row.rank - 1]++;
    return {
      version: E.version, games, seeds: seedGroups.size,
      avgRankPoints: stats(rows.map((r) => r.points)),
      avgPlacement: stats(rows.map((r) => r.rank)),
      avgScoreDelta: stats(rows.map((r) => r.scoreDelta)),
      seedClusterRankPoints: stats(bySeedPoints),
      seedClusterPlacement: stats(bySeedPlacement),
      rankDistribution: distribution.map((n) => ({ count: n, rate: games ? n / games : 0 })),
      winRate: rate(rows, 'win'), tsumoRate: rate(rows, 'tsumoWin'), ronRate: rate(rows, 'ronWin'),
      dealInRate: rate(rows, 'dealIn'), callRate: rate(rows, 'called'), riichiRate: rate(rows, 'riichi'),
      rankConfig: options.rankConfig || 'tenhou'
    };
  };

  // Pairwise seed-cluster difference (candidate - control) for non-zero-sum rank configs.
  E.pairedDelta = function (candidateRows, controlRows) {
    const group = (rows) => {
      const map = new Map();
      for (const row of rows) {
        if (!map.has(row.seed)) map.set(row.seed, []);
        map.get(row.seed).push(row);
      }
      return map;
    };
    const a = group(candidateRows), b = group(controlRows), diffs = [];
    for (const [seed, rows] of a) {
      const other = b.get(seed);
      if (!other || !other.length) continue;
      const mean = (groupRows) => groupRows.reduce((n, r) => n + r.points, 0) / groupRows.length;
      diffs.push(mean(rows) - mean(other));
    }
    return stats(diffs);
  };

  E.formatReport = function (report, extra = {}) {
    const pct = (v) => (v * 100).toFixed(1) + '%';
    const ci = (s) => `[${(s.mean - s.ci95).toFixed(2)}, ${(s.mean + s.ci95).toFixed(2)}]`;
    const lines = [
      `seeds ${report.seeds} / games ${report.games} / rank ${report.rankConfig}`,
      `avg rank points ${report.avgRankPoints.mean.toFixed(2)} (95% CI ${ci(report.avgRankPoints)})`,
      `seed-cluster rank points ${report.seedClusterRankPoints.mean.toFixed(2)} (95% CI ${ci(report.seedClusterRankPoints)})`,
      `avg placement ${report.avgPlacement.mean.toFixed(3)} (95% CI ${ci(report.avgPlacement)})`,
      `rank distribution: ${report.rankDistribution.map((r, i) => `${i + 1}位 ${pct(r.rate)}`).join(' / ')}`,
      `win ${pct(report.winRate.mean)} (tsumo ${pct(report.tsumoRate.mean)} / ron ${pct(report.ronRate.mean)}) | deal-in ${pct(report.dealInRate.mean)} | call ${pct(report.callRate.mean)} | riichi ${pct(report.riichiRate.mean)}`
    ];
    if (extra.control) lines.push(`control seed-cluster ${extra.control.seedClusterRankPoints.mean.toFixed(2)}`);
    if (extra.delta) lines.push(`paired delta ${extra.delta.mean.toFixed(2)} (95% CI [${(extra.delta.mean - extra.delta.ci95).toFixed(2)}, ${(extra.delta.mean + extra.delta.ci95).toFixed(2)}], seeds ${extra.delta.n})`);
    if (extra.gamesPerSecond != null) lines.push(`throughput ${extra.gamesPerSecond.toFixed(1)} games/s (${(extra.elapsedMs / 1000).toFixed(1)} s)`);
    return lines.join('\n');
  };
})();
