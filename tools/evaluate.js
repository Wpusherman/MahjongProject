'use strict';
// Duplicate self-play evaluation.
//
//   node tools/evaluate.js --candidate weights.json --seeds 400 --workers 8
//   node tools/evaluate.js --seeds 200 --rank mleague --control
//
// The default is a 1-vs-3 duplicate: the candidate plays each of the four seats
// with the same wall, and a rotating handicap (40k/25k/20k/15k) makes the
// standings differ by seat. At equal scores rankBias is inert, so all four
// replays collapse into the same deal and the four candidate rank points are
// that deal's four seats (sum 0). With the handicap the four games differ and
// their per-seed mean is the cluster used for the 95% CI. A 1-seed/1-seat paired
// control (--candidate-seat seed --control) remains available as an option.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp', 'ai', 'game', 'record', 'core', 'evaluate']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;
const WORKER = path.join(__dirname, 'evaluate-worker.js');

function parseArgs(argv) {
  const args = { seeds: 200, workers: Math.max(1, Math.min(8, (os.cpus().length || 2) - 1)),
    seed: 20261020, level: 'standard', rank: 'tenhou', control: false, out: null,
    scorePattern: 'handicap', effects: [0.2, 0.5, 1.0] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--control') { args.control = true; continue; }
    if (key === '--candidate-no-rank-bias') { args.candidateNoRankBias = true; continue; }
    if (key === '--baseline-no-rank-bias') { args.baselineNoRankBias = true; continue; }
    if (key === '--profile') { args.profile = true; continue; }
    if (key === '--divergence') { args.divergence = true; continue; }
    if (key === '--fast') { args.level = 'fast'; continue; }
    if (key === '--effect') { args.effects = argv[++i].split(',').map(Number).filter((n) => n > 0); continue; }
    if (key === '--root-candidates') { args.rootCandidates = Number(argv[++i]); continue; }
    if (key === '--start-states') { args.startStatesFile = argv[++i]; continue; }
    if (key === '--seeds') args.seeds = Number(argv[++i]);
    else if (key === '--workers') args.workers = Number(argv[++i]);
    else if (key === '--seed') args.seed = Number(argv[++i]);
    else if (key === '--level') args.level = argv[++i];
    else if (key === '--candidate-level') args.candidateLevel = argv[++i];
    else if (key === '--baseline-level') args.baselineLevel = argv[++i];
    else if (key === '--candidate') args.candidate = argv[++i];
    else if (key === '--baseline') args.baseline = argv[++i];
    else if (key === '--rank') args.rank = argv[++i];
    else if (key === '--match') args.match = argv[++i];
    else if (key === '--grp') args.grp = argv[++i];
    else if (key === '--candidate-grp') args.candidateGrp = argv[++i];
    else if (key === '--baseline-grp') args.baselineGrp = argv[++i];
    else if (key === '--baseline-heuristic') { args.baselineHeuristic = true; continue; }
    else if (key === '--candidate-seat') args.candidateSeat = argv[++i];
    else if (key === '--score-pattern') args.scorePattern = argv[++i];
    else if (key === '--initial-scores') args.initialScores = argv[++i].split(',').map(Number);
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
const loadStartStates = (file) => {
  const states = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line, i) => {
    let row;
    try { row = JSON.parse(line); } catch (error) { throw new Error(`${file}:${i + 1}: ${error.message}`); }
    if (!Array.isArray(row.scores) || row.scores.length !== 4 || !row.scores.every(Number.isFinite)) {
      throw new Error(`${file}:${i + 1}: scores must be four finite numbers`);
    }
    const dealer = Number.isInteger(row.dealer) ? row.dealer : 0;
    if (dealer < 0 || dealer > 3) throw new Error(`${file}:${i + 1}: dealer must be 0..3`);
    return { scores: row.scores.slice(), dealer,
      honba: Math.max(0, Number(row.honba) || 0), riichiSticks: Math.max(0, Number(row.riichiSticks) || 0),
      handIndex: Math.max(0, Math.min(7, Number(row.handIndex) || 0)),
      roundWind: row.roundWind == null ? null : Number(row.roundWind) };
  });
  if (!states.length) throw new Error('start-states file is empty');
  return states;
};
const usage = [
  'usage: node tools/evaluate.js [options]',
  '  --candidate FILE     candidate weights JSON (default: built-in weights)',
  '  --baseline FILE      baseline weights JSON (default: built-in weights)',
  '  --level LEVEL        both levels: standard|strong (default: standard)',
  '  --candidate-level    candidate level override',
  '  --baseline-level     baseline level override',
  '  --candidate-no-rank-bias  disable rank-point pressure for the candidate (legacy baseline)',
  '  --baseline-no-rank-bias   disable rank-point pressure for the baseline',
  '  --seeds N            wall seeds (default: 200)',
  '  --candidate-seat M   rotate (default: 4 games/seed, per-seed cluster) | seed (1 game/seed) | 0..3',
  '  --score-pattern P    handicap (default): rotate 40000/25000/20000/15000 per seed | even',
  '  --initial-scores L   comma-separated four starting scores (overrides --score-pattern)',
  '  --start-states FILE  JSONL of real hand-start states (scores, dealer, honba, riichiSticks, handIndex)',
  '  --effect L           comma-separated effect sizes for the power report (default: 0.2,0.5,1.0)',
  '  --root-candidates N  root candidates for the fast profile (default: 12)',
  '  --fast               evaluation-only fast profile (fewer root candidates, no lookahead)',
  '  --workers N          worker threads (default: CPU-1, max 8)',
  '  --seed N             first seed (default: 20261020)',
  '  --rank NAME          tenhou|mleague|raw (default: tenhou)',
  '  --match MODE         tonpu|hanchan: play a full match so standings change (default: one hand)',
  '  --grp FILE           learned GRP JSON model; replaces the heuristic rank EV (both sides)',
  '  --candidate-grp FILE use a GRP rank model for the candidate only',
  '  --baseline-grp FILE  use a GRP rank model for the baseline only',
  '  --baseline-heuristic force the heuristic rank EV for the baseline (overrides a global --grp)',
  '  --dealer N           fixed dealer seat (default: seed-dependent)',
  '  --control            also run baseline-vs-baseline and report paired delta',
  '  --profile            per-hand phase timings (shanten, ukeire, shape, scoring, lookahead)',
  '  --divergence         same-observation action divergence between candidate and baseline',
  '  --out FILE           write a JSON report',
  '  --help'
].join('\n');

function runSlice(task) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, { workerData: task });
    let settled = false;
    worker.on('message', (message) => {
      if (message.type === 'result') { settled = true; resolve({ rows: message.rows, profile: message.profile || null }); }
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
  const rows = results.flatMap((result) => result.rows);
  const profile = results.reduce((total, result) => {
    if (!result.profile) return total;
    for (const [key, value] of Object.entries(result.profile)) {
      if (typeof value === 'number' && key !== 'enabled') total[key] = (total[key] || 0) + value;
    }
    return total;
  }, {});
  return { rows, profile: results.some((result) => result.profile) ? profile : null };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); return; }
  const grpModel = args.grp ? JSON.parse(fs.readFileSync(args.grp, 'utf8')) : null;
  if (grpModel) MJ.rank.setRankModel(grpModel);
  const candidateRankModel = args.candidateGrp ? MJ.grp.validateModel(JSON.parse(fs.readFileSync(args.candidateGrp, 'utf8'))) : undefined;
  const baselineRankModel = args.baselineHeuristic ? null
    : args.baselineGrp ? MJ.grp.validateModel(JSON.parse(fs.readFileSync(args.baselineGrp, 'utf8'))) : undefined;
  const candidateWeights = args.candidate ? loadWeights(args.candidate) : MJ.ai.weights;
  const baselineWeights = args.baseline ? loadWeights(args.baseline) : MJ.ai.weights;
  const startStates = args.startStatesFile ? loadStartStates(args.startStatesFile) : null;
  const common = { seed: args.seed, seeds: args.seeds, workers: args.workers, rankConfig: args.rank,
    level: args.level, candidateLevel: args.candidateLevel || args.level, baselineLevel: args.baselineLevel || args.level,
    candidateRankBias: !args.candidateNoRankBias, baselineRankBias: !args.baselineNoRankBias,
    matchMode: args.match === 'tonpu' || args.match === 'hanchan' ? args.match : null,
    candidateSeatMode: args.candidateSeat || 'rotate',
    scorePattern: args.scorePattern === 'even' ? 'even' : 'handicap',
    initialScores: Array.isArray(args.initialScores) && args.initialScores.length === 4 && args.initialScores.every(Number.isFinite)
      ? args.initialScores : null,
    startStates, rootCandidates: Number.isFinite(args.rootCandidates) ? args.rootCandidates : undefined,
    grpModel, candidateRankModel, baselineRankModel, profile: !!args.profile, divergence: !!args.divergence,
    dealer: Number.isFinite(args.dealer) ? args.dealer : undefined };
  const seatsPerSeed = common.candidateSeatMode === 'rotate' ? 4 : 1;
  console.log(`evaluating ${args.seeds} seeds (${args.seeds * seatsPerSeed} games), workers=${args.workers}, match=${common.matchMode || 'single-hand'}, seat=${common.candidateSeatMode}, scores=${startStates ? 'start-states:' + startStates.length : common.initialScores ? 'custom' : common.scorePattern}, level=${common.candidateLevel}/${common.baselineLevel}, rankBias=${common.candidateRankBias}/${common.baselineRankBias}`);
  const started = Date.now();
  const candidateRun = await evaluate({ ...common, candidateWeights, baselineWeights });
  const candidateRows = candidateRun.rows;
  let controlRows = null, controlProfile = null;
  if (args.control) {
    console.log('control: baseline vs baseline');
    const controlRun = await evaluate({ ...common, candidateWeights: baselineWeights, baselineWeights,
      candidateLevel: common.baselineLevel, baselineLevel: common.baselineLevel,
      candidateRankModel: common.baselineRankModel, baselineRankModel: common.baselineRankModel,
      candidateRankBias: common.baselineRankBias, baselineRankBias: common.baselineRankBias });
    controlRows = controlRun.rows; controlProfile = controlRun.profile;
  }
  const elapsedMs = Date.now() - started;
  const candidate = MJ.evaluate.summarize(candidateRows, { rankConfig: args.rank });
  const control = controlRows ? MJ.evaluate.summarize(controlRows, { rankConfig: args.rank }) : null;
  const delta = controlRows ? MJ.evaluate.pairedDelta(candidateRows, controlRows) : null;
  const gamesPerSecond = candidateRows.length / (elapsedMs / 1000);
  const effects = args.effects.length ? args.effects : [0.2];
  const power = effects.map((effect) => MJ.evaluate.power({ sd: candidate.seedClusterRankPoints.sd, effect,
    seatsPerSeed: candidate.gamesPerSeed || seatsPerSeed }));
  const report = {
    version: MJ.evaluate.version, config: { seeds: args.seeds, games: candidateRows.length, workers: args.workers,
      seed: args.seed, rank: args.rank, match: common.matchMode || 'single-hand',
      candidateSeat: common.candidateSeatMode,
      scorePattern: startStates ? 'start-states' : common.initialScores ? 'custom' : common.scorePattern,
      startStates: startStates ? startStates.length : 0,
      candidateLevel: common.candidateLevel, baselineLevel: common.baselineLevel, divergence: common.divergence,
      candidate: args.candidate || 'built-in', baseline: args.baseline || 'built-in', control: !!args.control,
      grp: args.grp || null, candidateGrp: args.candidateGrp || null,
      baselineGrp: args.baselineHeuristic ? 'heuristic' : args.baselineGrp || null,
      rootCandidates: common.rootCandidates || null,
      candidateRankBias: common.candidateRankBias, baselineRankBias: common.baselineRankBias },
    candidate, control, delta, power, throughput: { elapsedMs, gamesPerSecond },
    profile: candidateRun.profile,
    controlProfile: controlProfile
  };
  console.log(MJ.evaluate.formatReport(candidate, { control, delta, elapsedMs, gamesPerSecond, power }));
  if (candidateRun.profile) {
    const p = candidateRun.profile, total = p.shanten + p.shape + p.scoring + p.risk + p.lookahead;
    console.log(`profile: ${p.evaluations} candidate evaluations; shanten ${p.shanten.toFixed(0)} ms, ukeire ${p.ukeire.toFixed(0)} ms (inner shanten), shape ${p.shape.toFixed(0)} ms, scoring ${p.scoring.toFixed(0)} ms, lookahead ${p.lookahead.toFixed(0)} ms, risk ${p.risk.toFixed(0)} ms (timed total ${total.toFixed(0)} ms)`);
  }
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
