'use strict';
// Decision-level divergence between two AI profiles on identical public views.
//
//   node tools/divergence.js --hands 500 --fast --out test-results/divergence.json
//
// `--fast` compares standard vs fast (the evaluation-only profile). Without it
// the two profiles are strong vs standard. The game result can look identical
// when both sides pick the same discard, so agreement is measured directly.
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ, T = MJ.tiles;

function parseArgs(argv) {
  const args = { hands: 300, seed: 20261122, fast: false, out: null, threat: 0.35, root: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--hands') args.hands = Math.max(1, Number(argv[++i]));
    else if (argv[i] === '--seed') args.seed = Number(argv[++i]);
    else if (argv[i] === '--threat') args.threat = Number(argv[++i]);
    else if (argv[i] === '--fast') { args.fast = true; continue; }
    else if (argv[i] === '--root') args.root = Number(argv[++i]);
    else if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--help') { console.log('usage: node tools/divergence.js [--hands N] [--fast] [--out FILE]'); process.exit(0); }
    else throw new Error('unknown option: ' + argv[i]);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
let seed = args.seed >>> 0;
const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

function randomView() {
  const counts = new Array(34).fill(0), hand = [];
  let left = 14;
  while (left > 0) {
    const t = Math.floor(rnd() * 34);
    if (counts[t] < 4) { counts[t]++; hand.push(t * 4 + counts[t] - 1); left--; }
  }
  hand.sort((a, b) => a - b);
  const seat = Math.floor(rnd() * 4), dealer = Math.floor(rnd() * 4);
  const unseen = counts.map((n) => 4 - n);
  const opponents = [0, 1, 2, 3].filter((s) => s !== seat).map((s) => ({
    seat: s, riichi: rnd() < args.threat, discards: [], discardTypes: [],
    safeTypes: [], melds: [], score: 25000, isDealer: s === dealer
  }));
  return { hand, drawnTile: hand[hand.length - 1], melds: [], menzen: true, riichi: false, seat,
    seatWind: 27 + ((seat - dealer + 4) % 4), roundWind: 27, dealer, isDealer: seat === dealer,
    score: 25000, liveRemaining: 12 + Math.floor(rnd() * 58), turnCount: Math.floor(rnd() * 14),
    unseen, ownDiscardTypes: [], opponents, doraIndicators: [], threat: opponents.some((o) => o.riichi),
    honba: 0, riichiSticks: 0, handsLeft: 4 };
}

const profileA = args.fast ? 'fast' : 'strong';
const profileB = 'standard';
const results = [];
let agree = 0, topInOther = 0, totalRank = 0, scoreGap = 0;
const started = Date.now();
for (let i = 0; i < args.hands; i++) {
  const view = randomView();
  const opts = args.root ? { rootCandidates: args.root } : {};
  const a = MJ.ai.analyzeDiscard(view, profileA, MJ.ai.weights, opts);
  const b = MJ.ai.analyzeDiscard(view, profileB);
  const pickA = a.candidates[0], pickB = b.candidates[0];
  const ok = pickA.t === pickB.t;
  const index = a.candidates.findIndex((c) => c.t === pickB.t);
  if (ok) agree++;
  if (index >= 0) topInOther++;
  totalRank += index < 0 ? a.candidates.length : index;
  scoreGap += Math.abs(pickA.score - pickB.score);
  results.push({ hand: view.hand.slice(), pickA: pickA.t, pickB: pickB.t, agree: ok, rankOfB: index });
}
const elapsedMs = Date.now() - started;
const report = {
  format: 'suitaku-divergence', version: 1, profileA, profileB, hands: args.hands, threat: args.threat,
  agreement: agree / args.hands, topInOther: topInOther / args.hands,
  meanRankOfOther: totalRank / args.hands, meanAbsScoreGap: scoreGap / args.hands, elapsedMs
};
console.log(`${profileA} vs ${profileB}: ${(report.agreement * 100).toFixed(1)}% top-1 agreement, ` +
  `other top ranked ${report.meanRankOfOther.toFixed(2)} on average, mean |score gap| ${report.meanAbsScoreGap.toFixed(2)} ` +
  `(${args.hands} hands, ${(elapsedMs / 1000).toFixed(1)} s)`);
if (args.out) { fs.writeFileSync(args.out, JSON.stringify({ ...report, results }, null, 2)); console.log('wrote', args.out); }
