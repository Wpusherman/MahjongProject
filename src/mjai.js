(function () {
  const MJ = (globalThis.MJ = globalThis.MJ || {});
  const T = MJ.tiles;
  const M = (MJ.mjai = { version: 'mjai-0.1' });
  const HONORS = ['E', 'S', 'W', 'N', 'P', 'F', 'C'];
  const HONOR_INDEX = { E: 27, S: 28, W: 29, N: 30, P: 31, F: 32, C: 33 };
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function tileString(id) {
    if (!Number.isInteger(id) || id < 0 || id > 135) throw new Error('Invalid tile id: ' + id);
    const type = id >> 2;
    if (type >= 27) return HONORS[type - 27];
    const suit = 'mps'[Math.floor(type / 9)];
    return (type % 9 + 1) + suit + (T.isRed(id) ? 'r' : '');
  }
  function parseTile(str) {
    if (str == null || str === '?') return null;
    if (HONOR_INDEX[str] != null) return { type: HONOR_INDEX[str], red: false };
    const m = /^([0-9])([mps])(r)?$/.exec(str);
    if (!m) throw new Error('Unknown mjai tile: ' + str);
    const n = Number(m[1]);
    const type = 'mps'.indexOf(m[2]) * 9 + (n === 0 ? 4 : n - 1);
    return { type, red: !!m[3] || n === 0 };
  }
  M.tileString = tileString;
  M.parseTile = parseTile;

  M.parse = function (text) {
    if (typeof text !== 'string') throw new Error('mjai input must be JSON Lines text');
    const events = [];
    text.split(/\r?\n/).forEach((line, i) => {
      const s = line.trim();
      if (!s) return;
      let event;
      try { event = JSON.parse(s); } catch (e) { throw new Error(`mjai line ${i + 1}: ${e.message}`); }
      if (!event || typeof event.type !== 'string') throw new Error(`mjai line ${i + 1}: missing type`);
      events.push(event);
    });
    return events;
  };
  M.stringify = function (events) { return events.map((e) => JSON.stringify(e)).join('\n') + '\n'; };

  function createPool() {
    const used = new Set();
    return {
      take(str) {
        const p = parseTile(str);
        if (!p) throw new Error('Cannot assign an unknown tile');
        const ids = [0, 1, 2, 3].map((c) => p.type * 4 + c);
        ids.sort((a, b) => Number(T.isRed(a) && !p.red) - Number(T.isRed(b) && !p.red));
        for (const id of ids) if (!used.has(id)) { used.add(id); return id; }
        throw new Error('A tile type appears more than four times: ' + str);
      },
      remaining() {
        const out = [];
        for (let id = 0; id < 136; id++) if (!used.has(id)) out.push(id);
        return out;
      }
    };
  }
  function takeFromHand(hand, str, prefer) {
    const p = parseTile(str);
    if (!p) throw new Error('Cannot match an unknown tile');
    let candidates = hand.filter((id) => (id >> 2) === p.type && (!p.red || T.isRed(id)));
    if (!candidates.length) candidates = hand.filter((id) => (id >> 2) === p.type);
    if (!candidates.length) throw new Error('Tile is not in hand: ' + str);
    candidates.sort((a, b) => Number(T.isRed(a)) - Number(T.isRed(b)));
    return prefer != null && candidates.includes(prefer) ? prefer : candidates[0];
  }
  function findInHand(hand, str, prefer) {
    const p = parseTile(str);
    if (!p) throw new Error('Cannot match an unknown tile');
    const candidates = hand.filter((id) => (id >> 2) === p.type);
    return prefer != null && candidates.includes(prefer) ? prefer : candidates[0];
  }
  const remove = (hand, id) => { const i = hand.indexOf(id); if (i < 0) throw new Error('Tile not in hand: ' + id); hand.splice(i, 1); };
  const mapTenhouReason = (type) => ({
    yao9: 'nine_terminals', kaze4: 'four_winds', reach4: 'four_riichi', kan4: 'four_kans', nm: 'nagashi'
  }[type] || 'exhaustive');
  const toTenhouReason = (reason) => ({
    'four-kans': 'four_kans', 'four-riichi': 'four_riichi', 'four-winds': 'four_winds', exhaustive: 'exhaustive'
  }[reason] || 'exhaustive');
  const roundWindOf = (bakaze) => (bakaze === 'S' || bakaze === 's' ? 28 : 27);

  // ---------------------------------------------------------------------------
  // 翠卓 JSON -> mjai events
  // ---------------------------------------------------------------------------
  M.fromSuitaku = function (record, options = {}) {
    if (!record || !Array.isArray(record.hands) || !record.hands.length) throw new Error('翠卓の牌譜が必要です');
    const seat = Number.isInteger(options.seat) && options.seat >= 0 && options.seat < 4 ? options.seat : null;
    const maskOtherDraws = !!options.maskOtherDraws && seat != null;
    const events = [];
    const startDealer = Number.isInteger(record.startDealer) ? record.startDealer
      : Number.isInteger(record.hands[0] && record.hands[0].config && record.hands[0].config.startDealer) ? record.hands[0].config.startDealer
        : Number.isInteger(record.hands[0] && record.hands[0].config && record.hands[0].config.dealer) ? record.hands[0].config.dealer : 0;
    events.push({ type: 'start_game', names: options.names || ['P0', 'P1', 'P2', 'P3'],
      rule: { aka: (record.rules && record.rules.redFives) !== 0, kuitan: !!(record.rules && record.rules.openTanyao),
        atamahane: !record.rules || record.rules.ron !== 'multiple', mode: record.mode || 'tonpu',
        start_dealer: startDealer, riichi_ankan: (record.rules && record.rules.riichiAnkan) || 'wait' } });
    record.hands.forEach((hand) => {
      const config = hand.config || {}, start = (hand.events || []).find((e) => e.type === 'start') || {};
      const acceptedRiichi = new Set((hand.events || []).filter((e) => e.type === 'riichi').map((e) => e.seat));
      const initialDora = start.doraIndicators && start.doraIndicators[0];
      const handIndex = Number.isInteger(config.hand) ? config.hand : Number.isInteger(config.handIndex) ? config.handIndex : 0;
      if (!Array.isArray(hand.initialHands) || hand.initialHands.length !== 4) throw new Error('配牌データが不正です');
      events.push({ type: 'start_kyoku', bakaze: handIndex >= 4 ? 'S' : 'E', kyoku: (handIndex % 4) + 1,
        honba: config.honba || 0, kyotaku: config.riichiSticks || 0, oya: config.dealer || 0,
        start_dealer: startDealer,
        dora_marker: initialDora == null ? null : tileString(initialDora),
        tehais: hand.initialHands.map((ids) => ids.map(tileString)), scores: (config.scores || []).slice() });
      for (const e of hand.events || []) {
        if (e.type === 'start' || e.type === 'riichi' || e.type === 'response') continue;
        if (e.type === 'draw') events.push({ type: 'tsumo', actor: e.seat,
          pai: maskOtherDraws && e.seat !== seat ? '?' : tileString(e.tileId), ...(e.rinshan ? { rinshan: true } : {}) });
        else if (e.type === 'discard') {
          if (e.riichi) events.push({ type: 'reach', actor: e.seat });
          events.push({ type: 'dahai', actor: e.seat, pai: tileString(e.tileId), tsumogiri: !!e.tsumogiri });
          if (e.riichi && acceptedRiichi.has(e.seat)) events.push({ type: 'reach_accepted', actor: e.seat });
        } else if (e.type === 'call') {
          const meld = e.meld, called = meld.calledTile;
          const consumed = meld.tiles.filter((id) => id !== called && id !== meld.addedTile);
          events.push({ type: e.action.type === 'chi' ? 'chi' : e.action.type === 'pon' ? 'pon' : 'daiminkan',
            actor: e.seat, target: e.from, pai: tileString(called), consumed: consumed.map(tileString) });
        } else if (e.type === 'kan') {
          if (e.action.kind === 'ankan') {
            const meld = (e.melds || []).find((m) => m.kind === 'kan' && !m.open && m.type === e.action.tile);
            events.push({ type: 'ankan', actor: e.seat, consumed: meld.tiles.map(tileString) });
          } else {
            const meld = (e.melds || []).find((m) => m.kind === 'kan' && m.addedTile != null && (m.addedTile >> 2) === e.action.tile);
            events.push({ type: 'kakan', actor: e.seat, pai: tileString(meld.addedTile),
              consumed: meld.tiles.filter((id) => id !== meld.addedTile).map(tileString) });
          }
        } else if (e.type === 'dora') {
          const indicators = e.doraIndicators || [];
          events.push({ type: 'dora', dora_marker: tileString(indicators[indicators.length - 1]) });
        } else if (e.type === 'end') {
          const end = e, result = end.result || {};
          if (result.type === 'win') {
            events.push({ type: 'hora', actor: result.winner, target: result.tsumo ? result.winner : result.loser,
              pai: tileString(result.winTile), tsumo: !!result.tsumo,
              deltas: (end.scores || []).map((s, i) => s - (config.scores[i] || 0)), scores: (end.scores || []).slice(),
              yaku: ((result.score && result.score.yaku) || []).map((y) => y.name),
              han: result.score && result.score.han || 0, fu: result.score && result.score.fu || 0,
              point: result.received || 0, ura_markers: (result.uraIndicators || []).map(tileString) });
          } else {
            events.push({ type: 'ryukyoku', reason: toTenhouReason(result.reason),
              tenpai: (result.tenpai || []).slice(), deltas: (end.scores || []).map((s, i) => s - (config.scores[i] || 0)),
              scores: (end.scores || []).slice() });
          }
          events.push({ type: 'end_kyoku' });
        }
      }
    });
    events.push({ type: 'end_game' });
    return events;
  };

  // ---------------------------------------------------------------------------
  // mjai events -> 翠卓 JSON (rebuilds a valid wall and replayable event log)
  // ---------------------------------------------------------------------------
  M.toSuitaku = function (events, options = {}) {
    if (!Array.isArray(events) || !events.length) throw new Error('mjai events are required');
    const startGame = events.find((e) => e.type === 'start_game') || {};
    const rule = startGame.rule || {};
    if (rule.sanma) throw new Error('三麻牌譜は四人打ちcoreでは扱えません');
    const strict = !!options.strict;
    const flags = [];
    const rounds = [];
    let current = null;
    let sawSouth = false;
    for (const e of events) {
      if (e.type === 'start_kyoku') { if (current) rounds.push(current); current = { start: e, events: [] }; }
      else if (current) {
        if (e.type === 'end_game') { rounds.push(current); current = null; }
        else if (e.type === 'end_kyoku') current.ended = true;
        else current.events.push(e);
      }
    }
    if (current) rounds.push(current);
    if (!rounds.length) throw new Error('start_kyoku がありません');

    // 翠卓 does not adopt nine terminals, nagashi mangan or pao. Keep these as
    // explicit rule differences instead of silently importing them.
    const ruleDiffs = new Set();
    for (const round of rounds) for (const event of round.events) {
      if (event.type === 'ryukyoku') {
        if (event.reason === 'nine_terminals') ruleDiffs.add('nine_terminals');
        if (event.reason === 'nagashi') ruleDiffs.add('nagashi_mangan');
      }
      if (event.type === 'hora' && event.paoWho != null) ruleDiffs.add('pao');
    }
    const DIFF_MESSAGES = {
      nine_terminals: '九種九牌は翠卓のルールでは採用していません',
      nagashi_mangan: '流し満貫は翠卓のルールでは採用していません',
      pao: '包（責任払い）は翠卓のルールでは採用していません'
    };
    if (strict && ruleDiffs.size) throw new Error([...ruleDiffs].map((d) => DIFF_MESSAGES[d]).join(' / ') + '。--strict では除外します');
    flags.push(...ruleDiffs);
    const tenhouSource = options.source === 'tenhou' || rule.source === 'tenhou';

    const firstDealer = Number.isInteger(rule.start_dealer) ? rule.start_dealer
      : Number.isInteger(rounds[0].start.oya) ? rounds[0].start.oya : 0;
    const hands = rounds.map((round, roundIndex) => {
      const pool = createPool();
      const start = round.start;
      if (!Array.isArray(start.tehais) || start.tehais.length !== 4) throw new Error('start_kyoku.tehais が不正です');
      const initialHands = start.tehais.map((arr, seat) => {
        if (!Array.isArray(arr) || arr.length !== 13) throw new Error(`座席${seat}の配牌が13枚ではありません`);
        return arr.map((str) => pool.take(str));
      });
      const scores = Array.isArray(start.scores) && start.scores.length === 4 ? start.scores.slice() : [25000, 25000, 25000, 25000];
      const bakaze = start.bakaze === 'S' ? 28 : 27;
      if (bakaze === 28) sawSouth = true;
      const kyoku = Number.isInteger(start.kyoku) ? Math.max(1, Math.min(4, start.kyoku)) : ((Number(start.oya) || 0) % 4) + 1;
      const handIndex = (bakaze === 28 ? 4 : 0) + kyoku - 1;
      const config = { roundWind: bakaze, dealer: start.oya || 0, startDealer: firstDealer, honba: start.honba || 0,
        riichiSticks: start.kyotaku || 0, scores, hand: handIndex, handIndex, mode: rule.mode || 'tonpu',
        rules: { riichiAnkan: rule.riichi_ankan || 'wait', startDealer: firstDealer } };
      const state = {
        hands: initialHands.map((h) => h.slice()), melds: [[], [], [], []], discards: [[], [], [], []],
        dora: start.dora_marker ? [pool.take(start.dora_marker)] : [], draws: [], lastDraw: [null, null, null, null],
        lastDiscard: [null, null, null, null], rinshan: [false, false, false, false], reach: [false, false, false, false],
        anyCall: false, turn: 0, riichiSticks: config.riichiSticks, result: null, finalScores: null,
        horaCount: 0, ura: [], events: []
      };
      const emit = (event) => state.events.push(Object.assign({ index: state.events.length, turn: state.turn }, event));
      emit({ type: 'start', scores: scores.slice(), doraIndicators: state.dora.slice() });

      for (const e of round.events) {
        switch (e.type) {
          case 'tsumo': {
            const id = pool.take(e.pai);
            const rinshan = !!e.rinshan || state.rinshan[e.actor];
            state.rinshan[e.actor] = false;
            state.hands[e.actor].push(id); state.lastDraw[e.actor] = id;
            state.draws.push({ id, rinshan });
            emit({ type: 'draw', seat: e.actor, tileId: id, rinshan });
            break;
          }
          case 'dahai': {
            const id = takeFromHand(state.hands[e.actor], e.pai, state.lastDraw[e.actor]);
            const tsumogiri = e.tsumogiri == null ? state.lastDraw[e.actor] === id : !!e.tsumogiri;
            remove(state.hands[e.actor], id);
            state.lastDraw[e.actor] = null; state.lastDiscard[e.actor] = id; state.discards[e.actor].push(id);
            emit({ type: 'discard', seat: e.actor, tileId: id, tsumogiri, riichi: !!state.reach[e.actor], called: false });
            state.turn++;
            break;
          }
          case 'reach': state.reach[e.actor] = true; break;
          case 'reach_accepted': {
            const doubleRiichi = !state.anyCall && state.discards[e.actor].length === 1;
            state.reach[e.actor] = false; state.riichiSticks++;
            emit({ type: 'riichi', seat: e.actor, doubleRiichi });
            break;
          }
          case 'chi': case 'pon': case 'daiminkan': {
            const target = e.target, called = state.lastDiscard[target];
            if (called == null) throw new Error(`${e.type}: 鳴かれた牌がありません`);
            const p = parseTile(e.pai);
            if (!p || (called >> 2) !== p.type) throw new Error(`${e.type}: pai と直前の打牌が一致しません`);
            const consumed = [];
            for (const str of e.consumed || []) {
              const id = takeFromHand(state.hands[e.actor], str);
              remove(state.hands[e.actor], id);
              consumed.push(id);
            }
            const meld = { kind: e.type === 'chi' ? 'seq' : e.type === 'pon' ? 'trip' : 'kan',
              type: e.type === 'chi' ? Math.min(called >> 2, ...consumed.map((id) => id >> 2)) : called >> 2,
              open: true, tiles: [called, ...consumed], from: target, calledTile: called };
            state.melds[e.actor].push(meld); state.lastDraw[e.actor] = null; state.lastDiscard[target] = null;
            state.anyCall = true;
            if (e.type === 'daiminkan') state.rinshan[e.actor] = true;
            emit({ type: 'call', seat: e.actor, from: target,
              action: { type: e.type === 'daiminkan' ? 'kan' : e.type, tile: called >> 2,
                ...(e.type === 'chi' ? { tiles: consumed.map((id) => id >> 2) } : {}) }, meld: clone(meld) });
            break;
          }
          case 'ankan': {
            const consumed = [];
            for (const str of e.consumed || []) {
              const id = takeFromHand(state.hands[e.actor], str);
              remove(state.hands[e.actor], id);
              consumed.push(id);
            }
            const meld = { kind: 'kan', type: consumed[0] >> 2, open: false, tiles: consumed.slice() };
            state.melds[e.actor].push(meld); state.lastDraw[e.actor] = null; state.anyCall = true; state.rinshan[e.actor] = true;
            emit({ type: 'kan', seat: e.actor, action: { kind: 'ankan', tile: meld.type }, melds: clone(state.melds[e.actor]) });
            break;
          }
          case 'kakan': {
            const added = takeFromHand(state.hands[e.actor], e.pai);
            remove(state.hands[e.actor], added);
            const meld = state.melds[e.actor].find((m) => m.kind === 'trip' && m.type === (added >> 2));
            if (!meld) throw new Error('kakan: 加槓するポンがありません');
            meld.kind = 'kan'; meld.addedTile = added; meld.tiles.push(added);
            state.lastDraw[e.actor] = null; state.anyCall = true; state.rinshan[e.actor] = true;
            emit({ type: 'kan', seat: e.actor, action: { kind: 'kakan', tile: added >> 2 }, melds: clone(state.melds[e.actor]) });
            break;
          }
          case 'dora': {
            state.dora.push(pool.take(e.dora_marker));
            emit({ type: 'dora', doraIndicators: state.dora.slice() });
            break;
          }
          case 'hora': {
            state.horaCount++;
            if (state.horaCount > 1) {
              flags.push('multiple_hora');
              if (strict) throw new Error('複数ロン（ダブロン）は頭ハネ設定と異なるため除外します');
              break;
            }
            const tsumo = !!e.tsumo;
            let winTile;
            if (tsumo) {
              winTile = findInHand(state.hands[e.actor], e.pai, state.lastDraw[e.actor]);
              if (winTile == null) throw new Error('hora: ツモ和了牌が手牌にありません');
            } else {
              winTile = state.lastDiscard[e.target];
              if (winTile == null) throw new Error('hora: ロン和了牌がありません');
            }
            state.ura = (e.ura_markers || []).map((str) => pool.take(str));
            const finalScores = Array.isArray(e.scores) && e.scores.length === 4 ? e.scores.slice()
              : e.deltas ? scores.map((s, i) => s + (e.deltas[i] || 0)) : null;
            if (!finalScores) throw new Error('hora: scores も deltas もありません');
            const deltas = Array.isArray(e.deltas) && e.deltas.length === 4 ? e.deltas.slice()
              : finalScores.map((s, i) => s - scores[i]);
            const yaku = (e.yaku || []).map((y) => typeof y === 'string' ? { name: y, han: 0 } : { name: String(y.name || y), han: Number(y.han) || 0 });
            const result = { type: 'win', winner: e.actor, loser: tsumo ? null : (e.target == null ? null : e.target),
              tsumo, score: { han: Number(e.han) || 0, fu: Number(e.fu) || 0, yaku, dora: Number(e.dora) || 0,
                yakuman: !!e.yakuman, payments: {} }, winTile, uraIndicators: state.ura.slice(),
              received: deltas[e.actor] || 0, sticks: config.riichiSticks,
              ...(e.paoWho == null ? {} : { paoWho: e.paoWho }) };
            state.result = result; state.finalScores = finalScores; state.riichiSticks = 0;
            emit({ type: 'end', scores: finalScores.slice(), result, riichiSticks: 0 });
            break;
          }
          case 'ryukyoku': {
            const finalScores = Array.isArray(e.scores) && e.scores.length === 4 ? e.scores.slice()
              : e.deltas ? scores.map((s, i) => s + (e.deltas[i] || 0)) : scores.slice();
            const result = { type: 'draw', tenpai: (e.tenpai || []).slice(), reason: (e.reason || 'exhaustive').replace(/_/g, '-') };
            state.result = result; state.finalScores = finalScores;
            emit({ type: 'end', scores: finalScores.slice(), result, riichiSticks: state.riichiSticks });
            break;
          }
          default: break;
        }
      }
      if (!state.result || !state.finalScores) throw new Error(`局${handIndex + 1}: 和了・流局イベントがありません`);

      const wall = new Array(136).fill(null);
      let pos = 0;
      for (let seat = 0; seat < 4; seat++) for (const id of initialHands[seat]) wall[pos++] = id;
      let live = 52, rinshanCount = 0;
      for (const d of state.draws) {
        if (d.rinshan) { if (rinshanCount >= 4) throw new Error('嶺上牌が4枚を超えています'); wall[122 + rinshanCount++] = d.id; }
        else { if (live >= 122) throw new Error('生牌山が不足しています'); wall[live++] = d.id; }
      }
      for (let i = 0; i < state.dora.length; i++) {
        if (i >= 5) throw new Error('ドラ表示牌が5枚を超えています');
        wall[126 + i * 2] = state.dora[i];
      }
      for (let i = 0; i < state.ura.length; i++) {
        if (i >= 5) throw new Error('裏ドラ表示牌が5枚を超えています');
        wall[127 + i * 2] = state.ura[i];
      }
      const remaining = pool.remaining();
      let ri = 0;
      for (let i = 0; i < 136; i++) if (wall[i] == null) wall[i] = remaining[ri++];
      if (ri !== remaining.length || wall.some((id) => id == null) || new Set(wall).size !== 136) throw new Error('牌山の再構築に失敗しました');

      return { config, wall, initialHands: initialHands.map((h) => h.slice().sort((a, b) => a - b)),
        events: state.events, result: state.result, finalScores: state.finalScores };
    });

    const hasRed = events.some((e) => {
      const tiles = [e.pai, ...(e.consumed || []), ...(e.ura_markers || []), e.dora_marker];
      if (e.type === 'start_kyoku') for (const hand of e.tehais || []) tiles.push(...hand);
      return ['5mr', '5pr', '5sr', '0m', '0p', '0s'].some((t) => tiles.includes(t));
    });
    if (rule.aka === false && hasRed) {
      flags.push('red_mismatch');
      if (strict) throw new Error('赤なしの牌譜に赤5が含まれています');
    }
    if (rule.kuitan === false) {
      flags.push('no_kuitan');
      if (strict) throw new Error('喰いタンなしの牌譜は現在のルールと異なります');
    }
    const mode = rule.mode === 'hanchan' || sawSouth ? 'hanchan' : 'tonpu';
    const record = {
      format: 'suitaku-riichi', version: 1, createdAt: options.createdAt || new Date().toISOString(),
      mode, ai: 'imported', startDealer: firstDealer,
      rules: { players: 4, initialScore: 25000, redFives: rule.aka === false ? 0 : 3,
        openTanyao: rule.kuitan !== false, ron: rule.atamahane === false ? 'multiple' : 'atamahane',
        dealerTenpaiRepeat: true, agariYame: false, extension: false, kuikae: false,
        nineTerminals: false, nagashiMangan: false, riichiAnkan: rule.riichi_ankan || 'wait', startDealer: firstDealer },
      hands, annotations: [], finalScores: hands[hands.length - 1].finalScores.slice(), finished: true,
      mjai: { rule: clone(rule), flags: [...new Set(flags)], source: options.source || 'mjai' }
    };
    if (tenhouSource) {
      record.rules.returnScore = 30000;
      record.rules.pao = false;
      record.mjai.tenhou = {
        startScore: 25000, returnScore: 30000, okaPerFirst: 20,
        rankConfig: { name: 'tenhou', uma: [90, 45, 0, -135], startScore: 25000, returnScore: 30000, scoreUnit: 1000, scoreWeight: 0 },
        note: '天鳳は30000点返し（オカ20）です。翠卓の rankConfig tenhou は25000点返しなので、順位点を比較するときはこの差を適用してください。'
      };
    }
    return record;
  };

  M.validate = function (record) {
    MJ.record.validate(record);
    const warnings = [];
    for (let i = 0; i < record.hands.length; i++) {
      const hand = record.hands[i];
      let replay;
      try { replay = MJ.record.snapshot(hand, hand.events.length - 1); }
      catch (e) { throw new Error(`局${i + 1}のリプレイに失敗しました: ${e.message}`); }
      const got = replay.players.map((p) => p.score);
      const expected = hand.finalScores || (hand.events.filter((e) => e.type === 'end').slice(-1)[0] || {}).scores;
      if (expected && JSON.stringify(got) !== JSON.stringify(expected)) warnings.push(`局${i + 1}: 最終点数が一致しません ${got} != ${expected}`);
      const sum = got.reduce((a, b) => a + b, 0) + replay.riichiSticks * 1000;
      if (sum !== 100000) warnings.push(`局${i + 1}: 点数と供託の合計が100,000点ではありません (${sum})`);
      if (hand.events.some((e, index) => e.index != null && e.index !== index)) warnings.push(`局${i + 1}: イベント番号が連続していません`);
    }
    return { ok: warnings.length === 0, warnings };
  };

  // ---------------------------------------------------------------------------
  // Tenhou mjlog XML -> mjai events
  // ---------------------------------------------------------------------------
  M.fromTenhou = function (xml, options = {}) {
    if (typeof xml !== 'string') throw new Error('mjlog XML text is required');
    const tags = [];
    const re = /<([A-Za-z0-9]+)((?:\s+[^>]*?)?)\s*\/?>/g;
    let match;
    while ((match = re.exec(xml))) {
      const attrs = {};
      const ar = /([A-Za-z0-9_]+)="([^"]*)"/g;
      let a;
      while ((a = ar.exec(match[2]))) attrs[a[1]] = a[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      tags.push({ tag: match[1], attrs });
    }
    const decodeName = (s) => { try { return decodeURIComponent(s); } catch (_) { return s; } };
    const events = [];
    let go = 0, names = ['P0', 'P1', 'P2', 'P3'], startEmitted = false;
    let round = null, roundEnded = false, roundIndex = 0;
    let lastDraw = [null, null, null, null], lastDiscard = [null, null, null, null], rinshanPending = [false, false, false, false];
    const emitStart = () => {
      if (startEmitted) return;
      startEmitted = true;
      events.push({ type: 'start_game', names: names.slice(),
        rule: { aka: !(go & 0x02), kuitan: !(go & 0x04), atamahane: true, sanma: !!(go & 0x10),
          mode: go & 0x08 ? 'hanchan' : 'tonpu', source: 'tenhou' } });
    };
    const finishRound = () => { if (roundEnded) { events.push({ type: 'end_kyoku' }); roundEnded = false; round = null; } };

    for (const { tag, attrs } of tags) {
      if (roundEnded && tag !== 'AGARI') finishRound();
      if (tag === 'GO') { go = Number(attrs.type) || 0; continue; }
      if (tag === 'UN' && attrs.dan && !startEmitted) {
        for (let i = 0; i < 4; i++) if (attrs['n' + i] != null) names[i] = decodeName(attrs['n' + i]);
        continue;
      }
      if (tag === 'TAIKYOKU' || tag === 'INIT') emitStart();
      if (tag === 'INIT') {
        if (go & 0x10) throw new Error('三麻牌譜は四人打ちcoreでは扱えません');
        const seed = (attrs.seed || '0,0,0,0,0,0').split(',').map(Number);
        const kyoku = seed[0] || 0, honba = seed[1] || 0, kyotaku = seed[2] || 0, dora = seed[5];
        const ten = (attrs.ten || '250,250,250,250').split(',').map((x) => Number(x) * 100);
        const oya = Number(attrs.oya) || 0;
        const tehais = [0, 1, 2, 3].map((s) => (attrs['hai' + s] || '').split(',').filter(Boolean).map((x) => tileString(Number(x))));
        if (tehais.some((h) => h.length !== 13)) throw new Error(`天鳳局${roundIndex + 1}: 配牌が13枚ではありません`);
        events.push({ type: 'start_kyoku', bakaze: kyoku < 4 ? 'E' : 'S', kyoku: kyoku % 4 + 1, honba,
          kyotaku, oya, dora_marker: dora == null || Number.isNaN(dora) ? null : tileString(dora), tehais, scores: ten });
        round = { index: roundIndex++ }; roundEnded = false;
        lastDraw = [null, null, null, null]; lastDiscard = [null, null, null, null]; rinshanPending = [false, false, false, false];
        continue;
      }
      const drawMatch = /^([TUVW])(\d+)$/.exec(tag);
      if (drawMatch) {
        const seat = 'TUVW'.indexOf(drawMatch[1]), id = Number(drawMatch[2]);
        const rinshan = rinshanPending[seat]; rinshanPending[seat] = false;
        events.push({ type: 'tsumo', actor: seat, pai: tileString(id), ...(rinshan ? { rinshan: true } : {}) });
        lastDraw[seat] = id;
        continue;
      }
      const discardMatch = /^([DEFG])(\d+)$/.exec(tag);
      if (discardMatch) {
        const seat = 'DEFG'.indexOf(discardMatch[1]), id = Number(discardMatch[2]);
        events.push({ type: 'dahai', actor: seat, pai: tileString(id), tsumogiri: lastDraw[seat] === id });
        lastDraw[seat] = null; lastDiscard[seat] = id;
        continue;
      }
      if (tag === 'N') {
        const who = Number(attrs.who), m = Number(attrs.m);
        const decoded = decodeMeld(m);
        const target = (who + decoded.from) % 4;
        if (decoded.kind === 'ankan') {
          events.push({ type: 'ankan', actor: who, consumed: decoded.tiles.map(tileString) });
        } else if (decoded.kind === 'kakan') {
          events.push({ type: 'kakan', actor: who, pai: tileString(decoded.called),
            consumed: decoded.tiles.filter((id) => id !== decoded.called).map(tileString) });
        } else {
          const called = lastDiscard[target] != null && decoded.tiles.some((id) => (id >> 2) === (lastDiscard[target] >> 2))
            ? lastDiscard[target] : decoded.called;
          let calledIndex = lastDiscard[target] != null ? decoded.tiles.indexOf(lastDiscard[target]) : -1;
          if (calledIndex < 0) calledIndex = decoded.tiles.findIndex((id) => (id >> 2) === (called >> 2));
          const consumed = decoded.tiles.filter((_, index) => index !== calledIndex);
          events.push({ type: decoded.kind === 'chi' ? 'chi' : decoded.kind === 'pon' ? 'pon' : 'daiminkan',
            actor: who, target, pai: tileString(called), consumed: consumed.map(tileString) });
        }
        lastDraw[who] = null;
        if (decoded.kind === 'chi' || decoded.kind === 'pon' || decoded.kind === 'daiminkan') lastDiscard[target] = null;
        if (decoded.kind === 'ankan' || decoded.kind === 'kakan' || decoded.kind === 'daiminkan') rinshanPending[who] = true;
        continue;
      }
      if (tag === 'REACH') {
        events.push({ type: Number(attrs.step) === 2 ? 'reach_accepted' : 'reach', actor: Number(attrs.who) });
        continue;
      }
      if (tag === 'DORA') { events.push({ type: 'dora', dora_marker: tileString(Number(attrs.hai)) }); continue; }
      if (tag === 'AGARI') {
        const who = Number(attrs.who), fromWho = Number(attrs.fromWho);
        const sc = (attrs.sc || '').split(',').map(Number);
        const ten = (attrs.ten || '30,0,0').split(',').map(Number);
        const yakuRaw = (attrs.yaku || '').split(',').filter(Boolean).map(Number);
        const yaku = [];
        for (let i = 0; i + 1 < yakuRaw.length; i += 2) yaku.push(yakuName(yakuRaw[i]));
        // Tenhou's sc is (score before the result, delta) per seat, in 100-point units.
        const scores = [0, 1, 2, 3].map((i) => ((sc[i * 2] || 0) + (sc[i * 2 + 1] || 0)) * 100);
        const deltas = [0, 1, 2, 3].map((i) => (sc[i * 2 + 1] || 0) * 100);
        const ura = (attrs.doraHaiUra || '').split(',').filter(Boolean).map((x) => tileString(Number(x)));
        events.push({ type: 'hora', actor: who, target: who === fromWho ? who : fromWho,
          pai: tileString(Number(attrs.machi)), tsumo: who === fromWho, deltas, scores,
          yaku, han: yakuRaw.filter((_, i) => i % 2 === 1).reduce((a, b) => a + b, 0), fu: ten[0] || 0,
          point: ten[1] || deltas[who], ura_markers: ura,
          ...(attrs.paoWho == null ? {} : { paoWho: Number(attrs.paoWho) }) });
        roundEnded = true;
        continue;
      }
      if (tag === 'RYUUKYOKU') {
        const sc = (attrs.sc || '').split(',').map(Number);
        // Tenhou's sc is (score before the result, delta) per seat, in 100-point units.
        const scores = [0, 1, 2, 3].map((i) => ((sc[i * 2] || 0) + (sc[i * 2 + 1] || 0)) * 100);
        const deltas = [0, 1, 2, 3].map((i) => (sc[i * 2 + 1] || 0) * 100);
        const tenpai = [0, 1, 2, 3].filter((i) => attrs['hai' + i] != null);
        events.push({ type: 'ryukyoku', reason: mapTenhouReason(attrs.type), tenpai, deltas, scores });
        roundEnded = true;
        continue;
      }
      if (tag === 'owari' && options.keepOwari) events.push({ type: 'owari', raw: attrs.owari || '' });
    }
    finishRound();
    events.push({ type: 'end_game' });
    return events;
  };

  // ---------------------------------------------------------------------------
  // Tenhou wall reproduction (optional verification)
  //
  // The seed in <SHUFFLE seed="mt19937ar-sha512-n288-base64,..."> is decoded to
  // 624 little-endian uint32 values and used with mt19937ar init_by_array.
  // Each hand consumes 288 uint32 values -> nine SHA-512 blocks -> 144 uint32
  // values used by Fisher-Yates. The generated array has the dead wall at the
  // head and the live wall at the tail (draws run from index 135 downwards).
  // ---------------------------------------------------------------------------
  function mt19937FromSeed(seedBytes) {
    if (seedBytes.length !== 624 * 4) throw new Error('天鳳seedは624個の32bit整数（2496バイト）ではありません');
    const key = new Uint32Array(624);
    for (let i = 0; i < 624; i++) key[i] = seedBytes.readUInt32LE ? seedBytes.readUInt32LE(i * 4)
      : (seedBytes[i * 4] | (seedBytes[i * 4 + 1] << 8) | (seedBytes[i * 4 + 2] << 16) | (seedBytes[i * 4 + 3] << 24)) >>> 0;
    const mt = new Uint32Array(624);
    let index = 624;
    const initGenrand = (s) => {
      mt[0] = s >>> 0; index = 1;
      while (index < 624) { mt[index] = (Math.imul(1812433253, mt[index - 1] ^ (mt[index - 1] >>> 30)) + index) >>> 0; index++; }
    };
    initGenrand(19650218);
    let i = 1, j = 0, k = Math.max(624, key.length);
    for (; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1664525)) + key[j] + j) >>> 0;
      i++; j++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (k = 623; k; k--) {
      mt[i] = ((mt[i] ^ Math.imul(mt[i - 1] ^ (mt[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      i++;
      if (i >= 624) { mt[0] = mt[623]; i = 1; }
    }
    mt[0] = 0x80000000;
    const generate = () => {
      for (let n = 0; n < 624; n++) {
        const y = (mt[n] & 0x80000000) | (mt[(n + 1) % 624] & 0x7fffffff);
        mt[n] = mt[(n + 397) % 624] ^ (y >>> 1) ^ ((y & 1) ? 0x9908b0df : 0);
      }
      index = 0;
    };
    return function genrand() {
      if (index >= 624) generate();
      let y = mt[index++];
      y ^= y >>> 11; y ^= (y << 7) & 0x9d2c5680; y ^= (y << 15) & 0xefc60000; y ^= y >>> 18;
      return y >>> 0;
    };
  }
  function nodeSha512() {
    try {
      if (typeof require === 'function') return (bytes) => require('node:crypto').createHash('sha512').update(bytes).digest();
    } catch (_) { /* browser */ }
    return null;
  }
  M.tenhouSeed = function (xml) {
    if (typeof xml !== 'string') throw new Error('mjlog XML text is required');
    const match = /<SHUFFLE\s+seed="([^"]+)"/.exec(xml);
    if (!match) throw new Error('SHUFFLE seed がありません');
    return match[1].includes(',') ? match[1].slice(match[1].lastIndexOf(',') + 1) : match[1];
  };
  M.tenhouWalls = function (xml, options = {}) {
    if (typeof xml !== 'string') throw new Error('mjlog XML text is required');
    const sha512 = nodeSha512();
    if (!sha512) throw new Error('牌山の再現にはNode.jsのcryptoが必要です');
    const b64 = M.tenhouSeed(xml);
    let seedBytes;
    try { seedBytes = Buffer.from(b64, 'base64'); } catch (_) { throw new Error('天鳳seedのbase64デコードに失敗しました'); }
    const genrand = mt19937FromSeed(seedBytes);
    const rounds = Number.isInteger(options.rounds) ? options.rounds : (xml.match(/<INIT\b/g) || []).length;
    const walls = [];
    for (let round = 0; round < rounds; round++) {
      const src = new Uint32Array(288);
      for (let i = 0; i < 288; i++) src[i] = genrand();
      const rnd = [];
      for (let block = 0; block < 9; block++) {
        const bytes = Buffer.alloc(128);
        for (let i = 0; i < 32; i++) bytes.writeUInt32LE(src[block * 32 + i], i * 4);
        const digest = sha512(bytes);
        for (let i = 0; i < 16; i++) rnd.push(digest.readUInt32LE(i * 4));
      }
      const yama = Array.from({ length: 136 }, (_, i) => i);
      for (let i = 0; i < 135; i++) {
        const j = rnd[i] % (136 - i) + i;
        const tmp = yama[i]; yama[i] = yama[j]; yama[j] = tmp;
      }
      walls.push(yama);
    }
    return walls;
  };
  // Convert one Tenhou yama into the deal/draw order used by Game#setup.
  // Tenhou deals from the tail: 4 tiles per seat for three rounds, then one.
  M.tenhouWallLayout = function (yama, dealer) {
    if (!Array.isArray(yama) || yama.length !== 136) throw new Error('yama must have 136 tiles');
    const d = Number.isInteger(dealer) && dealer >= 0 && dealer < 4 ? dealer : 0;
    const dealt = [[], [], [], []];
    for (let batch = 0; batch < 3; batch++) {
      for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) {
        dealt[(d + i) % 4].push(yama[135 - (batch * 16 + i * 4 + k)]);
      }
    }
    for (let i = 0; i < 4; i++) dealt[(d + i) % 4].push(yama[87 - i]);
    const live = [];
    for (let i = 83; i >= 14; i--) live.push(yama[i]);
    return { dealt, live, rinshan: yama.slice(0, 4), dora: [5, 7, 9, 11, 13].map((i) => yama[i]),
      ura: [4, 6, 8, 10, 12].map((i) => yama[i]) };
  };
  M.verifyTenhouWall = function (xml, record, options = {}) {
    if (!record || !Array.isArray(record.hands)) throw new Error('翠卓レコードが必要です');
    const walls = M.tenhouWalls(xml, { rounds: record.hands.length });
    const rounds = [];
    let ok = true;
    record.hands.forEach((hand, index) => {
      const yama = walls[index];
      if (!yama) { ok = false; rounds.push({ index, ok: false, errors: ['牌山を再現できませんでした'] }); return; }
      const config = hand.config || {};
      const layout = M.tenhouWallLayout(yama, config.dealer);
      const errors = [];
      // mjai/mjlog do not preserve the physical copy number, so compare the tile
      // type and the red-five flag (the red copy is preserved by the importer).
      const sig = (id) => String(id >> 2) + (T.isRed(id) ? 'r' : '');
      const sigs = (ids) => ids.map(sig);
      const sort = (a) => a.slice().sort();
      const same = (a, b) => JSON.stringify(sort(sigs(a))) === JSON.stringify(sort(sigs(b)));
      for (let seat = 0; seat < 4; seat++) {
        if (!same(hand.initialHands[seat], layout.dealt[seat])) errors.push(`座席${seat}の配牌が一致しません`);
      }
      const draws = (hand.events || []).filter((e) => e.type === 'draw' && !e.rinshan).map((e) => sig(e.tileId));
      if (JSON.stringify(draws) !== JSON.stringify(sigs(layout.live.slice(0, draws.length)))) errors.push('生牌山のツモ順が一致しません');
      const start = (hand.events || []).find((e) => e.type === 'start');
      let indicators = start && start.doraIndicators ? start.doraIndicators.slice() : [];
      for (const e of hand.events || []) if (e.type === 'dora') indicators = e.doraIndicators.slice();
      if (indicators.length && JSON.stringify(sigs(indicators)) !== JSON.stringify(sigs(layout.dora.slice(0, indicators.length)))) errors.push('ドラ表示牌が一致しません');
      const rinshan = (hand.events || []).filter((e) => e.type === 'draw' && e.rinshan).map((e) => sig(e.tileId));
      if (rinshan.length && JSON.stringify(rinshan) !== JSON.stringify(sigs(layout.rinshan.slice(0, rinshan.length)))) errors.push('嶺上牌が一致しません');
      const result = hand.result || ((hand.events || []).filter((e) => e.type === 'end').slice(-1)[0] || {}).result;
      if (result && Array.isArray(result.uraIndicators) && result.uraIndicators.length &&
        JSON.stringify(sigs(result.uraIndicators)) !== JSON.stringify(sigs(layout.ura.slice(0, result.uraIndicators.length)))) errors.push('裏ドラ表示牌が一致しません');
      if (errors.length) ok = false;
      rounds.push({ index, ok: errors.length === 0, errors, rinshanObserved: rinshan.length });
    });
    return { ok, rounds };
  };

  function decodeMeld(m) {
    const from = m & 3;
    if (m & 0x4) {
      let t = m >> 10;
      const r = t % 3;
      t = Math.floor(t / 3);
      const base = Math.floor(t / 7) * 9 + t % 7;
      const ofs = [(m >> 3) & 3, (m >> 5) & 3, (m >> 7) & 3];
      const tiles = [0, 1, 2].map((i) => (base + i) * 4 + ofs[i]);
      return { kind: 'chi', tiles, from, called: tiles[r] };
    }
    if (m & 0x8) {
      let t = m >> 9;
      const r = t % 3;
      t = Math.floor(t / 3);
      const unused = (m >> 5) & 3;
      const tiles = [0, 1, 2, 3].map((i) => t * 4 + i).filter((id) => (id & 3) !== unused);
      return { kind: 'pon', tiles, from, called: tiles[r] };
    }
    if (m & 0x10) {
      const t = Math.floor((m >> 9) / 3);
      const added = t * 4 + ((m >> 5) & 3);
      return { kind: 'kakan', tiles: [0, 1, 2, 3].map((i) => t * 4 + i), from, called: added };
    }
    const type = Math.floor((m >> 8) / 4);
    return { kind: from === 0 ? 'ankan' : 'daiminkan', tiles: [0, 1, 2, 3].map((i) => type * 4 + i), from, called: null };
  }

  // Partial Tenhou yaku-ID table. Unknown IDs remain visible as yaku_<id>.
  const YAKU_NAMES = {
    0: '門前清自摸和', 1: '立直', 2: '一発', 3: '槍槓', 4: '嶺上開花', 5: '海底摸月', 6: '河底撈魚',
    7: '平和', 8: '断幺九', 9: '一盃口', 10: '自風牌', 11: '場風牌', 12: '白', 13: '發', 14: '中',
    15: 'ドラ', 16: '裏ドラ', 17: '両立直', 18: '白', 19: '發', 20: '中', 21: '混全帯幺九',
    22: '七対子', 23: '混一色', 24: '純全帯幺九', 25: '混老頭', 26: '小三元', 27: '三色同刻',
    28: '対々和', 29: '三暗刻', 30: '三槓子', 31: '三色同順', 32: '一気通貫', 33: '二盃口',
    34: '混一色', 35: '清一色', 36: '人和', 37: '天和', 38: '地和', 39: '大三元', 40: '四暗刻',
    41: '四暗刻単騎', 42: '緑一色', 43: '清老頭', 44: '九蓮宝燈', 45: '純正九蓮宝燈', 46: '国士無双',
    47: '国士無双十三面', 48: '小四喜', 49: '大四喜', 50: '字一色', 51: '四槓子', 52: 'ドラ',
    53: '裏ドラ', 54: '赤ドラ', 55: '八連荘'
  };
  function yakuName(id) { return YAKU_NAMES[id] || ('yaku_' + id); }
  M.yakuName = yakuName;
  M.decodeTenhouMeld = decodeMeld;
})();
