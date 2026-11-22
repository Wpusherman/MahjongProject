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
  // At equal scores rankBias is inert, so candidate and baseline play identically;
  // the four replayed games are then the same deal, and the candidate's four rank
  // points are the four seats of that one deal (sum 0). A rotating handicap keeps
  // the wall fixed while the candidate's standings differ by seat, so the four
  // games genuinely differ and their mean is a valid per-seed cluster.
  E.runSeed = async function (options) {
    const seed = options.seed >>> 0;
    const candidateLevel = options.candidateLevel || options.level || 'standard';
    const baselineLevel = options.baselineLevel || options.level || 'standard';
    const candidateWeights = options.candidateWeights || MJ.ai.weights;
    const baselineWeights = options.baselineWeights || MJ.ai.weights;
    const rankConfig = options.rankConfig || 'tenhou';
    // Full-match duplicate evaluation: with a single hand all seats start on the
    // same score, so rank-point pressure can barely move. A tonpu/hanchan match
    // carries scores across hands and exercises the standings-aware part of the AI.
    const matchMode = options.matchMode === 'hanchan' ? 'hanchan' : options.matchMode === 'tonpu' ? 'tonpu' : null;
    const maxDeals = matchMode ? (matchMode === 'hanchan' ? 16 : 8) : 1;
    const seatMode = options.candidateSeatMode == null ? 'rotate' : String(options.candidateSeatMode);
    const seats = seatMode === 'rotate' ? [0, 1, 2, 3]
      : [seatMode === 'seed' ? seed % 4 : Math.max(0, Math.min(3, Number(seatMode) | 0))];
    // Keep the candidate seat and the first dealer independent; otherwise the
    // candidate would always be the dealer when both use seed % 4.
    const dealer = options.dealer != null ? options.dealer
      : seatMode === 'seed' ? Math.floor(seed / 16) % 4 : seed % 4;
    // A start state captured from a real Tenhou log (scores, dealer, honba,
    // riichi sticks) replaces the synthetic opening. This is the mode used to
    // validate rankBias: the standings are already uneven and hands are left.
    const startStates = Array.isArray(options.startStates) ? options.startStates : [];
    const startState = startStates.length ? startStates[seed % startStates.length] : null;
    const rows = [];
    for (const candidateSeat of seats) {
      const agents = [0, 1, 2, 3].map((seat) => MJ.ai.create(seat, {
        level: seat === candidateSeat ? candidateLevel : baselineLevel,
        weights: seat === candidateSeat ? candidateWeights : baselineWeights,
        rootCandidates: options.rootCandidates,
        rankModel: seat === candidateSeat ? options.candidateRankModel : options.baselineRankModel,
        rankBias: seat === candidateSeat ? options.candidateRankBias !== false : options.baselineRankBias !== false
      }));
      const rng = MJ.core.rng(seed);
      // Rank-point pressure is inactive when all four seats start equal. A
      // rotating handicap gives every seed a different standing while keeping
      // the candidate and control on exactly the same scores.
      const rotate = (arr, n) => arr.map((_, i) => arr[(i + n) % 4]);
      const baseScores = startState && Array.isArray(startState.scores) && startState.scores.length === 4
        ? startState.scores.map(Number)
        : Array.isArray(options.initialScores) && options.initialScores.length === 4
          ? options.initialScores.slice()
          : options.scorePattern === 'even'
            ? [25000, 25000, 25000, 25000]
            : rotate([40000, 25000, 20000, 15000], Math.floor(seed / 4) % 4);
      const startHand = startState && Number.isInteger(startState.handIndex) ? Math.max(0, Math.min(7, startState.handIndex)) : 0;
      const startDealer = startState && Number.isInteger(startState.dealer) ? startState.dealer : dealer;
      const startHonba = startState ? Number(startState.honba) || 0 : 0;
      const startSticks = startState ? Number(startState.riichiSticks) || 0 : 0;
      let scores = baseScores.slice(), sticks = startSticks;
      // Keep the original match length when using a captured South-3/4 state,
      // so handsLeft and rank pressure reflect the real remaining hands.
      const openingMode = matchMode || (startState && startState.mode === 'hanchan' ? 'hanchan' : 'tonpu');
      let state = { hand: startHand, dealer: startDealer, honba: startHonba, mode: openingMode };
      let calls = 0, riichis = 0, win = false, tsumoWin = false, ronWin = false, dealIn = false, result = null, deals = 0;
      for (let deal = 0; deal < maxDeals; deal++) {
        const game = new MJ.Game({ agents, rng });
        const handResult = await game.playHand({ roundWind: 27 + Math.floor(state.hand / 4), dealer: state.dealer,
          honba: state.honba, riichiSticks: sticks, scores: scores.slice(), hand: state.hand, mode: state.mode,
          rankConfig });
        deals++;
        result = handResult;
        scores = game.players.map((p) => p.score);
        sticks = game.riichiSticks;
        for (const e of game.recording.events) {
          if ((e.type === 'call' || e.type === 'kan') && e.seat === candidateSeat) calls++;
          if (e.type === 'riichi' && e.seat === candidateSeat) riichis++;
        }
        const handWin = handResult.type === 'win' && handResult.winner === candidateSeat;
        win = win || handWin;
        tsumoWin = tsumoWin || (handWin && !!handResult.tsumo);
        ronWin = ronWin || (handWin && !handResult.tsumo);
        dealIn = dealIn || (handResult.type === 'win' && !handResult.tsumo && handResult.loser === candidateSeat);
        if (!matchMode) break;
        const next = MJ.match.advance(state, handResult, scores);
        state = { hand: next.hand, dealer: next.dealer, honba: next.honba, mode: matchMode };
        if (next.ended) break;
      }
      // The UI gives any remaining deposits to first place before ranking.
      if (sticks) scores[MJ.rank.order(scores)[0]] += sticks * 1000;
      const settled = MJ.rank.finalResult(scores, rankConfig);
      rows.push({ seed, candidateSeat, rank: settled.ranks[candidateSeat], points: settled.points[candidateSeat],
        scores: scores.slice(), startScores: baseScores.slice(),
        scoreDelta: scores[candidateSeat] - baseScores[candidateSeat], win, tsumoWin, ronWin, dealIn, deals,
        called: calls > 0, riichi: riichis > 0, calls, riichis, result: result && result.type,
        startState: startState ? { handIndex: startHand, dealer: startDealer, honba: startHonba, riichiSticks: startSticks } : null });
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
      version: E.version, games, seeds: seedGroups.size, gamesPerSeed: seedGroups.size ? games / seedGroups.size : 0,
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

  // How many independent seed clusters are needed to detect `effect` at the
  // observed cluster standard deviation? n = (z * sd / effect)^2. This uses the
  // per-seed mean (four seats/seed) as one cluster, so it does not pretend that
  // the four replayed seats are independent samples.
  E.power = function (options = {}) {
    const sd = Number(options.sd), effect = Number(options.effect), z = Number(options.z) || 1.96;
    if (!(sd >= 0) || !(effect > 0)) return { effect, seeds: null, games: null, note: 'effect must be positive and sd non-negative' };
    if (sd < 1e-9) return { effect, seeds: null, games: null, observedSd: 0,
      note: 'zero observed variance (identical policies or a degenerate sample)' };
    const seeds = Math.max(1, Math.ceil((z * sd / effect) ** 2));
    const seats = Number(options.seatsPerSeed) > 0 ? Number(options.seatsPerSeed) : 1;
    return { effect, seeds, games: seeds * seats, alpha: Number(options.alpha) || 0.05, z,
      observedSd: sd, seatsPerSeed: seats };
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
    if (extra.power) for (const p of extra.power) {
      if (p.seeds == null) lines.push(`power: effect ${p.effect.toFixed(2)} unavailable — ${p.note}`);
      else lines.push(`power: effect ${p.effect.toFixed(2)} needs ${p.seeds} seeds / ${p.games} games (cluster sd ${p.observedSd.toFixed(2)})`);
    }
    if (extra.gamesPerSecond != null) lines.push(`throughput ${extra.gamesPerSecond.toFixed(1)} games/s (${(extra.elapsedMs / 1000).toFixed(1)} s)`);
    return lines.join('\n');
  };
})();
