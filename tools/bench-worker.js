'use strict';
// Worker for tools/bench-throughput.js: runs seeds sequentially and reports the
// wall time of each seed so the parent can drop the warm-up window.
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp', 'ai', 'game', 'record', 'core', 'evaluate']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;

(async () => {
  const times = [];
  for (let i = 0; i < workerData.count; i++) {
    const seed = (workerData.seed + workerData.start + i) >>> 0;
    const started = performance.now();
    await MJ.evaluate.runSeed({ ...workerData, seed });
    times.push(performance.now() - started);
  }
  parentPort.postMessage({ type: 'result', times });
})().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  process.exit(1);
});
