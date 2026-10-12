(function () {
  const MJ = globalThis.MJ, T = MJ.tiles, S = MJ.shanten;
  const AI = MJ.ai = { version: 'public-search-3' };
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

  // Public-information danger model. These are heuristic probabilities, not calibrated frequencies.
  AI.risk = function (t, view) {
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
    return { probability: 1 - survive, loss, detail };
  };

  // Non-overlapping block decompositions. Keep alternatives with 5 and 6 blocks;
  // count the sixth only as flexibility, never as a fifth usable meld.
  function blockShape(counts, view, unseen) {
    const c = counts.slice(), groups = [], singles = [], meldCount = view.melds.length;
    let best = null, five = null, six = null;
    function growth(t) {
      if (t >= 27) return unseen[t] * 0.14 + yakuhai(t, view) * unseen[t] * Math.max(0, unseen[t] - 1) * 0.16 + (t === view.seatWind ? 0.1 : 0);
      let value = unseen[t] * 0.24;
      for (const delta of [-2, -1, 1, 2]) {
        const x = t + delta;
        if (x < 0 || x >= 27 || Math.floor(x / 9) !== Math.floor(t / 9)) continue;
        const low = Math.min(t, x) % 9;
        value += unseen[x] * (Math.abs(delta) === 2 ? 0.36 : low >= 1 && low <= 6 ? 0.8 : 0.43);
      }
      return value;
    }
    function finish(sets) {
      const pairs = groups.filter((g) => g.kind === 'pair');
      const head = pairs.length > 0;
      const incomplete = groups.filter((g) => g.kind !== 'set');
      const sh = 8 - 2 * (sets + meldCount) - Math.min(4 - sets - meldCount, incomplete.length - Number(head)) - Number(head);
      const blocks = groups.length + meldCount;
      let quality = 0;
      const values = incomplete.map((g) => {
        if (g.kind === 'pair') return unseen[g.t] * (1.0 + yakuhai(g.t, view) * 0.35);
        return g.waits.reduce((n, t) => n + unseen[t], 0) * (g.kind === 'ryanmen' ? 1 : g.kind === 'kanchan' ? 0.82 : 0.68);
      }).sort((a, b) => b - a);
      values.forEach((value, i) => { quality += value * (i < 5 - sets - meldCount ? 1 : 0.12); });
      const spare = singles.map(growth).sort((a, b) => b - a);
      // Spare central tiles can replace bad taatsu even at five blocks.
      spare.forEach((value, i) => { quality += value * (blocks < 5 ? 0.8 : 0.38) / (i + 1); });
      if (head) quality += 3.0;
      if (pairs.length === 2) quality += 1.4; // alternative heads / triplet completion
      const value = -sh * 100 + quality;
      const plan = { blocks, head, pairs: pairs.length, ryanmen: groups.filter((g) => g.kind === 'ryanmen').length,
        weak: groups.filter((g) => g.kind === 'penchan' || g.kind === 'kanchan').length, quality, sh, value };
      if (blocks === 5 && (!five || value > five.value)) five = plan;
      if (blocks === 6 && (!six || value > six.value)) six = plan;
      if (!best || value > best.value) best = plan;
    }
    function walk(start, sets) {
      while (start < 34 && !c[start]) start++;
      if (start === 34) { finish(sets); return; }
      if (groups.length + meldCount > 6 || sets + meldCount > 4) return;
      const t = start, n = t % 9;
      function use(tiles, group, set) {
        tiles.forEach((x) => c[x]--); groups.push(group); walk(t, sets + Number(set)); groups.pop(); tiles.forEach((x) => c[x]++);
      }
      if (c[t] >= 3) use([t, t, t], { kind: 'set' }, true);
      if (t < 27 && n <= 6 && c[t + 1] && c[t + 2]) use([t, t + 1, t + 2], { kind: 'set' }, true);
      if (c[t] >= 2) use([t, t], { kind: 'pair', t }, false);
      if (t < 27 && n <= 7 && c[t + 1]) {
        const waits = []; if (n > 0) waits.push(t - 1); if (n < 7) waits.push(t + 2);
        use([t, t + 1], { kind: waits.length === 2 ? 'ryanmen' : 'penchan', waits }, false);
      }
      if (t < 27 && n <= 6 && c[t + 2]) use([t, t + 2], { kind: 'kanchan', waits: [t + 1] }, false);
      c[t]--; singles.push(t); walk(t, sets); singles.pop(); c[t]++;
    }
    walk(0, 0);
    return { ...best, five: five && round(five.quality), six: six && round(six.quality) };
  }
  AI.blockShape = blockShape;

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
  function evaluator(view) {
    const cache = new Map(), shapeCache = new Map();
    return function evaluate(counts, unseen, turns, reds, discarded = [], future) {
      const key = counts.join('') + '/' + unseen.join('') + '/' + turns + '/' + reds + '/' + discarded.join(',') + '/' + future;
      if (cache.has(key)) return cache.get(key);
      const sh = S.shanten(counts, view.melds.length), uk = S.ukeire(counts, view.melds.length, unseen);
      const shapeKey = counts.join('') + '/' + unseen.join('');
      let shape = shapeCache.get(shapeKey);
      if (!shape) {
        shape = sh === 0 ? { quality: 0, blocks: 5, head: counts.some((n) => n === 2), ryanmen: 0, five: 0, six: null } : blockShape(counts, view, unseen);
        shapeCache.set(shapeKey, shape);
      }
      const hv = handValue(counts, { ...view, unseen }, reds);
      let outs = uk.count, points = hv.points, yakuChance = hv.yakuChance;
      const furiten = sh === 0 && uk.tiles.some((t) => view.ownDiscardTypes.includes(t) || discarded.includes(t));
      if (sh === 0) {
        let gain = 0; outs = 0;
        for (const t of uk.tiles) {
          counts[t]++;
          const value = winValue(counts, t, view, reds, hv.closed && view.score >= 1000 && view.liveRemaining >= 4);
          counts[t]--;
          if (value) { outs += unseen[t]; gain += value * unseen[t]; }
        }
        points = outs ? gain / outs : 0; yakuChance = 1;
      }
      const probs = probability(sh, outs, future, sum(unseen), turns);
      // Ron and opponents ending the hand are approximated, clearly identified in the record.
      const survival = Math.exp(-(view.threat ? 0.075 : 0.027) * Math.max(1, sh + 1) * turns / 2);
      const ronFactor = sh === 0 && outs ? uk.tiles.reduce((n, t) => n + unseen[t] * (T.isYaochu(t) ? 0.6 : T.numOf(t) === 2 || T.numOf(t) === 8 ? 0.4 : 0.25), 0) / outs : 0.35;
      const gross = probs.winProbability * points * yakuChance * survival * (furiten ? 1 : 1 + ronFactor);
      const efficiency = -sh * 125 + uk.count * 1.25 + shape.quality * 2.4;
      const value = { sh, ukeire: uk.count, waits: uk.tiles, shape: round(shape.quality), blocks: shape.blocks,
        blockPlans: { five: shape.five, six: shape.six, head: shape.head, ryanmen: shape.ryanmen },
        ...probs, estimatedWinPoints: round(points), grossEV: gross, yakuChance, furiten,
        score: efficiency + gross * 0.035 };
      cache.set(key, value); return value;
    };
  }
  function horizon(view) { return Math.max(0, Math.ceil(view.liveRemaining / 4)); }
  function redCount(view) { return view.hand.concat(view.melds.flatMap((m) => m.tiles || [])).filter(T.isRed).length; }
  function postDrawChoices(counts, unseen, view, evaluate, turns, reds, forbidden = []) {
    const choices = [];
    let min = 99;
    for (let t = 0; t < 34; t++) if (counts[t] && !forbidden.includes(t)) {
      counts[t]--; const sh = S.shanten(counts, view.melds.length); counts[t]++;
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
  function lookahead(counts, view, evaluate, turns, reds) {
    const unseen = view.unseen.slice(), pool = sum(unseen);
    let score = 0, gross = 0, tenpai = 0, win = 0, future = 0, improvedWeight = 0, improvedUkeire = 0;
    const baseSh = S.shanten(counts, view.melds.length);
    // Includes non-shanten-improving draws: replacement taatsu, spare central tiles, extra heads.
    for (let t = 0; t < 34; t++) {
      if (!unseen[t] || counts[t] >= 4) continue;
      const weight = unseen[t] / pool;
      counts[t]++; unseen[t]--;
      if (MJ.agari.isAgari(counts, view.melds.length)) {
        const value = winValue(counts, t, view, reds, view.menzen && view.score >= 1000);
        if (value) { score += weight * (125 + value * 0.035); gross += weight * value; tenpai += weight; win += weight; counts[t]--; unseen[t]++; continue; }
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
  AI.analyzeDiscard = function (rawView, level = 'strong') {
    const view = normalized(rawView), counts = T.countsFromIds(view.hand), evaluate = evaluator(view);
    const turns = horizon(view), reds = redCount(view), candidates = [];
    const types = [...new Set((view.legalDiscards || view.hand).filter((id) => !(view.forbidden || []).includes(id >> 2)).map((id) => id >> 2))];
    for (const t of types) {
      const tileId = pickId(view.hand, t, view.drawnTile);
      counts[t]--;
      const ev = evaluate(counts, view.unseen, turns, reds - Number(T.isRed(tileId)), [t]);
      counts[t]++;
      const risk = AI.risk(t, view);
      const copies = counts[t];
      // Folding with duplicate safer tiles reserves safe exits for later turns.
      const reserve = risk.probability < 0.09 ? Math.max(0, copies - 1) * (1 - risk.probability * 8) * 65 : 0;
      const futureLoss = view.threat ? risk.loss * Math.min(3, 0.65 + ev.sh * 0.65) : 0;
      const expectedNet = ev.grossEV - risk.loss - futureLoss;
      candidates.push({ ...ev, t, tileId, danger: round(risk.probability * 100), dangerByOpponent: risk.detail,
        expectedLoss: round(risk.loss + futureLoss), expectedNet, reserve,
        doraLoss: dora(t, view) + Number(T.isRed(tileId)), score: view.threat ? expectedNet + reserve + ev.score * 0.08 : ev.score });
    }
    candidates.sort((a, b) => b.score - a.score || b.t - a.t);
    if (level === 'strong' && turns > 1 && !view.threat) {
      const bestSh = Math.min(...candidates.map((c) => c.sh));
      const beam = candidates.filter((c) => c.sh <= bestSh + 1).slice(0, 4);
      for (const c of beam) {
        if (c.sh === 0) continue;
        counts[c.t]--;
        const next = lookahead(counts, view, evaluate, turns, reds - Number(T.isRed(c.tileId)));
        counts[c.t]++;
        c.futureUkeire = round(next.futureUkeire);
        c.improvedUkeire = round(next.improvedUkeire);
        c.winProbability = next.winProbability; c.tenpaiProbability = next.tenpaiProbability;
        c.expectedNet = next.expectedGross - c.expectedLoss;
        c.score = c.score * 0.35 + next.nextScore * 0.65;
        c.searched = true;
      }
      candidates.sort((a, b) => b.score - a.score || b.t - a.t);
    }
    for (const c of candidates) { c.expectedNet = round(c.expectedNet); c.score = round(c.score); c.grossEV = round(c.grossEV); }
    return { version: AI.version, model: 'public-info / all-tile one-draw search + finite-horizon approximation',
      level, horizon: turns, unseen: view.unseen.slice(), candidates };
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
  AI.analyzeCall = function (rawView, options) {
    const view = normalized(rawView), turns = horizon(view), ev = evaluator(view);
    const counts = T.countsFromIds(view.hand), pass = ev(counts, view.unseen, turns, redCount(view));
    const alternatives = [{ action: null, label: '見送り', sh: pass.sh, ukeire: pass.ukeire, expectedNet: round(pass.grossEV), winProbability: pass.winProbability }];
    const actions = [];
    if (options.pon != null) actions.push({ type: 'pon', tile: options.tile });
    for (const pair of options.chi || []) actions.push({ type: 'chi', tile: options.tile, tiles: pair });
    if (options.kan != null) actions.push({ type: 'kan', tile: options.tile });
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
        const next = lookahead(T.countsFromIds(hand), v, evaluator(v), turns, redCount(v));
        result = { sh: S.shanten(T.countsFromIds(hand), v.melds.length), ukeire: next.futureUkeire,
          expectedNet: next.expectedGross - (view.threat ? 500 : 120), winProbability: next.winProbability };
      } else result = AI.analyzeDiscard(v, 'standard').candidates[0];
      if (!result) continue;
      // Fewer concealed tiles also reduce future defensive exits.
      const defenseCost = view.threat ? 180 + 80 * v.melds.length : 0;
      alternatives.push({ action, label: action.type === 'chi' ? 'チー ' + action.tiles.map(T.label).join('・') : action.type === 'pon' ? 'ポン' : '大明槓',
        discard: result.tileId, sh: result.sh, ukeire: round(result.ukeire), expectedNet: round(result.expectedNet - defenseCost), winProbability: result.winProbability });
    }
    const baseline = alternatives[0].expectedNet;
    const calls = alternatives.slice(1).sort((a, b) => b.expectedNet - a.expectedNet);
    const best = calls[0];
    const delta = best ? best.expectedNet - baseline : 0;
    // Normalized EV difference stays defined with zero/negative EV; it is NOT a win probability.
    const advantagePercent = best ? 100 * delta / Math.max(100, Math.abs(best.expectedNet), Math.abs(baseline)) : 0;
    const selected = best && delta > Math.max(20, Math.abs(baseline) * 0.025) ? best.action : null;
    return { version: AI.version, kind: 'call', model: 'approximate net EV', unseen: view.unseen.slice(), horizon: turns,
      alternatives, selected, bestCall: best?.action || null, delta: round(delta), advantagePercent: round(advantagePercent),
      percentDefinition: '(bestCallEV - passEV) / max(100, abs(bestCallEV), abs(passEV)) * 100' };
  };
  AI.create = function (seat, opts = {}) {
    return {
      seat, lastCallAnalysis: null,
      async wantTsumo() { return true; },
      async chooseDiscard(view) {
        if (view.riichi) return { tileId: view.drawnTile, riichi: false, analysis: { version: AI.version, forced: true } };
        const analysis = AI.analyzeDiscard(view, opts.level || 'strong'), best = analysis.candidates[0];
        const riichi = view.menzen && best.sh === 0 && !best.furiten && view.score >= 1000 && view.liveRemaining >= 4 && (!view.threat || best.expectedNet > 100);
        return { tileId: best.tileId, riichi, analysis };
      },
      async wantCall(view, options) {
        this.lastCallAnalysis = null;
        if (options.ron) return { type: 'ron' };
        if (view.riichi) return null;
        this.lastCallAnalysis = AI.analyzeCall(view, options);
        return this.lastCallAnalysis.selected;
      },
      async wantKan(view, kans) {
        if (view.threat || view.liveRemaining < 8) return null;
        const c = T.countsFromIds(view.hand), base = S.shanten(c, view.melds.length);
        return kans.find((k) => { const after = c.slice(); after[k.tile] -= k.kind === 'ankan' ? 4 : 1;
          return S.shanten(after, view.melds.length + Number(k.kind === 'ankan')) <= base; }) || null;
      }
    };
  };
})();
