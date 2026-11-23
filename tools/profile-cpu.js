'use strict';
// Summarize a V8 .cpuprofile by self time.
//
//   node --cpu-prof --cpu-prof-dir=test-results/prof tools/evaluate.js --seeds 16 --workers 1 --fast
//   node tools/profile-cpu.js test-results/prof/*.cpuprofile
//
// The report aggregates samples by function + script and prints the top frames.
const fs = require('node:fs');
const path = require('node:path');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/profile-cpu.js <file.cpuprofile> [--top N] [--json FILE]');
  process.exit(2);
}
const topIndex = process.argv.indexOf('--top');
const top = topIndex >= 0 ? Number(process.argv[topIndex + 1]) : 25;
const jsonIndex = process.argv.indexOf('--json');
const jsonFile = jsonIndex >= 0 ? process.argv[jsonIndex + 1] : null;

const profile = JSON.parse(fs.readFileSync(file, 'utf8'));
const byId = new Map(profile.nodes.map((node) => [node.id, node]));
const times = new Map();
let total = 0;
profile.samples.forEach((id, i) => {
  const delta = profile.timeDeltas && profile.timeDeltas[i] ? profile.timeDeltas[i] : 0;
  total += delta;
  const node = byId.get(id);
  if (!node) return;
  const frame = node.callFrame || {};
  const name = frame.functionName || '(anonymous)';
  const url = frame.url ? path.basename(frame.url) : '';
  const key = name + (url ? ' @ ' + url : '') + (frame.lineNumber >= 0 ? ':' + (frame.lineNumber + 1) : '');
  times.set(key, (times.get(key) || 0) + delta);
});
const rows = [...times.entries()].sort((a, b) => b[1] - a[1]).slice(0, top)
  .map(([name, us]) => ({ name, ms: us / 1000, percent: total ? 100 * us / total : 0 }));
console.log(`profile ${path.basename(file)}: ${(total / 1000).toFixed(0)} ms sampled, ${profile.samples.length} samples`);
for (const row of rows) console.log(`${row.percent.toFixed(1).padStart(5)}%  ${row.ms.toFixed(0).padStart(7)} ms  ${row.name}`);
if (jsonFile) {
  fs.writeFileSync(jsonFile, JSON.stringify({ file, totalMs: total / 1000, samples: profile.samples.length, top: rows }, null, 2) + '\n');
  console.log('wrote', jsonFile);
}
