(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const A = (MJ.agari = {});

  function enumSets(c, idx, cur, out) {
    while (idx < 34 && c[idx] === 0) idx++;
    if (idx >= 34) {
      out.push(cur.slice());
      return;
    }
    const t = idx;
    const n = t % 9;
    if (c[t] >= 3) {
      c[t] -= 3;
      cur.push({ type: t, kind: 'trip', open: false });
      enumSets(c, t, cur, out);
      cur.pop();
      c[t] += 3;
    }
    if (t < 27 && n <= 6 && c[t + 1] > 0 && c[t + 2] > 0) {
      c[t]--; c[t + 1]--; c[t + 2]--;
      cur.push({ type: t, kind: 'seq', open: false });
      enumSets(c, t, cur, out);
      cur.pop();
      c[t]++; c[t + 1]++; c[t + 2]++;
    }
  }

  A.decompose = function (counts) {
    const results = [];
    for (let p = 0; p < 34; p++) {
      if (counts[p] < 2) continue;
      const c = counts.slice();
      c[p] -= 2;
      const out = [];
      enumSets(c, 0, [], out);
      for (const sets of out) results.push({ pair: p, sets });
    }
    return results;
  };

  A.isChiitoi = function (counts, meldCount) {
    if (meldCount > 0) return false;
    let pairs = 0;
    let sum = 0;
    for (let i = 0; i < 34; i++) {
      if (counts[i] >= 2) pairs++;
      if (counts[i] >= 4) return false;
      sum += counts[i];
    }
    return pairs === 7 && sum === 14;
  };

  A.isKokushi = function (counts, meldCount) {
    if (meldCount > 0) return false;
    let kinds = 0;
    let hasPair = false;
    let sum = 0;
    for (const t of T.YAOCHU_TYPES) {
      if (counts[t] > 0) kinds++;
      if (counts[t] >= 2) hasPair = true;
      sum += counts[t];
    }
    for (let t = 0; t < 34; t++) if (T.YAOCHU_TYPES.indexOf(t) < 0 && counts[t] > 0) return false;
    return kinds === 13 && hasPair && sum === 14;
  };

  A.isAgari = function (counts, meldCount) {
    meldCount = meldCount || 0;
    if (A.isChiitoi(counts, meldCount) || A.isKokushi(counts, meldCount)) return true;
    const needed = 4 - meldCount;
    if (needed < 0) return false;
    const decomps = A.decompose(counts);
    for (const d of decomps) if (d.sets.length === needed) return true;
    return false;
  };
})();
