const assert = require('node:assert/strict');
require('../src/rank.js');
const R = globalThis.MJ.rank;

// Final placement uses raw score, and ties keep the starting seat order.
assert.deepEqual(R.order([25000, 30000, 25000, 20000]), [1, 0, 2, 3]);
assert.deepEqual(R.finalResult([25000, 25000, 25000, 25000], 'tenhou').ranks, [1, 2, 3, 4]);
// With a non-zero East-1 dealer, the tie order is the rotation from that seat.
assert.deepEqual(R.order([25000, 30000, 25000, 25000], 2), [1, 2, 3, 0]);
assert.deepEqual(R.order([25000, 25000, 25000, 25000], 2), [2, 3, 0, 1]);
assert.deepEqual(R.finalResult([25000, 25000, 25000, 25000], 'tenhou', 2).order, [2, 3, 0, 1]);
assert.deepEqual(R.finalResult([25000, 25000, 25000, 25000], 'tenhou', 2).ranks, [3, 4, 1, 2]);

const tenhou = R.finalResult([30000, 25000, 25000, 20000], 'tenhou');
assert.deepEqual(tenhou.order, [0, 1, 2, 3]);
assert.deepEqual(tenhou.points, [90, 45, 0, -135]);
assert.equal(tenhou.points.reduce((a, b) => a + b, 0), 0);

const mleague = R.finalResult([30000, 25000, 25000, 20000], 'mleague');
assert.deepEqual(mleague.points, [50.5, 10, -10, -30.5]);
assert.deepEqual(R.finalResult([30000, 25000, 25000, 20000], 'raw').points, [5, 0, 0, -5]);

// A return score above the start score adds oka to first place.
const oka = R.finalResult([30000, 25000, 25000, 20000], { name: 'oka', uma: [0, 0, 0, 0], startScore: 25000,
  returnScore: 30000, scoreUnit: 1000, scoreWeight: 0 });
assert.deepEqual(oka.points, [20, 0, 0, 0]);

// Expected rank points rise with a point swing and reflect the current standing.
const even = [25000, 25000, 25000, 25000];
const low = R.expectedPoints(even, 0, -5000, 'tenhou', { handsLeft: 4 }).points;
const mid = R.expectedPoints(even, 0, 0, 'tenhou', { handsLeft: 4 }).points;
const high = R.expectedPoints(even, 0, 5000, 'tenhou', { handsLeft: 4 }).points;
assert(low < mid && mid < high);
assert(R.deltaPoints(even, 0, 5000, 'tenhou') > 0);
const scores = [60000, 25000, 20000, 5000];
const leader = R.riskBias(scores, 0, 'tenhou', { handsLeft: 1 });
const trailer = R.riskBias(scores, 3, 'tenhou', { handsLeft: 1 });
assert(leader > 1, 'a leader values avoiding a loss more than gaining points');
assert(trailer < 1, 'a trailer accepts more risk to push');
assert.equal(R.riskBias([25000, 25000, 25000, 25000], 0, 'tenhou', { handsLeft: 1 }), 1);

R.default = 'tenhou';
assert.equal(R.resolve().name, '天鳳風');
assert.throws(() => R.resolve('missing'), /Unknown rank config/);
console.log('Rank points OK: ties, uma/oka/raw, expected rank EV, leader/trailer risk bias');
