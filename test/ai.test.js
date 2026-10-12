const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'record']) require('../src/' + file + '.js');
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
  console.log('AI strategy regressions OK: honors, growth, suji, tanki risk, call comparison, dead waits, immutability');
})().catch((e) => { console.error(e); process.exit(1); });
