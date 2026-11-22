'use strict';
// Duplicate self-play evaluation.
//
//   node tools/evaluate.js --candidate weights.json --seeds 400 --workers 8
//   node tools/evaluate.js --seeds 200 --rank mleague --control
//
// Each seed uses the same wall with the candidate in seats 0,1,2,3 and the
// baseline AI in the other seats. The reported 95% CI is a normal approximation;
// for tens of thousands of games use --seeds large enough to make it meaningful.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'core', 'evaluate']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;
const WORKER = path.join(__dirname, 'evaluate-worker.js');

function parseArgs(argv) {
  const args = { seeds: 200, workers: Math.max(1, Math.min(8, (os.cpus().length || 2) - 1)),
    seed: 20261020, level: 'standard', rank: 'tenhou', control: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--control') { args.control = true; continue; }
    if (key === '--seeds') args.seeds = Number(argv[++i]);
    else if (key === '--workers') args.workers = Number(argv[++i]);
    else if (key === '--seed') args.seed = Number(argv[++i]);
    else if (key === '--level') args.level = argv[++i];
    else if (key === '--candidate-level') args.candidateLevel = argv[++i];
    else if (key === '--baseline-level') args.baselineLevel = argv[++i];
    else if (key === '--candidate') args.candidate = argv[++i];
    else if (key === '--baseline') args.baseline = argv[++i];
    else if (key === '--rank') args.rank = argv[++i];
    else if (key === '--dealer') args.dealer = Number(argv[++i]);
    else if (key === '--out') args.out = argv[++i];
    else throw new Error('unknown option: ' + key);
  }
  return args;
}
const loadWeights = (file) => {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const weights = data && data.weights ? data.weights : data;
  if (!weights || typeof weights !== 'object') throw new Error('weights file must contain an object');
  return weights;
};
const usage = [
  'usage: node tools/evaluate.js [options]',
  '  --candidate FILE     candidate weights JSON (default: built-in weights)',
  '  --baseline FILE      baseline weights JSON (default: built-in weights)',
  '  --level LEVEL        both levels: standard|strong (default: standard)',
  '  --candidate-level    candidate level override',
  '  --baseline-level     baseline level override',
  '  --seeds N            wall seeds; each seed plays four games (default: 200)',
  '  --workers N          worker threads (default: CPU-1, max 8)',
  '  --seed N             first seed (default: 20261020)',
  '  --rank NAME          tenhou|mleague|raw (default: tenhou)',
  '  --dealer N           fixed dealer seat (default: seed % 4)',
  '  --control            also run baseline-vs-baseline and report paired delta',
  '  --out FILE           write a JSON report',
  '  --help'
].join('\n');

function runSlice(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    let settled = false;
    worker.on('message', (message) => {
      if (message.type === 'result') { settled = true; resolve(message.rows); }
      else if (message.type === 'error') { settled = true; reject(new Error(message.message)); }
    });
    worker.on('error', (error) => { if (!settled) { settled = true; reject(error); } });
    worker.on('exit', (code) => { if (!settled) { settled = true; reject(new Error('worker exited with code ' + code)); } });
  });
}

async function evaluate(params) {
  const seeds = Math.max(1, Math.floor(params.seeds));
  const workers = Math.max(1, Math.min(Math.floor(params.workers), seeds));
  const slices = [];
  for (let i = 0; i < workers; i++) {
    const start = Math.floor(seeds * i / workers), end = Math.floor(seeds * (i + 1) / workers);
    if (end > start) slices.push({ start, count: end - start });
  }
  const tasks = slices.map((slice) => runSlice({ ...params, seeds: undefined, start: slice.start, count: slice.count }));
  const results = await Promise.all(tasks);
  return results.flat();
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); return; }
  const candidateWeights = args.candidate ? loadWeights(args.candidate) : MJ.ai.weights;
  const baselineWeights = args.baseline ? loadWeights(args.baseline) : MJ.ai.weights;
  const common = { seed: args.seed, seeds: args.seeds, workers: args.workers, rankConfig: args.rank,
    level: args.level, candidateLevel: args.candidateLevel || args.level, baselineLevel: args.baselineLevel || args.level,
    dealer: Number.isFinite(args.dealer) ? args.dealer : undefined };
  console.log(`evaluating ${args.seeds} seeds (${args.seeds * 4} games), workers=${args.workers}, level=${common.candidateLevel}/${common.baselineLevel}`);
  const started = Date.now();
  const candidateRows = await evaluate({ ...common, candidateWeights, baselineWeights });
  let controlRows = null;
  if (args.control) {
    console.log('control: baseline vs baseline');
    controlRows = await evaluate({ ...common, candidateWeights: baselineWeights, baselineWeights,
      candidateLevel: common.baselineLevel, baselineLevel: common.baselineLevel });
  }
  const elapsedMs = Date.now() - started;
  const candidate = MJ.evaluate.summarize(candidateRows, { rankConfig: args.rank });
  const control = controlRows ? MJ.evaluate.summarize(controlRows, { rankConfig: args.rank }) : null;
  const delta = controlRows ? MJ.evaluate.pairedDelta(candidateRows, controlRows) : null;
  const gamesPerSecond = candidateRows.length / (elapsedMs / 1000);
  const report = {
    version: MJ.evaluate.version, config: { seeds: args.seeds, games: candidateRows.length, workers: args.workers,
      seed: args.seed, rank: args.rank, candidateLevel: common.candidateLevel, baselineLevel: common.baselineLevel,
      candidate: args.candidate || 'built-in', baseline: args.baseline || 'built-in', control: !!args.control },
    candidate, control, delta, throughput: { elapsedMs, gamesPerSecond }
  };
  console.log(MJ.evaluate.formatReport(candidate, { control, delta, elapsedMs, gamesPerSecond }));
  if (delta) {
    if (delta.mean - delta.ci95 > 0) console.log('decision: improvement (paired delta CI above 0)');
    else if (delta.mean + delta.ci95 < 0) console.log('decision: regression (paired delta CI below 0)');
    else console.log('decision: inconclusive (paired delta CI includes 0)');
  } else {
    const c = candidate.seedClusterRankPoints;
    if (c.mean - c.ci95 > 0) console.log('decision: improvement (seed-cluster CI above 0)');
    else if (c.mean + c.ci95 < 0) console.log('decision: regression (seed-cluster CI below 0)');
    else console.log('decision: inconclusive (seed-cluster CI includes 0; use --control for non-zero-sum ranks)');
  }
  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(report, null, 2)); console.log('wrote', args.out); }
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
