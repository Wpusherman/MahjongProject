(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = (MJ.tiles = {});

  T.RED_IDS = new Set([16, 52, 88]);

  T.typeOf = (id) => id >> 2;
  T.idOf = (type, copy) => type * 4 + copy;
  T.isRed = (id) => T.RED_IDS.has(id);

  T.suitOf = (t) => (t < 9 ? 'm' : t < 18 ? 'p' : t < 27 ? 's' : 'z');
  T.numOf = (t) => (t < 27 ? (t % 9) + 1 : t - 26);
  T.isHonor = (t) => t >= 27;
  T.isTerminal = (t) => t < 27 && (t % 9 === 0 || t % 9 === 8);
  T.isYaochu = (t) => T.isHonor(t) || T.isTerminal(t);
  T.isSimple = (t) => !T.isYaochu(t);

  T.HONOR_NAMES = ['東', '南', '西', '北', '白', '發', '中'];
  T.SUIT_KANJI = { m: '萬', p: '筒', s: '索' };

  T.honorName = (t) => T.HONOR_NAMES[t - 27];

  T.label = function (t) {
    if (t >= 27) return T.honorName(t);
    return T.numOf(t) + T.SUIT_KANJI[T.suitOf(t)];
  };

  T.HONOR_TYPES = { E: 27, S: 28, W: 29, N: 30, HAKU: 31, HATSU: 32, CHUN: 33 };
  T.DRAGONS = [31, 32, 33];
  T.WINDS = [27, 28, 29, 30];

  T.YAOCHU_TYPES = [0, 8, 9, 17, 18, 26, 27, 28, 29, 30, 31, 32, 33];

  T.countsFromIds = function (ids) {
    const c = new Array(34).fill(0);
    for (const id of ids) c[id >> 2]++;
    return c;
  };

  T.typesFromCounts = function (c) {
    const out = [];
    for (let t = 0; t < 34; t++) for (let k = 0; k < c[t]; k++) out.push(t);
    return out;
  };

  T.doraFromIndicator = function (ind) {
    if (ind >= 27) {
      if (ind === 30) return 27;
      if (ind === 33) return 31;
      return ind + 1;
    }
    const suitStart = Math.floor(ind / 9) * 9;
    const n = ind % 9;
    return suitStart + ((n + 1) % 9);
  };

  T.buildWall = function (rng) {
    const wall = [];
    for (let id = 0; id < 136; id++) wall.push(id);
    for (let i = wall.length - 1; i > 0; i--) {
      const j = Math.floor((rng ? rng() : Math.random()) * (i + 1));
      const tmp = wall[i];
      wall[i] = wall[j];
      wall[j] = tmp;
    }
    return wall;
  };

  T.sameType = (a, b) => a === b;
})();
