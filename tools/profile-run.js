'use strict';
// Single-process duplicate games for CPU profiling.
//
//   node --cpu-prof --cpu-prof-dir=test-results/prof tools/profile-run.js fast 8
//   node tools/profile-cpu.js test-results/prof/*.cpuprofile
const path = require('node:path');
const { pathToFileURL } = require('node:url');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp', 'ai', 'game', 'record', 'core', 'features', 'evaluate']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;
const level = process.argv[2] || 'fast';
const seeds = Math.max(1, Number(process.argv[3]) || 8);
(async () => {
  const started = Date.now();
  for (let i = 0; i < seeds; i++) {
    await MJ.evaluate.runSeed({ seed: 20261020 + i, level, candidateLevel: level, baselineLevel: level,
      scorePattern: 'handicap', rankConfig: 'tenhou' });
  }
  console.log(`${seeds} seeds (${seeds * 4} games) level=${level} in ${((Date.now() - started) / 1000).toFixed(2)} s`);
})().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exit(1); });
