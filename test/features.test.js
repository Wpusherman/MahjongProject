const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'core', 'mjai', 'features']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, F = MJ.features, T = MJ.tiles;

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
async function makeRecord(seed) {
  const game = new MJ.Game({ agents: [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level: 'standard' })), rng: rng(seed) });
  await game.playHand({ roundWind: 27, dealer: seed % 4, honba: 0, riichiSticks: 0, scores: [25000, 25000, 25000, 25000], hand: seed % 4, mode: 'tonpu' });
  const record = MJ.record.create('tonpu', 'standard');
  record.hands.push(game.recording);
  record.finalScores = game.players.map((p) => p.score); record.finished = true;
  return record;
}

(async () => {
  const record = await makeRecord(20261015);
  const samples = F.dataset(record);
  assert(samples.length > 0);
  const shape = samples[0].x.shape;
  assert.equal(shape.tiles, 34);
  assert.equal(shape.channels, F.CHANNELS.length);
  assert.equal(shape.globals, F.GLOBAL_NAMES.length);
  assert.equal(samples[0].x.data.length, shape.channels * 34 + shape.globals);
  assert(Array.from(samples[0].x.data).every(Number.isFinite));
  assert(samples.some((s) => s.label.kind === 'discard'));
  assert(samples.some((s) => ['pass', 'pon', 'chi', 'kan', 'ron'].includes(s.label.kind)));

  // Reconstruct a sample and verify the tensor is a pure function of the public observation.
  const sample = samples.find((s) => s.label.kind === 'discard');
  const hand = record.hands[sample.hand], event = hand.events[sample.eventIndex];
  const game = MJ.record.snapshot(hand, sample.eventIndex - 1);
  const obs = game.getObservation(sample.seat);
  obs.furiten = game.isFuriten(sample.seat);
  const encoded = F.encode(obs);
  assert.deepEqual(Array.from(encoded.data), Array.from(sample.x.data));
  const { canRiichi, legal, ...sampleLabel } = sample.label;
  assert.equal(typeof canRiichi, 'boolean');
  assert.deepEqual(sampleLabel, { kind: 'discard', tile: event.tileId >> 2, riichi: !!event.riichi, tsumogiri: !!event.tsumogiri, forced: false });
  assert(Array.isArray(legal) && legal.includes(event.tileId >> 2), 'the exact legal discard types are recorded');
  for (const t of legal) assert(obs.hand.some((id) => (id >> 2) === t), 'legal types are in hand');

  const handChannel = encoded.data.slice(0, 34);
  const counts = T.countsFromIds(obs.hand);
  for (let t = 0; t < 34; t++) assert.equal(handChannel[t], Math.min(1, counts[t] / 4));
  const redChannel = encoded.data.slice(34, 68);
  for (let t = 0; t < 34; t++) assert.equal(redChannel[t], obs.hand.some((id) => (id >> 2) === t && T.isRed(id)) ? 1 : 0);

  // Opponent hands and the wall are not inputs: changing opponent hands leaves the tensor unchanged.
  const other = (sample.seat + 1) % 4, other2 = (sample.seat + 2) % 4;
  const a = game.players[other].hand[0], b = game.players[other2].hand[0];
  if (a != null && b != null && (a >> 2) === (b >> 2)) {
    game.players[other].hand[0] = b; game.players[other].hand[1] = a;
    const changed = F.encode(game.getObservation(sample.seat));
    assert.deepEqual(Array.from(changed.data), Array.from(encoded.data));
  }
  assert(!('obs' in sample));
  assert(!JSON.stringify(sample.meta).includes('wall'));

  // Determinism and JSONL round-trip.
  const again = F.dataset(record);
  assert.deepEqual(again.map((s) => [s.hand, s.eventIndex, s.seat, s.label]), samples.map((s) => [s.hand, s.eventIndex, s.seat, s.label]));
  assert.deepEqual(Array.from(again[0].x.data), Array.from(samples[0].x.data));
  const text = F.toJSONL(samples.slice(0, 3));
  const back = F.fromJSONL(text);
  assert.equal(back.length, 3);
  assert.deepEqual(Array.from(back[0].x.data), Array.from(samples[0].x.data));
  assert.deepEqual(back[0].label, samples[0].label);
  assert.equal(F.version, 'obs-v2');
  // Loading an old shard warns instead of silently mixing seat-slot meanings.
  const legacyText = text.replace('"v":"obs-v2"', '"v":"obs-v1"');
  const warnings = [], oldWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  const legacyRows = F.fromJSONL(legacyText);
  console.warn = oldWarn;
  assert.equal(legacyRows.length, 3);
  assert(warnings.some((w) => w.includes('obs-v1') && w.includes('obs-v2')), 'legacy shards warn');
  // obs-v2 score slots follow the start dealer, not absolute seat numbers.
  const shiftedSeat = sample.seat;
  const startDealer = (shiftedSeat + 1) % 4;
  const shiftedScores = [10000, 20000, 30000, 40000];
  const shifted = { ...game.getObservation(shiftedSeat), startDealer, scores: shiftedScores };
  const shiftedX = F.encode(shifted), globalOffset = F.CHANNELS.length * 34;
  const near = (actual, expected) => Math.abs(actual - expected) < 1e-6;
  assert(near(shiftedX.data[globalOffset], (shiftedScores[startDealer] - 25000) / 100000), 'score0 is the start dealer slot');
  assert(near(shiftedX.data[globalOffset + 1], (shiftedScores[(startDealer + 1) % 4] - 25000) / 100000), 'score1 follows the seat order');

  // External mjai records use the same encoder.
  const mjaiRecord = MJ.mjai.toSuitaku(MJ.mjai.fromSuitaku(record), { createdAt: '2026-01-01T00:00:00.000Z' });
  const external = F.dataset(mjaiRecord);
  assert(external.length > 0);
  assert.equal(external[0].x.data.length, samples[0].x.data.length);

  // Tenhou-style records have `call` events but no `response` events. The call
  // and pass decisions must be reconstructed from the legal options.
  const noResponses = JSON.parse(JSON.stringify(record));
  noResponses.hands = noResponses.hands.map((h) => ({ ...h, events: h.events.filter((e) => e.type !== 'response') }));
  const synthetic = F.dataset(noResponses);
  assert(synthetic.some((s) => s.meta.synthetic && s.meta.kind === 'response'), 'call decisions are synthesized');
  assert(synthetic.some((s) => s.label.kind === 'pass'), 'pass decisions are synthesized');
  assert(synthetic.some((s) => ['pon', 'chi', 'kan', 'ron'].includes(s.label.kind)), 'taken calls are synthesized');
  assert(synthetic.every((s) => s.label.kind !== 'discard' || typeof s.label.canRiichi === 'boolean'),
    'discard samples carry the riichi opportunity flag');

  // Tsumo is a label at the winning draw, not only a ron response.
  const tsumoRecord = await makeRecord(2);
  if (tsumoRecord.hands[0].result.tsumo) assert(F.dataset(tsumoRecord).some((s) => s.label.kind === 'tsumo'));

  console.log('Features OK: 34×25 tensor + globals, discard/call labels, public-info only, JSONL round-trip');
})().catch((error) => { console.error(error); process.exit(1); });
