(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const G = (MJ.grp = { version: 'grp-v1' });

  // Feature order is part of the versioned contract. tools/grp-dataset.js,
  // tools/grp/train_grp.py and docs/features.md must agree with this list.
  G.FEATURES = ['score0', 'score1', 'score2', 'score3',
    'diff0', 'diff1', 'diff2', 'diff3',
    'honba', 'riichi_sticks', 'hands_left', 'round_progress', 'dealer',
    'seat0', 'seat1', 'seat2', 'seat3'];

  const finite = (n, fallback) => Number.isFinite(n) ? n : fallback;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // A game-position sample. The label is the final placement, so the model
  // estimates P(rank | current standings), not a hand result.
  G.encode = function (state) {
    if (!state || !Array.isArray(state.scores) || state.scores.length !== 4) throw new Error('grp.encode requires four scores');
    const seat = Number.isInteger(state.seat) && state.seat >= 0 && state.seat < 4 ? state.seat : 0;
    const startDealer = Number.isInteger(state.startDealer) ? state.startDealer : 0;
    const scores = state.scores.map((s) => finite(Number(s), 25000));
    // Score slots are ordered from the match's East-1 dealer (0 = 起家), not by
    // absolute seat number. With the default startDealer 0 this is unchanged.
    const seatAt = (slot) => (startDealer + slot) % 4;
    const slotOf = (s) => (s - startDealer + 4) % 4;
    const values = [];
    for (let slot = 0; slot < 4; slot++) values.push(scores[seatAt(slot)] / 1000);
    for (let slot = 0; slot < 4; slot++) values.push((scores[seat] - scores[seatAt(slot)]) / 1000);
    values.push(finite(Number(state.honba), 0) / 10, finite(Number(state.riichiSticks), 0) / 10,
      clamp(finite(Number(state.handsLeft), 4), 1, 16) / 8,
      clamp(finite(Number(state.handIndex), 0), 0, 8) / 8,
      state.dealer === seat ? 1 : 0);
    for (let slot = 0; slot < 4; slot++) values.push(slotOf(seat) === slot ? 1 : 0);
    return values;
  };

  // GRP rows from a finished 翠卓 record: one sample per seat at each hand start.
  G.dataset = function (record, options = {}) {
    if (!record || !Array.isArray(record.hands) || !record.hands.length) throw new Error('grp.dataset requires a record');
    const finalScores = record.finalScores || (() => {
      const last = record.hands[record.hands.length - 1];
      const end = (last.events || []).filter((e) => e.type === 'end').slice(-1)[0];
      return end && end.scores;
    })();
    if (!Array.isArray(finalScores) || finalScores.length !== 4) throw new Error('grp.dataset requires finalScores');
    const firstConfig = (record.hands[0] && record.hands[0].config) || {};
    const startDealer = Number.isInteger(record.startDealer) ? record.startDealer
      : Number.isInteger(firstConfig.startDealer) ? firstConfig.startDealer
        : Number.isInteger(firstConfig.dealer) ? firstConfig.dealer : 0;
    const settled = MJ.rank.finalResult(finalScores, options.rankConfig || 'tenhou', startDealer);
    const totalHands = record.mode === 'hanchan' ? 8 : 4;
    // Match id groups every hand of one game. Train/validation splits must keep
    // all hands of a match on the same side, otherwise near-duplicate positions
    // from the same game leak into validation.
    const match = options.matchId || record.matchId || record.createdAt || record.source || 'match';
    const rows = [];
    record.hands.forEach((hand, index) => {
      const config = hand.config || {};
      const handIndex = Number.isInteger(config.hand) ? config.hand : index;
      const handStartDealer = Number.isInteger(config.startDealer) ? config.startDealer : startDealer;
      for (let seat = 0; seat < 4; seat++) {
        rows.push({
          v: G.version,
          match,
          hand: index,
          handIndex,
          seat,
          startDealer: handStartDealer,
          x: G.encode({ scores: config.scores, seat, honba: config.honba, riichiSticks: config.riichiSticks,
            handsLeft: Math.max(1, totalHands - handIndex), handIndex, startDealer: handStartDealer, dealer: config.dealer }),
          rank: settled.ranks[seat],
          finalScore: finalScores[seat],
          scoreDelta: finalScores[seat] - (config.scores ? config.scores[seat] : 25000)
        });
      }
    });
    return rows;
  };

  G.toJSONL = function (rows) {
    return rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  };

  G.validateModel = function (model) {
    if (!model || model.version !== G.version) throw new Error('GRP model version mismatch');
    if (!Array.isArray(model.features) || model.features.join(',') !== G.FEATURES.join(',')) throw new Error('GRP model feature order mismatch');
    if (!Array.isArray(model.mean) || model.mean.length !== G.FEATURES.length) throw new Error('GRP model mean is invalid');
    if (!Array.isArray(model.std) || model.std.length !== G.FEATURES.length || model.std.some((v) => !(v > 0))) throw new Error('GRP model std is invalid');
    if (!Array.isArray(model.layers) || !model.layers.length) throw new Error('GRP model has no layers');
    let width = G.FEATURES.length;
    for (const layer of model.layers) {
      if (!Array.isArray(layer.w) || layer.w.length !== width || !layer.w.every((row) => Array.isArray(row) && row.length === layer.b.length)) throw new Error('GRP layer dimensions are invalid');
      width = layer.b.length;
    }
    if (width !== 4) throw new Error('GRP model must output four ranks');
    return model;
  };

  // All 24 finishing orders. A 4x4 matrix is a valid distribution over
  // finishing orders only when every permutation is assigned a non-negative
  // probability; its row and column sums are then exactly one.
  G.PERMUTATIONS = (() => {
    const out = [];
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) for (let c = 0; c < 4; c++) for (let d = 0; d < 4; d++) {
      if (a !== b && a !== c && a !== d && b !== c && b !== d && c !== d) out.push([a, b, c, d]);
    }
    return out;
  })();

  // Project independent per-seat rank probabilities onto the 24 permutations:
  // score(perm) = product over seats of P_seat(rank = perm[seat]), then
  // normalise in log space. Row and column sums are exactly one by construction.
  G.jointFromRows = function (rows) {
    if (!Array.isArray(rows) || rows.length !== 4 || rows.some((row) => !Array.isArray(row) || row.length !== 4)) {
      throw new Error('GRP matrix must be 4x4');
    }
    const logs = G.PERMUTATIONS.map((perm) => {
      let log = 0;
      for (let seat = 0; seat < 4; seat++) log += Math.log(Math.max(1e-12, rows[seat][perm[seat]]));
      return log;
    });
    const max = Math.max(...logs), weights = logs.map((log) => Math.exp(log - max));
    const total = weights.reduce((a, b) => a + b, 0);
    const out = Array.from({ length: 4 }, () => [0, 0, 0, 0]);
    G.PERMUTATIONS.forEach((perm, i) => {
      const p = weights[i] / total;
      for (let seat = 0; seat < 4; seat++) out[seat][perm[seat]] += p;
    });
    return out;
  };

  // General Sinkhorn normalisation, kept as a reference/utility. The inference
  // path uses the 24-permutation projection above because Sinkhorn converges
  // slowly on near-deterministic predictions.
  G.sinkhorn = function (matrix, iterations = 100) {
    if (!Array.isArray(matrix) || matrix.length !== 4 || matrix.some((row) => !Array.isArray(row) || row.length !== 4)) {
      throw new Error('GRP matrix must be 4x4');
    }
    const m = matrix.map((row) => row.map((v) => Number.isFinite(v) && v > 0 ? v : 1e-12));
    for (let it = 0; it < iterations; it++) {
      for (let r = 0; r < 4; r++) {
        const sum = m[r].reduce((a, b) => a + b, 0);
        if (sum > 0) for (let c = 0; c < 4; c++) m[r][c] /= sum;
      }
      for (let c = 0; c < 4; c++) {
        let sum = 0;
        for (let r = 0; r < 4; r++) sum += m[r][c];
        if (sum > 0) for (let r = 0; r < 4; r++) m[r][c] /= sum;
      }
    }
    for (let r = 0; r < 4; r++) {
      const sum = m[r].reduce((a, b) => a + b, 0);
      if (sum > 0) for (let c = 0; c < 4; c++) m[r][c] /= sum;
    }
    return m;
  };

  // Joint prediction for all four seats at the same position. The result is a
  // row/column-stochastic 4x4 matrix: row = player, column = final rank.
  G.predictSeats = function (model, state) {
    if (!state || !Array.isArray(state.scores) || state.scores.length !== 4) throw new Error('grp.predictSeats requires four scores');
    const rows = [];
    for (let seat = 0; seat < 4; seat++) {
      rows.push(G.predict(model, G.encode({ ...state, seat })));
    }
    return G.jointFromRows(rows);
  };

  G.predict = function (model, x) {
    if (!Array.isArray(x) || x.length !== G.FEATURES.length) throw new Error('GRP input length mismatch');
    let a = x.map((value, i) => (finite(Number(value), 0) - model.mean[i]) / model.std[i]);
    for (let l = 0; l < model.layers.length; l++) {
      const layer = model.layers[l], out = new Array(layer.b.length).fill(0);
      for (let i = 0; i < a.length; i++) {
        const v = a[i];
        if (v === 0) continue;
        for (let j = 0; j < out.length; j++) out[j] += v * layer.w[i][j];
      }
      for (let j = 0; j < out.length; j++) out[j] += layer.b[j];
      if (l < model.layers.length - 1) for (let j = 0; j < out.length; j++) out[j] = Math.max(0, out[j]);
      a = out;
    }
    const max = Math.max(...a), exps = a.map((v) => Math.exp(v - max)), sum = exps.reduce((s, v) => s + v, 0);
    return exps.map((v) => v / sum);
  };
})();
