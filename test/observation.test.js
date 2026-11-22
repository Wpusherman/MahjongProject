const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'record']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, T = MJ.tiles;

function game() {
  const g = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
  g.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000], wall: Array.from({ length: 136 }, (_, i) => i) });
  return g;
}

(() => {
  const g = game();
  for (let seat = 0; seat < 4; seat++) {
    const obs = g.getObservation(seat);
    assert.deepEqual(obs.hand, g.players[seat].hand, 'observation contains the viewer hand');
    for (const key of ['wall', 'liveWall', 'deadWall', 'uraIndicators']) assert(!(key in obs), `observation exposes ${key}`);
    assert.equal(obs.opponents.length, 3);
    for (const o of obs.opponents) {
      assert(!('hand' in o), 'opponent hand IDs are absent');
      assert.equal(o.handCount, g.players[o.seat].hand.length, 'only the opponent hand count is public');
      assert(!('handIds' in o));
    }
    assert.equal(obs.opponents.reduce((n, o) => n + o.handCount, 0), 39, 'opponent counts add up');
  }

  // A concealed kan reveals the tile type but not which physical copy is the red five.
  const k = game(), owner = k.players[0];
  owner.melds = [{ kind: 'kan', type: 4, open: false, tiles: [16, 17, 18, 19] }];
  owner.hand = [];
  const seen = k.getObservation(1), opponent = seen.opponents.find((o) => o.seat === 0);
  assert.equal(opponent.melds.length, 1);
  assert(opponent.melds[0].tiles.every((id) => (id >> 2) === 4), 'the concealed kan tile type is public');
  assert(opponent.melds[0].tiles.every((id) => !T.isRed(id)), 'the red five is not disclosed through a face-down position');
  const own = k.getObservation(0);
  assert(own.melds[0].tiles.includes(16), 'the owner still sees the red five');

  // The AI entry points reject raw game state and opponent hands.
  assert.doesNotThrow(() => MJ.ai.assertObservation(g.getObservation(0)));
  assert.throws(() => MJ.ai.assertObservation({ ...g.getObservation(0), wall: g.wall }), /hidden state/);
  assert.throws(() => MJ.ai.assertObservation({ ...g.getObservation(0), uraIndicators: [] }), /hidden state/);
  const leaky = g.getObservation(0);
  leaky.opponents = leaky.opponents.map((o, i) => (i === 0 ? { ...o, hand: [0, 1] } : o));
  assert.throws(() => MJ.ai.assertObservation(leaky), /opponent hand/);

  console.log('Observation API OK: own hand only, counts for opponents, concealed-kan red hidden, AI rejects raw state');
})();
