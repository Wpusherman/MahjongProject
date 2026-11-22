'use strict';
// Duplicate self-play evaluation worker.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp', 'ai', 'game', 'record', 'core', 'evaluate']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;
if (workerData.grpModel) MJ.rank.setRankModel(workerData.grpModel);
if (workerData.profile) MJ.ai.profile.enable();

(async () => {
  const rows = [];
  for (let i = 0; i < workerData.count; i++) {
    const seed = (workerData.seed + workerData.start + i) >>> 0;
    rows.push(...await MJ.evaluate.runSeed({ ...workerData, seed }));
  }
  parentPort.postMessage({ type: 'result', rows, profile: MJ.ai.profile.snapshot() });
})().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  process.exit(1);
});
