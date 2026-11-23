'use strict';
// Generates the deterministic core golden files used by test/core.test.js.
// The recorded action list lets a future Rust core replay the same game without
// reimplementing the JavaScript heuristic AI.
//
//   node tools/core-golden.js
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'core']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ;
const OUT = path.join(__dirname, '..', 'test', 'golden');

const CASES = [
  { seed: 20261015, policy: 'ai' },
  { seed: 1, policy: 'ai' },
  { seed: 20261013, policy: 'random' },
  { seed: 2, policy: 'random' },
  // Non-zero East-1 dealer plus a wait-preserving ankan after riichi.
  { seed: 177, policy: 'riichi-kan', dealer: 1, startDealer: 1 }
];

const configFor = (seed, overrides = {}) => {
  const startDealer = overrides.startDealer != null ? overrides.startDealer : 0;
  return { roundWind: 27, dealer: overrides.dealer != null ? overrides.dealer : seed % 4,
    startDealer, honba: 0, riichiSticks: 0, scores: [25000, 25000, 25000, 25000],
    rules: { riichiAnkan: overrides.riichiAnkan || 'wait', startDealer } };
};

async function choose(core, pending, policy, ctx) {
  if (pending.type === 'tsumo') return { type: 'tsumo' };
  if (policy === 'riichi-kan') {
    if (pending.type === 'kan') {
      return pending.legal.find((a) => a.type === 'kan' && a.kan && a.kan.kind === 'ankan') || { type: 'pass' };
    }
    if (pending.type === 'call') return pending.legal.find((a) => a.type === 'ron') || { type: 'pass' };
    const view = core.observe(pending.seat);
    const decision = await ctx.ais[pending.seat].chooseDiscard(view);
    const riichis = pending.legal.filter((a) => a.type === 'discard' && a.riichi);
    if (!view.riichi && riichis.length) return riichis.find((a) => a.tileId === decision.tileId) || riichis[0];
    return { type: 'discard', tileId: decision.tileId, riichi: !!decision.riichi };
  }
  if (pending.type === 'kan') return { type: 'pass' };
  if (pending.type === 'call') {
    return policy === 'ai' ? (pending.legal.find((a) => a.type === 'ron') || { type: 'pass' })
      : pending.legal[Math.floor(ctx.rng() * pending.legal.length)];
  }
  if (policy === 'random') return pending.legal[Math.floor(ctx.rng() * pending.legal.length)];
  const decision = await ctx.ais[pending.seat].chooseDiscard(core.observe(pending.seat));
  return { type: 'discard', tileId: decision.tileId, riichi: !!decision.riichi };
}

async function play(seed, policy, overrides = {}) {
  const config = configFor(seed, overrides);
  const core = MJ.core.create(config, seed);
  const events = await core.start();
  const ctx = { rng: MJ.core.rng('policy-' + seed), ais: [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level: 'standard' })) };
  const actions = [];
  const decisions = [];
  for (let i = 0; !core.is_terminal(); i++) {
    if (i > 5000) throw new Error('hand did not finish: seed ' + seed);
    const pending = core.current();
    if (!pending) throw new Error('missing pending decision: seed ' + seed);
    const action = await choose(core, pending, policy, ctx);
    decisions.push(JSON.parse(JSON.stringify(pending)));
    actions.push(JSON.parse(JSON.stringify(action)));
    events.push(...await core.step(action));
  }
  // The wall must be reproducible from the seed; record it so the Rust replay
  // does not have to reimplement dealing from scratch.
  const regenerated = MJ.tiles.buildWall(MJ.core.rng(seed));
  const wall = core.game.recording.wall.slice();
  if (JSON.stringify(regenerated) !== JSON.stringify(wall)) throw new Error('regenerated wall mismatch: seed ' + seed);
  return { seed, config, wall, initialHands: core.game.recording.initialHands, policy, decisions, actions, events,
    finalScores: core.game.players.map((p) => p.score), result: core.final_result() };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const item of CASES) {
    const golden = await play(item.seed, item.policy, item);
    const file = path.join(OUT, `core-${item.seed}.json`);
    fs.writeFileSync(file, JSON.stringify(golden, null, 2) + '\n');
    console.log('wrote', path.relative(process.cwd(), file), golden.actions.length, 'actions', golden.events.length, 'events');
  }
})().catch((error) => { console.error(error); process.exit(1); });
