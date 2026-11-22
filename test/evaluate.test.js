const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'core', 'evaluate']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, E = MJ.evaluate;

(async () => {
  const rows = await E.runSeeds({ seeds: 2, seed: 0, level: 'standard', rankConfig: 'tenhou' });
  assert.equal(rows.length, 8, 'one seed plays four seats');
  for (const seed of [0, 1]) {
    const group = rows.filter((r) => r.seed === seed);
    assert.equal(group.length, 4);
    assert.equal(group.reduce((n, r) => n + r.rank, 0), 10, 'ranks are a permutation of 1..4');
    assert.equal(group.reduce((n, r) => n + r.points, 0), 0, 'tenhou rank points are zero-sum');
  }
  const summary = E.summarize(rows, { rankConfig: 'tenhou' });
  assert.equal(summary.games, 8);
  assert.equal(summary.seeds, 2);
  assert(Number.isFinite(summary.avgRankPoints.mean));
  assert(Number.isFinite(summary.avgPlacement.mean));
  assert.equal(summary.rankDistribution.reduce((n, r) => n + r.count, 0), 8);
  assert.equal(summary.rankDistribution.reduce((n, r) => n + r.rate, 0).toFixed(6), '1.000000');
  assert(Number.isFinite(summary.winRate.mean));
  assert(Number.isFinite(summary.callRate.mean));
  assert(Number.isFinite(summary.seedClusterRankPoints.mean));
  assert(E.formatReport(summary).includes('seeds 2 / games 8'));

  // Synthetic rows: deterministic CI and rate calculations.
  const synthetic = Array.from({ length: 20 }, (_, i) => ({ seed: i, candidateSeat: 0, rank: 1, points: 10,
    scores: [35000, 25000, 20000, 20000], scoreDelta: 10000, win: true, tsumoWin: false, ronWin: true,
    dealIn: false, called: true, riichi: false, calls: 1, riichis: 0, result: 'win' }));
  const fixed = E.summarize(synthetic);
  assert.equal(fixed.avgRankPoints.mean, 10);
  assert.equal(fixed.avgRankPoints.ci95, 0);
  assert.equal(fixed.winRate.mean, 1);
  assert.equal(fixed.callRate.mean, 1);
  assert.equal(fixed.rankDistribution[0].rate, 1);

  const control = synthetic.map((r) => ({ ...r, points: 0, rank: 2 }));
  const delta = E.pairedDelta(synthetic, control);
  assert.equal(delta.mean, 10);
  assert.equal(delta.n, 20);

  // The same seed and policy are deterministic.
  const a = await E.runSeed({ seed: 7, level: 'standard', rankConfig: 'tenhou' });
  const b = await E.runSeed({ seed: 7, level: 'standard', rankConfig: 'tenhou' });
  assert.deepEqual(a, b);

  console.log('Evaluation OK: duplicate seats, rank points, distributions, rates, CI, paired delta, determinism');
})().catch((error) => { console.error(error); process.exit(1); });
