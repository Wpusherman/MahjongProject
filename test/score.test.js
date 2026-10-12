require('../src/tiles.js');
require('../src/shanten.js');
require('../src/agari.js');
require('../src/yaku.js');
require('../src/score.js');

const T = globalThis.MJ.tiles;
const Y = globalThis.MJ.yaku;
const SC = globalThis.MJ.score;
const A = globalThis.MJ.agari;

let pass = 0, fail = 0;
function eq(a, b, msg) { if (a === b) pass++; else { fail++; console.log(`FAIL: ${msg} expected=${b} actual=${a}`); } }
function has(list, name) { return list.some((y) => y.name === name); }

function C(spec) {
  const c = new Array(34).fill(0);
  for (const [suit, nums] of Object.entries(spec)) for (const n of nums) {
    let t = suit === 'm' ? n - 1 : suit === 'p' ? 9 + n - 1 : suit === 's' ? 18 + n - 1 : 27 + n - 1;
    c[t]++;
  }
  return c;
}
function T2(suit, n) { return suit === 'm' ? n - 1 : suit === 'p' ? 9 + n - 1 : suit === 's' ? 18 + n - 1 : 27 + n - 1; }

function ctxOf(counts, winTile, extra) {
  return Object.assign({
    counts, melds: [], winTile, tsumo: false,
    riichi: false, doubleRiichi: false, ippatsu: false,
    chankan: false, rinshan: false, haitei: false, houtei: false,
    seatWind: 28, roundWind: 27, isDealer: false,
    doraIndicators: [], uraIndicators: [], redIds: [],
  }, extra || {});
}

// 1. Riichi + Pinfu ron
{
  const counts = C({ m: [2, 3, 4, 5, 6, 7], p: [2, 3, 4, 5, 6, 7], s: [8, 8] });
  const ctx = ctxOf(counts, T2('m', 4), { riichi: true });
  const ev = Y.evaluate(ctx);
  eq(ev.han, 3, 'riichi+pinfu+tanyao han');
  eq(has(ev.list, '立直'), true, 'has riichi');
  eq(has(ev.list, '平和'), true, 'has pinfu');
  const sc = SC.compute(ctx, ev, 0);
  eq(sc.fu, 30, 'riichi+pinfu fu');
  eq(sc.payments.ron, 3900, 'riichi+pinfu points');
}

// 2. Pinfu + Tanyao + Menzen tsumo
{
  const counts = C({ m: [2, 3, 4, 5, 6, 7], p: [3, 4, 5, 6, 7, 8], s: [5, 5] });
  const ctx = ctxOf(counts, T2('p', 3), { tsumo: true });
  const ev = Y.evaluate(ctx);
  eq(ev.han, 3, 'pinfu+tanyao+tsumo han');
  const sc = SC.compute(ctx, ev, 0);
  eq(sc.fu, 20, 'pinfu tsumo fu');
}

// 3. Chiitoi
{
  const counts = C({ m: [1, 1, 2, 2, 4, 4], p: [1, 1, 2, 2, 3, 3], s: [4, 4] });
  const ctx = ctxOf(counts, T2('s', 4), { tsumo: true });
  const ev = Y.evaluate(ctx);
  eq(has(ev.list, '七対子'), true, 'chiitoi detected');
  const sc = SC.compute(ctx, ev, 0);
  eq(sc.fu, 25, 'chiitoi fu');
}

// 4. Kokushi
{
  const counts = C({ m: [1, 1, 9], p: [1, 9], s: [1, 9], z: [1, 2, 3, 4, 5, 6, 7] });
  const ctx = ctxOf(counts, T2('m', 1), {});
  const ev = Y.evaluate(ctx);
  eq(ev.yakuman, true, 'kokushi yakuman');
  eq(has(ev.list, '国士無双'), true, 'kokushi name');
}

// 5. Yakuhai chun
{
  const counts = C({ m: [2, 3, 4], p: [2, 3, 4], s: [2, 3, 4], z: [7, 7, 7, 1, 1] });
  const ctx = ctxOf(counts, T2('z', 7), {});
  const ev = Y.evaluate(ctx);
  eq(has(ev.list, '役牌 中'), true, 'chun yakuhai');
}

// 6. Suuankou tsumo
{
  const counts = C({ m: [2, 2, 2], p: [5, 5, 5], s: [3, 3, 3], z: [1, 1, 1, 2, 2] });
  const ctx = ctxOf(counts, T2('z', 2), { tsumo: true });
  const ev = Y.evaluate(ctx);
  eq(ev.yakuman, true, 'suuankou yakuman');
  eq(has(ev.list, '四暗刻'), true, 'suuankou name');
}

// 7. No yaku (open hand all simples no yaku)
{
  const counts = C({ m: [2, 3, 4, 5, 6, 7, 7, 8, 9], s: [5, 5] });
  const ctx = ctxOf(counts, T2('m', 3), { melds: [{ kind: 'seq', type: T2('p', 1), open: true }], riichi: false });
  const ev = Y.evaluate(ctx);
  eq(ev.list.length, 0, 'no yaku');
}

// 8. Sanshoku doujun
{
  const counts = C({ m: [2, 3, 4], p: [2, 3, 4, 5, 6, 7], s: [2, 3, 4], z: [1, 1] });
  const ctx = ctxOf(counts, T2('z', 1), { tsumo: true });
  const ev = Y.evaluate(ctx);
  eq(has(ev.list, '三色同順'), true, 'sanshoku');
}

// 9. Ittsu
{
  const counts = C({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], p: [1, 2, 3], z: [1, 1] });
  const ctx = ctxOf(counts, T2('p', 3), { tsumo: true });
  const ev = Y.evaluate(ctx);
  eq(has(ev.list, '一気通貫'), true, 'ittsu');
}

// 10. isAgari sanity
eq(A.isAgari(C({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], p: [1, 2, 3], s: [1, 1] }), 0), true, 'isAgari true');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
