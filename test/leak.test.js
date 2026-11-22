const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'pacing', 'ai', 'game', 'record']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, R = MJ.record, T = MJ.tiles, P = MJ.pacing;

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
async function makeRecord(seed) {
  const game = new MJ.Game({ agents: [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level: 'standard' })), rng: rng(seed) });
  await game.playHand({ roundWind: 27, dealer: seed % 4, honba: 0, riichiSticks: 0,
    scores: [25000, 25000, 25000, 25000], hand: seed % 4, mode: 'tonpu' });
  const record = R.create('tonpu', 'standard');
  record.hands.push(game.recording);
  record.finalScores = game.players.map((p) => p.score);
  record.finished = true;
  return record;
}

(async () => {
  const full = await makeRecord(20261022);
  assert.equal(full.hands[0].wall.length, 136);
  assert.equal(full.hands[0].initialHands.length, 4);
  assert(R.validate(full));

  const masked = R.redact(full, { seat: 0 });
  assert.equal(masked.redacted, true);
  assert.equal(masked.revealSeat, 0);
  assert(R.validate(masked), 'a masked record stays structurally readable');
  assert.throws(() => MJ.record.snapshot(masked.hands[0], masked.hands[0].events.length - 1),
    'a masked record cannot be replayed into the hidden wall');

  for (const hand of masked.hands) {
    assert(!('wall' in hand), 'the wall is absent while the match is running');
    assert(!('initialHands' in hand), 'the other seats initial hands are absent');
    for (const event of hand.events) {
      if (event.type === 'draw' && event.seat !== 0) {
        assert.equal(event.hidden, true, 'opponent draws are marked hidden');
        assert(!('tileId' in event), 'opponent draw tiles are not serialized');
      }
      if (event.type === 'response') assert.equal(event.seat, 0, 'other seats call options and passes are absent');
      if (event.type === 'discard' && event.seat !== 0) assert(!('analysis' in event), 'opponent AI analysis is absent');
    }
  }
  const text = JSON.stringify(masked);
  assert(!text.includes('"wall"'), 'serialized masked record never mentions a wall');
  assert(!/"(wall|liveWall|deadWall)"/.test(text));
  // Ura indicators appear only in a finished hand's result, where they are
  // public for a riichi winner; they are never part of a live wall snapshot.

  // A hidden red five in a concealed kan must not be disclosed by the mask either.
  const fake = {
    format: 'suitaku-riichi', version: 1, createdAt: '2026-01-01T00:00:00.000Z', mode: 'tonpu', ai: 'standard',
    rules: {}, hands: [{
      config: { roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000], honba: 0, riichiSticks: 0 },
      wall: Array.from({ length: 136 }, (_, i) => i), initialHands: [[], [], [], []],
      events: [{ index: 0, type: 'kan', seat: 1, action: { kind: 'ankan', tile: 4 },
        melds: [{ kind: 'kan', type: 4, open: false, tiles: [16, 17, 18, 19] }] }]
    }]
  };
  const fakeMasked = R.redact(fake, { seat: 0 });
  const kan = fakeMasked.hands[0].events[0].melds[0];
  assert(kan.tiles.every((id) => (id >> 2) === 4), 'the tile type stays public');
  assert(kan.tiles.every((id) => !T.isRed(id)), 'the red five hidden in a concealed kan is not disclosed');

  // Every seat is paced, even when it has no legal call. The delay therefore
  // cannot reveal whether an opponent could pon/ron a discard.
  const game = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
  game.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000],
    wall: Array.from({ length: 136 }, (_, i) => i) });
  const checks = [];
  let agentCalls = 0;
  game.onCheck = ({ seat, options }) => { checks.push({ seat, options: options || null }); };
  for (const agent of game.agents) {
    const originalWantCall = agent.wantCall.bind(agent);
    agent.wantCall = async (view, options) => { agentCalls++; return originalWantCall(view, options); };
  }
  await game.checkCalls(0, 27 * 4);
  assert.equal(checks.length, 3, 'each of the three opponents is checked');
  assert.equal(agentCalls, 3, 'every seat goes through the same paced wantCall, even with no options');
  assert.deepEqual(checks.map((c) => c.seat), [1, 2, 3]);
  assert(checks.every((c) => c.options == null), 'seats without options still receive the pacing callback');
  // Force a legal pon for one seat; the callback is identical (only its options differ).
  game.callOptions = (seat, from) => seat === 1 ? { tile: 27, from, ron: false, pon: 27, kan: null, chi: [] } : null;
  game.agents[1].wantCall = async () => null;
  await game.checkCalls(0, 27 * 4 + 1);
  assert.equal(checks.length, 6, 'the fixed pacing is repeated regardless of the result');
  assert(checks.some((c) => c.options == null), 'seats without options still receive the pacing callback');
  assert(checks.some((c) => c.options != null), 'seats with options use the same callback');

  // "Fast play" ON: the scheduled check delay is identical for every seat,
  // including the seat that actually had a legal ron. Only the options object
  // differs; the delay constants are shared by the UI and these tests.
  assert.equal(P.checkDelay(true), 0, 'fast mode has no check delay');
  assert.equal(P.checkDelay(false), 45, 'normal mode uses the same fixed check delay');
  assert.equal(P.agentDelay(true, 'wantCall'), 0);
  assert.equal(P.agentDelay(true, 'chooseDiscard'), 0);
  assert.equal(P.agentDelay(false, 'wantCall'), 100);
  assert.equal(P.agentBudget(false, 'wantCall'), 120);
  async function pacedCheck(forceRon) {
    const pacingGame = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
    pacingGame.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000],
      wall: Array.from({ length: 136 }, (_, i) => i) });
    const delays = [];
    pacingGame.onCheck = ({ seat, options }) => {
      delays.push({ seat, delay: P.checkDelay(true), hasOptions: !!options });
      return Promise.resolve();
    };
    pacingGame.callOptions = (seat, from) => forceRon && seat === 1
      ? { tile: 27, from, ron: true, pon: null, kan: null, chi: [] } : null;
    for (const agent of pacingGame.agents) agent.wantCall = async () => null;
    await pacingGame.checkCalls(0, 27 * 4);
    return delays;
  }
  const quiet = await pacedCheck(false), loud = await pacedCheck(true);
  assert.deepEqual(quiet.map((d) => d.delay), [0, 0, 0], 'fast checks are all zero-delay');
  assert.deepEqual(loud.map((d) => d.delay), [0, 0, 0], 'a legal ron does not add delay in fast mode');
  assert.deepEqual(quiet.map((d) => d.hasOptions), [false, false, false]);
  assert(loud[0].hasOptions, 'the forced option reaches the same fixed pacing callback');

  // A ron pass sets the seat's own temporary furiten, but no public view, log
  // line or masked record exposed to the other seats may reveal the pass.
  const furitenGame = new MJ.Game({ agents: [0, 1, 2, 3].map(MJ.ai.create) });
  furitenGame.setup({ roundWind: 27, dealer: 0, scores: [25000, 25000, 25000, 25000],
    wall: Array.from({ length: 136 }, (_, i) => i) });
  furitenGame.callOptions = (seat, from) => seat === 1
    ? { tile: 27, from, ron: true, pon: null, kan: null, chi: [] } : null;
  for (const agent of furitenGame.agents) agent.wantCall = async () => null;
  const logs = [];
  furitenGame.onEvent = (msg) => logs.push(msg);
  const before = JSON.stringify(furitenGame.getObservation(0));
  await furitenGame.checkCalls(0, 27 * 4);
  const after = JSON.stringify(furitenGame.getObservation(0));
  assert.equal(furitenGame.players[1].tempFuriten, true, 'the passing seat becomes temporarily furiten');
  assert.equal(after, before, 'another seat passing a ron does not change the public observation');
  assert(!after.includes('furiten'), 'the public observation has no furiten flag for opponents');
  assert.deepEqual(logs, [], 'a pass produces no log line');
  const passRecord = R.create('tonpu', 'standard');
  passRecord.hands.push(furitenGame.recording);
  const passMasked = R.redact(passRecord, { seat: 0 });
  assert(!passMasked.hands[0].events.some((e) => e.type === 'response' && e.seat !== 0),
    'other seats ron options and passes are removed from the masked record');
  assert(!JSON.stringify(passMasked).includes('"options"'), 'no call options leak into the masked record');

  // Console/hint hygiene: no console.log in the shipped sources, and the
  // built page does not expose the raw game or the unmasked record.
  for (const file of ['ui.js', 'ai.js', 'game.js', 'record.js', 'mjai.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    assert(!/console\.(log|debug|info)\s*\(/.test(source), file + ' must not log hidden state to the console');
  }
  const ui = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui.js'), 'utf8');
  assert(!/localStorage\.setItem\([^)]*JSON\.stringify\(ui\.record/.test(ui), 'autosave must use the masked record');
  assert(!/download\([^\n]*JSON\.stringify\(ui\.record/.test(ui), 'downloads must use the masked record');

  console.log('Leak audit OK: masked in-play record, concealed-kan red hidden, fixed response pacing, console hygiene');
})().catch((error) => { console.error(error); process.exit(1); });
