const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'features', 'policy']) {
  require('../src/' + file + '.js');
}
const MJ = globalThis.MJ;

// A valid public observation for the obs-v2 encoder.
function observation(overrides = {}) {
  const hand = [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48];
  const scores = [25000, 25000, 25000, 25000];
  const opponents = [1, 2, 3].map((offset) => ({
    seat: offset, handCount: 13, riichi: false, discards: [], discardTypes: [], discardHistory: [],
    melds: [], score: 25000, isDealer: false, safeTypes: []
  }));
  return Object.assign({
    seat: 0, hand, drawnTile: 48, melds: [], menzen: true, riichi: false, forbidden: [],
    legalDiscards: hand, scores, score: 25000, seatWind: 27, roundWind: 27, isDealer: false,
    doraIndicators: [0], unseen: new Array(34).fill(2), ownDiscardHistory: [], opponents,
    honba: 0, riichiSticks: 0, handsLeft: 4, handIndex: 0, liveRemaining: 70, turnCount: 0,
    startDealer: 0, threat: false, furiten: false
  }, overrides);
}

class FakeTensor {
  constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; }
}
function modelWith(outputs) {
  return {
    ort: { Tensor: FakeTensor },
    session: {
      run: async () => ({
        discard: { data: Float32Array.from(outputs.discard || new Array(34).fill(0)) },
        riichi: { data: Float32Array.from(outputs.riichi || [0, 0]) },
        call: { data: Float32Array.from(outputs.call || [0, 0, 0, 0, 0]) },
        win: { data: Float32Array.from(outputs.win || [0, 0]) }
      })
    },
    priors: null, inputNames: [], outputNames: [], shape: null
  };
}

(async () => {
  // (b) Illegal actions are masked to exactly zero probability.
  const illegalLogits = new Array(34).fill(0);
  illegalLogits[33] = 100; // 1z is not in the hand
  illegalLogits[0] = 3;
  const view = observation();
  const decision = await MJ.policy.chooseDiscard(modelWith({ discard: illegalLogits }), view);
  assert(decision, 'a legal discard is selected');
  assert.notEqual(decision.tile, 33, 'an illegal tile is never selected');
  assert.equal(decision.probabilities.discard[33], 0, 'illegal tile probability is exactly zero');
  const total = decision.probabilities.discard.reduce((a, b) => a + b, 0);
  assert(Math.abs(total - 1) < 1e-9, 'masked discard probabilities sum to one');

  // Kuikae (forbidden) types are excluded even when they are in hand.
  const forbiddenView = observation({ forbidden: [0] });
  const forbiddenLogits = new Array(34).fill(0);
  forbiddenLogits[0] = 100;
  const forbiddenDecision = await MJ.policy.chooseDiscard(modelWith({ discard: forbiddenLogits }), forbiddenView);
  assert.notEqual(forbiddenDecision.tile, 0, 'forbidden type is not discarded');
  assert.equal(forbiddenDecision.probabilities.discard[0], 0);

  // After riichi only the drawn tile is legal (tsumogiri).
  const riichiView = observation({ riichi: true, drawnTile: 20 });
  const riichiDecision = await MJ.policy.chooseDiscard(modelWith({ discard: illegalLogits }), riichiView);
  assert.equal(riichiDecision.tile, 5, 'riichi forces the drawn tile type');
  assert.equal(riichiDecision.probabilities.discard.filter((p) => p > 0).length, 1);

  // Call head: a chi is illegal when only pon is offered, and its probability is zero.
  const callModel = modelWith({ call: [0, 100, 5, -100, -100] });
  const action = await MJ.policy.chooseCall(callModel, view, { tile: 12, pon: 12, kan: null, chi: [], ron: false });
  assert(action && action.type === 'pon', 'only the legal pon can be selected');
  const callLegal = MJ.policy.legalCallMask({ tile: 12, pon: 12, kan: null, chi: [], ron: false });
  const callProbs = MJ.policy.maskedSoftmax([0, 100, 5, -100, -100], callLegal);
  assert.equal(callProbs[1], 0, 'illegal chi probability is exactly zero');
  assert(Math.abs(callProbs[0] + callProbs[2] - 1) < 1e-9, 'legal call probabilities sum to one');

  // Win head probabilities follow the same masking.
  assert.equal(await MJ.policy.chooseTsumo(modelWith({ win: [0, 2] }), view), true);

  // No legal discard (defensive): returns null instead of an illegal action.
  assert.equal(await MJ.policy.chooseDiscard(modelWith({ discard: illegalLogits }), observation({ hand: [], legalDiscards: [] })), null);

  console.log('Policy OK: legal-action masks zero illegal discard/call probabilities, forced riichi discard');
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
