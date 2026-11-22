'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parentPort, workerData } = require('node:worker_threads');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'grp', 'ai', 'game', 'record', 'core']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ;

(async () => {
  const written = [];
  for (let i = 0; i < workerData.count; i++) {
    const seed = (workerData.seed + workerData.start + i) >>> 0;
    const mode = workerData.mode === 'hanchan' ? 'hanchan' : 'tonpu';
    const record = MJ.record.create(mode, workerData.level || 'standard');
    record.createdAt = new Date(1700000000000 + seed * 1000).toISOString();
    let scores = [25000, 25000, 25000, 25000], sticks = 0, dealer = seed % 4, honba = 0, hand = 0;
    let state = { hand, dealer, honba, mode };
    const maxDeals = mode === 'hanchan' ? 16 : 8;
    for (let deal = 0; deal < maxDeals; deal++) {
      const game = new MJ.Game({ agents: [0, 1, 2, 3].map((seat) => MJ.ai.create(seat, { level: workerData.level || 'standard' })), rng: MJ.core.rng(seed) });
      const result = await game.playHand({ roundWind: 27 + Math.floor(state.hand / 4), dealer: state.dealer,
        honba: state.honba, riichiSticks: sticks, scores: scores.slice(), hand: state.hand, mode });
      record.hands.push(game.recording);
      scores = game.players.map((p) => p.score);
      sticks = game.riichiSticks;
      const next = MJ.match.advance(state, result, scores);
      state = { hand: next.hand, dealer: next.dealer, honba: next.honba, mode };
      if (next.ended) break;
    }
    if (sticks) {
      let top = 0;
      for (let seat = 1; seat < 4; seat++) if (scores[seat] > scores[top]) top = seat;
      scores[top] += sticks * 1000;
    }
    record.finalScores = scores;
    record.finished = true;
    const file = path.join(workerData.out, `match-${seed}.json`);
    fs.writeFileSync(file, JSON.stringify(record));
    written.push(file);
  }
  parentPort.postMessage({ type: 'result', written });
})().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  process.exit(1);
});
