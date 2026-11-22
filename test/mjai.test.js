const assert = require('node:assert/strict');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'core', 'mjai']) require('../src/' + file + '.js');
const MJ = globalThis.MJ, M = MJ.mjai, T = MJ.tiles;

function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
async function makeRecord(seeds) {
  const record = MJ.record.create('tonpu', 'standard');
  let scores = [25000, 25000, 25000, 25000], dealer = 0, honba = 0, sticks = 0;
  for (let i = 0; i < seeds.length; i++) {
    const game = new MJ.Game({ agents: [0, 1, 2, 3].map((s) => MJ.ai.create(s, { level: 'standard' })), rng: rng(seeds[i]) });
    await game.playHand({ roundWind: 27, dealer, honba, riichiSticks: sticks, scores: scores.slice(), hand: i, mode: 'tonpu' });
    record.hands.push(game.recording);
    scores = game.players.map((p) => p.score); sticks = game.riichiSticks;
    dealer = (dealer + 1) % 4; honba = 0;
  }
  record.finalScores = scores; record.finished = true;
  return record;
}

(async () => {
  assert.equal(M.tileString(0), '1m');
  assert.equal(M.tileString(16), '5mr');
  assert.equal(M.tileString(52), '5pr');
  assert.equal(M.tileString(88), '5sr');
  assert.equal(M.tileString(132), 'C');
  assert.deepEqual(M.parseTile('5mr'), { type: 4, red: true });
  assert.deepEqual(M.parseTile('0p'), { type: 13, red: true });
  assert.deepEqual(M.parseTile('E'), { type: 27, red: false });

  assert.equal(M.tenhouSeed('<SHUFFLE seed="mt19937ar-sha512-n288-base64,ABC123"/>'), 'ABC123');
  assert.throws(() => M.tenhouSeed('<mjloggm></mjloggm>'), /SHUFFLE/);
  const pon = M.decodeTenhouMeld(10794);
  assert.equal(pon.kind, 'pon'); assert.equal(pon.from, 2);
  assert.deepEqual(pon.tiles.map((id) => id >> 2), [7, 7, 7]);
  const chi = M.decodeTenhouMeld(14391);
  assert.equal(chi.kind, 'chi'); assert.equal(chi.from, 3);
  assert.deepEqual(chi.tiles.map((id) => id >> 2), [4, 5, 6]);
  assert.equal(M.decodeTenhouMeld(15923).kind, 'kakan');

  const record = await makeRecord([20261015, 1, 2]);
  const events = M.fromSuitaku(record);
  assert(M.parse(M.stringify(events)).length === events.length, 'JSON Lines round-trip');
  // Seat-view learning data can hide every other seat's tsumo tile.
  const maskedDraws = M.fromSuitaku(record, { seat: 0, maskOtherDraws: true });
  const tsumoEvents = maskedDraws.filter((e) => e.type === 'tsumo');
  assert(tsumoEvents.length > 0);
  assert(tsumoEvents.filter((e) => e.actor !== 0).every((e) => e.pai === '?'), 'opponent tsumo tiles are masked');
  assert(tsumoEvents.filter((e) => e.actor === 0).every((e) => e.pai !== '?'), 'own tsumo tiles stay visible');
  assert(M.fromSuitaku(record).filter((e) => e.type === 'tsumo').every((e) => e.pai !== '?'), 'masking is opt-in');
  assert(events.some((e) => ['chi', 'pon', 'daiminkan', 'ankan', 'kakan'].includes(e.type)), 'the sample covers calls');
  const back = M.toSuitaku(events, { createdAt: '2026-01-01T00:00:00.000Z' });
  const again = M.toSuitaku(events, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(back, again, 'conversion is deterministic');
  const validation = M.validate(back);
  assert(validation.ok, validation.warnings.join('\n'));
  assert.equal(back.hands.length, record.hands.length);
  for (let i = 0; i < record.hands.length; i++) {
    assert.equal(back.hands[i].wall.length, 136);
    assert.equal(new Set(back.hands[i].wall).size, 136);
    const before = MJ.record.snapshot(record.hands[i], record.hands[i].events.length - 1);
    const after = MJ.record.snapshot(back.hands[i], back.hands[i].events.length - 1);
    const sig = (id) => `${id >> 2}${T.isRed(id) ? 'r' : ''}`;
    const handSig = (ids) => ids.map(sig).sort().join(',');
    const meldSig = (m) => ({ kind: m.kind, open: !!m.open, type: m.type, from: m.from,
      added: m.addedTile == null ? null : sig(m.addedTile), called: m.calledTile == null ? null : sig(m.calledTile),
      tiles: m.tiles.map(sig).sort() });
    for (let seat = 0; seat < 4; seat++) {
      assert.equal(handSig(after.players[seat].hand), handSig(before.players[seat].hand));
      assert.deepEqual(after.players[seat].discards.map(sig), before.players[seat].discards.map(sig));
      assert.deepEqual(after.players[seat].melds.map(meldSig), before.players[seat].melds.map(meldSig));
      assert.equal(after.players[seat].score, before.players[seat].score);
      assert.equal(after.players[seat].riichi, before.players[seat].riichi);
    }
  }

  // Rule differences are flagged; strict mode rejects an incompatible log.
  const redEvents = M.fromSuitaku(back);
  const hasRed = redEvents.some((e) => ['5mr', '5pr', '5sr'].some((t) => [e.pai, ...(e.consumed || [])].includes(t)));
  const noAka = redEvents.map((e) => e.type === 'start_game' ? { ...e, rule: { ...e.rule, aka: false } } : e);
  if (hasRed) {
    assert.throws(() => M.toSuitaku(noAka, { strict: true }), /赤なし/);
    assert(M.toSuitaku(noAka).mjai.flags.includes('red_mismatch'));
  }
  const noKuitan = redEvents.map((e) => e.type === 'start_game' ? { ...e, rule: { ...e.rule, kuitan: false } } : e);
  assert.throws(() => M.toSuitaku(noKuitan, { strict: true }), /喰いタンなし/);

  // Tenhou mjlog -> mjai -> 翠卓. The sequence includes a tsumo win and score movement.
  const xml = `<mjloggm ver="2.3">
<GO type="169" lobby="0"/>
<UN n0="A" n1="B" n2="C" n3="D" dan="1,1,1,1" rate="1500,1500,1500,1500" sx="M,M,M,M"/>
<TAIKYOKU oya="0"/>
<INIT seed="0,0,0,1,2,121" ten="250,250,250,250" oya="0" hai0="0,1,2,3,4,5,6,7,8,9,10,11,12" hai1="13,14,15,16,17,18,19,20,21,22,23,24,25" hai2="26,27,28,29,30,31,32,33,34,35,36,37,38" hai3="39,40,41,42,43,44,45,46,47,48,49,50,51"/>
<T52/><D52/><U53/><E13/><V54/><F26/><W55/><G39/><T56/>
<AGARI ba="0,0" hai="0,1,2,3,4,5,6,7,8,9,10,11,12,56" machi="56" ten="30,1000,0" yaku="8,1" doraHai="121" who="0" fromWho="0" sc="260,10,247,-3,247,-3,246,-4"/>
</mjloggm>`;
  const tenhouEvents = M.fromTenhou(xml);
  assert.equal(tenhouEvents[0].type, 'start_game');
  assert.equal(tenhouEvents[0].names[0], 'A');
  assert.equal(tenhouEvents[0].rule.aka, true);
  assert.equal(tenhouEvents[0].rule.mode, 'hanchan');
  assert(tenhouEvents.some((e) => e.type === 'hora'));
  assert.equal(tenhouEvents[tenhouEvents.length - 1].type, 'end_game');
  const tenhouRecord = M.toSuitaku(tenhouEvents, { createdAt: '2026-01-01T00:00:00.000Z' });
  // Pao, nine terminals and nagashi mangan are flagged as rule differences.
  const paoEvents = tenhouEvents.map((e) => e.type === 'hora' ? { ...e, paoWho: 2 } : e);
  const paoRecord = M.toSuitaku(paoEvents);
  assert(paoRecord.mjai.flags.includes('pao'));
  assert.equal(paoRecord.hands[0].result.paoWho, 2);
  assert.throws(() => M.toSuitaku(paoEvents, { strict: true }), /包/);
  assert.equal(tenhouRecord.mode, 'hanchan');
  assert.deepEqual(tenhouRecord.hands[0].finalScores, [27000, 24400, 24400, 24200]);
  assert.equal(tenhouRecord.hands[0].result.type, 'win');
  assert.equal(tenhouRecord.hands[0].result.winner, 0);
  assert.equal(tenhouRecord.hands[0].result.tsumo, true);
  assert(M.validate(tenhouRecord).ok);
  assert.equal(tenhouRecord.mjai.tenhou.returnScore, 30000, 'Tenhou 30000-point return is recorded');
  assert.equal(tenhouRecord.rules.returnScore, 30000);
  assert.deepEqual(tenhouRecord.mjai.tenhou.rankConfig.uma, [90, 45, 0, -135]);

  // A Tenhou pon code: who=1, type 4m, from seat 3 (kamicha), called copy 12.
  const xmlPon = `<mjloggm ver="2.3">
<GO type="169"/><UN n0="A" n1="B" n2="C" n3="D" dan="1,1,1,1" rate="1500,1500,1500,1500" sx="M,M,M,M"/><TAIKYOKU oya="0"/>
<INIT seed="0,0,0,1,2,121" ten="250,250,250,250" oya="0" hai0="0,1,2,3,4,5,6,7,8,9,10,11,12" hai1="13,14,15,16,17,18,19,20,21,22,23,24,25" hai2="26,27,28,29,30,31,32,33,34,35,36,37,38" hai3="39,40,41,42,43,44,45,46,47,48,49,50,51"/>
<T52/><D12/><N who="1" m="4715"/><E15/>
<AGARI ba="0,0" hai="26,27,28,29,30,31,32,33,34,35,36,37,38" machi="15" ten="30,1000,0" yaku="8,1" doraHai="121" who="2" fromWho="1" sc="250,0,240,-10,260,10,250,0"/>
</mjloggm>`;
  const ponEvents = M.fromTenhou(xmlPon);
  const ponEvent = ponEvents.find((e) => e.type === 'pon');
  assert(ponEvent);
  assert.equal(ponEvent.actor, 1); assert.equal(ponEvent.target, 0);
  assert.equal(ponEvent.pai, '4m');
  assert.deepEqual(ponEvent.consumed, ['4m', '4m']);
  const ponRecord = M.toSuitaku(ponEvents, { createdAt: '2026-01-01T00:00:00.000Z' });
  assert(M.validate(ponRecord).ok);
  assert.equal(ponRecord.hands[0].result.winner, 2);

  for (const [type, flag, pattern] of [['yao9', 'nine_terminals', /九種九牌/], ['nm', 'nagashi_mangan', /流し満貫/]]) {
    const xmlDraw = `<mjloggm ver="2.3">
<GO type="169"/><TAIKYOKU oya="0"/>
<INIT seed="0,0,0,1,2,121" ten="250,250,250,250" oya="0" hai0="0,1,2,3,4,5,6,7,8,9,10,11,12" hai1="13,14,15,16,17,18,19,20,21,22,23,24,25" hai2="26,27,28,29,30,31,32,33,34,35,36,37,38" hai3="39,40,41,42,43,44,45,46,47,48,49,50,51"/>
<RYUUKYOKU type="${type}" sc="250,0,250,0,250,0,250,0" hai0="0" hai1="13"/>
</mjloggm>`;
    const drawRecord = M.toSuitaku(M.fromTenhou(xmlDraw));
    assert(drawRecord.mjai.flags.includes(flag), flag + ' is flagged');
    assert.throws(() => M.toSuitaku(M.fromTenhou(xmlDraw), { strict: true }), pattern);
  }

  // Wall layout: dead wall at the head, initial deal from the tail, dora at 5,
  // ura at 4. Physical copy numbers are not preserved, so signatures compare type+red.
  const yama = Array.from({ length: 136 }, (_, i) => (i * 37 + 11) % 136);
  const seen = new Set(yama); assert.equal(seen.size, 136);
  const layout = M.tenhouWallLayout(yama, 1);
  assert(layout.dealt.every((h) => h.length === 13));
  assert.equal(layout.live.length, 70);
  assert.equal(layout.rinshan.length, 4);
  assert.deepEqual(layout.dora, [5, 7, 9, 11, 13].map((i) => yama[i]));
  assert.deepEqual(layout.ura, [4, 6, 8, 10, 12].map((i) => yama[i]));
  const fake = { hands: [{
    config: { dealer: 1 }, initialHands: layout.dealt.map((h) => h.slice().sort((a, b) => a - b)),
    events: [
      { index: 0, type: 'start', doraIndicators: [layout.dora[0]] },
      ...layout.live.slice(0, 5).map((tileId, i) => ({ index: i + 1, type: 'draw', seat: i % 4, tileId })),
      { index: 6, type: 'draw', seat: 1, tileId: layout.rinshan[0], rinshan: true },
      { index: 7, type: 'dora', doraIndicators: layout.dora.slice(0, 2) },
      { index: 8, type: 'end', scores: [25000, 25000, 25000, 25000], result: { type: 'win', uraIndicators: layout.ura.slice(0, 1) } }
    ],
    result: { type: 'win', uraIndicators: layout.ura.slice(0, 1) }
  }] };
  const originalWalls = M.tenhouWalls;
  M.tenhouWalls = () => [yama];
  try {
    const verified = M.verifyTenhouWall('<mjloggm><SHUFFLE seed="x"/></mjloggm>', fake);
    assert(verified.ok, JSON.stringify(verified.rounds));
    fake.hands[0].initialHands[0][0] = (fake.hands[0].initialHands[0][0] + 4) % 136;
    const broken = M.verifyTenhouWall('<mjloggm><SHUFFLE seed="x"/></mjloggm>', fake);
    assert.equal(broken.ok, false);
    assert(broken.rounds[0].errors.some((e) => e.includes('配牌')));
  } finally { M.tenhouWalls = originalWalls; }

  console.log('mjai OK: tile notation, Tenhou meld decode, 翠卓↔mjai round-trip (calls/riichi/wins), mjlog replay, rule flags, wall layout');
})().catch((error) => { console.error(error); process.exit(1); });
