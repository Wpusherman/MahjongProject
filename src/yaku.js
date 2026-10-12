(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const Y = (MJ.yaku = {});

  const GREEN = new Set([19, 20, 21, 23, 25, 32]);

  function isDragon(t) { return t >= 31; }
  function isWind(t) { return t >= 27 && t <= 30; }

  function allTiles(ctx, dec) {
    const tiles = [];
    for (const s of dec.sets.concat(ctx.melds)) {
      if (s.kind === 'seq') tiles.push(s.type, s.type + 1, s.type + 2);
      else {
        tiles.push(s.type, s.type, s.type);
        if (s.kind === 'kan') tiles.push(s.type);
      }
    }
    tiles.push(dec.pair, dec.pair);
    return tiles;
  }

  function waitOptions(ctx, dec) {
    const w = ctx.winTile;
    const opts = [];
    for (const s of dec.sets) {
      if (s.kind === 'seq' && w >= s.type && w <= s.type + 2) {
        const pos = w - s.type;
        if (pos === 1) opts.push({ type: 'kanchan', fu: 2, set: s });
        else if (s.type % 9 === 0 && pos === 2) opts.push({ type: 'penchan', fu: 2, set: s });
        else if (s.type % 9 === 6 && pos === 0) opts.push({ type: 'penchan', fu: 2, set: s });
        else opts.push({ type: 'ryanmen', fu: 0, set: s });
      } else if (s.kind !== 'seq' && s.type === w) {
        opts.push({ type: 'shanpon', fu: 0, set: s });
      }
    }
    if (dec.pair === w) opts.push({ type: 'tanki', fu: 2 });
    return opts;
  }

  function countIdenticalSeq(sequences) {
    const map = {};
    for (const s of sequences) map[s.type] = (map[s.type] || 0) + 1;
    let pairs = 0;
    for (const k in map) pairs += Math.floor(map[k] / 2);
    return pairs;
  }

  function concealedTripletCount(ctx, triplets, dec) {
    let ct = triplets.filter((s) => !s.open).length;
    if (!ctx.tsumo) {
      if (ctx.wait && ctx.wait.type === 'shanpon') ct -= 1;
    }
    return ct;
  }

  function yakumanList(ctx, dec, allSets, tiles, triplets, kans) {
    const out = [];
    const menzen = !ctx.melds.some((m) => m.open);
    const pair = dec.pair;
    const ct = concealedTripletCount(ctx, triplets, dec);

    if (ctx.tenhou) out.push({ name: '天和', han: 13, yakuman: true });
    if (ctx.chiihou) out.push({ name: '地和', han: 13, yakuman: true });
    if (allSets.filter((s) => isDragon(s.type) && s.kind !== 'seq').length === 3) out.push({ name: '大三元', han: 13, yakuman: true });
    const windTriplets = allSets.filter((s) => isWind(s.type) && s.kind !== 'seq').length;
    if (windTriplets === 4) out.push({ name: '大四喜', han: 26, yakuman: true });
    else if (windTriplets === 3 && isWind(pair)) out.push({ name: '小四喜', han: 13, yakuman: true });
    if (tiles.every((t) => T.isHonor(t))) out.push({ name: '字一色', han: 13, yakuman: true });
    if (tiles.every((t) => T.isTerminal(t))) out.push({ name: '清老頭', han: 13, yakuman: true });
    if (tiles.every((t) => GREEN.has(t))) out.push({ name: '緑一色', han: 13, yakuman: true });
    if (kans.length === 4) out.push({ name: '四槓子', han: 13, yakuman: true });
    if (ct === 4) {
      if (!ctx.tsumo && pair === ctx.winTile) out.push({ name: '四暗刻単騎', han: 26, yakuman: true });
      else out.push({ name: '四暗刻', han: 13, yakuman: true });
    }
    if (menzen && isChuuren(ctx)) out.push({ name: '九蓮宝燈', han: 13, yakuman: true });

    return out;
  }

  function isChuuren(ctx) {
    if (ctx.melds.length > 0) return false;
    const suits = new Set();
    for (let t = 0; t < 34; t++) if (ctx.counts[t] > 0) suits.add(T.suitOf(t));
    if (suits.size !== 1) return false;
    const suit = [...suits][0];
    if (suit === 'z') return false;
    const start = suit === 'm' ? 0 : suit === 'p' ? 9 : 18;
    const c = [];
    for (let i = 0; i < 9; i++) c.push(ctx.counts[start + i]);
    if (c[0] < 3 || c[8] < 3) return false;
    for (let i = 1; i <= 7; i++) if (c[i] < 1) return false;
    let sum = 0;
    for (const v of c) sum += v;
    return sum === 14;
  }

  function evalChiitoi(ctx) {
    const list = [];
    const tiles = [];
    for (let t = 0; t < 34; t++) for (let k = 0; k < ctx.counts[t]; k++) tiles.push(t);
    const menzen = true;
    const special = [];
    if (ctx.tenhou) special.push({ name: '天和', han: 13, yakuman: true });
    if (ctx.chiihou) special.push({ name: '地和', han: 13, yakuman: true });
    if (tiles.every(T.isHonor)) special.push({ name: '字一色', han: 13, yakuman: true });
    if (special.length) return { list: special, han: special.length * 13, yakuman: true, chiitoi: true };

    if (ctx.doubleRiichi) list.push({ name: 'ダブル立直', han: 2 });
    else if (ctx.riichi) list.push({ name: '立直', han: 1 });
    if (ctx.ippatsu) list.push({ name: '一発', han: 1 });
    if (ctx.tsumo) list.push({ name: '門前清自摸和', han: 1 });
    if (ctx.haitei) list.push({ name: '海底撈月', han: 1 });
    if (ctx.houtei) list.push({ name: '河底撈魚', han: 1 });
    if (ctx.chankan) list.push({ name: '搶槓', han: 1 });

    list.push({ name: '七対子', han: 2 });
    if (tiles.every((t) => T.isSimple(t))) list.push({ name: '断幺九', han: 1 });
    if (tiles.every((t) => T.isYaochu(t))) list.push({ name: '混老頭', han: 2 });

    const suits = new Set();
    let hasHonor = false;
    for (const t of tiles) {
      if (T.isHonor(t)) hasHonor = true;
      else suits.add(T.suitOf(t));
    }
    if (suits.size === 1 && hasHonor) list.push({ name: '混一色', han: 3 });
    else if (suits.size === 1 && !hasHonor) list.push({ name: '清一色', han: 6 });

    let han = 0;
    for (const y of list) han += y.han;
    return { list, han, dec: null, chiitoi: true };
  }

  function evalStandard(ctx, dec) {
    const menzen = !ctx.melds.some((m) => m.open);
    const allSets = dec.sets.concat(ctx.melds);
    const tiles = allTiles(ctx, dec);
    const sequences = allSets.filter((s) => s.kind === 'seq');
    const triplets = allSets.filter((s) => s.kind !== 'seq');
    const kans = allSets.filter((s) => s.kind === 'kan');
    const pair = dec.pair;

    const yk = yakumanList(ctx, dec, allSets, tiles, triplets, kans);
    if (yk.length > 0) {
      let han = 0;
      for (const y of yk) han += y.han;
      return { list: yk, han, dec, yakuman: true };
    }

    const list = [];
    const opts = [ctx.wait];
    const ryanmen = opts.some((o) => o.type === 'ryanmen');
    const pairIsYakuhai = isDragon(pair) || pair === ctx.seatWind || pair === ctx.roundWind;

    if (ctx.doubleRiichi) list.push({ name: 'ダブル立直', han: 2 });
    else if (ctx.riichi) list.push({ name: '立直', han: 1 });
    if (ctx.ippatsu) list.push({ name: '一発', han: 1 });
    if (ctx.tsumo && menzen) list.push({ name: '門前清自摸和', han: 1 });
    if (ctx.rinshan) list.push({ name: '嶺上開花', han: 1 });
    if (ctx.chankan) list.push({ name: '搶槓', han: 1 });
    if (ctx.haitei) list.push({ name: '海底撈月', han: 1 });
    if (ctx.houtei) list.push({ name: '河底撈魚', han: 1 });

    const allSeq = triplets.length === 0;
    if (menzen && allSeq && !pairIsYakuhai && ryanmen) list.push({ name: '平和', han: 1 });

    if (tiles.every((t) => T.isSimple(t))) list.push({ name: '断幺九', han: 1 });

    const seqPairs = countIdenticalSeq(sequences);
    if (menzen && seqPairs >= 2) list.push({ name: '二盃口', han: 3 });
    else if (menzen && seqPairs === 1) list.push({ name: '一盃口', han: 1 });

    for (const s of triplets) {
      if (isDragon(s.type)) list.push({ name: `役牌 ${T.honorName(s.type)}`, han: 1 });
      else {
        if (s.type === ctx.roundWind) list.push({ name: '場風牌', han: 1 });
        if (s.type === ctx.seatWind) list.push({ name: '自風牌', han: 1 });
      }
    }

    for (let n = 0; n < 7; n++) {
      const has = (start) => sequences.some((s) => s.type === start + n);
      if (has(0) && has(9) && has(18)) { list.push({ name: '三色同順', han: menzen ? 2 : 1 }); break; }
    }
    for (const suitStart of [0, 9, 18]) {
      const has = (n) => sequences.some((s) => s.type === suitStart + n);
      if (has(0) && has(3) && has(6)) { list.push({ name: '一気通貫', han: menzen ? 2 : 1 }); break; }
    }
    for (let n = 0; n < 9; n++) {
      const has = (start) => triplets.some((s) => s.type === start + n);
      if (has(0) && has(9) && has(18)) { list.push({ name: '三色同刻', han: 2 }); break; }
    }

    const ct = concealedTripletCount(ctx, triplets, dec);
    if (ct >= 3) list.push({ name: '三暗刻', han: 2 });
    if (kans.length === 3) list.push({ name: '三槓子', han: 2 });

    const dragonTriplets = triplets.filter((s) => isDragon(s.type)).length;
    if (dragonTriplets === 2 && isDragon(pair)) list.push({ name: '小三元', han: 2 });

    const allTriplets = sequences.length === 0;
    if (allTriplets) list.push({ name: '対々和', han: 2 });

    if (tiles.every((t) => T.isYaochu(t))) list.push({ name: '混老頭', han: 2 });

    let chanta = true;
    for (const s of allSets) {
      if (s.kind === 'seq') { if (!(s.type % 9 === 0 || s.type % 9 === 6)) { chanta = false; break; } }
      else if (!T.isYaochu(s.type)) { chanta = false; break; }
    }
    if (chanta && !T.isYaochu(pair)) chanta = false;
    let hasHonor = false;
    for (const t of tiles) if (T.isHonor(t)) hasHonor = true;
    let junchan = chanta && !hasHonor;
    if (sequences.length && chanta && hasHonor) list.push({ name: '混全帯幺九', han: menzen ? 2 : 1 });
    else if (sequences.length && junchan) list.push({ name: '純全帯幺九', han: menzen ? 3 : 2 });

    const suits = new Set();
    let honor = false;
    for (const t of tiles) { if (T.isHonor(t)) honor = true; else suits.add(T.suitOf(t)); }
    if (suits.size === 1 && honor) list.push({ name: '混一色', han: menzen ? 3 : 2 });
    else if (suits.size === 1 && !honor) list.push({ name: '清一色', han: menzen ? 6 : 5 });

    let han = 0;
    for (const y of list) han += y.han;
    return { list, han, dec, ryanmen, opts, wait: ctx.wait };
  }

  Y.evaluate = function (ctx) {
    const meldCount = ctx.melds.length;
    if (MJ.agari.isKokushi(ctx.counts, meldCount)) {
      const list = [{ name: '国士無双', han: 13, yakuman: true }];
      if (ctx.tenhou) list.push({ name: '天和', han: 13, yakuman: true });
      if (ctx.chiihou) list.push({ name: '地和', han: 13, yakuman: true });
      return { list, han: list.length * 13, yakuman: true, kokushi: true, dec: null };
    }
    const needed = 4 - meldCount;
    const decomps = MJ.agari.decompose(ctx.counts).filter((d) => d.sets.length === needed);
    let best = MJ.agari.isChiitoi(ctx.counts, meldCount) ? evalChiitoi(ctx) : null;
    const value = (r) => r.list.length ? MJ.score.compute(ctx, r, r.yakuman ? 0 : MJ.score.countDora(ctx)).payments.total : 0;
    for (const d of decomps) {
      for (const wait of waitOptions(ctx, d)) {
        const r = evalStandard(Object.assign({}, ctx, { wait }), d);
        if (!best || value(r) > value(best) || (value(r) === value(best) && r.han > best.han)) best = r;
      }
    }
    return best;
  };
})();
