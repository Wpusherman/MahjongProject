(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const F = (MJ.features = { version: 'obs-v2' });
  const countIds = (ids) => {
    const c = new Array(34).fill(0);
    for (const id of ids || []) c[id >> 2]++;
    return c;
  };
  const normalized = (ids, scale = 4) => countIds(ids).map((n) => Math.min(1, n / scale));
  const redCounts = (ids) => {
    const c = new Array(34).fill(0);
    for (const id of ids || []) if (T.isRed(id)) c[id >> 2] = 1;
    return c;
  };
  const meldCounts = (melds) => normalized((melds || []).flatMap((m) => m.tiles || []), 4);
  const oneHotLast = (history) => {
    const out = new Array(34).fill(0);
    const last = (history || [])[history.length - 1];
    if (last) out[last.tileId >> 2] = 1;
    return out;
  };
  const oneHotRiichi = (history) => {
    const out = new Array(34).fill(0);
    for (let i = (history || []).length - 1; i >= 0; i--) if (history[i].riichi) { out[history[i].tileId >> 2] = 1; break; }
    return out;
  };
  const tsumogiriCounts = (history) => normalized((history || []).filter((d) => d.tsumogiri).map((d) => d.tileId), 4);
  const doraCounts = (indicators) => {
    const out = new Array(34).fill(0);
    for (const id of indicators || []) out[T.doraFromIndicator(id >> 2)]++;
    return out.map((n) => Math.min(1, n / 4));
  };
  const indicatorCounts = (indicators) => {
    const out = new Array(34).fill(0);
    for (const id of indicators || []) out[id >> 2] = Math.min(1, out[id >> 2] + 0.25);
    return out;
  };
  const safeCounts = (obs) => {
    const riichi = (obs.opponents || []).filter((o) => o.riichi);
    if (!riichi.length) return new Array(34).fill(0);
    const out = new Array(34).fill(0);
    for (const o of riichi) {
      for (let t = 0; t < 34; t++) {
        if ((o.discardTypes || []).includes(t) || (o.safeTypes || []).includes(t)) out[t]++;
      }
    }
    return out.map((n) => n / riichi.length);
  };

  const opponentChannel = (index, name, fn) => ({
    name: `opp${index + 1}_${name}`,
    fn: (obs) => { const o = obs.opponents.find((x) => x.seat === (obs.seat + index + 1) % 4); return o ? fn(o) : new Array(34).fill(0); }
  });
  F.CHANNELS = [
    { name: 'hand', fn: (o) => normalized(o.hand, 4) },
    { name: 'hand_red', fn: (o) => redCounts(o.hand) },
    { name: 'meld_self', fn: (o) => meldCounts(o.melds) },
    { name: 'dora', fn: (o) => doraCounts(o.doraIndicators) },
    { name: 'dora_indicator', fn: (o) => indicatorCounts(o.doraIndicators) },
    { name: 'unseen', fn: (o) => (o.unseen || new Array(34).fill(0)).map((n) => n / 4) },
    { name: 'river_self', fn: (o) => normalized((o.ownDiscardHistory || []).map((d) => d.tileId), 4) },
    { name: 'last_self', fn: (o) => oneHotLast(o.ownDiscardHistory) },
    { name: 'tsumogiri_self', fn: (o) => tsumogiriCounts(o.ownDiscardHistory) },
    opponentChannel(0, 'river', (o) => normalized((o.discardHistory || []).map((d) => d.tileId), 4)),
    opponentChannel(0, 'last', (o) => oneHotLast(o.discardHistory)),
    opponentChannel(0, 'tsumogiri', (o) => tsumogiriCounts(o.discardHistory)),
    opponentChannel(0, 'riichi_tile', (o) => oneHotRiichi(o.discardHistory)),
    opponentChannel(0, 'meld', (o) => meldCounts(o.melds)),
    opponentChannel(1, 'river', (o) => normalized((o.discardHistory || []).map((d) => d.tileId), 4)),
    opponentChannel(1, 'last', (o) => oneHotLast(o.discardHistory)),
    opponentChannel(1, 'tsumogiri', (o) => tsumogiriCounts(o.discardHistory)),
    opponentChannel(1, 'riichi_tile', (o) => oneHotRiichi(o.discardHistory)),
    opponentChannel(1, 'meld', (o) => meldCounts(o.melds)),
    opponentChannel(2, 'river', (o) => normalized((o.discardHistory || []).map((d) => d.tileId), 4)),
    opponentChannel(2, 'last', (o) => oneHotLast(o.discardHistory)),
    opponentChannel(2, 'tsumogiri', (o) => tsumogiriCounts(o.discardHistory)),
    opponentChannel(2, 'riichi_tile', (o) => oneHotRiichi(o.discardHistory)),
    opponentChannel(2, 'meld', (o) => meldCounts(o.melds)),
    { name: 'safe_vs_riichi', fn: (o) => safeCounts(o) }
  ];

  F.GLOBAL_NAMES = ['score0', 'score1', 'score2', 'score3', 'diff0', 'diff1', 'diff2', 'diff3',
    'wind_e', 'wind_s', 'wind_w', 'wind_n', 'dealer', 'south_round', 'honba', 'riichi_sticks',
    'live_remaining', 'turn', 'hands_left', 'riichi0', 'riichi1', 'riichi2', 'riichi3',
    'threat', 'furiten', 'open_melds_opp0', 'open_melds_opp1', 'open_melds_opp2',
    'hand_count_opp0', 'hand_count_opp1', 'hand_count_opp2'];
  function globals(obs) {
    const scores = obs.scores || [25000, 25000, 25000, 25000];
    const seat = obs.seat;
    // Score and riichi slots follow the match's starting seat order (0 = 起家),
    // not absolute seat numbers. startDealer defaults to 0 for older records.
    // This is the obs-v2 slot meaning; obs-v1 used absolute seat order.
    const startDealer = Number.isInteger(obs.startDealer) ? obs.startDealer : 0;
    const seatAt = (slot) => (startDealer + slot) % 4;
    const values = [];
    for (let slot = 0; slot < 4; slot++) values.push((scores[seatAt(slot)] - 25000) / 100000);
    for (let slot = 0; slot < 4; slot++) values.push((scores[seat] - scores[seatAt(slot)]) / 100000);
    const wind = obs.seatWind != null ? obs.seatWind : (obs.seatWinds || [27, 28, 29, 30])[seat];
    for (let w = 0; w < 4; w++) values.push(wind === 27 + w ? 1 : 0);
    values.push(obs.isDealer ? 1 : 0);
    values.push(obs.roundWind === 28 ? 1 : 0);
    values.push((obs.honba || 0) / 10, (obs.riichiSticks || 0) / 10,
      (obs.liveRemaining == null ? 70 : obs.liveRemaining) / 70, (obs.turnCount || 0) / 100,
      (obs.handsLeft == null ? 4 : obs.handsLeft) / 8);
    const riichi = [0, 0, 0, 0];
    if (obs.riichi) riichi[seat] = 1;
    for (const o of obs.opponents || []) if (o.riichi) riichi[o.seat] = 1;
    for (let slot = 0; slot < 4; slot++) values.push(riichi[seatAt(slot)]);
    values.push(obs.threat ? 1 : 0, obs.furiten ? 1 : 0);
    for (let i = 0; i < 3; i++) {
      const o = (obs.opponents || []).find((x) => x.seat === (seat + i + 1) % 4);
      values.push(o ? (o.melds || []).filter((m) => m.open).length / 4 : 0);
    }
    for (let i = 0; i < 3; i++) {
      const o = (obs.opponents || []).find((x) => x.seat === (seat + i + 1) % 4);
      values.push(o ? (o.handCount || 0) / 14 : 0);
    }
    return values;
  }

  F.encode = function (obs) {
    if (!obs || !Array.isArray(obs.hand)) throw new Error('features.encode requires an observation');
    const tiles = 34, channels = F.CHANNELS.length, g = globals(obs);
    const data = new Float32Array(channels * tiles + g.length);
    F.CHANNELS.forEach((channel, c) => {
      const values = channel.fn(obs);
      if (!Array.isArray(values) || values.length !== tiles) throw new Error('Invalid feature channel: ' + channel.name);
      for (let t = 0; t < tiles; t++) data[c * tiles + t] = Number.isFinite(values[t]) ? values[t] : 0;
    });
    for (let i = 0; i < g.length; i++) data[channels * tiles + i] = Number.isFinite(g[i]) ? g[i] : 0;
    return { version: F.version, shape: { channels, tiles, globals: g.length },
      channelNames: F.CHANNELS.map((c) => c.name), globalNames: F.GLOBAL_NAMES.slice(), data };
  };

  function labelOf(event, options) {
    const action = event.action;
    if (event.type === 'discard') return { kind: 'discard', tile: event.tileId >> 2, riichi: !!event.riichi, tsumogiri: !!event.tsumogiri };
    if (!action) return { kind: 'pass' };
    if (action.type === 'ron') return { kind: 'ron' };
    if (action.type === 'pon') return { kind: 'pon', tile: event.tileId >> 2 };
    if (action.type === 'kan') return { kind: 'kan', tile: event.tileId >> 2 };
    if (action.type === 'chi') return { kind: 'chi', tile: event.tileId >> 2, tiles: action.tiles.slice() };
    return { kind: action.type };
  }

  // Deterministic supervised samples from a 翠卓 record. The observation is taken
  // immediately before the action, so opponent hands and the wall are never encoded.
  // External mjlog conversions record calls as `call` events and do not contain
  // `response` events for the seats that passed. For those records the call/pass
  // decisions are reconstructed from the legal options and the next recorded event.
  F.dataset = function (record, opts = {}) {
    if (!record || !Array.isArray(record.hands)) throw new Error('features.dataset requires a 翠卓 record');
    const samples = [], limit = Number.isFinite(opts.limit) ? opts.limit : Infinity;
    const synthesize = opts.syntheticCalls !== false;
    const match = record.matchId || record.source || record.createdAt || 'match';
    for (let h = 0; h < record.hands.length; h++) {
      const hand = record.hands[h];
      const hasResponses = hand.events.some((e) => e.type === 'response');
      for (let i = 0; i < hand.events.length; i++) {
        const event = hand.events[i];
        if (event.type === 'end' && event.result && event.result.type === 'win' && event.result.tsumo) {
          const game = MJ.record.snapshot(hand, i - 1);
          const seat = event.result.winner;
          const obs = game.getObservation(seat);
          obs.furiten = game.isFuriten(seat);
          samples.push({ hand: h, eventIndex: i, seat, x: F.encode(obs),
            label: { kind: 'tsumo', tile: event.result.winTile >> 2 }, match,
            meta: { version: F.version, hand: h, eventIndex: i, seat, turn: event.turn == null ? game.turnCount : event.turn, kind: 'end', riichi: !!game.players[seat].riichi } });
          if (samples.length >= limit) return samples;
          continue;
        }
        if (event.type !== 'discard' && event.type !== 'response') continue;
        const game = MJ.record.snapshot(hand, i - 1);
        const seat = event.seat;
        const extra = event.type === 'response'
          ? { callTile: event.tileId, callType: event.tileId >> 2, callFrom: event.from, isCallDecision: true }
          : undefined;
        const obs = game.getObservation(seat, extra);
        obs.furiten = game.isFuriten(seat);
        const x = F.encode(obs);
        const label = labelOf(event, event.options);
        if (event.type === 'discard') { label.forced = !!game.players[seat].riichi; label.canRiichi = game.canRiichi(seat); }
        samples.push({ hand: h, eventIndex: i, seat, x, label, match,
          meta: { version: F.version, hand: h, eventIndex: i, seat, turn: event.turn == null ? game.turnCount : event.turn,
            kind: event.type, riichi: !!game.players[seat].riichi } });
        if (samples.length >= limit) return samples;
        if (event.type === 'discard' && synthesize && !hasResponses) {
          const after = MJ.record.snapshot(hand, i);
          const next = hand.events[i + 1];
          const called = next && next.type === 'call' && next.from === seat ? next : null;
          const ronned = next && next.type === 'end' && next.result && next.result.type === 'win' &&
            !next.result.tsumo && next.result.loser === seat ? next : null;
          for (let dist = 1; dist < 4; dist++) {
            const caller = (seat + dist) % 4;
            const options = after.callOptions(caller, seat, event.tileId);
            if (!options) continue;
            const action = called && called.seat === caller ? called.action
              : ronned && ronned.result.winner === caller ? { type: 'ron' } : null;
            const callObs = after.getObservation(caller, { callTile: event.tileId, callType: event.tileId >> 2,
              callFrom: seat, isCallDecision: true, win: options.ron ? options.win : undefined });
            callObs.furiten = after.isFuriten(caller);
            const callLabel = action ? (action.type === 'ron' ? { kind: 'ron' }
              : action.type === 'chi' ? { kind: 'chi', tile: event.tileId >> 2, tiles: action.tiles.slice() }
                : { kind: action.type, tile: event.tileId >> 2 }) : { kind: 'pass' };
            samples.push({ hand: h, eventIndex: i, seat: caller, x: F.encode(callObs), label: callLabel, match,
              meta: { version: F.version, hand: h, eventIndex: i, seat: caller, turn: event.turn == null ? after.turnCount : event.turn,
                kind: 'response', riichi: !!after.players[caller].riichi, synthetic: true, ron: !!options.ron,
                pon: options.pon != null, kan: options.kan != null, chi: (options.chi || []).length } });
            if (samples.length >= limit) return samples;
          }
        }
      }
    }
    return samples;
  };

  F.toJSONL = function (samples) {
    return samples.map((s) => JSON.stringify({ v: s.x.version, match: s.match, hand: s.hand, event: s.eventIndex, seat: s.seat,
      channels: s.x.channelNames, globals: s.x.globalNames, shape: s.x.shape,
      x: Array.from(s.x.data), label: s.label, meta: s.meta })).join('\n') + '\n';
  };
  F.fromJSONL = function (text) {
    const lines = String(text).split(/\r?\n/).filter(Boolean);
    let legacy = 0;
    const legacyVersions = new Set();
    const rows = lines.map((line) => {
      const row = JSON.parse(line);
      if (row.v !== F.version) { legacy++; legacyVersions.add(row.v || 'missing'); }
      return { hand: row.hand, eventIndex: row.event, seat: row.seat, label: row.label, meta: row.meta,
        x: { version: row.v, channelNames: row.channels, globalNames: row.globals, shape: row.shape, data: Float32Array.from(row.x) } };
    });
    if (legacy) console.warn(`features.fromJSONL: ${legacy}/${lines.length} rows use ${[...legacyVersions].join(', ')} (expected ${F.version}); regenerate old shards before training.`);
    return rows;
  };
})();
