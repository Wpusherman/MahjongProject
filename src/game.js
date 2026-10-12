(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles, S = MJ.shanten;
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const sortHand = (hand) => hand.slice().sort((a, b) => a - b);
  const takeIds = (hand, type, n) => {
    const ids = hand.filter((id) => (id >> 2) === type).sort((a, b) => Number(T.isRed(a)) - Number(T.isRed(b))).slice(0, n);
    for (const id of ids) hand.splice(hand.indexOf(id), 1);
    return ids;
  };

  function Game(config) {
    this.onEvent = config.onEvent || (() => {});
    this.onUpdate = config.onUpdate || (() => {});
    this.agents = config.agents;
    this.rng = config.rng || Math.random;
    this.logs = [];
    this.cancelled = false;
  }
  Game.prototype.record = function (type, data) {
    const event = Object.assign({ index: this.recording.events.length, type, turn: this.turnCount }, clone(data || {}));
    this.recording.events.push(event);
    return event;
  };
  Game.prototype.log = function (msg, data) {
    this.logs.push({ msg, data });
    this.onEvent(msg, data);
  };
  Game.prototype.setup = function (config) {
    Object.assign(this, { roundWind: config.roundWind, dealer: config.dealer, honba: config.honba || 0,
      riichiSticks: config.riichiSticks || 0, turnCount: 0, anyCall: false, ended: false, result: null,
      wallIndex: 0, liveEnd: 122, rinshanIndex: 0, doraRevealed: 1, currentSeat: config.dealer });
    this.players = Array.from({ length: 4 }, (_, seat) => ({ seat, hand: [], melds: [], discards: [], river: [],
      discardHistory: [], score: config.scores[seat], riichi: false, doubleRiichi: false, ippatsu: false,
      tempFuriten: false, riichiFuriten: false, drawnTile: null, drawCount: 0, riichiTurn: -1,
      isTenpai: false, forbidden: [] }));
    this.wall = config.wall ? config.wall.slice() : T.buildWall(this.rng);
    if (this.wall.length !== 136 || new Set(this.wall).size !== 136 || this.wall.some((id) => !Number.isInteger(id) || id < 0 || id > 135)) throw new Error('Invalid wall');
    this.liveWall = this.wall.slice(0, 122);
    this.deadWall = this.wall.slice(122);
    // Four tiles at a time, starting with the dealer; the entire wall is fixed before dealing.
    for (let batch = 0; batch < 3; batch++) for (let i = 0; i < 4; i++) {
      const p = this.players[(this.dealer + i) % 4];
      for (let k = 0; k < 4; k++) p.hand.push(this.liveWall[this.wallIndex++]);
    }
    for (let i = 0; i < 4; i++) this.players[(this.dealer + i) % 4].hand.push(this.liveWall[this.wallIndex++]);
    for (const p of this.players) p.hand = sortHand(p.hand);
    this.syncDora();
    this.recording = { config: clone(config), wall: this.wall.slice(), initialHands: this.players.map((p) => p.hand.slice()), events: [] };
    delete this.recording.config.wall;
    this.record('start', { scores: config.scores, doraIndicators: this.doraIndicators });
  };
  Game.prototype.syncDora = function () {
    // Four rinshan tiles, then five non-overlapping pairs of dora / ura indicators.
    this.doraIndicators = Array.from({ length: this.doraRevealed }, (_, i) => this.deadWall[4 + i * 2]);
    this.uraIndicators = Array.from({ length: this.doraRevealed }, (_, i) => this.deadWall[5 + i * 2]);
  };
  Game.prototype.liveRemaining = function () { return this.liveEnd - this.wallIndex; };
  Game.prototype.drawTile = function () { return this.liveRemaining() > 0 ? this.liveWall[this.wallIndex++] : null; };
  Game.prototype.drawRinshan = function () {
    if (this.rinshanIndex >= 4 || this.liveRemaining() <= 0) return null;
    this.liveEnd--; // The last live tile replenishes the dead wall.
    return this.deadWall[this.rinshanIndex++];
  };
  Game.prototype.seatWindOf = function (seat) { return 27 + ((seat - this.dealer + 4) % 4); };
  Game.prototype.computeUnseen = function (seat) {
    const u = Array(34).fill(4), seen = new Set();
    const dec = (id) => { if (!seen.has(id)) { u[id >> 2]--; seen.add(id); } };
    this.players[seat].hand.forEach(dec);
    for (const p of this.players) {
      p.discards.forEach(dec);
      for (const m of p.melds) m.tiles.forEach(dec);
    }
    this.doraIndicators.forEach(dec);
    return u;
  };
  Game.prototype.buildView = function (seat, extra) {
    const p = this.players[seat];
    const opponents = this.players.filter((o) => o.seat !== seat).map((o) => ({ seat: o.seat, riichi: o.riichi,
      discards: o.discards.slice(), discardTypes: o.discardHistory.map((d) => d.tileId >> 2),
      discardHistory: clone(o.discardHistory), melds: clone(o.melds), score: o.score, isDealer: o.seat === this.dealer,
      safeTypes: o.riichi ? [...new Set(this.players.flatMap((x) => x.discardHistory.filter((d) => d.turn >= o.riichiTurn).map((d) => d.tileId >> 2)))] : [] }));
    return Object.assign({ seat, hand: sortHand(p.hand), melds: clone(p.melds), drawnTile: p.drawnTile,
      discards: this.players.map((x) => x.discards.slice()), doraIndicators: this.doraIndicators.slice(),
      scores: this.players.map((x) => x.score), roundWind: this.roundWind, seatWind: this.seatWindOf(seat),
      isDealer: seat === this.dealer, riichi: p.riichi, menzen: !p.melds.some((m) => m.open),
      liveRemaining: this.liveRemaining(), unseen: this.computeUnseen(seat), opponents,
      threat: opponents.some((o) => o.riichi), score: p.score, turnCount: this.turnCount,
      forbidden: p.forbidden.slice(), legalDiscards: p.hand.filter((id) => !p.forbidden.includes(id >> 2)),
      ownDiscardTypes: p.discardHistory.map((d) => d.tileId >> 2) }, extra || {});
  };
  Game.prototype.waits = function (seat, hand, meldCount) {
    const p = this.players[seat], counts = T.countsFromIds(hand || p.hand), out = [];
    for (let t = 0; t < 34; t++) {
      const owned = counts[t] + p.melds.reduce((n, m) => n + m.tiles.filter((id) => (id >> 2) === t).length, 0);
      if (owned >= 4) continue;
      counts[t]++;
      if (MJ.agari.isAgari(counts, meldCount == null ? p.melds.length : meldCount)) out.push(t);
      counts[t]--;
    }
    return out;
  };
  Game.prototype.isFuriten = function (seat) {
    const p = this.players[seat];
    if (p.tempFuriten || p.riichiFuriten) return true;
    const waits = this.waits(seat);
    return p.discardHistory.some((d) => waits.includes(d.tileId >> 2));
  };
  Game.prototype.evalWin = function (seat, winTileId, opts) {
    const p = this.players[seat], handIds = p.hand.slice();
    if (!opts.tsumo) handIds.push(winTileId);
    const ctx = { counts: T.countsFromIds(handIds), melds: p.melds.map((m) => ({ kind: m.kind, type: m.type, open: m.open })),
      winTile: winTileId >> 2, tsumo: !!opts.tsumo, riichi: p.riichi, doubleRiichi: p.doubleRiichi,
      ippatsu: p.ippatsu, chankan: !!opts.chankan, rinshan: !!opts.rinshan, haitei: !!opts.haitei,
      houtei: !!opts.houtei, seatWind: this.seatWindOf(seat), roundWind: this.roundWind, isDealer: seat === this.dealer,
      tenhou: !!opts.tsumo && seat === this.dealer && p.drawCount === 1 && !this.anyCall,
      chiihou: !!opts.tsumo && seat !== this.dealer && p.drawCount === 1 && !this.anyCall,
      doraIndicators: this.doraIndicators.slice(), uraIndicators: p.riichi ? this.uraIndicators.slice() : [],
      redIds: handIds.concat(p.melds.flatMap((m) => m.tiles)).filter(T.isRed) };
    const ev = MJ.yaku.evaluate(ctx);
    if (!ev || (!ev.yakuman && !ev.list.length)) return null;
    return { ctx, ev, score: MJ.score.compute(ctx, ev, ev.yakuman ? 0 : MJ.score.countDora(ctx)), winTileId };
  };
  Game.prototype.callOptions = function (seat, from, tileId, robKan) {
    const p = this.players[seat], type = tileId >> 2, counts = T.countsFromIds(p.hand);
    const opts = { tile: type, from, ron: false, pon: null, kan: null, chi: [] };
    const win = this.evalWin(seat, tileId, { tsumo: false, chankan: !!robKan, houtei: !robKan && !this.lastDrawRinshan && this.liveRemaining() === 0 });
    if (win && !this.isFuriten(seat) && (robKan !== 'ankan' || win.ev.kokushi)) opts.ron = true;
    if (!robKan && !p.riichi && this.liveRemaining() > 0) {
      if (counts[type] >= 2 && p.hand.some((id) => (id >> 2) !== type)) opts.pon = type;
      if (counts[type] >= 3 && this.rinshanIndex < 4) opts.kan = type;
      if (seat === (from + 1) % 4 && type < 27) {
        for (let start = type - 2; start <= type; start++) {
          if (start < 0 || start >= 27 || start % 9 > 6 || Math.floor(start / 9) !== Math.floor(type / 9)) continue;
          const pair = [start, start + 1, start + 2].filter((t) => t !== type);
          if (!pair.every((t) => counts[t] > 0)) continue;
          const remaining = counts.slice(); pair.forEach((t) => remaining[t]--);
          const forbidden = this.callForbidden({ type: 'chi', tile: type, tiles: pair });
          if (remaining.some((n, t) => n && !forbidden.includes(t))) opts.chi.push(pair);
        }
      }
    }
    return opts.ron || opts.pon != null || opts.kan != null || opts.chi.length ? opts : null;
  };
  Game.prototype.callForbidden = function (action) {
    const out = [action.tile];
    if (action.type === 'chi') {
      const start = Math.min(action.tile, ...action.tiles);
      const other = action.tile === start ? start + 3 : action.tile === start + 2 ? start - 1 : -1;
      if (other >= 0 && other < 27 && Math.floor(other / 9) === Math.floor(start / 9)) out.push(other);
    }
    return out;
  };
  Game.prototype.availableKans = function (seat) {
    const p = this.players[seat], counts = T.countsFromIds(p.hand), out = [];
    if (this.rinshanIndex >= 4 || this.liveRemaining() < 1) return out;
    for (let t = 0; t < 34; t++) if (counts[t] === 4) {
      if (p.riichi) {
        if ((p.drawnTile >> 2) !== t) continue;
        const before = p.hand.filter((id) => id !== p.drawnTile);
        const after = p.hand.filter((id) => (id >> 2) !== t);
        const waits = this.waits(seat, before);
        if (JSON.stringify(waits) !== JSON.stringify(this.waits(seat, after, p.melds.length + 1))) continue;
        // Every winning decomposition must use the original three tiles as a triplet.
        const c = T.countsFromIds(before);
        if (waits.some((w) => { c[w]++; const ds = MJ.agari.decompose(c); c[w]--; return ds.some((d) => !d.sets.some((s) => s.kind === 'trip' && s.type === t)); })) continue;
      }
      out.push({ kind: 'ankan', tile: t });
    }
    if (!p.riichi) for (const m of p.melds) if (m.kind === 'trip' && m.open && counts[m.type]) out.push({ kind: 'kakan', tile: m.type });
    return out;
  };
  Game.prototype.applyCall = function (seat, action, from, tileId) {
    const p = this.players[seat], source = this.players[from];
    this.anyCall = true;
    this.players.forEach((x) => { x.ippatsu = false; });
    source.discards.pop();
    const riverTile = source.river.pop();
    riverTile.called = true;
    p.drawnTile = null;
    action = Object.assign({}, action, { tile: tileId >> 2 });
    const ids = action.type === 'chi' ? action.tiles.flatMap((t) => takeIds(p.hand, t, 1)) : takeIds(p.hand, action.tile, action.type === 'kan' ? 3 : 2);
    const m = { kind: action.type === 'chi' ? 'seq' : action.type === 'kan' ? 'kan' : 'trip',
      type: action.type === 'chi' ? Math.min(action.tile, ...action.tiles) : action.tile, open: true,
      tiles: [tileId, ...ids], from, calledTile: tileId };
    p.melds.push(m);
    p.forbidden = action.type === 'kan' ? [] : this.callForbidden(action);
    p.hand = sortHand(p.hand);
    this.record('call', { seat, from, action, meld: m });
    this.log(`P${seat + 1} ${action.type === 'chi' ? 'チー' : action.type === 'pon' ? 'ポン' : '大明槓'} ${T.label(action.tile)}`, { type: action.type });
  };
  Game.prototype.applyKan = function (seat, k) {
    const p = this.players[seat];
    this.anyCall = true;
    this.players.forEach((x) => { x.ippatsu = false; });
    if (k.kind === 'ankan') p.melds.push({ kind: 'kan', type: k.tile, open: false, tiles: takeIds(p.hand, k.tile, 4) });
    else {
      const m = p.melds.find((m) => m.kind === 'trip' && m.type === k.tile);
      m.kind = 'kan'; m.addedTile = takeIds(p.hand, k.tile, 1)[0]; m.tiles.push(m.addedTile);
    }
    p.hand = sortHand(p.hand);
    this.record('kan', { seat, action: k, melds: p.melds });
    this.log(`P${seat + 1} ${k.kind === 'ankan' ? '暗槓' : '加槓'} ${T.label(k.tile)}`, { type: 'kan' });
  };
  Game.prototype.revealKanDora = function () {
    if (this.doraRevealed < 5) {
      this.doraRevealed++; this.syncDora();
      this.record('dora', { doraIndicators: this.doraIndicators });
    }
  };
  Game.prototype.canRiichi = function (seat) {
    const p = this.players[seat];
    if (p.riichi || p.melds.some((m) => m.open) || p.score < 1000 || this.liveRemaining() < 4) return false;
    return p.hand.some((id) => this.waits(seat, p.hand.filter((x) => x !== id)).length > 0);
  };
  Game.prototype.declareRiichi = function (seat) {
    const p = this.players[seat];
    p.riichi = true; p.doubleRiichi = p.discardHistory.length === 1 && !this.anyCall;
    p.ippatsu = true; p.riichiTurn = this.turnCount;
    p.score -= 1000; this.riichiSticks++;
    this.record('riichi', { seat, doubleRiichi: p.doubleRiichi });
    this.log(`P${seat + 1} リーチ！`, { type: 'riichi' });
  };
  Game.prototype.discard = function (seat, tileId, riichi, analysis) {
    const p = this.players[seat], idx = p.hand.indexOf(tileId);
    if (idx < 0 || p.forbidden.includes(tileId >> 2)) throw new Error('Illegal discard');
    const d = { tileId, tsumogiri: tileId === p.drawnTile, riichi: !!riichi, called: false, turn: this.turnCount };
    p.hand.splice(idx, 1); p.discards.push(tileId); p.river.push(d); p.discardHistory.push(d);
    p.drawnTile = null; p.forbidden = [];
    p.hand = sortHand(p.hand);
    const event = this.record('discard', { seat, ...d, analysis: analysis || null });
    d.eventIndex = event.index;
    this.lastDiscard = { seat, ...d };
    this.log(`P${seat + 1} ${d.tsumogiri ? 'ツモ切り' : '打'} ${T.label(tileId >> 2)}${riichi ? '（リーチ宣言）' : ''}`, { type: 'discard', seat, ...d });
  };
  Game.prototype.tenpai = function (seat) { return this.waits(seat).length > 0; };
  Game.prototype.finish = function (result) {
    this.result = result; this.ended = true;
    this.recording.result = clone(result);
    this.recording.finalScores = this.players.map((p) => p.score);
    this.record('end', { result, scores: this.recording.finalScores, riichiSticks: this.riichiSticks });
    this.onUpdate();
    return result;
  };
  Game.prototype.doWin = function (seat, tileId, opts, evaluated) {
    const res = evaluated || this.evalWin(seat, tileId, opts);
    if (!res) throw new Error('Invalid win');
    const score = res.score;
    let received = 0;
    for (let s = 0; s < 4; s++) {
      if (s === seat || (!opts.tsumo && s !== opts.loser)) continue;
      const base = !opts.tsumo ? score.payments.ron : seat === this.dealer ? score.payments.each : s === this.dealer ? score.payments.fromDealer : score.payments.fromOthers;
      const pay = base + this.honba * (opts.tsumo ? 100 : 300);
      this.players[s].score -= pay; received += pay;
    }
    const sticks = this.riichiSticks;
    this.players[seat].score += received + sticks * 1000; this.riichiSticks = 0;
    this.log(`P${seat + 1} ${opts.tsumo ? 'ツモ' : 'ロン'} ${received + sticks * 1000}点`, { type: opts.tsumo ? 'tsumo' : 'ron' });
    return this.finish({ type: 'win', winner: seat, loser: opts.loser == null ? null : opts.loser,
      tsumo: !!opts.tsumo, score, han: score.han, fu: score.fu, yaku: score.yaku, dora: score.dora,
      yakuman: score.yakuman, winTile: tileId, sticks, received: received + sticks * 1000,
      uraIndicators: this.players[seat].riichi ? this.uraIndicators : [] });
  };
  Game.prototype.doRyuukyoku = function (reason) {
    const tenpai = [];
    if (!reason || reason === 'exhaustive') {
      for (const p of this.players) { p.isTenpai = this.tenpai(p.seat); if (p.isTenpai) tenpai.push(p.seat); }
      if (tenpai.length > 0 && tenpai.length < 4) for (const p of this.players) p.score += p.isTenpai ? 3000 / tenpai.length : -3000 / (4 - tenpai.length);
    }
    this.log('流局');
    return this.finish({ type: 'draw', tenpai, reason: reason || 'exhaustive' });
  };
  Game.prototype.checkCalls = async function (from, tileId, robKan) {
    const claims = [];
    for (let dist = 1; dist < 4; dist++) {
      const seat = (from + dist) % 4, opts = this.callOptions(seat, from, tileId, robKan);
      if (!opts) continue;
      const agent = this.agents[seat];
      agent.lastCallAnalysis = null;
      const action = await agent.wantCall(this.buildView(seat, { callTile: tileId, callType: tileId >> 2, callFrom: from, isCallDecision: true }), opts);
      if (this.cancelled) return null;
      this.record('response', { seat, from, tileId, robKan: robKan || null, action, options: opts, analysis: agent.lastCallAnalysis });
      if (opts.ron && (!action || action.type !== 'ron')) {
        this.players[seat].tempFuriten = true;
        if (this.players[seat].riichi) this.players[seat].riichiFuriten = true;
      }
      if (action) {
        const valid = action.type === 'ron' ? opts.ron : action.type === 'pon' ? opts.pon != null : action.type === 'kan' ? opts.kan != null : action.type === 'chi' && opts.chi.some((pair) => JSON.stringify(pair) === JSON.stringify(action.tiles));
        if (!valid) throw new Error('Illegal call');
        claims.push({ seat, action: { ...action, tile: tileId >> 2 }, dist });
      }
    }
    const rank = (a) => a.type === 'ron' ? 3 : a.type === 'chi' ? 1 : 2;
    claims.sort((a, b) => rank(b.action) - rank(a.action) || a.dist - b.dist);
    return claims[0] || null; // Atamahane (head-bump), specified in the rules.
  };
  Game.prototype.playHand = async function (config) {
    this.setup(config); this.onUpdate();
    let cur = this.dealer, drawKind = 'live';
    while (!this.ended && !this.cancelled) {
      const p = this.players[cur]; this.currentSeat = cur;
      let rinshan = drawKind === 'rinshan', haitei = false;
      this.lastDrawRinshan = rinshan;
      if (drawKind !== 'none') {
        if (this.liveRemaining() <= 0) return this.doRyuukyoku();
        const tile = rinshan ? this.drawRinshan() : this.drawTile();
        if (tile == null) throw new Error('No draw available');
        p.hand.push(tile); p.drawnTile = tile; p.drawCount++; p.tempFuriten = false;
        if (rinshan) this.revealKanDora();
        haitei = !rinshan && this.liveRemaining() === 0;
        this.record('draw', { seat: cur, tileId: tile, rinshan, liveRemaining: this.liveRemaining() });
        this.log(`P${cur + 1} ${rinshan ? '嶺上ツモ' : 'ツモ'}`);
        this.onUpdate();
        const win = this.evalWin(cur, tile, { tsumo: true, rinshan, haitei });
        if (win && await this.agents[cur].wantTsumo(this.buildView(cur, { win, canTsumo: true }))) {
          if (this.cancelled) return null;
          return this.doWin(cur, tile, { tsumo: true, rinshan, haitei }, win);
        }
        if (this.cancelled) return null;
        const kans = this.availableKans(cur);
        if (kans.length) {
          const k = await this.agents[cur].wantKan(this.buildView(cur, { kans }), kans);
          if (this.cancelled) return null;
          if (k) {
            if (!kans.some((x) => x.kind === k.kind && x.tile === k.tile)) throw new Error('Illegal kan');
            const tileId = p.hand.find((id) => (id >> 2) === k.tile);
            const claim = await this.checkCalls(cur, tileId, k.kind);
            if (this.cancelled) return null;
            if (claim) return this.doWin(claim.seat, tileId, { tsumo: false, chankan: true, loser: cur });
            this.applyKan(cur, k); drawKind = 'rinshan'; continue;
          }
        }
      }
      this.onUpdate();
      const wasRiichi = p.riichi;
      const decision = await this.agents[cur].chooseDiscard(this.buildView(cur, { canRiichi: this.canRiichi(cur), haitei }));
      if (this.cancelled) return null;
      const tileId = wasRiichi ? p.drawnTile : decision.tileId;
      const riichi = !wasRiichi && decision.riichi && this.canRiichi(cur) && this.waits(cur, p.hand.filter((id) => id !== tileId)).length > 0;
      if (wasRiichi) p.ippatsu = false;
      this.discard(cur, tileId, riichi, decision.analysis);
      this.turnCount++; this.onUpdate();
      const claim = await this.checkCalls(cur, tileId);
      if (this.cancelled) return null;
      if (claim && claim.action.type === 'ron') return this.doWin(claim.seat, tileId, { tsumo: false, loser: cur, houtei: !rinshan && this.liveRemaining() === 0 });
      if (riichi) this.declareRiichi(cur); // A ron on the declaration tile prevents the deposit.
      const kanOwners = this.players.filter((x) => x.melds.some((m) => m.kind === 'kan'));
      if (this.rinshanIndex === 4 && kanOwners.length > 1) return this.doRyuukyoku('four-kans');
      if (this.players.every((x) => x.riichi)) return this.doRyuukyoku('four-riichi');
      if (!this.anyCall && this.players.every((x) => x.discardHistory.length === 1)) {
        const types = this.players.map((x) => x.discardHistory[0].tileId >> 2);
        if (types[0] >= 27 && types[0] <= 30 && types.every((t) => t === types[0])) return this.doRyuukyoku('four-winds');
      }
      if (claim) {
        this.applyCall(claim.seat, claim.action, cur, tileId);
        cur = claim.seat; drawKind = claim.action.type === 'kan' ? 'rinshan' : 'none';
      } else { cur = (cur + 1) % 4; drawKind = 'live'; }
    }
    return this.result;
  };
  MJ.Game = Game;
  MJ.sortHand = sortHand;
  MJ.match = {
    advance(state, result, scores) {
      const abort = result.type === 'draw' && result.reason !== 'exhaustive';
      const repeat = abort || (result.type === 'win' ? result.winner === state.dealer : result.tenpai.includes(state.dealer));
      const next = { ...state, honba: result.type === 'draw' || repeat ? state.honba + 1 : 0 };
      if (!repeat) { next.hand++; next.dealer = (state.dealer + 1) % 4; }
      next.ended = scores.some((s) => s < 0) || next.hand >= (state.mode === 'hanchan' ? 8 : 4);
      return next;
    }
  };
})();
