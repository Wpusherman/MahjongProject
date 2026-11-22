'use strict';
// Generate finished self-play records for GRP/supervised training. The output
// format is the normal 翠卓 record, so tools/grp-dataset.js and tools/features.js
// consume it directly.
//
//   node tools/grp-selfplay.js --matches 200 --workers 8 --out data/selfplay
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const WORKER = path.join(__dirname, 'grp-selfplay-worker.js');

function parseArgs(argv) {
  const args = { matches: 100, workers: Math.max(1, Math.min(8, (os.cpus().length || 2) - 1)),
    seed: 20261022, out: 'data/selfplay', mode: 'tonpu', level: 'standard' };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--matches') args.matches = Number(argv[++i]);
    else if (key === '--workers') args.workers = Number(argv[++i]);
    else if (key === '--seed') args.seed = Number(argv[++i]);
    else if (key === '--out') args.out = argv[++i];
    else if (key === '--mode') args.mode = argv[++i];
    else if (key === '--level') args.level = argv[++i];
    else throw new Error('unknown option: ' + key);
  }
  return args;
}
const usage = 'usage: node tools/grp-selfplay.js [--matches N] [--workers N] [--seed N] [--out DIR] [--mode tonpu|hanchan] [--level standard|strong]';

function run(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    worker.on('message', (m) => m.type === 'result' ? resolve(m.written) : reject(new Error(m.message)));
    worker.on('error', reject);
    worker.on('exit', (code) => { if (code) reject(new Error('worker exited ' + code)); });
  });
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); return; }
  const matches = Math.max(1, Math.floor(args.matches));
  const workers = Math.max(1, Math.min(Math.floor(args.workers), matches));
  fs.mkdirSync(args.out, { recursive: true });
  const tasks = [];
  for (let i = 0; i < workers; i++) {
    const start = Math.floor(matches * i / workers), end = Math.floor(matches * (i + 1) / workers);
    if (end > start) tasks.push(run({ seed: args.seed, start, count: end - start, out: args.out, mode: args.mode, level: args.level }));
  }
  const started = Date.now();
  const written = (await Promise.all(tasks)).flat();
  console.log(`wrote ${written.length} records -> ${args.out} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
