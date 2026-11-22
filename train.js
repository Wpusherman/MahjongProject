'use strict';
// Self-play weight tuner for the 翠卓 AI.
//
//   node train.js                       run evolution from the built-in defaults
//   node train.js --hands 240 --iters 30
//   node train.js --resume weights.json --out weights-v2.json
//   node train.js --eval weights.json    score a weights file against the baseline
//
// Fitness is the candidate seat's average final points in seeded self-play where the
// candidate occupies each seat in turn and the other three seats use the baseline
// weights. The same wall seeds are reused for every candidate so comparisons are fair.
const { Worker } = require('node:worker_threads');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game']) require('./src/' + file + '.js');
const MJ = globalThis.MJ;

// Search bounds per weight. The built-in value always lies inside its range.
const RANGES = {
  shantenCost: [40, 400], ukeireGain: [0, 5], shapeGain: [0, 10], grossWeight: [0, 0.2],
  spareFive: [0, 1.5], spareLow: [0, 2], headBonus: [0, 10], secondPairBonus: [0, 6], pairYakuhai: [0, 1.5],
  growthHonor: [0, 0.6], growthHonorPair: [0, 0.6], growthNumber: [0, 0.8],
  growthNeighbor: [0, 1.6], growthKabe: [0, 1.2], growthEdge: [0, 1.2],
  survivalBase: [0.005, 0.1], survivalThreat: [0.02, 0.25],
  dangerScale: [0.3, 2.5], dangerPoints: [0.3, 2.5],
  pushMargin: [-500, 1000], callDefense: [0, 600], callDeltaRatio: [0, 0.2], callDeltaMin: [0, 200],
};

const WORKER = path.join(__dirname, 'train-worker.js');

function parseArgs(argv) {
  const args = { hands: 160, population: 8, iters: 20, sigma: 0.15, mutateRate: 0.5,
    level: 'standard', workers: Math.max(1, Math.min(8, os.cpus().length - 1)),
    seed: 20261020, out: 'weights.json', holdout: 240 };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, '');
    if (key === 'help') { args.help = true; continue; }
    if (key === 'eval') { args.eval = argv[++i]; continue; }
    if (key === 'baseline') { args.baseline = argv[++i]; continue; }
    if (key === 'resume') { args.resume = argv[++i]; continue; }
    const value = argv[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    if (['level', 'out'].includes(key)) args[key] = value;
    else args[key] = Number(value);
  }
  return args;
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function gaussian(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function mutate(base, sigma, rng, rate) {
  const out = { ...base };
  for (const key of Object.keys(RANGES)) {
    if (rng() < rate) out[key] = clamp(base[key] + gaussian(rng) * sigma * (RANGES[key][1] - RANGES[key][0]), RANGES[key][0], RANGES[key][1]);
  }
  return out;
}
function loadWeights(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const weights = data && data.weights ? data.weights : data;
  if (!weights || typeof weights !== 'object') throw new Error('weights file must contain a weights object');
  return weights;
}

function runTask(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    let settled = false;
    worker.on('message', (msg) => {
      if (msg.type === 'result') { settled = true; resolve(msg); }
      else if (msg.type === 'error') { settled = true; reject(new Error(msg.message)); }
    });
    worker.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    worker.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('worker exited with code ' + code)); } });
  });
}

// Evaluate every entry of `list` against the baseline on the same seed set.
async function evaluatePopulation(list, opts, onDone) {
  const { hands, level, seed, workers } = opts;
  const lanes = Math.min(workers, hands);
  const slices = Array.from({ length: lanes }, (_, i) => ({ start: Math.floor(hands * i / lanes), count: Math.floor(hands * (i + 1) / lanes) - Math.floor(hands * i / lanes) }))
    .filter((s) => s.count > 0);
  const tasks = [];
  for (let index = 0; index < list.length; index++) for (const slice of slices) tasks.push({ index, slice });
  const stats = list.map(() => ({ total: 0, placements: 0, wins: 0, dealins: 0, games: 0 }));
  let cursor = 0, finished = 0;
  async function lane() {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      const result = await runTask({ weights: list[task.index], baseline: opts.baseline, level, seed, start: task.slice.start, count: task.slice.count });
      const agg = stats[task.index];
      agg.total += result.total; agg.placements += result.placements; agg.wins += result.wins; agg.dealins += result.dealins; agg.games += result.games;
      finished++;
      if (onDone) onDone(finished, tasks.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, tasks.length) }, lane));
  return stats.map((s) => ({ ...s, avgScore: s.total / s.games, avgPlacement: s.placements / s.games, winRate: s.wins / s.games, dealInRate: s.dealins / s.games }));
}

function fmt(stats) {
  return `平均${Math.round(stats.avgScore)}点 / 順位${stats.avgPlacement.toFixed(2)} / 和了${(stats.winRate * 100).toFixed(1)}% / 放銃${(stats.dealInRate * 100).toFixed(1)}%`;
}
const help = () => console.log([
  'usage: node train.js [options]',
  '  --hands N        games scored per candidate (default 160)',
  '  --population N   offspring per iteration (default 8)',
  '  --iters N        evolution iterations (default 20)',
  '  --sigma X        initial mutation step as a fraction of the range (default 0.15)',
  '  --mutate-rate X  per-weight mutation probability (default 0.5)',
  '  --level L        AI level for self-play: standard | strong (default standard)',
  '  --workers N      parallel workers (default min(cpus-1, 8))',
  '  --seed N         RNG seed for the training walls (default 20261020)',
  '  --holdout N      games for the final held-out report (default 240)',
  '  --out PATH       output weights file (default weights.json)',
  '  --resume PATH    start from a weights file instead of the built-in defaults',
  '  --baseline PATH  baseline weights for the other three seats (default built-in)',
  '  --eval PATH      evaluate a weights file against the baseline and exit',
].join('\n'));

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  const defaults = { ...MJ.ai.weights };
  const baseline = args.baseline ? { ...defaults, ...loadWeights(args.baseline) } : defaults;
  const level = args.level;
  if (args.eval) {
    const weights = { ...defaults, ...loadWeights(args.eval) };
    console.log(`workers ${args.workers} / level ${level} / eval ${args.hands} games`);
    const started = Date.now();
    const [candidate, base] = await evaluatePopulation([weights, baseline], { hands: args.hands, level, seed: args.seed, workers: args.workers, baseline });
    console.log(`candidate ${fmt(candidate)}`);
    console.log(`baseline  ${fmt(base)}`);
    console.log(`score delta ${Math.round(candidate.avgScore - base.avgScore)}点 (${((Date.now() - started) / 1000).toFixed(0)}s)`);
    return;
  }
  console.log(`workers ${args.workers} / level ${level} / ${args.hands} games per candidate / ${args.population}+1 per iteration`);

  const rng = mulberry32(args.seed ^ 0x1234567);
  let current = args.resume ? { ...defaults, ...loadWeights(args.resume) } : { ...defaults };
  let best = current, bestStats = null, bestFit = -Infinity;
  let sigma = args.sigma;
  const started = Date.now();
  for (let iter = 1; iter <= args.iters; iter++) {
    const population = [current];
    for (let i = 0; i < args.population; i++) population.push(mutate(current, sigma, rng, args.mutateRate));
    const stats = await evaluatePopulation(population, { hands: args.hands, level, seed: args.seed, workers: args.workers, baseline });
    let winner = 0;
    for (let i = 1; i < stats.length; i++) if (stats[i].avgScore > stats[winner].avgScore) winner = i;
    const improved = winner !== 0;
    current = population[winner];
    sigma = clamp(improved ? sigma * 1.15 : sigma * 0.85, 0.02, 0.4);
    if (stats[winner].avgScore > bestFit) { best = current; bestFit = stats[winner].avgScore; bestStats = stats[winner]; }
    const elapsed = ((Date.now() - started) / 1000).toFixed(0);
    console.log(`iter ${String(iter).padStart(3)} sigma ${sigma.toFixed(3)} ${improved ? 'accept' : 'reject'}  best ${Math.round(stats[winner].avgScore)}点 (順位${stats[winner].avgPlacement.toFixed(2)})  ${elapsed}s`);
  }

  if (args.holdout > 0) {
    const holdoutSeed = (args.seed ^ 0x51ed270b) >>> 0;
    const [trained, base] = await evaluatePopulation([best, baseline], { hands: args.holdout, level, seed: holdoutSeed, workers: args.workers, baseline });
    bestStats = trained;
    console.log(`holdout (${args.holdout}戦 seed ${holdoutSeed}) trained ${fmt(trained)}`);
    console.log(`holdout baseline ${fmt(base)} / delta ${Math.round(trained.avgScore - base.avgScore)}点`);
  }

  const output = { format: 'suitaku-ai-weights', version: 1, aiVersion: MJ.ai.version, createdAt: new Date().toISOString(),
    weights: best, fitness: bestStats && { avgScore: bestStats.avgScore, avgPlacement: bestStats.avgPlacement, winRate: bestStats.winRate, dealInRate: bestStats.dealInRate },
    training: { hands: args.hands, population: args.population, iters: args.iters, level, seed: args.seed, baseline: args.baseline || 'builtin' } };
  fs.writeFileSync(args.out, JSON.stringify(output, null, 2) + '\n');
  console.log(`wrote ${args.out}`);
})().catch((error) => { console.error(error); process.exit(1); });
