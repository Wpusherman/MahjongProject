(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const R = (MJ.rank = {});
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const round = (n) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };

  // uma: rank points by placement. returnScore > startScore adds the standard oka
  // (return - start) * 4 / scoreUnit to first place. scoreWeight converts raw points
  // above/below the start score into rank points.
  R.CONFIGS = {
    tenhou: { name: '天鳳風', uma: [90, 45, 0, -135], startScore: 25000, returnScore: 25000, scoreUnit: 1000, scoreWeight: 0 },
    mleague: { name: 'Mリーグ風', uma: [50, 10, -10, -30], startScore: 25000, returnScore: 25000, scoreUnit: 1000, scoreWeight: 0.1 },
    raw: { name: '素点のみ', uma: [0, 0, 0, 0], startScore: 25000, returnScore: 25000, scoreUnit: 1000, scoreWeight: 1 }
  };
  R.default = 'tenhou';
  // Optional learned Game Result Prediction model (src/grp.js). When set it
  // replaces the heuristic logistic rank EV with P(final rank | standings).
  R.GRP = { model: null };
  R.setRankModel = function (model) {
    if (!MJ.grp) throw new Error('MJ.grp is not loaded');
    R.GRP.model = MJ.grp.validateModel(model);
    return R.GRP.model;
  };
  R.clearRankModel = function () { R.GRP.model = null; };
  R.setDefault = function (name) { R.resolve(name); R.default = name; };
  R.resolve = function (config) {
    const source = config == null ? R.default : config;
    const found = typeof source === 'string' ? R.CONFIGS[source] : source;
    if (!found) throw new Error('Unknown rank config: ' + source);
    const resolved = Object.assign({ name: 'custom', uma: [0, 0, 0, 0], startScore: 25000, returnScore: 25000,
      scoreUnit: 1000, scoreWeight: 0 }, found);
    resolved.uma = (found.uma || [0, 0, 0, 0]).slice();
    return resolved;
  };

  // Ties use the starting seat order: positions counted from the match's East-1
  // dealer (0 = 起家), not the absolute seat number.
  const orderIndex = (seat, startDealer) => Number.isInteger(startDealer) ? (seat - startDealer + 4) % 4 : seat;
  R.order = function (scores, startDealer) {
    return scores.map((score, seat) => ({ score, seat }))
      .sort((a, b) => b.score - a.score || orderIndex(a.seat, startDealer) - orderIndex(b.seat, startDealer))
      .map((x) => x.seat);
  };

  R.finalResult = function (scores, config, startDealer) {
    const c = R.resolve(config);
    if (!Array.isArray(scores) || scores.length !== 4 || !scores.every(Number.isFinite)) throw new Error('scores must be four finite numbers');
    const order = R.order(scores, startDealer), ranks = Array(4), points = Array(4), uma = Array(4), raw = Array(4), oka = Array(4);
    order.forEach((seat, i) => { ranks[seat] = i + 1; });
    const okaValue = Math.max(0, (c.returnScore - c.startScore) * 4 / c.scoreUnit);
    for (let seat = 0; seat < 4; seat++) {
      const rank = ranks[seat];
      uma[seat] = c.uma[rank - 1] || 0;
      oka[seat] = rank === 1 ? okaValue : 0;
      raw[seat] = (scores[seat] - c.startScore) / c.scoreUnit * c.scoreWeight;
      points[seat] = round(uma[seat] + oka[seat] + raw[seat]);
    }
    return { config: c, order, ranks, points, uma, oka, raw };
  };

  // Rule-based expected rank points after a point swing. Each opponent is compared
  // independently with a logistic whose scale grows when more hands remain.
  R.expectedPoints = function (scores, seat, delta, config, opts = {}) {
    if (!Array.isArray(scores) || scores.length !== 4) throw new Error('scores must have four seats');
    const c = R.resolve(config);
    const handsLeft = Math.max(1, opts.handsLeft == null ? 4 : opts.handsLeft);
    const scale = Math.max(1, opts.scale == null ? 4000 + 2500 * handsLeft : opts.scale);
    const target = scores[seat] + (Number(delta) || 0);
    const model = opts.model !== undefined ? opts.model : R.GRP.model;
    if (model) {
      const after = scores.slice();
      after[seat] = target;
      // Joint 4x4 prediction with row and column sums of 1, so the four seats
      // are guaranteed to occupy one rank each in expectation.
      const matrix = MJ.grp.predictSeats(model, { scores: after, handsLeft, honba: opts.honba,
        riichiSticks: opts.riichiSticks, handIndex: opts.handIndex, dealer: opts.dealer });
      const probabilities = matrix[seat];
      const okaValue = Math.max(0, (c.returnScore - c.startScore) * 4 / c.scoreUnit);
      let uma = 0, oka = 0, expectedRank = 1;
      for (let i = 0; i < 4; i++) {
        uma += probabilities[i] * (c.uma[i] || 0);
        if (i === 0) oka += probabilities[i] * okaValue;
        expectedRank += i * probabilities[i];
      }
      const raw = (target - c.startScore) / c.scoreUnit * c.scoreWeight;
      return { rank: round(expectedRank), points: round(uma + oka + raw), uma: round(uma), oka: round(oka),
        raw: round(raw), probabilities: probabilities.slice() };
    }
    let below = 0;
    for (let other = 0; other < 4; other++) {
      if (other === seat) continue;
      below += 1 / (1 + Math.exp(-(target - scores[other]) / scale));
    }
    const rank = clamp(4 - below, 1, 4);
    const low = Math.floor(rank), high = Math.ceil(rank), f = rank - low;
    const uma = c.uma[low - 1] * (1 - f) + c.uma[high - 1] * f;
    const okaValue = Math.max(0, (c.returnScore - c.startScore) * 4 / c.scoreUnit);
    const oka = okaValue * clamp(2 - rank, 0, 1);
    const raw = (target - c.startScore) / c.scoreUnit * c.scoreWeight;
    return { rank, points: round(uma + oka + raw), uma, oka, raw };
  };
  R.deltaPoints = function (scores, seat, delta, config, opts) {
    const after = R.expectedPoints(scores, seat, delta, config, opts);
    const before = R.expectedPoints(scores, seat, 0, config, opts);
    return round(after.points - before.points);
  };

  // >1: losing points costs more rank EV than gaining the same points (protect a lead).
  // <1: the player needs to push (chase). 1 without standings information.
  R.riskBias = function (scores, seat, config, opts = {}) {
    const swing = opts.swing == null ? 2000 : opts.swing;
    const mid = R.expectedPoints(scores, seat, 0, config, opts);
    const up = R.expectedPoints(scores, seat, swing, config, opts);
    const down = R.expectedPoints(scores, seat, -swing, config, opts);
    const gain = up.points - mid.points, loss = mid.points - down.points;
    if (!(gain > 0) || !(loss > 0)) return 1;
    return round(clamp(loss / gain, 0.5, 2));
  };
})();
