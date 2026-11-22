const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'core', 'evaluate']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, E = MJ.evaluate;

(async () => {
  // Default: 1-vs-3 with a rotating handicap, four seats per seed and the same wall.
  const rows = await E.runSeeds({ seeds: 2, seed: 0, level: 'standard', rankConfig: 'tenhou' });
  assert.equal(rows.length, 8, 'one seed plays four seats');
  for (const seed of [0, 1]) {
    const group = rows.filter((r) => r.seed === seed);
    assert.equal(group.length, 4);
    assert.deepEqual(group.map((r) => r.candidateSeat), [0, 1, 2, 3]);
    for (const row of group) {
      assert(row.rank >= 1 && row.rank <= 4);
      assert.equal(row.scores.reduce((a, b) => a + b, 0), 100000, 'hand scores stay conserved');
      assert.equal(row.startScores.slice().sort((a, b) => a - b).join(','), '15000,20000,25000,40000');
    }
  }
  const summary = E.summarize(rows, { rankConfig: 'tenhou' });
  assert.equal(summary.games, 8);
  assert.equal(summary.seeds, 2);
  assert.equal(summary.gamesPerSeed, 4);
  assert(Number.isFinite(summary.avgRankPoints.mean));
  assert(Number.isFinite(summary.avgPlacement.mean));
  assert.equal(summary.rankDistribution.reduce((n, r) => n + r.count, 0), 8);
  assert.equal(summary.rankDistribution.reduce((n, r) => n + r.rate, 0).toFixed(6), '1.000000');
  assert(Number.isFinite(summary.winRate.mean));
  assert(Number.isFinite(summary.callRate.mean));
  assert(Number.isFinite(summary.seedClusterRankPoints.mean));
  assert(E.formatReport(summary).includes('seeds 2 / games 8'));

  // The documented zero: at equal scores rankBias is inert, so all four replays
  // are the same deal and the four candidate rank points sum to zero.
  const even = await E.runSeed({ seed: 4, level: 'standard', rankConfig: 'tenhou', scorePattern: 'even' });
  assert.equal(even.length, 4);
  assert(even.every((r) => r.scores.join(',') === even[0].scores.join(',')), 'equal starts replay the same deal');
  assert.equal(even.reduce((n, r) => n + r.points, 0), 0, 'zero-sum rank points cancel in the equal-start case');
  const evenSummary = E.summarize(even, {});
  assert.equal(evenSummary.seedClusterRankPoints.mean, 0);
  assert.equal(evenSummary.seedClusterRankPoints.sd, 0);

  // Real hand-start states from Tenhou logs replace the synthetic opening.
  const state = { scores: [35000, 30000, 20000, 15000], dealer: 1, honba: 2, riichiSticks: 1, handIndex: 6 };
  const started = await E.runSeed({ seed: 9, level: 'fast', rankConfig: 'tenhou', startStates: [state] });
  assert.equal(started.length, 4);
  assert(started.every((r) => r.startScores.join(',') === state.scores.join(',')));
  assert(started.every((r) => r.startState.handIndex === 6 && r.startState.dealer === 1 &&
    r.startState.honba === 2 && r.startState.riichiSticks === 1));

  // Power: required clusters grow with the square of the observed sd.
  const p1 = E.power({ sd: 2, effect: 0.2, seatsPerSeed: 4 });
  const p2 = E.power({ sd: 4, effect: 0.2, seatsPerSeed: 4 });
  assert.equal(p1.seeds, Math.ceil((1.96 * 2 / 0.2) ** 2));
  assert.equal(p2.seeds, Math.ceil((1.96 * 4 / 0.2) ** 2));
  assert.equal(p1.games, p1.seeds * 4);
  assert.equal(E.power({ sd: 0, effect: 0.2 }).seeds, null);
  assert.equal(E.power({ sd: 2, effect: 0 }).seeds, null);

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

  // Same-observation counterfactual wiring: identical policies diverge 0%,
  // a deliberate weight change must produce a non-zero rate.
  const sameDivergence = E.summarize(await E.runSeeds({ seeds: 1, seed: 3, divergence: true }));
  assert(sameDivergence.actionDivergence.decisions > 0, 'divergence observes decisions');
  assert.equal(sameDivergence.actionDivergence.rate, 0, 'identical policies choose the same action');
  const changed = E.summarize(await E.runSeeds({ seeds: 1, seed: 3, divergence: true,
    candidateWeights: { ...MJ.ai.weights, shapeGain: 10 } }));
  assert(changed.actionDivergence.decisions > 0);
  assert(changed.actionDivergence.rate > 0, 'different weights diverge on some position');

  // The same seed and policy are deterministic.
  const a = await E.runSeed({ seed: 7, level: 'standard', rankConfig: 'tenhou' });
  const b = await E.runSeed({ seed: 7, level: 'standard', rankConfig: 'tenhou' });
  assert.deepEqual(a, b);

  // A single fixed seat and a seed-chosen seat remain available for paired controls.
  const seeded = await E.runSeed({ seed: 5, level: 'standard', rankConfig: 'tenhou', candidateSeatMode: 'seed' });
  assert.equal(seeded.length, 1);
  assert.equal(seeded[0].candidateSeat, 1);
  const seatFixed = await E.runSeed({ seed: 5, level: 'standard', rankConfig: 'tenhou', candidateSeatMode: 3 });
  assert.equal(seatFixed.length, 1);
  assert.equal(seatFixed[0].candidateSeat, 3);
  const handicap = await E.runSeed({ seed: 0, level: 'standard', rankConfig: 'tenhou', candidateSeatMode: 'seed', scorePattern: 'handicap' });
  assert.equal(handicap.length, 1);
  assert.equal(handicap[0].scores.reduce((a, b) => a + b, 0), 100000, 'handicap scores sum to 100,000');

  // Evaluation-only fast profile: fewer full root decompositions, same schema.
  const fast = await E.runSeed({ seed: 11, level: 'fast', rankConfig: 'tenhou', candidateSeatMode: 'seed' });
  assert.equal(fast.length, 1);
  assert.equal(fast[0].candidateSeat, 3);

  console.log('Evaluation OK: rotate+handicap clusters, equal-start zero, start states, power, distributions, paired delta, determinism, fast profile');
})().catch((error) => { console.error(error); process.exit(1); });
