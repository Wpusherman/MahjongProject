const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'game', 'core']) require('../src/' + file + '.js');
const MJ = globalThis.MJ;

const DIR = path.join(__dirname, 'golden');
const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => /^core-.*\.json$/.test(f)).sort() : [];
assert(files.length > 0, 'run node tools/core-golden.js first');

async function replay(golden) {
  const core = MJ.core.create(golden.config, golden.seed);
  const events = await core.start();
  for (const action of golden.actions) events.push(...await core.step(action));
  return { core, events };
}
function conservation(core) {
  const g = core.game;
  const owned = g.players.flatMap((p) => p.hand.concat(p.discards, p.melds.flatMap((m) => m.tiles)));
  const remaining = g.liveWall.slice(g.wallIndex, g.liveEnd).concat(g.liveWall.slice(g.liveEnd), g.deadWall.slice(g.rinshanIndex));
  assert.equal(owned.length + remaining.length, 136, '136 physical tiles are conserved');
  assert.equal(new Set(owned.concat(remaining)).size, 136, 'no tile is duplicated');
  const sum = g.players.reduce((n, p) => n + p.score, 0);
  assert.equal(sum + g.riichiSticks * 1000, 100000, 'scores and deposits sum to 100,000');
}

(async () => {
  for (const file of files) {
    const golden = JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'));
    const first = await replay(golden), second = await replay(golden);
    assert.deepEqual(first.events, second.events, 'the same seed and action script are deterministic');
    assert.deepEqual(first.events, golden.events, 'JS core matches the golden event stream: ' + file);
    assert(first.events.every((e, i) => e.index === i), 'event indices are contiguous');
    assert(first.core.is_terminal(), 'golden script reaches a terminal state');
    assert.deepEqual(first.core.final_result(), golden.result, 'final result matches the golden file');
    assert.deepEqual(first.core.game.players.map((p) => p.score), golden.finalScores, 'final scores match');
    conservation(first.core);
  }

  // Public observation and action validation on a fresh, partially played game.
  const core = MJ.core.create({ dealer: 0 }, 20261015);
  await core.start();
  const pending = core.current();
  assert.equal(pending.seat, 0);
  assert.equal(pending.type, 'discard');
  assert(core.legal_actions(0).length > 0);
  assert.deepEqual(core.legal_actions(1), [], 'only the pending seat has legal actions');
  const obs = core.observe(0);
  for (const key of ['wall', 'liveWall', 'deadWall', 'uraIndicators']) assert(!(key in obs));
  for (const o of obs.opponents) assert(!('hand' in o), 'observation hides opponent hand IDs');
  assert.equal(obs.opponents.reduce((n, o) => n + o.handCount, 0), 39);
  await assert.rejects(core.step({ type: 'discard', tileId: 999 }), /Illegal discard/);
  assert(core.legal_actions(0).length > 0, 'a rejected action leaves the decision pending');
  await core.step(core.legal_actions(0).find((a) => !a.riichi));
  assert(!core.is_terminal());

  console.log(`Core API OK: ${files.length} golden hands, deterministic replay, conservation, observation, action validation`);
})().catch((error) => { console.error(error); process.exit(1); });
