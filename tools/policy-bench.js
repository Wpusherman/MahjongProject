'use strict';
// Measure ONNX policy inference throughput for several batch sizes.
//
//   node tools/policy-bench.js --model test-results/policy-model-tenhou/policy.onnx --samples 4096
//
// The game engine asks one seat at a time, so in-game inference is batch=1.
// This benchmark isolates the runtime cost and shows the batching headroom for a
// future multi-seat scheduler.
const path = require('node:path');
for (const file of ['tiles', 'features', 'policy']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ;

function parseArgs(argv) {
  const args = { model: null, samples: 2048, batches: [1, 8, 32, 128, 256], out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--model') args.model = argv[++i];
    else if (key === '--samples') args.samples = Math.max(1, Number(argv[++i]));
    else if (key === '--batches') args.batches = String(argv[++i]).split(',').map(Number).filter((n) => n > 0);
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--help' || key === '-h') {
      console.log('usage: node tools/policy-bench.js --model FILE [--samples N] [--batches 1,8,32,128] [--out FILE]');
      process.exit(0);
    } else throw new Error('unknown option: ' + key);
  }
  if (!args.model) throw new Error('--model is required');
  return args;
}

function observation(rng) {
  const hand = [];
  for (let i = 0; i < 14; i++) hand.push(Math.floor(rng() * 136));
  const scores = [0, 0, 0, 0].map(() => 15000 + Math.floor(rng() * 40000));
  const opponents = [1, 2, 3].map((offset, i) => ({
    seat: (i + 1) % 4, handCount: 13, riichi: false, discards: [], discardTypes: [],
    discardHistory: [], melds: [], score: scores[(i + 1) % 4], isDealer: false, safeTypes: []
  }));
  return {
    hand, drawnTile: hand[13], melds: [], menzen: true, riichi: false, seat: 0,
    seatWind: 27, roundWind: 27, isDealer: false, scores, score: scores[0],
    doraIndicators: [Math.floor(rng() * 136)], unseen: new Array(34).fill(2),
    ownDiscardHistory: [], opponents, honba: 0, riichiSticks: 0, handsLeft: 4,
    handIndex: 0, liveRemaining: 60, turnCount: 4
  };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const model = await MJ.policy.load(args.model);
  let seed = 20261123;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const views = Array.from({ length: args.samples }, () => observation(rng));
  // Warm up the runtime and the feature cache.
  await MJ.policy.predictBatch(model, views.slice(0, Math.min(4, views.length)));
  const results = [];
  for (const batch of args.batches) {
    const started = Date.now();
    let done = 0;
    for (let i = 0; i < views.length; i += batch) {
      await MJ.policy.predictBatch(model, views.slice(i, i + batch));
      done += Math.min(batch, views.length - i);
    }
    const ms = Date.now() - started;
    results.push({ batch, samples: done, elapsedMs: ms, samplesPerSecond: done / (ms / 1000) });
    console.log(`batch ${String(batch).padStart(3)}: ${done} samples in ${ms} ms = ${(done / (ms / 1000)).toFixed(0)} samples/s`);
  }
  if (args.out) {
    const report = { format: 'suitaku-policy-bench', version: MJ.policy.version, model: args.model, samples: args.samples, results,
      note: 'In-game inference is batch=1 because turns are sequential; this isolates batching headroom.' };
    require('node:fs').writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log('wrote', args.out);
  }
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
