(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const SC = (MJ.score = {});

  function isDragon(t) { return t >= 31; }
  function isWind(t) { return t >= 27 && t <= 30; }

  function roundUp100(n) { return Math.ceil(n / 100) * 100; }

  SC.fu = function (ctx, ev) {
    if (ev.kokushi) return 0;
    if (ev.chiitoi) return 25;
    const menzen = !ctx.melds.some((m) => m.open);
    const isPinfu = ev.list.some((y) => y.name === '平和');
    let fu = 20;
    if (menzen && !ctx.tsumo) fu += 10;
    if (ctx.tsumo && !isPinfu) fu += 2;

    const sets = ev.dec.sets.concat(ctx.melds);
    for (const s of sets) {
      if (s.kind === 'seq') continue;
      const simple = T.isSimple(s.type);
      const openedByRon = !ctx.tsumo && ev.wait && ev.wait.set === s;
      if (s.kind === 'trip') fu += (s.open || openedByRon) ? (simple ? 2 : 4) : (simple ? 4 : 8);
      else fu += s.open ? (simple ? 8 : 16) : (simple ? 16 : 32);
    }

    const pair = ev.dec.pair;
    if (isDragon(pair)) fu += 2;
    if (isWind(pair)) {
      if (pair === ctx.seatWind) fu += 2;
      if (pair === ctx.roundWind) fu += 2;
    }

    let waitFu;
    if (isPinfu) waitFu = 0;
    else waitFu = ev.wait ? ev.wait.fu : Math.max(...ev.opts.map((o) => o.fu));
    fu += waitFu;

    if (fu === 20 && !ctx.tsumo) fu = 30;
    return Math.ceil(fu / 10) * 10;
  };

  SC.limitBase = function (han, base) {
    if (han >= 13) return 8000;
    if (han >= 11) return 6000;
    if (han >= 8) return 4000;
    if (han >= 6) return 3000;
    if (han >= 5) return 2000;
    if (han === 4 && base >= 2000) return 2000;
    if (han === 3 && base >= 2000) return 2000;
    return base;
  };

  SC.compute = function (ctx, ev, doraHan) {
    doraHan = doraHan || 0;
    const yakuman = !!ev.yakuman;
    const han = yakuman ? ev.han : ev.han + doraHan;
    const dealer = !!ctx.isDealer;

    let base;
    if (yakuman) {
      base = 8000 * Math.floor(ev.han / 13);
    } else {
      const fu = SC.fu(ctx, ev);
      base = SC.limitBase(han, fu * Math.pow(2, 2 + han));
      ctx = Object.assign({}, ctx, { _fu: fu });
    }

    const result = { han, yakuman, yaku: ev.list, dora: doraHan };

    if (ctx.tsumo) {
      if (dealer) {
        const each = roundUp100(base * 2);
        result.payments = { each, total: each * 3 };
      } else {
        const fromDealer = roundUp100(base * 2);
        const fromOthers = roundUp100(base);
        result.payments = { fromDealer, fromOthers, total: fromDealer + fromOthers * 2 };
      }
    } else {
      const total = roundUp100(dealer ? base * 6 : base * 4);
      result.payments = { ron: total, total };
    }

    result.fu = yakuman ? 0 : ctx._fu;
    result.base = base;
    return result;
  };

  SC.countDora = function (ctx) {
    let dora = 0;
    const allTypes = [];
    for (let t = 0; t < 34; t++) for (let k = 0; k < ctx.counts[t]; k++) allTypes.push(t);
    for (const m of ctx.melds) {
      if (m.kind === 'seq') allTypes.push(m.type, m.type + 1, m.type + 2);
      else {
        allTypes.push(m.type, m.type, m.type);
        if (m.kind === 'kan') allTypes.push(m.type);
      }
    }
    for (const ind of ctx.doraIndicators) {
      const d = T.doraFromIndicator(ind >> 2);
      dora += allTypes.filter((t) => t === d).length;
    }
    for (const ura of ctx.uraIndicators || []) {
      const d = T.doraFromIndicator(ura >> 2);
      dora += allTypes.filter((t) => t === d).length;
    }
    for (const id of ctx.redIds || []) if (T.isRed(id)) dora += 1;
    return dora;
  };
})();
