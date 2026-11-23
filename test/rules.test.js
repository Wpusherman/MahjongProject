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
  assert.deepEqual(ankanTiles(riichiGame('777m44m456m666p88p', 3, { riichiAnkan: 'wait' }).g), [3],
    'wait mode allows a kan whose waits are unchanged even if one decomposition uses a run');
  assert.deepEqual(ankanTiles(riichiGame('777m44m456m666p88p', 3, { riichiAnkan: 'strict' }).g), [],
    'strict mode rejects a kan unless every decomposition uses the triplet');
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
