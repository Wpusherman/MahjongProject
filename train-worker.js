'use strict';
// Self-play evaluation worker. Plays `count` hands starting at global index `start`,
// with the candidate weights on the rotating seat and the baseline on the others.
const { parentPort, workerData } = require('node:worker_threads');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game']) require(path.join(__dirname, 'src', file + '.js'));
const MJ = globalThis.MJ;

const { weights, baseline, level, seed, start, count } = workerData;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const handSeed = (h) => (Math.imul(seed ^ 0x9e3779b1, h + 1) ^ Math.imul(h + 1, 0x85ebca6b)) >>> 0;

(async () => {
  let total = 0, placements = 0, wins = 0, dealins = 0, games = 0;
  for (let h = start; h < start + count; h++) {
    const rng = mulberry32(handSeed(h));
    const candidateSeat = h & 3;
    const dealer = (h + 1) & 3;
    const agents = [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level, weights: s === candidateSeat ? weights : baseline }));
    const game = new MJ.Game({ agents, rng });
    const result = await game.playHand({ roundWind: 27, dealer, honba: 0, riichiSticks: 0, scores: [25000, 25000, 25000, 25000], hand: h & 3, mode: 'tonpu' });
    const score = game.players[candidateSeat].score;
    total += score;
    let rank = 1;
    for (const p of game.players) if (p.seat !== candidateSeat && p.score > score) rank++;
    placements += rank;
    if (result.type === 'win' && result.winner === candidateSeat) wins++;
    if (result.type === 'win' && !result.tsumo && result.loser === candidateSeat) dealins++;
    games++;
    if ((games & 15) === 0) parentPort.postMessage({ type: 'progress', done: games });
  }
  parentPort.postMessage({ type: 'result', total, placements, wins, dealins, games });
})().catch((error) => {
  parentPort.postMessage({ type: 'error', message: error && error.stack ? error.stack : String(error) });
  process.exit(1);
});
