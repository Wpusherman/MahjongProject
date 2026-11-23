const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, G = MJ.grp, R = MJ.rank;

const record = {
  format: 'suitaku-riichi', version: 1, mode: 'tonpu', finalScores: [35000, 25000, 22000, 18000], finished: true,
  hands: [
    { config: { scores: [25000, 25000, 25000, 25000], dealer: 0, honba: 0, riichiSticks: 0, hand: 0 }, events: [] },
    { config: { scores: [27000, 24000, 25000, 24000], dealer: 1, honba: 1, riichiSticks: 1, hand: 1 }, events: [] },
    { config: { scores: [31000, 25000, 23000, 21000], dealer: 2, honba: 0, riichiSticks: 0, hand: 2 }, events: [] }
  ]
};

const rows = G.dataset(record);
assert.equal(rows.length, 12, 'one row per seat at each hand start');
for (const row of rows) {
  assert.equal(row.v, 'grp-v2');
  assert.equal(row.x.length, G.FEATURES.length);
  assert(row.x.every(Number.isFinite));
  assert(row.rank >= 1 && row.rank <= 4);
  assert(!G.FEATURES.some((name) => /final|rank|result/i.test(name)), 'features never contain the label or final score');
  assert.equal(row.match, 'match', 'a dataset can be grouped by match');
  assert(Number.isInteger(row.handIndex));
}
const tagged = G.dataset(record, { matchId: 'game-1' });
assert(tagged.every((row) => row.match === 'game-1'), 'matchId groups all hands of one game');
// rank points from final scores: seat 0 first, seat 1 second, seat 2 third, seat 3 fourth.
assert.deepEqual([...new Set(rows.map((r) => r.rank))].sort(), [1, 2, 3, 4]);
// diff features use the sample's own seat.
const even = G.encode({ scores: [25000, 25000, 25000, 25000], seat: 2, handsLeft: 4, handIndex: 0, dealer: 0, honba: 0, riichiSticks: 0 });
assert.equal(even.length, G.FEATURES.length);
assert(even.slice(4, 8).every((v) => v === 0));
assert.equal(even[13 + 2], 1, 'seat one-hot marks seat 2');
assert.deepEqual(G.dataset(JSON.parse(JSON.stringify(record))), rows, 'dataset is deterministic');
// grp-v2: score/seat slots are ordered from the match's East-1 dealer.
const relative = G.encode({ scores: [10000, 20000, 30000, 40000], seat: 0, startDealer: 1,
  handsLeft: 4, handIndex: 0, dealer: 1, honba: 0, riichiSticks: 0 });
assert.equal(relative[0], 20, 'slot 0 is the East-1 dealer');
assert.equal(relative[1], 30, 'slot 1 is the next seat');
assert.equal(relative[13], 0, 'slot 0 is the East-1 dealer seat, not absolute seat 0');
assert.equal(relative[16], 1, 'seat slot 3 marks absolute seat 0 when startDealer is 1');

const constant = {
  version: 'grp-v2', features: G.FEATURES.slice(), mean: Array(G.FEATURES.length).fill(0),
  std: Array(G.FEATURES.length).fill(1),
  layers: [{ w: Array.from({ length: G.FEATURES.length }, () => [0, 0, 0, 0]), b: [1, 1, 1, 1] }]
};
R.setRankModel(constant);
const evenPoints = R.expectedPoints([25000, 25000, 25000, 25000], 0, 0, 'tenhou', { handsLeft: 4 });
assert.deepEqual(evenPoints.probabilities.map((p) => +p.toFixed(9)), [0.25, 0.25, 0.25, 0.25]);
assert.equal(evenPoints.points, 0);
assert.equal(R.GRP.model.version, 'grp-v2');
assert.throws(() => R.setRankModel({ ...constant, version: 'grp-v0' }), /version/);
assert.throws(() => R.setRankModel({ ...constant, version: 'grp-v1' }), /version/,
  'the old absolute-seat model must not load into grp-v2');
R.clearRankModel();
assert.equal(R.GRP.model, null);
assert.equal(R.expectedPoints([25000, 25000, 25000, 25000], 0, 0, 'tenhou', { handsLeft: 4 }).probabilities, undefined);

// Joint inference: every seat predicts a row, Sinkhorn makes both rows and
// columns sum to 1 so the matrix is a distribution over finishing orders.
const w = Array.from({ length: G.FEATURES.length }, () => [0, 0, 0, 0]);
for (let seat = 0; seat < 4; seat++) w[13 + seat][seat] = 4;
const seatModel = { ...constant, layers: [{ w, b: [0, 0, 0, 0] }] };
const state = { scores: [32000, 27000, 23000, 18000], handsLeft: 4, handIndex: 3, dealer: 0, honba: 0, riichiSticks: 0 };
const matrix = G.predictSeats(seatModel, state);
assert.equal(matrix.length, 4);
for (const row of matrix) {
  assert.equal(row.length, 4);
  assert(row.every((v) => v >= 0));
  assert(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'rows sum to 1');
}
for (let col = 0; col < 4; col++) {
  const sum = matrix.reduce((n, row) => n + row[col], 0);
  assert(Math.abs(sum - 1) < 1e-6, 'columns sum to 1');
}
const direct = G.sinkhorn([[0.97, 0.01, 0.01, 0.01], [0.01, 0.97, 0.01, 0.01],
  [0.01, 0.01, 0.97, 0.01], [0.01, 0.01, 0.01, 0.97]]);
assert.deepEqual(G.sinkhorn(direct), direct, 'Sinkhorn is stable on a permutation matrix');
assert.deepEqual(G.sinkhorn([[0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25],
  [0.25, 0.25, 0.25, 0.25], [0.25, 0.25, 0.25, 0.25]]).flat().map((v) => +v.toFixed(9)), Array(16).fill(0.25));
assert.throws(() => G.sinkhorn([[1, 0, 0, 0]]), /4x4/);
assert.equal(G.PERMUTATIONS.length, 24, 'all finishing orders are enumerated');
const projected = G.jointFromRows([[0.9, 0.05, 0.04, 0.01], [0.2, 0.6, 0.15, 0.05],
  [0.1, 0.2, 0.6, 0.1], [0.02, 0.08, 0.2, 0.7]]);
for (const row of projected) assert(Math.abs(row.reduce((a, b) => a + b, 0) - 1) < 1e-12, 'permutation rows sum to 1');
for (let col = 0; col < 4; col++) assert(Math.abs(projected.reduce((n, row) => n + row[col], 0) - 1) < 1e-12,
  'permutation columns sum to 1');
assert.throws(() => G.jointFromRows([[1, 0, 0, 0]]), /4x4/);
R.setRankModel(seatModel);
const jointPoints = R.expectedPoints([32000, 27000, 23000, 18000], 0, 0, 'tenhou', { handsLeft: 4 });
assert(Math.abs(jointPoints.probabilities.reduce((a, b) => a + b, 0) - 1) < 1e-6);
R.clearRankModel();

console.log('GRP OK: versioned features, match-grouped dataset, rank labels, 24-permutation matrix, model loading and rank EV replacement');
