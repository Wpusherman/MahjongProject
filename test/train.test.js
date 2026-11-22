const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai']) require('../src/' + file + '.js');
const MJ = globalThis.MJ;

const root = path.resolve(__dirname, '..');
const out = path.join(os.tmpdir(), `suitaku-train-test-${process.pid}.json`);

try {
  const stdout = execFileSync(process.execPath, [path.join(root, 'train.js'),
    '--hands', '8', '--population', '2', '--iters', '1', '--workers', '4', '--holdout', '0', '--out', out,
  ], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert(stdout.includes('iter   1'), 'training prints an iteration line');
  const data = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(data.format, 'suitaku-ai-weights');
  assert.equal(data.aiVersion, MJ.ai.version);
  assert.deepEqual(Object.keys(data.weights).sort(), Object.keys(MJ.ai.weights).sort(), 'all tunable weights are stored');
  assert(Object.values(data.weights).every(Number.isFinite), 'weights are finite numbers');
  assert(Number.isFinite(data.fitness.avgScore), 'fitness is recorded');
  console.log('Trainer OK: self-play CLI writes a valid weights file');
} finally {
  try { fs.unlinkSync(out); } catch (_) {}
}
