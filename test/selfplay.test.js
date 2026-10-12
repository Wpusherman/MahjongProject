require('../src/tiles.js');
require('../src/shanten.js');
require('../src/agari.js');
require('../src/yaku.js');
require('../src/score.js');
require('../src/ai.js');
require('../src/game.js');
require('../src/record.js');
const assert = require('node:assert/strict');

const MJ = globalThis.MJ;

const N = parseInt(process.argv[2] || '200', 10);

(async () => {
  let scores = [25000, 25000, 25000, 25000];
  let dealer = 0;
  let honba = 0;
  let sticks = 0;
  const stats = { win: 0, tsumo: 0, ron: 0, draw: 0, yakuman: 0 };
  let maxLog = 0;
  let seed = 20261013;
  const rng = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };

  for (let hand = 0; hand < N; hand++) {
    const agents = [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level: hand % 10 === 0 ? 'strong' : 'standard' }));
    const game = new MJ.Game({ agents, rng });
    const res = await game.playHand({ roundWind: 27, dealer, honba, riichiSticks: sticks, scores: scores.slice() });
    const owned = game.players.flatMap((p) => p.hand.concat(p.discards, p.melds.flatMap((m) => m.tiles)));
    const remaining = game.liveWall.slice(game.wallIndex, game.liveEnd).concat(game.liveWall.slice(game.liveEnd), game.deadWall.slice(game.rinshanIndex));
    assert.equal(new Set(owned.concat(remaining)).size, 136, 'all physical tiles conserved');
    assert.equal(owned.length + remaining.length, 136, 'no duplicate tiles');
    const replay = MJ.record.snapshot(game.recording, game.recording.events.length - 1);
    for (let seat = 0; seat < 4; seat++) {
      assert.deepEqual(replay.players[seat].hand.slice().sort((a, b) => a - b), game.players[seat].hand.slice().sort((a, b) => a - b));
      assert.deepEqual(replay.players[seat].discards, game.players[seat].discards);
      assert.deepEqual(replay.players[seat].melds, game.players[seat].melds);
      assert.equal(replay.players[seat].score, game.players[seat].score);
    }
    scores = game.players.map((p) => p.score);
    if (maxLog < game.logs.length) maxLog = game.logs.length;

    if (res.type === 'win') {
      stats.win++;
      if (res.tsumo) stats.tsumo++; else stats.ron++;
      if (res.yakuman) stats.yakuman++;
      if (res.winner === dealer) { honba++; } else { dealer = (dealer + 1) % 4; honba = 0; }
      sticks = 0;
    } else {
      stats.draw++;
      dealer = (dealer + 1) % 4;
      honba = 0;
      sticks = game.riichiSticks;
    }
    const sum = scores.reduce((a, b) => a + b, 0) + sticks * 1000;
    if (sum !== 100000) {
      console.log(`SCORE SUM BROKEN at hand ${hand}: ${sum}`, scores, 'sticks', sticks);
      process.exit(1);
    }
  }

  console.log('hands:', N);
  console.log('results:', stats);
  console.log('final scores:', scores);
  console.log('max log lines in a hand:', maxLog);
  console.log('OK');
})();
