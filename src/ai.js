(function () {
  const MJ = globalThis.MJ, T = MJ.tiles, S = MJ.shanten;
  const AI = MJ.ai = { version: 'public-search-4' };
  // Tunable heuristic weights. The defaults reproduce the hand-tuned public-search-4 AI.
  // Coarse phase timers for tools/evaluate.js --profile. They are only enabled
  // explicitly; when disabled, timed() adds a single boolean branch.
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const PROFILE = { enabled: false, evaluations: 0, shanten: 0, ukeire: 0, shape: 0, scoring: 0, lookahead: 0, risk: 0 };
  AI.profile = {
    enable() { PROFILE.enabled = true; }, disable() { PROFILE.enabled = false; },
    reset() { for (const key of Object.keys(PROFILE)) if (typeof PROFILE[key] === 'number') PROFILE[key] = 0; },
    snapshot() { return { ...PROFILE }; }
  };
  const timed = (key, fn) => {
    if (!PROFILE.enabled) return fn();
    const start = now();
    try { return fn(); } finally { PROFILE[key] += now() - start; }
  };
  const W = AI.weights = {
    shantenCost: 125, ukeireGain: 1.25, shapeGain: 2.4, grossWeight: 0.035,
    spareFive: 0.38, spareLow: 0.8, headBonus: 3.0, secondPairBonus: 1.4, pairYakuhai: 0.35,
    growthHonor: 0.14, growthHonorPair: 0.16, growthNumber: 0.24,
    growthNeighbor: 0.8, growthKabe: 0.36, growthEdge: 0.43,
    survivalBase: 0.027, survivalThreat: 0.075,
    dangerScale: 1.0, dangerPoints: 1.0,
    pushMargin: 100, callDefense: 180, callDeltaRatio: 0.025, callDeltaMin: 20,
    rankScale: 10, rankEfficiency: 0.5, rankReserve: 1, rankRiichiMargin: 0.05, rankCallMargin: 0.5,
    rankOrder: 0, rankRiichiEnabled: 0, rankCallEnabled: 0,
  };
  AI.setWeights = function (next) {
    if (next) for (const key of Object.keys(W)) if (Number.isFinite(next[key])) W[key] = next[key];
    return { ...W };
  };
  const sum = (xs) => xs.reduce((a, b) => a + b, 0);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const round = (n) => Math.round(n * 100) / 100;
  const yakuhai = (t, v) => Number(t >= 31) + Number(t === v.seatWind) + Number(t === v.roundWind);
  const dora = (t, v) => (v.doraIndicators || []).filter((id) => T.doraFromIndicator(id >> 2) === t).length;
  function pickId(hand, t, drawn) {
    if (drawn != null && (drawn >> 2) === t && !T.isRed(drawn)) return drawn;
    return hand.filter((id) => (id >> 2) === t).sort((a, b) => Number(T.isRed(a)) - Number(T.isRed(b)) || a - b)[0];
  }
  function normalized(view) {
    const counts = T.countsFromIds(view.hand);
    return { opponents: [], ownDiscardTypes: [], doraIndicators: [], turnCount: 0, liveRemaining: 60,
      score: 25000, unseen: counts.map((n) => 4 - n), ...view };
  }
  const HIDDEN_VIEW_KEYS = ['wall', 'liveWall', 'deadWall', 'uraIndicators', 'game', 'players'];
  // The AI may only consume a public observation. These keys belong to the raw game state.
  AI.assertObservation = function (view) {
    if (!view || typeof view !== 'object') throw new Error('AI requires an observation');
    for (const key of HIDDEN_VIEW_KEYS) if (key in view) throw new Error('AI observation leaked hidden state: ' + key);
    for (const o of view.opponents || []) if ('hand' in o) throw new Error('AI observation leaked an opponent hand');
    return view;
  };
  // Rank-point pressure: leaders value a point lost more than a point gained,
  // trailers need to push. Without standings information this is neutral.
  function rankBias(view, enabled = true, model) {
    if (!enabled || !MJ.rank || !Array.isArray(view.scores) || view.scores.length !== 4 || view.handsLeft == null) return 1;
    try { return MJ.rank.riskBias(view.scores, view.seat, view.rankConfig, { handsLeft: view.handsLeft,
      honba: view.honba, riichiSticks: view.riichiSticks, handIndex: view.handIndex, dealer: view.dealer,
      model }); }
    catch (_) { return 1; }
  }

  // Rank-point EV is a nonlinear function of the score swing, so a single
  // risk multiplier cannot express "a leader protects a lead" and "a trailer
  // must push" at the same time. These helpers price the three hand outcomes
  // (win / deal-in / draw) with the heuristic or a loaded GRP model. When no
  // standings are available they return null and the legacy raw-point path is
  // used unchanged.
  function rankContext(view, model) {
    if (!MJ.rank || !view || !Array.isArray(view.scores) || view.scores.length !== 4 || view.handsLeft == null) return null;
    const handsLeft = Math.max(1, Number(view.handsLeft) || 1);
    const base = { handsLeft, honba: view.honba || 0, riichiSticks: view.riichiSticks || 0,
      handIndex: view.handIndex, dealer: view.dealer, model };
    try {
      return { view, rankConfig: view.rankConfig, seat: view.seat,
        rest: Math.max(1, handsLeft - 1), base,
        current: MJ.rank.expectedPoints(view.scores, view.seat, 0, view.rankConfig, base).points };
    } catch (_) { return null; }
  }
  function rankAt(ctx, scores, delta, sticks) {
    if (!ctx) return null;
    const after = scores.slice();
    after[ctx.seat] += Number(delta) || 0;
    // In the final hand the deal result is the game result: no later hand can
    // repair a deal-in. Use the deterministic placement instead of pretending
    // one more hand remains.
    if (ctx.base.handsLeft <= 1) {
      try { return MJ.rank.finalResult(after, ctx.rankConfig).points[ctx.seat]; }
      catch (_) { return null; }
    }
    const opts = { ...ctx.base, handsLeft: ctx.rest, riichiSticks: sticks };
    return MJ.rank.expectedPoints(after, ctx.seat, 0, ctx.rankConfig, opts).points;
  }
  // The winning hand ends the deal, so the win/loss/draw outcomes all use one
  // fewer remaining hand; the current value keeps the full horizon. If we win
  // we also collect the deposit sticks, otherwise they stay on the table.
  function rankExpectation(ctx, pWin, winPoints, pLoss, lossPoints) {
    if (!ctx) return null;
    const pW = clamp(Number(pWin) || 0, 0, 1);
    const pL = clamp(Number(pLoss) || 0, 0, 1 - pW);
    const sticks = ctx.view.riichiSticks || 0;
    const win = rankAt(ctx, ctx.view.scores, Math.max(0, winPoints) + sticks * 1000, 0);
    const loss = rankAt(ctx, ctx.view.scores, -Math.max(0, lossPoints), sticks);
    const draw = rankAt(ctx, ctx.view.scores, 0, sticks);
    const expected = pW * win + pL * loss + (1 - pW - pL) * draw;
    return { current: ctx.current, win, loss, draw, expected, gain: round(expected - ctx.current),
      pWin: round(pW), pLoss: round(pL) };
  }
  AI.rankExpectation = rankExpectation;

  // Public-information danger model. These are heuristic probabilities, not calibrated frequencies.
  AI.risk = function (t, view, w = AI.weights) {
    let survive = 1, loss = 0;
    const detail = [];
    for (const o of view.opponents || []) {
      const open = o.melds?.filter((m) => m.open).length || 0;
      if (!o.riichi && open < 2) continue;
      const types = o.discardTypes || [];
      const safe = types.includes(t) || (o.safeTypes || []).includes(t);
      const left = view.unseen[t];
      let p = 0;
      if (!safe) {
        if (t >= 27) {
          // One unseen honor can still be a tanki. Even zero unseen does not rule out kokushi.
          p = left <= 0 ? 0.0005 : left === 1 ? 0.012 : left === 2 ? 0.035 : 0.065;
        } else {
          const base = Math.floor(t / 9) * 9, n = t % 9;
          p = 0.012 + (left >= 2 ? 0.016 : 0.003); // tanki / kanchan / shanpon floor
          // Enumerate both ryanmen lines separately: half-suji never erases the other line.
          for (const side of [-1, 1]) {
            const other = n + side * 3;
            if (other < 0 || other > 8 || types.includes(base + other) || (o.safeTypes || []).includes(base + other)) continue;
            const a = t + side, b = t + side * 2;
            const bottleneck = Math.min(view.unseen[a], view.unseen[b]);
            p += 0.043 * (bottleneck === 0 ? 0.02 : bottleneck === 1 ? 0.38 : 1);
          }
          if (n === 0 || n === 8) p *= 0.83;
          if (left === 0) p *= 0.55;
        }
        p *= 1 + Math.min(2, dora(t, view)) * 0.15;
        if (!o.riichi) p *= [0, 0, 0.4, 0.7, 0.95][Math.min(4, open)];
      }
      p = clamp(p, 0, 0.35);
      const points = (o.isDealer ? 7800 : 5200) * (1 + open * 0.07);
      survive *= 1 - p; loss += p * points;
      detail.push({ seat: o.seat, probability: round(p * 100), genbutsu: safe });
    }
    return { probability: clamp((1 - survive) * w.dangerScale, 0, 1), loss: loss * w.dangerPoints, detail };
  };

  // Non-overlapping block decompositions. Keep alternatives with 5 and 6 blocks;
  // count the sixth only as flexibility, never as a fifth usable meld.
  function blockShape(counts, view, unseen, w = AI.weights) {
    const c = counts.slice(), groups = [], singles = [], meldCount = view.melds.length;
    let best = null, five = null, six = null;
    // Static tables for this call: growth and pair values depend only on the
    // public unseen counts, not on the decomposition, so compute them once.
    const growthValue = new Array(34), pairValue = new Array(34);
    const yakuhaiValue = new Array(34);
    for (let t = 0; t < 34; t++) yakuhaiValue[t] = yakuhai(t, view);
    for (let t = 0; t < 34; t++) {
      pairValue[t] = unseen[t] * (1.0 + yakuhaiValue[t] * w.pairYakuhai);
      if (t >= 27) {
        growthValue[t] = unseen[t] * w.growthHonor + yakuhaiValue[t] * unseen[t] * Math.max(0, unseen[t] - 1) * w.growthHonorPair +
          (t === view.seatWind ? 0.1 : 0);
        continue;
      }
      let value = unseen[t] * w.growthNumber;
      const n = t % 9, base = t - n;
      for (const delta of [-2, -1, 1, 2]) {
        const x = n + delta;
        if (x < 0 || x > 8) continue;
        const low = Math.min(n, x);
        value += unseen[base + x] * (Math.abs(delta) === 2 ? w.growthKabe : low >= 1 && low <= 6 ? w.growthNeighbor : w.growthEdge);
      }
      growthValue[t] = value;
    }
    const values = [], spares = [];
    const insertDesc = (list, value) => {
      let i = list.length;
      while (i > 0 && list[i - 1] < value) { list[i] = list[i - 1]; i--; }
      list[i] = value;
    };
    function finish(sets) {
      // Reuse the two small arrays: most leaves only need a scalar comparison,
      // so plan records are allocated only when they become the current best.
      let head = false, pairs = 0, incomplete = 0, ryanmen = 0, weak = 0, slots = 0, quality = 0;
      values.length = 0;
      for (const g of groups) {
        if (g.kind === 'set') continue;
        incomplete++;
        if (g.kind === 'pair') { head = true; pairs++; }
        else if (g.kind === 'ryanmen') ryanmen++;
        else weak++;
        insertDesc(values, g.value);
      }
      const sh = 8 - 2 * (sets + meldCount) - Math.min(4 - sets - meldCount, incomplete - Number(head)) - Number(head);
      const blocks = groups.length + meldCount;
      slots = 5 - sets - meldCount;
      for (let i = 0; i < values.length; i++) quality += values[i] * (i < slots ? 1 : 0.12);
      spares.length = 0;
      for (const t of singles) insertDesc(spares, growthValue[t]);
      // Spare central tiles can replace bad taatsu even at five blocks.
      const spareWeight = blocks < 5 ? w.spareLow : w.spareFive;
      for (let i = 0; i < spares.length; i++) quality += spares[i] * spareWeight / (i + 1);
      if (head) quality += w.headBonus;
      if (pairs === 2) quality += w.secondPairBonus; // alternative heads / triplet completion
      const value = -sh * 100 + quality;
      if (blocks === 5 && (!five || value > five.value)) {
        five = { blocks, head, pairs, ryanmen, weak, quality, sh, value };
      }
      if (blocks === 6 && (!six || value > six.value)) {
        six = { blocks, head, pairs, ryanmen, weak, quality, sh, value };
      }
      if (!best || value > best.value) {
        best = { blocks, head, pairs, ryanmen, weak, quality, sh, value };
      }
    }
    // Reuse group objects by depth; no per-branch arrays or objects.
    const pool = [];
    function pushGroup(depth, kind, t, value) {
      const g = pool[depth] || (pool[depth] = {});
      g.kind = kind; g.t = t; g.value = value;
      groups.push(g);
      return g;
    }
    function walk(start, sets) {
      while (start < 34 && !c[start]) start++;
      if (start === 34) { finish(sets); return; }
      if (groups.length + meldCount > 6 || sets + meldCount > 4) return;
      const t = start, n = t % 9, depth = groups.length;
      if (c[t] >= 3) {
        c[t] -= 3; pushGroup(depth, 'set', t, 0); walk(t, sets + 1); groups.pop(); c[t] += 3;
      }
      if (t < 27 && n <= 6 && c[t + 1] && c[t + 2]) {
        c[t]--; c[t + 1]--; c[t + 2]--; pushGroup(depth, 'set', t, 0); walk(t, sets + 1);
        groups.pop(); c[t]++; c[t + 1]++; c[t + 2]++;
      }
      if (c[t] >= 2) {
        c[t] -= 2; pushGroup(depth, 'pair', t, pairValue[t]); walk(t, sets); groups.pop(); c[t] += 2;
      }
      if (t < 27 && n <= 7 && c[t + 1]) {
        const value = (unseen[t] + unseen[t + 1]) * (n > 0 && n < 7 ? 1 : 0.68);
        c[t]--; c[t + 1]--; pushGroup(depth, n > 0 && n < 7 ? 'ryanmen' : 'penchan', t, value);
        walk(t, sets); groups.pop(); c[t]++; c[t + 1]++;
      }
      if (t < 27 && n <= 6 && c[t + 2]) {
        const value = (unseen[t] + unseen[t + 2]) * 0.82;
        c[t]--; c[t + 2]--; pushGroup(depth, 'kanchan', t, value); walk(t, sets); groups.pop(); c[t]++; c[t + 2]++;
      }
      c[t]--; singles.push(t); walk(t, sets); singles.pop(); c[t]++;
    }
    walk(0, 0);
    return { ...best, five: five && round(five.quality), six: six && round(six.quality) };
  }
  AI.blockShape = blockShape;

  // Seven pairs and thirteen orphans are scored as their own plans, so the shape,
  // acceptance and point estimate always match the route that fixes the shanten.
  function chiitoiShape(counts, unseen) {
    let pairs = 0, kinds = 0, growth = 0;
    for (let t = 0; t < 34; t++) {
      if (!counts[t]) continue;
      kinds++;
      if (counts[t] >= 2) pairs++; else growth += Math.min(unseen[t], 3);
    }
    return { blocks: pairs, head: pairs > 0, pairs, ryanmen: 0, weak: 0,
      quality: pairs * 4 + growth * 0.55, sh: 6 - pairs + Math.max(0, 7 - kinds), five: null, six: null };
  }
  function kokushiShape(counts, unseen) {
    let kinds = 0, pair = 0, growth = 0;
    for (const t of T.YAOCHU_TYPES) {
      if (counts[t]) kinds++;
      if (counts[t] >= 2) pair = 1;
      if (counts[t] === 1) growth += Math.min(unseen[t], 3);
    }
    return { blocks: 0, head: !!pair, pairs: pair, ryanmen: 0, weak: 0,
      quality: growth * 0.6, sh: 13 - kinds - pair, five: null, six: null };
  }
  function closedPoints(han, fu, view) {
    const pointsAt = (h) => Math.min(8000, MJ.score.limitBase(h, fu * 2 ** (2 + h)) * 4) * (view.isDealer ? 1.5 : 1);
    return pointsAt(Math.floor(han)) * (1 - han % 1) + pointsAt(Math.ceil(han)) * (han % 1);
  }
  function chiitoiValue(counts, view, reds) {
    let han = 2, simple = true, yaochu = true, honor = false;
    const suits = new Set();
    for (let t = 0; t < 34; t++) if (counts[t]) {
      if (!T.isSimple(t)) simple = false;
      if (!T.isYaochu(t)) yaochu = false;
      if (T.isHonor(t)) honor = true; else suits.add(T.suitOf(t));
    }
    if (simple) han += 1;
    if (yaochu) han += 2;
    if (suits.size === 1) han += honor ? 3 : 6;
    for (let t = 0; t < 34; t++) han += counts[t] * dora(t, view);
    han += reds;
    return { points: Math.max(1000, closedPoints(han, 25, view)), yakuChance: 1, closed: true };
  }
  function kokushiValue(view) {
    return { points: view.isDealer ? 48000 : 32000, yakuChance: 1, closed: true };
  }
  function routeShanten(counts, melds, route) {
    if (route === 'chiitoi') return S.chiitoi(counts);
    if (route === 'kokushi') return S.kokushi(counts);
    return S.standard(counts, melds);
  }
  function bestRoute(counts, melds) {
    const std = S.standard(counts, melds);
    let route = 'standard', sh = std;
    if (melds === 0) {
      const chi = S.chiitoi(counts), kok = S.kokushi(counts);
      if (chi < sh) { route = 'chiitoi'; sh = chi; }
      if (kok < sh) { route = 'kokushi'; sh = kok; }
    }
    return { route, sh };
  }
  // Improving tile TYPES depend on the 13-tile hand and route, not on the
  // current unseen counts, so the expensive part is cached per hand. For the
  // standard route only draws within two ranks of a held tile (or pairing a held
  // tile) can help; isolated tiles cannot change a decomposition.
  const ukeireCache = new Map();
  function improvingTiles(counts, melds, route) {
    const key = route + ':' + melds + ':' + counts.join('');
    const hit = ukeireCache.get(key);
    if (hit) return hit;
    const base = routeShanten(counts, melds, route), tiles = [];
    if (route === 'chiitoi') {
      let kinds = 0;
      for (let t = 0; t < 34; t++) if (counts[t]) kinds++;
      for (let t = 0; t < 34; t++) if (counts[t] < 4 && (counts[t] === 1 || (counts[t] === 0 && kinds < 7))) tiles.push(t);
    } else if (route === 'kokushi') {
      let kinds = 0, pair = 0;
      for (const t of T.YAOCHU_TYPES) { if (counts[t]) kinds++; if (counts[t] >= 2) pair = 1; }
      for (const t of T.YAOCHU_TYPES) {
        if (counts[t] >= 4) continue;
        if ((counts[t] === 0 && kinds < 13) || (counts[t] === 1 && !pair)) tiles.push(t);
      }
    } else {
      // Reuse the three unchanged suit groups: a draw changes exactly one suit,
      // so only that group is rebuilt before the small combination step.
      const baseGroups = S.standardGroups(counts);
      const tryTile = (t) => {
        counts[t]++;
        const suit = Math.min(3, Math.floor(t / 9));
        const groups = baseGroups.slice();
        groups[suit] = S.groupForSuit(counts, suit);
        const s = S.combineGroups(groups, melds);
        counts[t]--;
        if (s < base) tiles.push(t);
      };
      for (let t = 0; t < 34; t++) {
        if (counts[t] >= 4) continue;
        let useful = counts[t] > 0;
        if (!useful && t < 27) {
          const n = t % 9, from = t - n;
          for (const d of [-2, -1, 1, 2]) {
            const x = n + d;
            if (x >= 0 && x <= 8 && counts[from + x] > 0) { useful = true; break; }
          }
        }
        if (useful) tryTile(t);
      }
    }
    if (ukeireCache.size >= 50000) ukeireCache.delete(ukeireCache.keys().next().value);
    ukeireCache.set(key, tiles);
    return tiles;
  }
  function routeUkeire(counts, melds, unseen, route) {
    const all = improvingTiles(counts, melds, route), tiles = [];
    let total = 0;
    for (const t of all) if (unseen[t] > 0) { tiles.push(t); total += unseen[t]; }
    return { tiles, count: total, base: routeShanten(counts, melds, route) };
  }
  AI.bestRoute = bestRoute;
  // Exposed for the ukeire regression test; not part of the policy interface.
  AI.improvingTiles = improvingTiles;

  function handValue(counts, view, redCount) {
    const all = counts.slice();
    for (const m of view.melds) {
      if (m.kind === 'seq') for (let i = 0; i < 3; i++) all[m.type + i]++;
      else all[m.type] += m.kind === 'kan' ? 4 : 3;
    }
    const closed = !view.melds.some((m) => m.open);
    let han = closed ? 1.7 : 0, assured = 0, potential = 0;
    for (let t = 27; t < 34; t++) {
      const y = yakuhai(t, view);
      if (all[t] >= 3) { han += y; assured += y; }
      else if (all[t] === 2 && view.unseen[t] > 0) potential = Math.max(potential, 0.65 * y);
    }
    if (all.every((n, t) => !n || T.isSimple(t))) { han++; assured++; }
    const suitCounts = [sum(all.slice(0, 9)), sum(all.slice(9, 18)), sum(all.slice(18, 27))];
    if (suitCounts.filter(Boolean).length === 1) { const h = sum(all.slice(27)) ? (closed ? 3 : 2) : (closed ? 6 : 5); han += h; assured += h; }
    if (!closed && !assured) han += potential;
    han += redCount;
    for (let t = 0; t < 34; t++) han += all[t] * dora(t, view);
    const pointsAt = (h) => Math.min(8000, MJ.score.limitBase(h, 30 * 2 ** (2 + h)) * 4) * (view.isDealer ? 1.5 : 1);
    const points = pointsAt(Math.floor(han)) * (1 - han % 1) + pointsAt(Math.ceil(han)) * (han % 1);
    return { points: Math.max(1000, points), yakuChance: closed || assured ? 1 : potential ? 0.45 : 0.08, closed };
  }
  function winValue(counts, t, view, reds, riichi) {
    const ctx = { counts, melds: view.melds, winTile: t, tsumo: true, riichi,
      seatWind: view.seatWind, roundWind: view.roundWind, isDealer: view.isDealer,
      doraIndicators: view.doraIndicators, uraIndicators: [], redIds: [] };
    const ev = MJ.yaku.evaluate(ctx);
    if (!ev || !ev.list.length) return 0;
    return MJ.score.compute(ctx, ev, ev.yakuman ? 0 : MJ.score.countDora(ctx) + reds).payments.total;
  }
  // Finite-horizon absorbing chain. Exact current ukeire; later transition rates are
  // approximations refined by explicit all-tile lookahead. No hidden wall is consulted.
  function probability(sh, ukeire, future, pool, turns) {
    const stages = Math.max(0, sh) + 1, mass = Array(stages + 1).fill(0); mass[0] = 1;
    let tenpai = sh === 0 ? 1 : 0;
    for (let n = 0; n < turns; n++) {
      const next = mass.slice();
      for (let j = 0; j < stages; j++) {
        const distance = stages - j - 1;
        const outs = j === 0 ? ukeire : j === 1 && future != null ? future : distance === 0 ? 5.5 : Math.min(32, 11 + distance * 6);
        const p = clamp(outs / Math.max(1, pool - n), 0, 1);
        const moved = mass[j] * p; next[j] -= moved; next[j + 1] += moved;
      }
      for (let j = 0; j <= stages; j++) mass[j] = next[j];
      tenpai = Math.max(tenpai, mass[stages - 1] + mass[stages]);
    }
    return { winProbability: mass[stages], tenpaiProbability: tenpai };
  }
  // Shapes depend on the public unseen counts, not on hidden tiles. A small LRU
  // shared by every evaluator avoids recomputing the same decomposition when the
  // same hand shape recurs (e.g. after a called tile or in the next seat's turn).
  const shapeCache = new Map();
  const SHAPE_CACHE_MAX = 60000;
  function cachedShape(key, make) {
    const hit = shapeCache.get(key);
    if (hit !== undefined) { shapeCache.delete(key); shapeCache.set(key, hit); return hit; }
    const value = make();
    if (shapeCache.size >= SHAPE_CACHE_MAX) shapeCache.delete(shapeCache.keys().next().value);
    shapeCache.set(key, value);
    return value;
  }
  function evaluator(view, w = AI.weights) {
    const cache = new Map();
    return function evaluate(counts, unseen, turns, reds, discarded = [], future, pre) {
      PROFILE.evaluations += PROFILE.enabled ? 1 : 0;
      const key = counts.join('') + '/' + unseen.join('') + '/' + turns + '/' + reds + '/' + discarded.join(',') + '/' + future;
      if (cache.has(key)) return cache.get(key);
      const { route, sh } = pre || timed('shanten', () => bestRoute(counts, view.melds.length));
      const uk = pre && pre.ukeire ? pre.ukeire : timed('ukeire', () => routeUkeire(counts, view.melds.length, unseen, route));
      const shapeKey = route + ':' + counts.join('') + '/' + unseen.join('') + '/' + view.melds.length + '/' + view.seatWind;
      const shape = cachedShape(shapeKey, () => {
        if (sh === 0) return { quality: 0, blocks: 5, head: counts.some((n) => n === 2), ryanmen: 0, five: 0, six: null };
        if (route === 'chiitoi') return chiitoiShape(counts, unseen);
        if (route === 'kokushi') return kokushiShape(counts, unseen);
        return timed('shape', () => blockShape(counts, view, unseen, w));
      });
      const hv = timed('scoring', () => route === 'chiitoi' ? chiitoiValue(counts, view, reds)
        : route === 'kokushi' ? kokushiValue(view)
        : handValue(counts, { ...view, unseen }, reds));
      let outs = uk.count, points = hv.points, yakuChance = hv.yakuChance;
      const furiten = sh === 0 && uk.tiles.some((t) => view.ownDiscardTypes.includes(t) || discarded.includes(t));
      if (sh === 0) {
        let gain = 0; outs = 0;
        for (const t of uk.tiles) {
          counts[t]++;
          const value = timed('scoring', () => winValue(counts, t, view, reds, hv.closed && view.score >= 1000 && view.liveRemaining >= 4));
          counts[t]--;
          if (value) { outs += unseen[t]; gain += value * unseen[t]; }
        }
        points = outs ? gain / outs : 0; yakuChance = 1;
      }
      const probs = probability(sh, outs, future, sum(unseen), turns);
      // Ron and opponents ending the hand are approximated, clearly identified in the record.
      const survival = Math.exp(-(view.threat ? w.survivalThreat : w.survivalBase) * Math.max(1, sh + 1) * turns / 2);
      const ronFactor = sh === 0 && outs ? uk.tiles.reduce((n, t) => n + unseen[t] * (T.isYaochu(t) ? 0.6 : T.numOf(t) === 2 || T.numOf(t) === 8 ? 0.4 : 0.25), 0) / outs : 0.35;
      const gross = probs.winProbability * points * yakuChance * survival * (furiten ? 1 : 1 + ronFactor);
      const efficiency = -sh * w.shantenCost + uk.count * w.ukeireGain + shape.quality * w.shapeGain;
      const value = { sh, ukeire: uk.count, waits: uk.tiles, shape: round(shape.quality), blocks: shape.blocks, route,
        blockPlans: { five: shape.five, six: shape.six, head: shape.head, ryanmen: shape.ryanmen, pairs: shape.pairs },
        ...probs, estimatedWinPoints: round(points), grossEV: gross, yakuChance, furiten,
        score: efficiency + gross * w.grossWeight };
      cache.set(key, value); return value;
    };
  }
  function horizon(view) { return Math.max(0, Math.ceil(view.liveRemaining / 4)); }
  function redCount(view) { return view.hand.concat(view.melds.flatMap((m) => m.tiles || [])).filter(T.isRed).length; }
  function postDrawChoices(counts, unseen, view, evaluate, turns, reds, forbidden = []) {
    const choices = [];
    let min = 99;
    for (let t = 0; t < 34; t++) if (counts[t] && !forbidden.includes(t)) {
      counts[t]--; const sh = bestRoute(counts, view.melds.length).sh; counts[t]++;
      choices.push({ t, sh }); min = Math.min(min, sh);
    }
    let best = null;
    // Shape-changing discards are allowed if they preserve shanten; root also allows shanten-back.
    for (const c of choices) if (c.sh === min) {
      counts[c.t]--;
      const ev = evaluate(counts, unseen, turns, reds, [c.t]);
      counts[c.t]++;
      if (!best || ev.score > best.score) best = { ...ev, t: c.t };
    }
    return best;
  }
  function lookahead(counts, view, evaluate, turns, reds, w = AI.weights) {
    const unseen = view.unseen.slice(), pool = sum(unseen);
    let score = 0, gross = 0, tenpai = 0, win = 0, future = 0, improvedWeight = 0, improvedUkeire = 0;
    const baseSh = bestRoute(counts, view.melds.length).sh;
    // Includes non-shanten-improving draws: replacement taatsu, spare central tiles, extra heads.
    for (let t = 0; t < 34; t++) {
      if (!unseen[t] || counts[t] >= 4) continue;
      const weight = unseen[t] / pool;
      counts[t]++; unseen[t]--;
      if (MJ.agari.isAgari(counts, view.melds.length)) {
        const value = winValue(counts, t, view, reds, view.menzen && view.score >= 1000);
        if (value) { score += weight * (w.shantenCost + value * w.grossWeight); gross += weight * value; tenpai += weight; win += weight; counts[t]--; unseen[t]++; continue; }
      }
      const best = postDrawChoices(counts, unseen, view, evaluate, Math.max(0, turns - 1), reds);
      counts[t]--; unseen[t]++;
      if (!best) continue;
      score += weight * best.score; gross += weight * best.grossEV;
      tenpai += weight * best.tenpaiProbability; win += weight * best.winProbability; future += weight * best.ukeire;
      if (best.sh < baseSh) { improvedWeight += weight; improvedUkeire += weight * best.ukeire; }
    }
    return { nextScore: score, expectedGross: gross, futureUkeire: future, improvedUkeire: improvedWeight ? improvedUkeire / improvedWeight : 0,
      winProbability: win, tenpaiProbability: tenpai };
  }
  // An approximation for discard candidates that are not worth a full shape
  // decomposition. It keeps the shanten/ukeire/efficiency term but drops the
  // block-shape bonus and the gross EV. Used only by the evaluation-only fast
  // profile; the highest-ranked root candidates are still fully evaluated.
  function cheapValue(pre, unseen, turns, w) {
    const sh = pre.sh, uk = pre.ukeire;
    const probs = probability(sh, uk.count, null, sum(unseen), turns);
    return { sh, ukeire: uk.count, waits: uk.tiles, shape: 0, blocks: 0, route: pre.route,
      blockPlans: { five: null, six: null, head: false, ryanmen: 0, pairs: 0 }, ...probs,
      estimatedWinPoints: 0, grossEV: 0, yakuChance: sh === 0 ? 1 : 0.3, furiten: false,
      score: -sh * w.shantenCost + uk.count * w.ukeireGain, approximated: true };
  }
  // Cheap upper bound on acceptance used to rank root candidates before the
  // exact 34-tile ukeire. It only needs one pass over the counts, not 34 shanten
  // evaluations. A draw helps if it pairs a held tile or sits within two ranks
  // of one; for chiitoi/kokushi the route-specific tiles are used instead.
  function approxAcceptance(counts, unseen, route) {
    let total = 0;
    if (route === 'kokushi') {
      for (const t of T.YAOCHU_TYPES) if (unseen[t] > 0 && counts[t] < 4) total += unseen[t];
      return total;
    }
    if (route === 'chiitoi') {
      let kinds = 0;
      for (let t = 0; t < 34; t++) if (counts[t]) kinds++;
      for (let t = 0; t < 34; t++) if (unseen[t] > 0 && counts[t] < 4 && (counts[t] === 1 || kinds < 7)) total += unseen[t];
      return total;
    }
    for (let t = 0; t < 34; t++) {
      if (unseen[t] <= 0 || counts[t] >= 4) continue;
      let useful = counts[t] > 0;
      if (!useful && t < 27) {
        const n = t % 9, base = t - n;
        for (const d of [-2, -1, 1, 2]) {
          const x = n + d;
          if (x >= 0 && x <= 8 && counts[base + x] > 0) { useful = true; break; }
        }
      }
      if (useful) total += unseen[t];
    }
    return total;
  }
  AI.analyzeDiscard = function (rawView, level = 'strong', w = AI.weights, options = {}) {
    AI.assertObservation(rawView);
    const view = normalized(rawView), counts = T.countsFromIds(view.hand), evaluate = evaluator(view, w);
    const turns = horizon(view), reds = redCount(view), bias = rankBias(view, options.rankBias !== false, options.rankModel), candidates = [];
    // Rank EV replaces the raw-score comparison whenever standings are known.
    // `rankBias: false` stays the legacy raw-point baseline for paired tests.
    const rctx = options.rankBias !== false ? rankContext(view, options.rankModel) : null;
    const honbaBonus = (view.honba || 0) * 300;
    const types = [...new Set((view.legalDiscards || view.hand).filter((id) => !(view.forbidden || []).includes(id >> 2)).map((id) => id >> 2))];
    // Fast profile: compute the cheap shanten/ukeire for every discard, then run
    // the full block-shape evaluation only for the best root candidates.
    const fast = options.fast === true || level === 'fast';
    // Twelve roots keeps ~99% top-1 agreement with the full standard search on
    // random views; lower it with --root-candidates for a coarser, faster pass.
    const rootLimit = Math.max(1, options.rootCandidates || (fast ? 12 : 4));
    const cheap = new Map();
    if (fast) {
      for (const t of types) {
        counts[t]--;
        const sh = timed('shanten', () => bestRoute(counts, view.melds.length));
        cheap.set(t, { route: sh.route, sh: sh.sh, approx: approxAcceptance(counts, view.unseen, sh.route) });
        counts[t]++;
      }
    }
    const full = fast
      ? new Set([...cheap.entries()].sort((a, b) => a[1].sh - b[1].sh || b[1].approx - a[1].approx)
        .slice(0, rootLimit).map(([t]) => t))
      : null;
    for (const t of types) {
      const tileId = pickId(view.hand, t, view.drawnTile);
      counts[t]--;
      let ev;
      if (fast) {
        const pre = cheap.get(t);
        if (full.has(t)) {
          const ukeire = timed('ukeire', () => routeUkeire(counts, view.melds.length, view.unseen, pre.route));
          ev = evaluate(counts, view.unseen, turns, reds - Number(T.isRed(tileId)), [t], undefined, { ...pre, ukeire });
        } else {
          ev = cheapValue({ route: pre.route, sh: pre.sh, ukeire: { tiles: [], count: pre.approx } }, view.unseen, turns, w);
        }
      } else ev = evaluate(counts, view.unseen, turns, reds - Number(T.isRed(tileId)), [t]);
      counts[t]++;
      const risk = timed('risk', () => AI.risk(t, view, w));
      const copies = counts[t];
      // Folding with duplicate safer tiles reserves safe exits for later turns.
      const reserve = risk.probability < 0.09 ? Math.max(0, copies - 1) * (1 - risk.probability * 8) * 65 : 0;
      const futureLoss = view.threat ? risk.loss * Math.min(3, 0.65 + ev.sh * 0.65) : 0;
      const loss = risk.loss + futureLoss;
      const expectedNet = ev.grossEV - loss * bias;
      const rank = rankExpectation(rctx, ev.winProbability, ev.estimatedWinPoints + honbaBonus,
        risk.probability, loss + honbaBonus);
      const efficiency = -ev.sh * w.shantenCost + ev.ukeire * w.ukeireGain + ev.shape * w.shapeGain;
      const legacyScore = view.threat ? expectedNet + reserve + ev.score * 0.08 : ev.score;
      const score = rank && w.rankOrder ? (rank.expected - rank.current) * w.rankScale + efficiency * w.rankEfficiency + (view.threat ? reserve * w.rankReserve : 0)
        : legacyScore;
      candidates.push({ ...ev, t, tileId, danger: round(risk.probability * 100), dangerByOpponent: risk.detail,
        expectedLoss: round(loss), expectedNet, reserve, efficiency: round(efficiency),
        rankEV: rank ? round(rank.expected) : null, rankGain: rank ? rank.gain : null, rank,
        doraLoss: dora(t, view) + Number(T.isRed(tileId)), score });
    }
    // In the fast profile the fully evaluated roots stay ahead of the cheap
    // approximations; otherwise a loose acceptance bound could outrank them.
    candidates.sort((a, b) => (Number(!!a.approximated) - Number(!!b.approximated)) || b.score - a.score || b.t - a.t);
    if (level === 'strong' && !fast && turns > 1 && !view.threat) {
      const bestSh = Math.min(...candidates.map((c) => c.sh));
      const beam = candidates.filter((c) => c.sh <= bestSh + 1).slice(0, 4);
      for (const c of beam) {
        if (c.sh === 0) continue;
        counts[c.t]--;
        const next = timed('lookahead', () => lookahead(counts, view, evaluate, turns, reds - Number(T.isRed(c.tileId)), w));
        counts[c.t]++;
        c.futureUkeire = round(next.futureUkeire);
        c.improvedUkeire = round(next.improvedUkeire);
        c.winProbability = next.winProbability; c.tenpaiProbability = next.tenpaiProbability;
        c.expectedNet = next.expectedGross - c.expectedLoss;
        if (c.rank && rctx && w.rankOrder) {
          const rr = rankExpectation(rctx, next.winProbability, c.estimatedWinPoints + honbaBonus,
            (c.danger || 0) / 100, c.expectedLoss + honbaBonus);
          if (rr) {
            c.rank = rr; c.rankEV = round(rr.expected); c.rankGain = rr.gain;
            c.score = (rr.expected - rr.current) * w.rankScale + c.efficiency * w.rankEfficiency + (view.threat ? c.reserve * w.rankReserve : 0);
          } else c.score = c.score * 0.35 + next.nextScore * 0.65;
        } else c.score = c.score * 0.35 + next.nextScore * 0.65;
        c.searched = true;
      }
      candidates.sort((a, b) => b.score - a.score || b.t - a.t);
    }
    for (const c of candidates) { c.expectedNet = round(c.expectedNet); c.score = round(c.score); c.grossEV = round(c.grossEV); }
    return { version: AI.version, model: 'public-info / all-tile one-draw search + finite-horizon approximation',
      level, horizon: turns, rankBias: bias, unseen: view.unseen.slice(), candidates };
  };
  function forbiddenCall(action) {
    const out = [action.tile];
    if (action.type === 'chi') {
      const start = Math.min(action.tile, ...action.tiles);
      const other = action.tile === start ? start + 3 : action.tile === start + 2 ? start - 1 : -1;
      if (other >= 0 && other < 27 && Math.floor(other / 9) === Math.floor(start / 9)) out.push(other);
    }
    return out;
  }
  AI.analyzeCall = function (rawView, callOptions, w = AI.weights, options = {}) {
    AI.assertObservation(rawView);
    const opts = callOptions;
    const view = normalized(rawView), turns = horizon(view), ev = evaluator(view, w), bias = rankBias(view, options.rankBias !== false, options.rankModel);
    const counts = T.countsFromIds(view.hand), pass = ev(counts, view.unseen, turns, redCount(view));
    const rctx = options.rankBias !== false ? rankContext(view, options.rankModel) : null;
    const honbaBonus = (view.honba || 0) * 300;
    const passRank = rankExpectation(rctx, pass.winProbability, pass.estimatedWinPoints + honbaBonus, 0, 0);
    const alternatives = [{ action: null, label: '見送り', sh: pass.sh, ukeire: pass.ukeire, expectedNet: round(pass.grossEV),
      winProbability: pass.winProbability, rankEV: passRank ? round(passRank.expected) : null, rankExpected: passRank ? passRank.expected : null, rank: passRank }];
    const actions = [];
    if (opts.pon != null) actions.push({ type: 'pon', tile: opts.tile });
    for (const pair of opts.chi || []) actions.push({ type: 'chi', tile: opts.tile, tiles: pair });
    if (opts.kan != null) actions.push({ type: 'kan', tile: opts.tile });
    for (const action of actions) {
      const hand = view.hand.slice(), used = [];
      const needed = action.type === 'chi' ? action.tiles : Array(action.type === 'kan' ? 3 : 2).fill(action.tile);
      for (const t of needed) { const id = pickId(hand, t, null); hand.splice(hand.indexOf(id), 1); used.push(id); }
      const meld = { kind: action.type === 'chi' ? 'seq' : action.type === 'kan' ? 'kan' : 'trip',
        type: action.type === 'chi' ? Math.min(action.tile, ...action.tiles) : action.tile, open: true, tiles: [...used, view.callTile] };
      const v = { ...view, hand, melds: [...view.melds, meld], menzen: false, drawnTile: null, forbidden: action.type === 'kan' ? [] : forbiddenCall(action) };
      v.legalDiscards = hand.filter((id) => !v.forbidden.includes(id >> 2));
      let result;
      if (action.type === 'kan') {
        // Average the replacement draw. Unknown new dora is not peeked at or credited.
        const next = lookahead(T.countsFromIds(hand), v, evaluator(v, w), turns, redCount(v), w);
        result = { sh: bestRoute(T.countsFromIds(hand), v.melds.length).sh, ukeire: next.futureUkeire,
          expectedNet: next.expectedGross - (view.threat ? 500 : 120), winProbability: next.winProbability };
      } else result = AI.analyzeDiscard(v, 'standard', w, { rankBias: options.rankBias !== false, rankModel: options.rankModel }).candidates[0];
      if (!result) continue;
      // Fewer concealed tiles also reduce future defensive exits.
      const defenseCost = view.threat ? (w.callDefense + 80 * v.melds.length) * bias : 0;
      let rankExpected = result.rank ? result.rank.expected : null;
      if (rankExpected != null && defenseCost && rctx) {
        // Price the lost defensive exits in rank points, not raw points.
        rankExpected -= rctx.current - rankAt(rctx, view.scores, -defenseCost, view.riichiSticks);
      }
      alternatives.push({ action, label: action.type === 'chi' ? 'チー ' + action.tiles.map(T.label).join('・') : action.type === 'pon' ? 'ポン' : '大明槓',
        discard: result.tileId, sh: result.sh, ukeire: round(result.ukeire), expectedNet: round(result.expectedNet - defenseCost),
        winProbability: result.winProbability, rankEV: rankExpected == null ? null : round(rankExpected),
        rankExpected, rank: result.rank || null });
    }
    const baseline = alternatives[0].expectedNet;
    const rankMode = rctx && options.rankBias !== false && w.rankCallEnabled !== 0 && alternatives.every((a) => a.rankExpected != null);
    const calls = alternatives.slice(1).sort((a, b) => rankMode ? b.rankExpected - a.rankExpected : b.expectedNet - a.expectedNet);
    const best = calls[0];
    const delta = best ? best.expectedNet - baseline : 0;
    // Normalized EV difference stays defined with zero/negative EV; it is NOT a win probability.
    const advantagePercent = best ? 100 * delta / Math.max(100, Math.abs(best.expectedNet), Math.abs(baseline)) : 0;
    const rankDelta = rankMode && best ? best.rankExpected - alternatives[0].rankExpected : null;
    const selected = rankMode
      ? (best && rankDelta > (w.rankCallMargin == null ? 0.05 : w.rankCallMargin) ? best.action : null)
      : (best && delta > Math.max(w.callDeltaMin, Math.abs(baseline) * w.callDeltaRatio) ? best.action : null);
    return { version: AI.version, kind: 'call', model: 'approximate net EV', unseen: view.unseen.slice(), horizon: turns, rankBias: bias,
      rankMode: !!rankMode, rankDelta: rankDelta == null ? null : round(rankDelta),
      alternatives, selected, bestCall: best?.action || null, delta: round(delta), advantagePercent: round(advantagePercent),
      percentDefinition: '(bestCallEV - passEV) / max(100, abs(bestCallEV), abs(passEV)) * 100' };
  };
  // Compare riichi with dama in rank-point space. The deposit is lost on a
  // draw/deal-in and returned with the sticks on a win; the riichi yaku is
  // approximated as +1000 points on the winning hand.
  AI.rankRiichi = function (view, best, w = AI.weights, model) {
    const ctx = rankContext(view, model);
    if (!ctx || !best) return { accept: true, reason: 'no-standings' };
    const honba = (view.honba || 0) * 300;
    const pWin = clamp(best.winProbability || 0, 0, 1);
    const pLoss = clamp((best.danger || 0) / 100, 0, 1);
    const winPoints = Math.max(0, best.estimatedWinPoints || 0) + honba;
    const lossPoints = Math.max(0, best.expectedLoss || 0) + honba;
    const dama = rankExpectation(ctx, pWin, winPoints, pLoss, lossPoints);
    const after = view.scores.slice();
    after[view.seat] -= 1000;
    const ctxR = rankContext({ ...view, scores: after }, model);
    const riichi = rankExpectation(ctxR, clamp(pWin * 1.08, 0, 1), winPoints + 1000,
      clamp(pLoss * 1.1, 0, 1), lossPoints);
    const gain = riichi ? riichi.expected - dama.expected : 0;
    return { accept: gain >= -(w.rankRiichiMargin == null ? 0.05 : w.rankRiichiMargin),
      reason: 'rank-ev', gain: round(gain), dama, riichi };
  };
  AI.winScores = function (view, win, tsumo, loser) {
    const score = win && win.score;
    if (!score || !score.payments || !Array.isArray(view.scores) || view.scores.length !== 4) return null;
    const after = view.scores.slice(), seat = view.seat;
    let received = 0;
    for (let s = 0; s < 4; s++) {
      if (s === seat || (!tsumo && s !== loser)) continue;
      const base = !tsumo ? score.payments.ron
        : seat === view.dealer ? score.payments.each
          : s === view.dealer ? score.payments.fromDealer : score.payments.fromOthers;
      const pay = (base || 0) + (view.honba || 0) * (tsumo ? 100 : 300);
      after[s] -= pay; received += pay;
    }
    after[seat] += received + (view.riichiSticks || 0) * 1000;
    return after;
  };
  // In the final hand a non-dealer win ends the game. If it still leaves us last,
  // passing keeps the deal (and the game) alive, so a cheap "cannot rise" win is
  // declined. A dealer win repeats the hand, so it is always accepted.
  AI.wantWin = function (view, win, tsumo, loser, options = {}) {
    if (options.rankBias === false) return { accept: true, reason: 'rank-bias-off' };
    if (!view || view.handsLeft == null || view.handsLeft > 1 || view.isDealer) return { accept: true, reason: 'not-final-or-dealer' };
    if (!MJ.rank) return { accept: true, reason: 'no-rank' };
    const scores = AI.winScores(view, win, tsumo, loser);
    if (!scores) return { accept: true, reason: 'no-win-score' };
    let rankAfter;
    try { rankAfter = MJ.rank.finalResult(scores, view.rankConfig).ranks[view.seat]; }
    catch (_) { return { accept: true, reason: 'rank-error' }; }
    return { accept: rankAfter !== 4, reason: rankAfter === 4 ? 'win-keeps-last' : 'win-improves',
      rankAfter, scores };
  };
  // A wait-preserving concealed kan after riichi is already legal (see
  // `Game.availableKans`). The strategic question is the dora swing: a new kan
  // dora and ura indicator help us on a win, but the same dora helps every
  // opponent. While someone is riichi, or too late for a rinshan draw, decline.
  AI.riichiKanDecision = function (view, kan) {
    const live = view.liveRemaining == null ? 70 : view.liveRemaining;
    const threats = (view.opponents || []).filter((o) => o.riichi).length;
    const dora = (view.doraIndicators || []).length;
    const reason = threats ? 'threat' : live < 8 ? 'late' : dora >= 5 ? 'max-dora' : 'value';
    const accept = !threats && live >= 8 && dora < 5;
    const value = accept ? Math.round(20 + live * 0.3 + dora * 4) : 0;
    return { accept, value, reason, threats, liveRemaining: live, kan: { kind: kan.kind, tile: kan.tile } };
  };

  AI.create = function (seat, opts = {}) {
    const weights = opts.weights ? { ...AI.weights, ...opts.weights } : AI.weights;
    const useRankBias = opts.rankBias !== false;
    // undefined = use the globally loaded GRP model; null = heuristic rank EV.
    const useRankModel = opts.rankModel;
    const fast = opts.fast === true || opts.level === 'fast';
    const policy = opts.policy || null;
    return {
      seat, weights, lastCallAnalysis: null, lastRiichiDecision: null, lastWinDecision: null, policy,
      async wantTsumo(view) {
        AI.assertObservation(view);
        if (policy && MJ.policy) {
          const accept = await MJ.policy.chooseTsumo(policy, view);
          this.lastWinDecision = { accept, reason: 'policy' };
          return accept;
        }
        this.lastWinDecision = AI.wantWin(view, view && view.win, true, null,
          { rankBias: useRankBias, rankModel: useRankModel });
        return this.lastWinDecision.accept;
      },
      async chooseDiscard(view) {
        AI.assertObservation(view);
        if (view.riichi) return { tileId: view.drawnTile, riichi: false, analysis: { version: AI.version, forced: true } };
        if (policy && MJ.policy) {
          const decision = await MJ.policy.chooseDiscard(policy, view);
          if (decision) {
            const tileId = pickId(view.hand, decision.tile, view.drawnTile);
            if (tileId != null) return { tileId, riichi: decision.riichi,
              analysis: { version: AI.version, policy: true, model: 'obs-v1-resnet', probabilities: decision.probabilities } };
          }
        }
        const analysis = AI.analyzeDiscard(view, opts.level || 'strong', weights,
          { rankBias: useRankBias, rankModel: useRankModel, fast, rootCandidates: opts.rootCandidates }), best = analysis.candidates[0];
        const margin = weights.pushMargin * rankBias(view, useRankBias, useRankModel);
        let riichi = view.menzen && best.sh === 0 && !best.furiten && view.score >= 1000 && view.liveRemaining >= 4 && (!view.threat || best.expectedNet > margin);
        if (riichi && useRankBias && weights.rankRiichiEnabled !== 0) {
          this.lastRiichiDecision = AI.rankRiichi(view, best, weights, useRankModel);
          riichi = this.lastRiichiDecision.accept;
        }
        return { tileId: best.tileId, riichi, analysis };
      },
      async wantCall(view, options) {
        AI.assertObservation(view);
        this.lastCallAnalysis = null;
        if (!options || (!options.ron && options.pon == null && options.kan == null && !(options.chi || []).length)) return null;
        if (policy && MJ.policy) {
          const action = await MJ.policy.chooseCall(policy, view, options);
          this.lastCallAnalysis = { version: AI.version, kind: 'call', policy: true, selected: action };
          return action;
        }
        if (options.ron) {
          this.lastWinDecision = AI.wantWin(view, options.win || view.win, false,
            view.callFrom != null ? view.callFrom : options.from,
            { rankBias: useRankBias, rankModel: useRankModel });
          return this.lastWinDecision.accept ? { type: 'ron' } : null;
        }
        if (view.riichi) return null;
        this.lastCallAnalysis = AI.analyzeCall(view, options, weights, { rankBias: useRankBias, rankModel: useRankModel });
        return this.lastCallAnalysis.selected;
      },
      async wantKan(view, kans) {
        AI.assertObservation(view);
        if (!Array.isArray(kans) || !kans.length) return null;
        if (view.riichi) {
          const ankan = kans.find((k) => k.kind === 'ankan');
          if (!ankan) return null;
          this.lastKanDecision = AI.riichiKanDecision(view, ankan);
          return this.lastKanDecision.accept ? ankan : null;
        }
        if (view.threat || view.liveRemaining < 8) return null;
        const c = T.countsFromIds(view.hand), base = bestRoute(c, view.melds.length).sh;
        return kans.find((k) => { const after = c.slice(); after[k.tile] -= k.kind === 'ankan' ? 4 : 1;
          return bestRoute(after, view.melds.length + Number(k.kind === 'ankan')).sh <= base; }) || null;
      }
    };
  };
})();
