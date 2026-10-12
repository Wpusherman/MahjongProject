(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const S = (MJ.shanten = {});

  function evalShanten(sets, taatsu, pair, openSets) {
    return 8 - 2 * (sets + openSets) - Math.min(taatsu, 4 - sets - openSets) - pair;
  }

  S.standard = function (counts, openSets) {
    openSets = openSets || 0;
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
  };

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
    if (cache.size > 80000) cache.clear();
    cache.set(key, best);
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
