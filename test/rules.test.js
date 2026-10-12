const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'record']) require('../src/' + file + '.js');
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
  const rec = MJ.record.create('tonpu', 'standard'); rec.hands.push(d.recording);
  const copy = JSON.parse(JSON.stringify(rec)); MJ.record.validate(copy);
  assert.equal(MJ.record.snapshot(copy.hands[0], 2).players[0].river[1].tsumogiri, true);
  console.log('Rules, scoring regressions, fixed wall, furiten, match progression, record roundtrip OK');
})().catch((e) => { console.error(e); process.exit(1); });
