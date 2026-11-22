'use strict';
// Steady-state throughput benchmark. Worker startup, module loading and the
// first `--warmup` seeds per worker are excluded from games/s, because short
// 16-game runs otherwise report a much lower number (42.5 vs 56.2 in v3).
//
//   node tools/bench-throughput.js --seeds 128 --warmup 8 --workers 4
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const WORKER = path.join(__dirname, 'bench-worker.js');

function parseArgs(argv) {
  const args = { seeds: 128, warmup: 8, workers: Math.max(1, Math.min(8, (os.cpus().length || 2) - 1)),
    seed: 20261020, rank: 'tenhou', level: 'standard', scorePattern: 'handicap', out: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--seeds') args.seeds = Number(argv[++i]);
    else if (key === '--warmup') args.warmup = Number(argv[++i]);
    else if (key === '--workers') args.workers = Number(argv[++i]);
    else if (key === '--seed') args.seed = Number(argv[++i]);
    else if (key === '--rank') args.rank = argv[++i];
    else if (key === '--level') args.level = argv[++i];
    else if (key === '--score-pattern') args.scorePattern = argv[++i];
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--help' || key === '-h') {
      console.log('usage: node tools/bench-throughput.js [--seeds N] [--warmup N] [--workers N] [--level standard|fast] [--out FILE]');
      process.exit(0);
    } else throw new Error('unknown option: ' + key);
  }
  return args;
}

function run(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    worker.on('message', (m) => m.type === 'result' ? resolve(m.times) : reject(new Error(m.message)));
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code) reject(new Error('worker exited ' + code)); });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const seeds = Math.max(1, Math.floor(args.seeds));
  const warmup = Math.max(0, Math.min(Math.floor(args.warmup), seeds - 1));
  const workers = Math.max(1, Math.min(Math.floor(args.workers), seeds));
  const started = Date.now();
  const tasks = [];
  for (let i = 0; i < workers; i++) {
    const start = Math.floor(seeds * i / workers), end = Math.floor(seeds * (i + 1) / workers);
    if (end > start) tasks.push(run({ seed: args.seed, start, count: end - start, warmup,
      rankConfig: args.rank, level: args.level, scorePattern: args.scorePattern }));
  }
  const perWorker = await Promise.all(tasks);
  const elapsed = Date.now() - started;
  // Rotate mode plays four seats per seed. Throughput is games/s, not seeds/s.
  const gamesPerSeed = 4;
  let warmupSeeds = 0, steadySeeds = 0, steadyWallMs = 0, warmupWallMs = 0;
  for (const times of perWorker) {
    let warm = 0, steady = 0, warmCount = 0, steadyCount = 0;
    times.forEach((ms, index) => {
      if (index < warmup) { warm += ms; warmCount++; }
      else { steady += ms; steadyCount++; }
    });
    warmupSeeds += warmCount; steadySeeds += steadyCount;
    if (steadyCount) steadyWallMs = Math.max(steadyWallMs, steady);
    if (warmCount) warmupWallMs = Math.max(warmupWallMs, warm);
  }
  const steadyGames = steadySeeds * gamesPerSeed, warmupGames = warmupSeeds * gamesPerSeed;
  const report = {
    seeds, warmup, workers, level: args.level, rank: args.rank, scorePattern: args.scorePattern,
    gamesPerSeed, wallMs: elapsed,
    steadySeeds, steadyGames,
    steadyGamesPerSecond: steadyWallMs ? steadyGames / (steadyWallMs / 1000) : 0,
    allGamesPerSecond: (seeds * gamesPerSeed) / (elapsed / 1000),
    warmupGames, warmupGamesPerSecond: warmupWallMs ? warmupGames / (warmupWallMs / 1000) : null,
    note: 'steady uses the slowest worker, excludes the first --warmup seeds per worker and worker startup'
  };
  console.log(`steady ${report.steadyGamesPerSecond.toFixed(1)} games/s (${steadyGames} games = ${steadySeeds} seeds, warmup ${warmup} seeds/worker excluded)`);
  console.log(`including startup/warmup ${report.allGamesPerSecond.toFixed(1)} games/s (${seeds} seeds = ${seeds * gamesPerSeed} games, ${(elapsed / 1000).toFixed(2)} s wall)`);
  if (report.warmupGamesPerSecond != null) console.log(`warmup window ${report.warmupGamesPerSecond.toFixed(1)} games/s (${warmupGames} games)`);
  if (args.out) { fs.writeFileSync(args.out, JSON.stringify(report, null, 2) + '\n'); console.log('wrote', args.out); }
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
