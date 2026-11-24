const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'record', 'core']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, T = MJ.tiles;
const ids = (text) => {
  const used = Array(34).fill(0), result = [];
  for (const [, digits, suit] of text.matchAll(/([1-9]+)([mpsz])/g)) for (const n of digits) {
    const t = 'mpsz'.indexOf(suit) * 9 + Number(n) - 1; result.push(t * 4 + used[t]++);
  }
  return result;
};
function game() {
  const g = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
  g.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000], wall: Array.from({ length: 136 }, (_, i) => i) });
  return g;
}
// A riichi player who just drew the fourth copy of `drawnType`.
function riichiGame(text, drawnType, rules) {
  const g = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
  g.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000], wall: Array.from({ length: 136 }, (_, i) => i), rules });
  const p = g.players[0];
  p.hand = ids(text);
  const used = new Set(p.hand);
  const drawn = [0, 1, 2, 3].map((k) => drawnType * 4 + k).find((id) => !used.has(id));
  p.hand.push(drawn); p.drawnTile = drawn; p.riichi = true;
  p.hand.sort((a, b) => a - b);
  return { g, p, drawn };
}
const ankanTiles = (g) => g.availableKans(0).filter((k) => k.kind === 'ankan').map((k) => k.tile);
// Play a full tonpu/hanchan with deterministic, always-discard agents. This
// exercises the dealer-move based match end rather than only advance().
async function playSeatMatch(mode, startDealer) {
  let state = { hand: 0, dealer: startDealer, startDealer, honba: 0, mode };
  let scores = [25000, 25000, 25000, 25000], sticks = 0, deals = 0;
  const makeAgents = () => [0, 1, 2, 3].map(() => ({
    lastCallAnalysis: null,
    wantTsumo: async () => false,
    chooseDiscard: async (view) => ({ tileId: view.riichi ? view.drawnTile
      : (view.legalDiscards && view.legalDiscards.length ? view.legalDiscards[0] : view.hand[0]), riichi: false }),
    wantCall: async () => null,
    wantKan: async () => null
  }));
  while (!state.ended && deals < 40) {
    const game = new MJ.Game({ agents: makeAgents(), rng: MJ.core.rng('seat-match:' + mode + ':' + startDealer + ':' + deals) });
    const result = await game.playHand({ roundWind: 27 + Math.floor(state.hand / 4), dealer: state.dealer,
      startDealer: state.startDealer, honba: state.honba, riichiSticks: sticks, scores: scores.slice(),
      hand: state.hand, mode });
    deals++;
    scores = game.players.map((p) => p.score); sticks = game.riichiSticks;
    assert.equal(state.dealer, (startDealer + state.hand) % 4, 'dealer follows dealer moves from the start dealer');
    state = MJ.match.advance(state, result, scores);
  }
  return { ended: state.ended, hand: state.hand, dealer: state.dealer, scores, sticks, deals };
}
// The match wall seed must advance on every deal. `hand` (the round index) stays
// put on a dealer repeat (renchan) or a draw, so it cannot seed the wall. This
// mirrors src/ui.js, which uses MJ.match.dealSeed for each hand.
function dealWalls(matchSeed, startDealer, mode, maxDeals = 16) {
  const walls = [];
  let state = { hand: 0, dealer: startDealer, startDealer, honba: 0, mode };
  for (let dealIndex = 0; !state.ended && dealIndex < maxDeals; dealIndex++) {
    walls.push(MJ.tiles.buildWall(MJ.core.rng(MJ.match.dealSeed(matchSeed, dealIndex))));
    // Force a renchan on two of every three deals so the round index does not move.
    const result = dealIndex % 3 === 0 ? { type: 'win', winner: state.dealer }
      : dealIndex % 3 === 1 ? { type: 'draw', reason: 'exhaustive', tenpai: [state.dealer] }
        : { type: 'win', winner: (state.dealer + 1) % 4 };
    state = MJ.match.advance(state, result, [25000, 25000, 25000, 25000]);
  }
  return walls;
}
const allDistinct = (walls) => new Set(walls.map((w) => w.join(','))).size === walls.length;
function score(text, tile, extra = {}) {
  const ctx = { counts: T.countsFromIds(ids(text)), melds: [], winTile: ids(tile)[0] >> 2, tsumo: false,
    roundWind: 27, seatWind: 28, doraIndicators: [], uraIndicators: [], redIds: [], ...extra };
  const ev = MJ.yaku.evaluate(ctx); return { ev, score: MJ.score.compute(ctx, ev, 0) };
}
(async () => {
  // Six taatsu without a pair must not be mistaken for a near-complete hand.
  assert.equal(MJ.shanten.standard(T.countsFromIds(ids('124578m124578p1s')), 0), 4);
  const g = game();
  assert.equal(g.liveRemaining(), 70);
  const initial = g.wall.slice();
  const indicators = [], ura = [], rinshan = [];
  for (let i = 0; i < 5; i++) {
    indicators.push(g.doraIndicators[i]); ura.push(g.uraIndicators[i]);
    if (i < 4) { rinshan.push(g.drawRinshan()); g.revealKanDora(); }
  }
  assert.equal(new Set([...indicators, ...ura, ...rinshan]).size, 14, 'dead wall roles never overlap');
  assert.equal(g.liveRemaining(), 66);
  assert.equal(g.drawRinshan(), null);
  assert.deepEqual(g.wall, initial, 'wall is fixed for the entire hand');
  assert.equal(MJ.score.countDora({ counts: T.countsFromIds(ids('55m')), melds: [], doraIndicators: [12], uraIndicators: [], redIds: [] }), 2, 'indicator IDs converted to types');
  // A discard on ANY side of a multi-sided wait makes all ron waits furiten.
  const f = game(), p = f.players[1];
  p.hand = ids('123456m23p789s55z');
  p.discardHistory = [{ tileId: 36, called: true }];
  assert.deepEqual(f.waits(1), [9, 12]);
  assert.equal(f.isFuriten(1), true);
  assert.equal(f.callOptions(1, 0, 48)?.ron || false, false);
  p.discardHistory = []; p.riichi = true;
  assert.equal(f.callOptions(1, 0, 48).pon, null, 'no calls in riichi');
  f.agents[1] = { wantCall: async () => null };
  f.players[2].hand = []; f.players[3].hand = [];
  await f.checkCalls(0, 48);
  assert.equal(p.riichiFuriten, true, 'passing ron in riichi is permanent furiten');
  p.tempFuriten = false;
  assert.equal(f.isFuriten(1), true);
  const z = game(); z.players[1].hand = ids('11m234p567s11223z');
  assert.equal(z.callOptions(1, 0, 2).pon, 0, '1m type zero is a valid pon');
  const d = game(); d.players[0].hand = [0, 1, 4]; d.players[0].drawnTile = 1;
  d.discard(0, 0, true); d.players[0].drawnTile = 1; d.discard(0, 1);
  assert.equal(d.players[0].river[0].tsumogiri, false, 'same type but different physical tile is tedashi');
  assert.equal(d.players[0].river[1].tsumogiri, true);
  assert.equal(d.recording.events[1].riichi, true);
  assert.throws(() => d.discard(0, 135), /Illegal discard/);
  const wind = score('111z234m567p789s22z', '1z', { seatWind: 27 });
  assert(wind.ev.list.some((y) => y.name === '場風牌'));
  assert(wind.ev.list.some((y) => y.name === '自風牌'));
  const open = score('234m456p678s22p', '4m', { melds: [{ kind: 'seq', type: 1, open: true }] });
  assert.equal(open.score.fu, 30, 'open pinfu-shape ron is 30 fu');
  const shanpon = score('222m234p678s111z55p', '2m', { riichi: true });
  assert.equal(shanpon.score.fu, 40, 'ron-completed triplet is open for fu');
  const mixed = score('112233m112233p44s', '4s', { tsumo: true });
  assert(mixed.ev.list.some((y) => y.name === '二盃口'), 'choose higher scoring standard interpretation over seven pairs');
  const honroutou = score('111999m111p999s11z', '1z');
  assert(!honroutou.ev.list.some((y) => y.name === '混全帯幺九'));
  const s = { hand: 3, dealer: 3, honba: 2, mode: 'hanchan' };
  assert.deepEqual(MJ.match.advance(s, { type: 'draw', reason: 'exhaustive', tenpai: [3] }, [25000, 25000, 25000, 25000]), { ...s, honba: 3, ended: false });
  assert.equal(MJ.match.advance(s, { type: 'win', winner: 1 }, [25000, 25000, 25000, 25000]).hand, 4);
  assert.equal(MJ.match.advance({ ...s, mode: 'tonpu' }, { type: 'win', winner: 1 }, [25000, 25000, 25000, 25000]).ended, true);
  // Kan, consecutive rinshan draws, and chankan transitions need explicit coverage.
  const k = game(), kp = k.players[0]; kp.hand = ids('1111m234p567s111z2z');
  const ankan = k.availableKans(0).find((x) => x.tile === 0);
  assert(ankan); k.applyKan(0, ankan);
  assert.equal(kp.melds[0].tiles.length, 4);
  assert.equal(kp.hand.length, 10);
  const rt = k.drawRinshan(); kp.hand.push(rt); kp.drawnTile = rt; k.revealKanDora();
  assert.equal(kp.hand.length, 11);
  assert.equal(k.doraRevealed, 2);
  const c = game(); c.players[1].hand = ids('123456m23p789s55z');
  const robbed = c.callOptions(1, 0, 48, 'kakan');
  assert(robbed.ron);
  assert.equal(c.callOptions(1, 0, 48, 'ankan'), null, 'only kokushi can rob concealed kan');
  const ri = game(); ri.players[0].hand = ids('111m234p567s789s2z'); ri.players[0].riichi = true;
  ri.players[0].drawnTile = 3; ri.players[0].hand.push(3);
  assert(ri.availableKans(0).some((x) => x.tile === 0), 'riichi kan retaining waits and decomposition allowed');
  // Riichi ankan rule switch: "wait" (default), "strict", "none".
  const ok = riichiGame('123m456p777s88s11z', 24, { riichiAnkan: 'wait' });
  assert.deepEqual(ankanTiles(ok.g), [24], 'OK: wait-preserving ankan after riichi is legal');
  assert.deepEqual(ankanTiles(riichiGame('123m456p777s88s11z', 24, { riichiAnkan: 'strict' }).g), [24]);
  assert.deepEqual(ankanTiles(riichiGame('123m456p777s88s11z', 24, { riichiAnkan: 'none' }).g), [], 'none disables riichi ankan');
  assert.deepEqual(ankanTiles(riichiGame('23s444s66m678p678p', 21, { riichiAnkan: 'wait' }).g), [],
    'NG: an ankan that changes the wait is illegal');
  // Correct divergence example: before waits {4m,7m}; after taking the 8s quad
  // into the kan the waits are still {4m,7m}. Wait mode allows it. Strict mode
  // rejects it because 4m/7m can also win via 456m + 678s + 678s + 678s + 白白,
  // which does not use the 888s triplet.
  assert.deepEqual(ankanTiles(riichiGame('56m666777888s55z', 25, { riichiAnkan: 'wait' }).g), [25],
    'wait mode allows an ankan whose wait set is unchanged even if a decomposition uses sequences');
  assert.deepEqual(ankanTiles(riichiGame('56m666777888s55z', 25, { riichiAnkan: 'strict' }).g), [],
    'strict mode rejects unless every decomposition uses the triplet');
  // The old example was wrong: before waits {4m,7m,8p}, but the kan owns all four
  // 4m, so 4m is no longer a wait after the kan ({7m,8p}). Both modes reject it.
  assert.deepEqual(ankanTiles(riichiGame('777m44m456m666p88p', 3, { riichiAnkan: 'wait' }).g), [],
    'NG: the fourth copy is in the kan, so the quad tile is no longer a wait');
  assert.deepEqual(ankanTiles(riichiGame('777m44m456m666p88p', 3, { riichiAnkan: 'strict' }).g), [],
    'strict also rejects the wait-changing kan');
  const okuri = ok.g, okPlayer = okuri.players[0];
  okPlayer.drawnTile = okPlayer.hand.find((id) => (id >> 2) !== 24);
  assert(!ankanTiles(okuri).includes(24), 'NG: the fourth copy must be the tile just drawn');
  const aiKanView = { riichi: true, liveRemaining: 40, doraIndicators: [0], opponents: [], hand: okPlayer.hand, melds: [], seat: 0 };
  assert(MJ.ai.riichiKanDecision(aiKanView, { kind: 'ankan', tile: 24 }).accept, 'AI takes a safe riichi kan');
  assert(!MJ.ai.riichiKanDecision({ ...aiKanView, opponents: [{ riichi: true }] }, { kind: 'ankan', tile: 24 }).accept,
    'AI declines while an opponent is riichi');
  const aiObs = ok.g.getObservation(0);
  aiObs.riichi = true; aiObs.liveRemaining = 40; aiObs.doraIndicators = [0];
  aiObs.opponents = (aiObs.opponents || []).map((o) => ({ ...o, riichi: false }));
  const kanAI = MJ.ai.create(0, { level: 'standard' });
  assert.deepEqual(await kanAI.wantKan(aiObs, [{ kind: 'ankan', tile: 24 }]), { kind: 'ankan', tile: 24 },
    'AI wantKan takes a safe riichi ankan');
  aiObs.opponents = aiObs.opponents.map((o, i) => i === 0 ? { ...o, riichi: true } : o);
  assert.equal(await kanAI.wantKan(aiObs, [{ kind: 'ankan', tile: 24 }]), null, 'AI wantKan declines under threat');

  // Exhaustive riichi-ankan check: the 13-tile wait set and the 10-tile + kan
  // wait set must be enumerated over every decomposition, including seven pairs
  // and thirteen orphans. The wait decision is exactly set equality; strict
  // additionally requires every winning decomposition to use the triplet.
  const waitSet = (handIds, meldCount, extraMelds) => {
    const counts = T.countsFromIds(handIds), out = [];
    for (let t = 0; t < 34; t++) {
      const owned = counts[t] + (extraMelds || []).reduce((n, m) => n + m.tiles.filter((id) => (id >> 2) === t).length, 0);
      if (owned >= 4) continue;
      counts[t]++;
      if (MJ.agari.isAgari(counts, meldCount)) out.push(t);
      counts[t]--;
    }
    return out;
  };
  const strictKeepsTriplet = (beforeIds, quadType, waits) => {
    const c = T.countsFromIds(beforeIds);
    return waits.every((w) => {
      c[w]++;
      const special = MJ.agari.isChiitoi(c, 0) || MJ.agari.isKokushi(c, 0);
      const ds = MJ.agari.decompose(c).filter((d) => d.sets.length === 4);
      c[w]--;
      if (special) return false;
      return ds.every((d) => d.sets.some((s) => s.kind === 'trip' && s.type === quadType));
    });
  };
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const expectedAnkan = (beforeIds, quadType, mode) => {
    const before = waitSet(beforeIds, 0);
    const quad = [0, 1, 2, 3].map((k) => quadType * 4 + k);
    const afterIds = beforeIds.filter((id) => (id >> 2) !== quadType);
    const after = waitSet(afterIds, 1, [{ kind: 'kan', type: quadType, open: false, tiles: quad }]);
    if (mode === 'none' || !same(before, after)) return false;
    return mode === 'wait' || strictKeepsTriplet(beforeIds, quadType, before);
  };
  // Deterministic near-win generator: a random winning hand with a triplet, then
  // remove one tile from another set (or the pair) to make a tenpai hand.
  let ruleSeed = 20261123;
  const ruleRng = () => { ruleSeed = (Math.imul(ruleSeed, 1664525) + 1013904223) >>> 0; return ruleSeed / 4294967296; };
  const makeRiichi = () => {
    const sets = []; let trip = -1;
    while (sets.length < 4) {
      if (ruleRng() < 0.5) {
        const t = Math.floor(ruleRng() * 34);
        if (sets.some((s) => s.kind === 'trip' && s.type === t)) continue;
        sets.push({ kind: 'trip', type: t, tiles: [t, t, t] }); if (trip < 0) trip = t;
      } else {
        const st = Math.floor(ruleRng() * 3) * 9 + Math.floor(ruleRng() * 7);
        if (sets.some((s) => s.kind === 'seq' && s.type === st)) continue;
        sets.push({ kind: 'seq', type: st, tiles: [st, st + 1, st + 2] });
      }
    }
    const pair = Math.floor(ruleRng() * 34);
    const counts = Array(34).fill(0);
    for (const s of sets) for (const t of s.tiles) counts[t]++;
    counts[pair] += 2;
    if (counts.some((n) => n > 4)) return null;
    const pool = [];
    for (const s of sets) if (!(s.kind === 'trip' && s.type === trip)) pool.push(...s.tiles);
    pool.push(pair);
    const remove = pool[Math.floor(ruleRng() * pool.length)];
    const before = [];
    for (let t = 0; t < 34; t++) for (let n = 0; n < counts[t]; n++) before.push(t * 4 + n);
    const at = before.findIndex((id) => (id >> 2) === remove);
    if (at < 0) return null;
    before.splice(at, 1);
    const beforeCounts = T.countsFromIds(before);
    if (beforeCounts[trip] !== 3) return null;
    return { before, trip };
  };
  const cases = Number(process.env.RULES_ANKAN_CASES) || 10000;
  const checkGame = game();
  let checked = 0;
  for (let i = 0; i < cases; i++) {
    const made = makeRiichi();
    if (!made) continue;
    const before = made.before;
    assert.deepEqual(waitSet(before, 0), checkGame.waits(0, before), 'wait set is the union over all decompositions');
    const drawn = [0, 1, 2, 3].map((k) => made.trip * 4 + k).find((id) => !before.includes(id));
    const hand = before.concat(drawn).sort((a, b) => a - b);
    for (const mode of ['wait', 'strict', 'none']) {
      checkGame.rules = MJ.rules.normalize({ riichiAnkan: mode });
      checkGame.players[0].hand = hand.slice(); checkGame.players[0].drawnTile = drawn;
      checkGame.players[0].riichi = true; checkGame.players[0].melds = [];
      const actual = checkGame.availableKans(0).some((k) => k.kind === 'ankan' && k.tile === made.trip);
      assert.equal(actual, expectedAnkan(before, made.trip, mode),
        `${mode} ankan decision must equal the enumerated wait-set test (case ${i})`);
    }
    checked++;
  }
  assert(checked > 0, 'the riichi ankan generator produced cases');
  // Seven pairs / thirteen orphans have no quad, but their waits must be part of
  // the same enumeration.
  const chiitoi = [];
  for (const t of [0, 2, 4, 6, 8, 10]) chiitoi.push(t * 4, t * 4 + 1);
  chiitoi.push(12 * 4);
  assert(waitSet(chiitoi, 0).includes(12));
  const chiitoiWin = T.countsFromIds(chiitoi); chiitoiWin[12]++;
  assert(MJ.agari.isChiitoi(chiitoiWin, 0));
  const kokushi = T.YAOCHU_TYPES.map((t) => t * 4);
  const kokushiWait = waitSet(kokushi, 0);
  assert(kokushiWait.length > 0 && kokushiWait.every((t) => T.YAOCHU_TYPES.includes(t)));
  checkGame.rules = MJ.rules.normalize({ riichiAnkan: 'wait' });
  checkGame.players[0].hand = chiitoi.slice(); checkGame.players[0].drawnTile = null;
  checkGame.players[0].riichi = false; checkGame.players[0].melds = [];
  assert.equal(checkGame.availableKans(0).length, 0, 'special hands have no concealed kan');

  // Start dealer: deterministic, uniform from a stream separate from the wall.
  const seen = [0, 0, 0, 0];
  for (let s = 0; s < 4000; s++) {
    const d = MJ.rules.resolveStartDealer('random', s);
    assert(Number.isInteger(d) && d >= 0 && d < 4);
    assert.equal(MJ.rules.resolveStartDealer('random', s), d, 'start dealer is reproducible');
    seen[d]++;
  }
  for (const n of seen) assert(Math.abs(n / 4000 - 0.25) < 0.03, 'start dealer distribution is roughly uniform: ' + seen.join(','));
  for (let d = 0; d < 4; d++) assert.equal(MJ.rules.resolveStartDealer(d, 12345), d, 'fixed start dealer');
  assert.deepEqual(MJ.core.create({ dealer: 0, startDealer: 0 }, 777).wall,
    MJ.core.create({ startDealer: 3 }, 777).wall, 'startDealer never consumes the wall RNG');
  for (const start of [0, 1, 2, 3]) {
    let st = { hand: 0, dealer: start, startDealer: start, honba: 0, mode: 'tonpu' };
    const relative = [];
    for (let i = 0; i < 20 && !st.ended; i++) {
      relative.push((st.dealer - start + 4) % 4);
      st = MJ.match.advance(st, { type: 'win', winner: (st.dealer + 1) % 4 }, [25000, 25000, 25000, 25000]);
    }
    assert(st.ended, 'tonpu ends after four dealer moves');
    assert.deepEqual(relative, [0, 1, 2, 3], 'rounds follow dealer moves, not the absolute dealer seat');
  }
  let hanchan = { hand: 0, dealer: 2, startDealer: 2, honba: 0, mode: 'hanchan' };
  let hanchanHands = 0;
  while (!hanchan.ended && hanchanHands < 20) {
    hanchan = MJ.match.advance(hanchan, { type: 'win', winner: (hanchan.dealer + 1) % 4 }, [25000, 25000, 25000, 25000]);
    hanchanHands++;
  }
  assert.equal(hanchanHands, 8, 'hanchan ends after eight dealer moves');
  for (const mode of ['tonpu', 'hanchan']) for (const start of [0, 1, 2, 3]) {
    const played = await playSeatMatch(mode, start);
    assert(played.ended, `${mode} from dealer ${start} reaches a terminal state`);
    assert.equal(played.hand, mode === 'hanchan' ? 8 : 4, `${mode} plays the correct number of dealer moves`);
    assert.equal(played.dealer, (start + played.hand) % 4, 'the final dealer follows the start dealer rotation');
    assert.equal(played.scores.reduce((a, b) => a + b, 0) + played.sticks * 1000, 100000, 'scores and deposits are conserved');
  }
  // Per-deal wall seeds: distinct on every deal and reproducible per match seed.
  assert.notEqual(MJ.match.dealSeed(123, 0), MJ.match.dealSeed(123, 1), 'successive deals get different wall seeds');
  assert.notEqual(MJ.match.dealSeed(123, 0), MJ.match.dealSeed(124, 0), 'different matches get different wall seeds');
  assert.equal(MJ.match.dealSeed(123, 7), MJ.match.dealSeed(123, 7), 'a deal seed is deterministic');
  for (const mode of ['tonpu', 'hanchan']) for (let s = 0; s < 32; s++) {
    for (const fixed of [0, 1, 2, 3]) {
      const walls = dealWalls(s, fixed, mode);
      assert(allDistinct(walls), `every deal wall differs (${mode} seed ${s} dealer ${fixed})`);
      assert.deepEqual(dealWalls(s, fixed, mode), walls, 'the same match seed replays the same walls');
    }
    const randomStart = MJ.rules.resolveStartDealer('random', s);
    assert(allDistinct(dealWalls(s, randomStart, mode)), `random start dealer walls differ (${mode} seed ${s})`);
  }
  // Explicit regression: East-1 0 honba -> renchan East-1 1 honba. The round
  // index stays 0, but the deal counter advances, so the walls must differ.
  const east1 = { hand: 0, dealer: 2, startDealer: 2, honba: 0, mode: 'tonpu' };
  const repeat = MJ.match.advance(east1, { type: 'win', winner: 2 }, [25000, 25000, 25000, 25000]);
  assert.equal(repeat.hand, 0, 'renchan keeps the round index');
  assert.equal(repeat.honba, 1);
  assert.notDeepEqual(MJ.tiles.buildWall(MJ.core.rng(MJ.match.dealSeed(77, 0))),
    MJ.tiles.buildWall(MJ.core.rng(MJ.match.dealSeed(77, 1))), 'East-1 0 honba and East-1 1 honba do not share a wall');
  // Real hands driven with the production deal seed stay distinct and replayable.
  {
    const makeAgents = () => [0, 1, 2, 3].map(() => ({
      lastCallAnalysis: null, wantTsumo: async () => false, wantCall: async () => null, wantKan: async () => null,
      chooseDiscard: async (view) => ({ tileId: view.riichi ? view.drawnTile
        : (view.legalDiscards && view.legalDiscards.length ? view.legalDiscards[0] : view.hand[0]), riichi: false })
    }));
    const run = async (matchSeed, startDealer, mode) => {
      const walls = [];
      let state = { hand: 0, dealer: startDealer, startDealer, honba: 0, mode };
      let scores = [25000, 25000, 25000, 25000], sticks = 0;
      for (let dealIndex = 0; !state.ended && dealIndex < 40; dealIndex++) {
        const dealSeed = MJ.match.dealSeed(matchSeed, dealIndex);
        const game = new MJ.Game({ agents: makeAgents(), rng: MJ.core.rng(dealSeed) });
        const result = await game.playHand({ roundWind: 27 + Math.floor(state.hand / 4), dealer: state.dealer,
          startDealer: state.startDealer, honba: state.honba, riichiSticks: sticks, scores: scores.slice(),
          hand: state.hand, mode, seed: dealSeed });
        walls.push(game.wall.slice());
        scores = game.players.map((p) => p.score); sticks = game.riichiSticks;
        const next = MJ.match.advance(state, result, scores);
        state = { hand: next.hand, dealer: next.dealer, startDealer, honba: next.honba, mode };
      }
      return walls;
    };
    for (const mode of ['tonpu', 'hanchan']) {
      const first = await run(4242, 1, mode), second = await run(4242, 1, mode);
      assert(allDistinct(first), `real match walls all differ (${mode})`);
      assert.deepEqual(first, second, `real match walls replay from the same seed (${mode})`);
    }
  }
  const seatGame = new MJ.Game({ agents: [] });
  seatGame.setup({ roundWind: 27, dealer: 1, startDealer: 1, scores: [25000, 25000, 25000, 25000], hand: 0,
    wall: Array.from({ length: 136 }, (_, i) => i) });
  const seatObs = seatGame.getObservation(0);
  assert.equal(seatObs.startDealer, 1);
  assert.equal(seatObs.seatOrder, 3);
  assert.equal(seatObs.seatWind, 30, 'seat 0 is North when seat 1 is dealer');
  assert.equal(seatObs.roundNumber, 1);
  assert.equal(seatObs.isDealer, false);
  const rec = MJ.record.create('tonpu', 'standard'); rec.hands.push(d.recording);
  const copy = JSON.parse(JSON.stringify(rec)); MJ.record.validate(copy);
  assert.equal(MJ.record.snapshot(copy.hands[0], 2).players[0].river[1].tsumogiri, true);
  console.log('Rules, scoring regressions, fixed wall, furiten, match progression, record roundtrip OK');
})().catch((e) => { console.error(e); process.exit(1); });
