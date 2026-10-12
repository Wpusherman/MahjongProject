require('../src/tiles.js');
require('../src/shanten.js');

const T = globalThis.MJ.tiles;
const S = globalThis.MJ.shanten;

let pass = 0;
let fail = 0;
function eq(actual, expected, msg) {
  if (actual === expected) {
    pass++;
  } else {
    fail++;
    console.log(`FAIL: ${msg}  expected=${expected} actual=${actual}`);
  }
}

function C(spec) {
  const c = new Array(34).fill(0);
  for (const [suit, nums] of Object.entries(spec)) {
    for (const n of nums) {
      let t;
      if (suit === 'm') t = n - 1;
      else if (suit === 'p') t = 9 + n - 1;
      else if (suit === 's') t = 18 + n - 1;
      else if (suit === 'z') t = 27 + n - 1;
      c[t]++;
    }
  }
  return c;
}

// Complete hand
eq(S.shanten(C({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], p: [1, 2, 3], s: [1, 1] })), -1, 'win standard');
// Tenpai: remove 3p -> waiting 3p
eq(S.shanten(C({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], p: [1, 2], s: [1, 1] })), 0, 'tenpai standard');
// 1-shanten
eq(S.shanten(C({ m: [1, 2, 3, 4, 5, 6, 7, 8], p: [1, 2], s: [1, 1] })), 1, '1-shanten');
// Kokushi tenpai
eq(S.shanten(C({ m: [1, 9], p: [1, 9], s: [1, 9], z: [1, 2, 3, 4, 5, 6, 7] })), 0, 'kokushi tenpai');
// Kokushi 13-wait complete
eq(S.shanten(C({ m: [1, 1, 9], p: [1, 9], s: [1, 9], z: [1, 2, 3, 4, 5, 6, 7] })), -1, 'kokushi win');
// Chiitoi tenpai
eq(S.shanten(C({ m: [1, 1, 2, 2, 3, 3], p: [4, 4, 5, 5], s: [6, 6, 7] })), 0, 'chiitoi tenpai');
// Chiitoi complete
eq(S.shanten(C({ m: [1, 1, 2, 2, 3, 3], p: [4, 4, 5, 5], s: [6, 6, 7, 7] })), -1, 'chiitoi win');
// Open melds: 1 open set, hand 3 sets + pair + taatsu
eq(S.shanten(C({ m: [4, 5, 6, 7, 8, 9], p: [1, 1, 2, 3] }), 1), 0, 'open tenpai');
// 7 pairs max pairs
eq(S.shanten(C({ m: [1, 1, 2, 2, 3, 3, 4, 4], p: [5, 5, 6, 6], s: [7] })), 0, 'chiitoi 6pairs+1');

// Ukeire: tenpai 2-sided 1p2p waiting 1p/3p with all visible -> counts
const hand = C({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], p: [1, 2], s: [1, 1] });
const uk = S.ukeire(hand, 0, null);
eq(uk.tiles.length >= 1, true, 'ukeire has tiles');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
