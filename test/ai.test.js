const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, T = MJ.tiles;
function hand(text) {
  const copies = Array(34).fill(0), result = [];
  for (const [, ns, suit] of text.matchAll(/([0-9]+)([mpsz])/g)) for (const char of ns) {
    const t = 'mpsz'.indexOf(suit) * 9 + (char === '0' ? 5 : Number(char)) - 1;
    result.push(t * 4 + copies[t]++);
  }
  return result;
}
function view(text, extra = {}) {
  const ids = hand(text), counts = T.countsFromIds(ids);
  return { hand: ids, drawnTile: ids.at(-1), melds: [], menzen: true, riichi: false, seat: 1,
    seatWind: 28, roundWind: 27, score: 25000, liveRemaining: 66, turnCount: 2, isDealer: false,
    unseen: counts.map((n) => 4 - n), ownDiscardTypes: [], opponents: [], doraIndicators: [], ...extra };
}
(async () => {
  const ai = MJ.ai.create(1);
  // User's east-1 early comments: equal immediate ukeire must not mean tile-ID tie breaking.
  let v = view('23678m5p24579s467z');
  const unchanged = JSON.stringify(v);
  assert.equal((await ai.chooseDiscard(v)).tileId >> 2, 30, 'discard isolated non-value north before central 5p');
  assert.equal(JSON.stringify(v), unchanged, 'search does not mutate the public view');
  v = view('1389m1237p3s12366z', { seatWind: 29 });
  assert.equal((await ai.chooseDiscard(v)).tileId >> 2, 28, 'non-value south before round east or own west');
  v = view('134589m15669p589s');
  assert([9, 17].includes((await ai.chooseDiscard(v)).tileId >> 2), 'preserve 566p growth rather than maximize only immediate ukeire');
  const risks = view('234567m123p456s11z', { threat: true,
    opponents: [{ seat: 2, riichi: true, discardTypes: [1], safeTypes: [], melds: [] }] });
  assert(MJ.ai.risk(4, risks).probability < MJ.ai.risk(5, risks).probability, 'one ryanmen line versus two');
  risks.unseen[27] = 1;
  assert(MJ.ai.risk(27, risks).probability > 0, 'three visible honors are not tanki-safe');
  risks.opponents[0].discardTypes.push(27);
  assert.equal(MJ.ai.risk(27, risks).probability, 0, 'genbutsu is safe against this opponent');
  risks.opponents[0].safeTypes.push(5);
  assert.equal(MJ.ai.risk(5, risks).probability, 0, 'tiles passed after riichi become safe');
  const callView = view('123m45p789s11z55z3s', { callTile: 126 });
  const opts = { tile: 31, from: 0, ron: false, pon: 31, kan: null, chi: [] };
  const comparison = MJ.ai.analyzeCall(callView, opts);
  assert.equal(comparison.alternatives.length, 2);
  assert(comparison.alternatives.every((a) => Number.isFinite(a.expectedNet)));
  const pass = comparison.alternatives[0].expectedNet, call = comparison.alternatives[1].expectedNet;
  assert(Math.abs(comparison.advantagePercent - 100 * (call - pass) / Math.max(100, Math.abs(call), Math.abs(pass))) < 0.02);
  await ai.wantCall(callView, opts);
  assert(ai.lastCallAnalysis && ai.lastCallAnalysis.kind === 'call', 'pass decisions also retain comparisons');
  const noTiles = view('123456m23p789s55z', { liveRemaining: 20 });
  noTiles.unseen[9] = noTiles.unseen[12] = 0;
  const add = { ...noTiles, hand: [...noTiles.hand, 135] };
  const analysis = MJ.ai.analyzeDiscard(add, 'standard');
  const tenpai = analysis.candidates.find((c) => c.t === 33);
  assert.equal(tenpai.ukeire, 0, 'dead waits have zero remaining ukeire');
  assert.equal(tenpai.winProbability, 0);
  const forced = await ai.chooseDiscard({ ...add, riichi: true, drawnTile: 135 });
  assert.equal(forced.tileId, 135);
  // Route-aware evaluation: the plan, shanten, acceptance and shape share one route.
  const chiitoiView = view('1589m38p36s113356z');
  const chiitoiAnalysis = MJ.ai.analyzeDiscard(chiitoiView, 'strong');
  assert.equal(chiitoiAnalysis.candidates[0].route, 'chiitoi', 'two honor pairs with many isolated tiles adopt the seven-pairs route');
  assert.equal(chiitoiAnalysis.candidates[0].sh, 4, 'the adopted route sets the reported shanten');
  assert.equal(chiitoiAnalysis.candidates[0].blockPlans.pairs, 2, 'the seven-pairs shape reports its pairs');
  const stdAnalysis = MJ.ai.analyzeDiscard(view('23678m5p24579s467z'), 'strong');
  assert.equal(stdAnalysis.candidates[0].route, 'standard', 'a standard hand keeps the standard route');
  // Per-agent weights are tunable without mutating the global defaults.
  // Standings turn raw points into rank-point pressure: leaders defend, trailers push.
  const rankView = view('23678m5p24579s467z', { seat: 3, seatWind: 27, scores: [60000, 25000, 20000, 5000], handsLeft: 1 });
  const trailer = MJ.ai.analyzeDiscard(rankView, 'standard');
  const leader = MJ.ai.analyzeDiscard({ ...rankView, scores: [5000, 25000, 20000, 60000] }, 'standard');
  assert(trailer.rankBias < 1, 'a trailer accepts more risk');
  assert(leader.rankBias > 1, 'a leader protects the lead');
  const legacy = MJ.ai.analyzeDiscard(rankView, 'standard', MJ.ai.weights, { rankBias: false });
  assert.equal(legacy.rankBias, 1, 'rank-point pressure can be disabled for the legacy baseline');
  const legacyAgent = MJ.ai.create(3, { rankBias: false });
  const legacyDecision = await legacyAgent.chooseDiscard(rankView);
  assert.equal(legacyDecision.analysis.rankBias, 1, 'the per-agent switch reaches chooseDiscard');
  // Rank-point outcomes are priced for win / deal-in / draw, and the final hand
  // uses the deterministic placement instead of pretending another hand remains.
  const rankDiscard = MJ.ai.analyzeDiscard(rankView, 'standard');
  const ranked = rankDiscard.candidates[0];
  assert(ranked.rank && [ranked.rank.win, ranked.rank.loss, ranked.rank.draw, ranked.rank.expected].every(Number.isFinite),
    'rank EV carries the three outcomes');
  const rawDiscard = MJ.ai.analyzeDiscard(rankView, 'standard', MJ.ai.weights, { rankBias: false });
  assert.equal(rawDiscard.candidates[0].rank, null, 'rankBias:false keeps the legacy raw-point path');
  const riichiProbe = MJ.ai.rankRiichi(rankView, { winProbability: 0.2, estimatedWinPoints: 2000, danger: 2, expectedLoss: 500 });
  assert.equal(typeof riichiProbe.accept, 'boolean', 'riichi is compared in rank points');
  const lastView = { ...rankView, seat: 3, isDealer: false, handsLeft: 1, dealer: 0,
    scores: [30000, 30000, 30000, 10000], riichiSticks: 0, honba: 0 };
  const cheapRon = { score: { payments: { ron: 1000 } } };
  assert.equal(MJ.ai.wantWin(lastView, cheapRon, false, 0).accept, false,
    'a final-hand non-dealer win that still leaves us last is declined');
  assert.equal(MJ.ai.wantWin({ ...lastView, isDealer: true }, cheapRon, false, 0).accept, true,
    'a dealer win repeats the hand and is accepted');
  assert.equal(MJ.ai.wantWin({ ...lastView, handsLeft: 2 }, cheapRon, false, 0).accept, true,
    'a win with hands remaining is accepted');
  const bigRon = { score: { payments: { ron: 21000 } } };
  assert.equal(MJ.ai.wantWin(lastView, bigRon, false, 0).accept, true,
    'a win that leaves last place is accepted');
  const defaults = JSON.stringify(MJ.ai.weights);
  const base = await ai.chooseDiscard(view('1589m38p36s113356z'));
  const heavy = await MJ.ai.create(1, { weights: { ...MJ.ai.weights, shapeGain: 10 } }).chooseDiscard(view('1589m38p36s113356z'));
  assert(Math.abs(heavy.analysis.candidates[0].shape) >= Math.abs(base.analysis.candidates[0].shape), 'shapeGain is read from per-agent weights');
  assert.equal(JSON.stringify(MJ.ai.weights), defaults, 'per-agent weights leave the global defaults untouched');
  // The cached improving-tile list must equal a full 34-tile scan on every route.
  let seed = 4242;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const shantenOf = (route, counts, melds) => route === 'standard' ? MJ.shanten.standard(counts, melds)
    : route === 'chiitoi' ? MJ.shanten.chiitoi(counts) : MJ.shanten.kokushi(counts);
  for (let i = 0; i < 500; i++) {
    const counts = new Array(34).fill(0);
    let left = 13;
    while (left > 0) { const t = Math.floor(rnd() * 34); if (counts[t] < 4) { counts[t]++; left--; } }
    const melds = Math.floor(rnd() * 4);
    for (const route of ['standard', 'chiitoi', 'kokushi']) {
      const base = shantenOf(route, counts, melds), exact = [];
      for (let t = 0; t < 34; t++) {
        if (counts[t] >= 4) continue;
        counts[t]++;
        if (shantenOf(route, counts, melds) < base) exact.push(t);
        counts[t]--;
      }
      assert.deepEqual(MJ.ai.improvingTiles(counts, melds, route), exact, `improving tiles ${route} #${i}`);
    }
  }
  console.log('AI strategy regressions OK: honors, growth, suji, tanki risk, call comparison, dead waits, immutability, route, ukeire tiles, weights');
})().catch((e) => { console.error(e); process.exit(1); });
