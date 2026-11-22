'use strict';
// Generate the Rust shanten/agari golden set from the JS engine.
//
//   node tools/shanten-golden.js --hands 5000 --out rust/tests/golden/shanten.json
//
// The Rust test (rust/tests/golden.rs) replays every counts vector and compares
// shanten and win detection. Random hands plus fixed boundary cases are used;
// this is a sampled exhaustive check, not an enumeration of every hand.
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ;

function parseArgs(argv) {
  const args = { hands: 5000, out: path.join(__dirname, '..', 'rust', 'tests', 'golden', 'shanten.json') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hands') args.hands = Math.max(1, Number(argv[++i]));
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--help') { console.log('usage: node tools/shanten-golden.js [--hands N] [--out FILE]'); process.exit(0); }
    else throw new Error('unknown option: ' + argv[i]);
  }
  return args;
}

function countsFrom(text) {
  const counts = new Array(34).fill(0);
  for (const [, ns, suit] of text.matchAll(/([0-9]+)([mpsz])/g)) {
    for (const ch of ns) counts['mpsz'.indexOf(suit) * 9 + Number(ch) - 1]++;
  }
  return counts;
}

const args = parseArgs(process.argv.slice(2));
const rows = [];
const push = (counts, melds) => rows.push({ c: counts, m: melds, s: MJ.shanten.shanten(counts, melds), a: MJ.agari.isAgari(counts, melds) });
// Fixed cases: complete, tenpai, chiitoi, kokushi, open melds.
for (const [text, melds] of [['123456789m123p11s', 0], ['123456789m12p11s', 0], ['1122334455667m', 0],
  ['19m19p19s1234567z', 0], ['19m19p19s1234567z1z', 0], ['456p789s111z22z', 1],
  ['11223344556677m', 0], ['123456789m123p1s', 0]]) push(countsFrom(text), melds);

let seed = 20261122;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
while (rows.length < args.hands) {
  const counts = new Array(34).fill(0);
  const melds = Math.floor(rnd() * 5);
  const total = 14 - melds * 3;
  let left = total;
  while (left > 0) {
    const t = Math.floor(rnd() * 34);
    if (counts[t] < 4) { counts[t]++; left--; }
  }
  push(counts, melds);
}
fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
fs.writeFileSync(args.out, JSON.stringify({ version: 'shanten-golden-v1', hands: rows }) + '\n');
console.log(`wrote ${rows.length} hands -> ${args.out}`);
