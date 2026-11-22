(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const S = (MJ.shanten = {});

  function evalShanten(sets, taatsu, pair, openSets) {
    return 8 - 2 * (sets + openSets) - Math.min(taatsu, 4 - sets - openSets) - pair;
  }

  // FIFO eviction avoids the latency spikes of clearing a large table. The key
  // is the exact 34-count vector, so hand-hash collisions cannot occur.
  const insert = (map, key, value, limit) => {
    if (map.size >= limit) map.delete(map.keys().next().value);
    map.set(key, value);
  };
  // Suit-wise decomposition table. A 14-tile hand is three 9-rank suits plus
  // seven honors; caching those small patterns has a far higher hit rate than
  // caching whole hands. Each group keeps its Pareto-optimal (melds, taatsu,
  // pair) options; combining the four groups is a small DP over <=50 states.
  const groupCache = new Map();
  function groupOptions(counts, suited) {
    const key = (suited ? 's' : 'h') + counts.join('');
    const hit = groupCache.get(key);
    if (hit) return hit;
    const c = counts.slice(), best = new Map();
    function dfs(i, melds, taatsu, pair) {
      while (i < c.length && c[i] === 0) i++;
      if (i >= c.length) {
        const k = melds * 2 + pair, t = Math.min(4, taatsu);
        if (!(best.get(k) >= t)) best.set(k, t);
        return;
      }
      if (melds > 4) return;
      const n = suited ? i % 9 : 0;
      if (c[i] >= 3) {
        c[i] -= 3; dfs(i, melds + 1, taatsu, pair); c[i] += 3;
      }
      if (suited && n <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--; dfs(i, melds + 1, taatsu, pair); c[i]++; c[i + 1]++; c[i + 2]++;
      }
      if (c[i] >= 2) {
        if (!pair) { c[i] -= 2; dfs(i, melds, taatsu, 1); c[i] += 2; }
        c[i] -= 2; dfs(i, melds, taatsu + 1, pair); c[i] += 2;
      }
      if (suited && n <= 7 && c[i + 1] > 0) {
        c[i]--; c[i + 1]--; dfs(i, melds, taatsu + 1, pair); c[i]++; c[i + 1]++;
      }
      if (suited && n <= 6 && c[i + 2] > 0) {
        c[i]--; c[i + 2]--; dfs(i, melds, taatsu + 1, pair); c[i]++; c[i + 2]++;
      }
      c[i]--; dfs(i, melds, taatsu, pair); c[i]++;
    }
    dfs(0, 0, 0, 0);
    const all = [...best].map(([k, taatsu]) => ({ m: Math.floor(k / 2), p: k & 1, t: taatsu }));
    const options = all.filter((a) => !all.some((b) => b !== a && b.m >= a.m && b.t >= a.t && b.p >= a.p &&
      (b.m > a.m || b.t > a.t || b.p > a.p)));
    insert(groupCache, key, options, 120000);
    return options;
  }

  // State index = melds * 10 + taatsu * 2 + pair (50 possible states). A pair
  // of reusable boolean bitmaps replaces per-call arrays and pruning.
  const STATE_A = new Uint8Array(50), STATE_B = new Uint8Array(50);
  S.groupForSuit = (counts, suit) => suit === 3
    ? groupOptions(counts.slice(27, 34), false)
    : groupOptions(counts.slice(suit * 9, suit * 9 + 9), true);
  S.standardGroups = (counts) => [0, 1, 2, 3].map((suit) => S.groupForSuit(counts, suit));
  function combineGroups(groups, openSets) {
    const meldCap = Math.max(0, 4 - openSets);
    STATE_A.fill(0); STATE_A[0] = 1;
    let source = STATE_A, target = STATE_B;
    for (const options of groups) {
      target.fill(0);
      for (let idx = 0; idx < 50; idx++) {
        if (!source[idx]) continue;
        const m = Math.floor(idx / 10), t = Math.floor((idx % 10) / 2), p = idx & 1;
        for (const o of options) {
          const m2 = Math.min(meldCap, m + o.m), t2 = Math.min(4, t + o.t);
          target[m2 * 10 + t2 * 2 + (p | o.p)] = 1;
        }
      }
      const swap = source; source = target; target = swap;
    }
    let min = 99;
    for (let idx = 0; idx < 50; idx++) {
      if (!source[idx]) continue;
      const m = Math.floor(idx / 10), t = Math.floor((idx % 10) / 2), p = idx & 1;
      const sets = m + openSets;
      if (sets > 4) continue;
      const value = 8 - 2 * sets - Math.min(t, 4 - sets) - p;
      if (value < min) min = value;
    }
    return min;
  }
  S.combineGroups = combineGroups;

  const standardCache = new Map();
  S.standard = function (counts, openSets) {
    openSets = openSets || 0;
    const key = openSets + ':' + counts.join('');
    let value = standardCache.get(key);
    if (value === undefined) {
      value = combineGroups(S.standardGroups(counts), openSets);
      insert(standardCache, key, value, 200000);
    }
    return value;
  };
  // Internal reference implementation, kept for the regression test that
  // compares the table against the original depth-first search.
  S.standardReference = standardRaw;

  function standardRaw(counts, openSets) {
    const c = counts.slice();
    let min = 99;

    function dfs(idx, sets, taatsu, pair) {
      if (sets + openSets > 4) return;
      while (idx < 34 && c[idx] === 0) idx++;
      if (idx >= 34) {
        const v = evalShanten(sets, taatsu, pair, openSets);
        if (v < min) min = v;
        return;
      }
      const t = idx;
      const n = t % 9;

      if (c[t] >= 3) {
        c[t] -= 3;
        dfs(t, sets + 1, taatsu, pair);
        c[t] += 3;
      }
      if (c[t] >= 2) {
        if (!pair) {
          c[t] -= 2;
          dfs(t, sets, taatsu, 1);
          c[t] += 2;
        }
        c[t] -= 2;
        dfs(t, sets, taatsu + 1, pair);
        c[t] += 2;
      }
      if (t < 27 && n <= 6 && c[t + 1] > 0 && c[t + 2] > 0) {
        c[t]--; c[t + 1]--; c[t + 2]--;
        dfs(t, sets + 1, taatsu, pair);
        c[t]++; c[t + 1]++; c[t + 2]++;
      }
      if (t < 27 && n <= 7 && c[t + 1] > 0) {
        c[t]--; c[t + 1]--;
        dfs(t, sets, taatsu + 1, pair);
        c[t]++; c[t + 1]++;
      }
      if (t < 27 && n <= 6 && c[t + 2] > 0) {
        c[t]--; c[t + 2]--;
        dfs(t, sets, taatsu + 1, pair);
        c[t]++; c[t + 2]++;
      }
      dfs(t + 1, sets, taatsu, pair);
    }

    dfs(0, 0, 0, 0);
    return min;
  }

  S.chiitoi = function (counts) {
    let pairs = 0;
    let kinds = 0;
    for (let i = 0; i < 34; i++) {
      if (counts[i] >= 2) pairs++;
      if (counts[i] > 0) kinds++;
    }
    return 6 - pairs + Math.max(0, 7 - kinds);
  };

  S.kokushi = function (counts) {
    const T = MJ.tiles;
    let kinds = 0;
    let pair = 0;
    for (const t of T.YAOCHU_TYPES) {
      if (counts[t] > 0) kinds++;
      if (counts[t] >= 2) pair = 1;
    }
    return 13 - kinds - pair;
  };

  const cache = new Map();
  S.shanten = function (counts, openSets) {
    openSets = openSets || 0;
    const key = openSets + ':' + counts.join('');
    if (cache.has(key)) return cache.get(key);
    let best = S.standard(counts, openSets);
    if (openSets === 0) {
      best = Math.min(best, S.chiitoi(counts), S.kokushi(counts));
    }
    insert(cache, key, best, 80000);
    return best;
  };

  S.isWin = function (counts, openSets) {
    return S.shanten(counts, openSets) < 0;
  };

  S.ukeire = function (counts, openSets, unseen) {
    openSets = openSets || 0;
    const base = S.shanten(counts, openSets);
    const tiles = [];
    let total = 0;
    for (let t = 0; t < 34; t++) {
      if (counts[t] >= 4) continue;
      const avail = unseen ? unseen[t] : 4 - counts[t];
      if (avail <= 0) continue;
      counts[t]++;
      const s = S.shanten(counts, openSets);
      counts[t]--;
      if (s < base) {
        tiles.push(t);
        total += avail;
      }
    }
    return { tiles, count: total, base };
  };
})();
