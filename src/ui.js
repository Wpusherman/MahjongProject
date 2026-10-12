(function () {
  const MJ = globalThis.MJ, T = MJ.tiles;
  const $ = (id) => document.getElementById(id);
  const NAMES = ['あなた', 'COM 1', 'COM 2', 'COM 3'];
  const WINDS = ['東', '南', '西', '北'];
  const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ui = MJ.ui = { game: null, humanSeat: 0, mode: null, running: false, fast: false, token: 0,
    record: null, review: null, pending: null, discardResolve: null, riichiWanted: false, level: 'strong' };
  const button = (label, action, cls) => { const b = document.createElement('button'); b.textContent = label; b.onclick = action; if (cls) b.className = cls; return b; };
  function toast(message) {
    $('toast').textContent = message; $('toast').classList.add('visible');
    clearTimeout(ui.toastTimer); ui.toastTimer = setTimeout(() => $('toast').classList.remove('visible'), 3200);
  }
  function tileEl(type, opts = {}) {
    const d = document.createElement(opts.clickable ? 'button' : 'div');
    d.className = 'tile ' + T.suitOf(type) + (type >= 27 ? ' h' + type : '') +
      ['small', 'mini', 'back', 'clickable', 'dim', 'red', 'drawn'].filter((c) => opts[c]).map((c) => ' ' + c).join('') + (opts.highlight ? ' tsumo-highlight' : '');
    d.title = opts.back ? '裏向きの牌' : (opts.red ? '赤' : '') + T.label(type);
    d.setAttribute('aria-label', d.title);
    if (!opts.back) {
      const glyph = document.createElement('span'); glyph.className = 'glyph';
      glyph.textContent = type < 9 ? 'qwertyuio'[type] : type < 18 ? 'zxcvbnm,.'[type - 9] : type < 27 ? 'asdfghjkl'[type - 18] : '1234567'[type - 27];
      glyph.setAttribute('aria-hidden', 'true'); d.appendChild(glyph);
    }
    if (opts.clickable) d.onclick = opts.onClick;
    if (opts.sideways) { const slot = document.createElement('span'); slot.className = 'sideways-slot'; slot.appendChild(d); return slot; }
    return d;
  }
  function appendTile(parent, id, opts) { return parent.appendChild(tileEl(id >> 2, { red: T.isRed(id), ...opts })); }
  function appendLog(msg, data) {
    const div = document.createElement('div');
    div.textContent = msg.replace(/P([1-4])/g, (_, s) => NAMES[Number(s) - 1]);
    if (data && data.eventIndex != null) {
      const tag = document.createElement('span'); tag.className = 'log-index'; tag.textContent = '#' + data.eventIndex;
      div.prepend(tag);
    }
    $('log').appendChild(div); $('log').scrollTop = $('log').scrollHeight;
  }
  function renderSeat(seat, game) {
    const el = $('seat-' + seat), p = game.players[seat]; el.innerHTML = '';
    const human = seat === 0;
    el.classList.toggle('active', game.currentSeat === seat && !game.ended);
    const head = document.createElement('div'); head.className = 'seat-head';
    head.innerHTML = `<span class="wind">${WINDS[game.seatWindOf(seat) - 27]}</span><span>${NAMES[seat]}</span><span class="score">${p.score.toLocaleString()}</span>` +
      (p.riichi ? '<span class="riichi-flag">● リーチ</span>' : '');
    const row = document.createElement('div'); row.className = 'hand-row';
    const reveal = human || (ui.review && ui.review.reveal) || (game.ended && game.result && (game.result.winner === seat || (game.result.tenpai || []).includes(seat)));
    const ids = MJ.sortHand(p.hand.filter((id) => id !== p.drawnTile));
    // The draw is always at the player's own left edge, including rotated opponents.
    if (p.drawnTile != null) ids.unshift(p.drawnTile);
    for (const id of ids) {
      const drawn = id === p.drawnTile;
      const legal = !p.forbidden.includes(id >> 2) && (!p.riichi || drawn) && (!ui.riichiWanted || game.waits(seat, p.hand.filter((x) => x !== id)).length > 0);
      appendTile(row, id, { back: !reveal, drawn, clickable: human && ui.mode === 'discard' && legal && !ui.review,
        highlight: human && drawn && ui.mode === 'discard', dim: human && ui.mode === 'discard' && !legal,
        onClick: () => onTileClick(id) });
    }
    el.appendChild(head); el.appendChild(row);
    const mr = document.createElement('div'); mr.className = 'melds-row';
    for (const m of p.melds) {
      const md = document.createElement('div'); md.className = 'meld';
      const tiles = m.tiles.filter((id) => id !== m.addedTile);
      if (m.open && m.calledTile != null) {
        const sorted = tiles.filter((id) => id !== m.calledTile).sort((a, b) => a - b);
        const distance = (m.from - seat + 4) % 4;
        sorted.splice(distance === 3 ? 0 : distance === 2 ? 1 : sorted.length, 0, m.calledTile);
        tiles.splice(0, tiles.length, ...sorted);
      }
      tiles.forEach((id, i) => appendTile(md, id, { mini: true, back: !m.open && (i === 0 || i === tiles.length - 1), sideways: m.open && id === m.calledTile }));
      if (m.addedTile != null) {
        const called = md.querySelector('.sideways-slot');
        if (called) {
          const added = appendTile(called, m.addedTile, { mini: true });
          added.classList.add('added-kan'); added.title = '加槓';
        }
      }
      mr.appendChild(md);
    }
    el.appendChild(mr);
  }
  function renderRiver(seat, game) {
    const root = $('river-' + seat); root.innerHTML = '';
    const p = game.players[seat]; let row;
    let pendingRiichi = false;
    const visible = [];
    for (const d of p.discardHistory) {
      if (d.riichi) pendingRiichi = true;
      if (d.called) continue;
      visible.push({ ...d, sideways: pendingRiichi }); pendingRiichi = false;
    }
    visible.forEach((d, i) => {
      if (i === 0 || i === 6 || i === 12) { row = document.createElement('div'); row.className = 'river-row'; root.appendChild(row); }
      const el = appendTile(row, d.tileId, { mini: true, sideways: d.sideways });
      const tile = d.sideways ? el.firstChild : el;
      if (d.tsumogiri) tile.classList.add('tsumogiri');
      if (game.lastDiscard && game.lastDiscard.tileId === d.tileId) tile.classList.add('latest');
      tile.title += ` · ${d.tsumogiri ? 'ツモ切り' : '手出し'}${d.riichi ? ' · リーチ宣言' : ''} · #${d.eventIndex}`;
    });
  }
  function guide(game) {
    const root = $('hand-guide'); root.innerHTML = '';
    if (!$('show-guide').checked) { root.textContent = '手牌ガイドはオフです'; return; }
    const p = game.players[0], counts = T.countsFromIds(p.hand);
    const sh = MJ.shanten.shanten(counts, p.melds.length);
    root.textContent = sh < 0 ? '和了形' : sh === 0 ? 'テンパイ' : `${sh} 向聴`;
    if (p.hand.length % 3 === 1 && sh === 0) {
      const waits = game.waits(0), unseen = game.computeUnseen(0), row = document.createElement('div'); row.className = 'guide-tiles';
      for (const t of waits) row.appendChild(tileEl(t, { mini: true }));
      root.appendChild(row);
      const note = document.createElement('div'); note.className = 'muted';
      note.textContent = `未見 ${waits.reduce((n, t) => n + unseen[t], 0)}枚${game.isFuriten(0) ? ' / フリテン' : ''}`; root.appendChild(note);
    }
  }
  function animateDiscard(game) {
    const d = game.lastDiscard;
    if (!d || ui.review) return;
    // Re-renders must not restart the same discard animation.
    const key = d.eventIndex + ':' + d.tileId;
    if (ui.animationKey === key) return;
    ui.animationKey = key;
    if (ui.fast || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const flight = $('discard-flight'); flight.innerHTML = '';
    appendTile(flight, d.tileId, { mini: true });
    const source = d.tsumogiri ? [[146, 790], [790, 730], [730, 87], [87, 146]][d.seat] : [[440, 790], [790, 440], [440, 87], [87, 440]][d.seat];
    const targets = [[410, 610], [604, 407], [408, 238], [240, 407]];
    const target = targets[d.seat], angle = [0, -90, 180, 90][d.seat];
    flight.style.left = source[0] + 'px'; flight.style.top = source[1] + 'px';
    if (flight.animate) {
      const a = flight.animate([{ transform: `rotate(${angle}deg)`, opacity: 1 }, { transform: `translate(${target[0] - source[0]}px,${target[1] - source[1]}px) rotate(${angle}deg)`, opacity: 0 }], { duration: 260, easing: 'ease-out' });
      a.onfinish = () => { flight.innerHTML = ''; };
    }
  }
  function render(game = ui.game) {
    if (!game || !game.players) return;
    $('table').classList.toggle('review-mode', !!ui.review);
    $('wall-info').innerHTML = `${game.liveRemaining()}<small>枚</small>`;
    $('wall-meter-fill').style.width = game.liveRemaining() / 70 * 100 + '%';
    $('round-info').textContent = `${WINDS[game.roundWind - 27]}${game.dealer + 1}局 ${game.honba}本場`;
    const di = $('dora-info'); di.innerHTML = '';
    for (let i = 0; i < 5; i++) {
      const id = game.doraIndicators[i];
      di.appendChild(tileEl(id == null ? 0 : id >> 2, { small: true, back: id == null, red: id != null && T.isRed(id) }));
    }
    $('center').innerHTML = `<span class="center-tag">${ui.review ? 'REPLAY' : ui.record && ui.record.mode === 'hanchan' ? 'HANCHAN' : 'TONPU'}</span><div class="center-round">${WINDS[game.roundWind - 27]} ${game.dealer + 1} 局</div><div class="center-remaining">${game.liveRemaining()}<small>枚</small></div><div class="info-line"><span>${game.honba} 本場</span><span>供託 ${game.riichiSticks}</span></div>`;
    for (let s = 0; s < 4; s++) { renderSeat(s, game); renderRiver(s, game); }
    guide(game); animateDiscard(game);
  }
  function onTileClick(id) {
    if (!ui.discardResolve || ui.mode !== 'discard') return;
    const p = ui.game.players[0];
    if (p.forbidden.includes(id >> 2) || (p.riichi && id !== p.drawnTile)) return;
    if (ui.riichiWanted && !ui.game.waits(0, p.hand.filter((x) => x !== id)).length) return;
    const resolve = ui.discardResolve, riichi = ui.riichiWanted;
    ui.discardResolve = null; ui.pending = null; ui.mode = null;
    $('controls').innerHTML = '<span class="hint">COM の思考中…</span>';
    resolve({ tileId: id, riichi });
  }
  function renderControls() {
    if (ui.mode !== 'discard') return;
    const c = $('controls'); c.innerHTML = '';
    const hint = document.createElement('span'); hint.className = 'hint';
    hint.textContent = ui.riichiWanted ? '横向きにする宣言牌を選んでください' : ui.view.riichi ? 'リーチ中です — 左端のツモ牌を切る' : 'あなたの手番です — 切る牌を選んでください';
    c.appendChild(hint);
    if (ui.view.canRiichi) c.appendChild(button(ui.riichiWanted ? 'リーチ取消' : 'リーチ', () => { ui.riichiWanted = !ui.riichiWanted; render(); renderControls(); }, ui.riichiWanted ? 'primary' : ''));
    c.appendChild(button('AIのヒント', async () => {
      const token = ui.token, view = ui.view;
      toast('候補を計算しています…');
      await new Promise((r) => setTimeout(r, 20));
      const d = await MJ.ai.create(0, { level: ui.level }).chooseDiscard(view);
      if (token !== ui.token || ui.mode !== 'discard') return;
      const best = d.analysis && d.analysis.candidates && d.analysis.candidates[0];
      toast(`推奨：${T.label(d.tileId >> 2)}${best ? ` / ${best.sh}向聴・受入${best.ukeire}枚` : '（リーチ中）'}${d.riichi ? ' / リーチ' : ''}`);
    }));
  }
  function askChoice(question, choices, token) {
    if (token !== ui.token) return Promise.resolve(null);
    ui.mode = 'choice';
    return new Promise((resolve) => {
      ui.pending = () => resolve(null);
      const c = $('controls'); c.innerHTML = '';
      const hint = document.createElement('span'); hint.className = 'hint'; hint.textContent = question; c.appendChild(hint);
      for (const option of choices) c.appendChild(button(option.label, () => {
        if (token !== ui.token) return;
        ui.pending = null; ui.mode = null; c.innerHTML = ''; resolve(option.value);
      }, option.primary ? 'primary' : ''));
    });
  }
  function humanAgent(token) {
    return {
      wantTsumo() { return askChoice('ツモ和了できます', [{ label: 'ツモ', value: true, primary: true }, { label: '見送る', value: false }], token); },
      async chooseDiscard(view) {
        if (token !== ui.token) return Promise.resolve({ tileId: view.hand[0] });
        if (view.riichi) {
          ui.mode = 'auto-discard'; ui.discardResolve = null;
          $('controls').innerHTML = '<span class="hint">リーチ中 — 自動ツモ切り</span>';
          await new Promise((resolve) => setTimeout(resolve, ui.fast ? 0 : 420));
          if (token === ui.token) ui.mode = null;
          return { tileId: view.drawnTile, riichi: false, analysis: { forced: true, automatic: true } };
        }
        return new Promise((resolve) => {
          ui.mode = 'discard'; ui.view = view; ui.riichiWanted = false; ui.discardResolve = resolve;
          ui.pending = () => resolve({ tileId: view.hand[0] }); render(); renderControls();
        });
      },
      async wantCall(view, opts) {
        this.lastCallAnalysis = !opts.ron && !view.riichi ? MJ.ai.analyzeCall(view, opts) : null;
        const choices = [];
        if (opts.ron) choices.push({ label: 'ロン', value: { type: 'ron' }, primary: true });
        if (opts.pon != null) choices.push({ label: 'ポン', value: { type: 'pon', tile: opts.tile } });
        if (opts.kan != null) choices.push({ label: '大明槓', value: { type: 'kan', tile: opts.tile } });
        for (const pair of opts.chi) choices.push({ label: `チー ${pair.map(T.label).join('・')}`, value: { type: 'chi', tiles: pair, tile: opts.tile } });
        choices.push({ label: 'パス', value: null });
        return askChoice(`${NAMES[opts.from]} の ${T.label(opts.tile)}`, choices, token);
      },
      wantKan(view, kans) {
        if (view.riichi) return Promise.resolve(null);
        return askChoice('槓を選択できます', [...kans.map((k) => ({ label: `${k.kind === 'ankan' ? '暗槓' : '加槓'} ${T.label(k.tile)}`, value: k })), { label: 'パス', value: null }], token);
      }
    };
  }
  function pacedAI(seat, token) {
    const ai = MJ.ai.create(seat, { level: ui.level }), out = {};
    for (const fn of ['wantTsumo', 'chooseDiscard', 'wantCall', 'wantKan']) out[fn] = async (...args) => {
      await new Promise((r) => setTimeout(r, ui.fast ? 0 : fn === 'chooseDiscard' ? 400 : 100));
      if (token !== ui.token) return fn === 'chooseDiscard' ? { tileId: args[0].hand[0] } : null;
      const result = await ai[fn](...args);
      if (fn === 'wantCall') out.lastCallAnalysis = ai.lastCallAnalysis;
      return result;
    };
    return out;
  }
  function panel(html) {
    $('overlay').classList.remove('hidden'); $('overlay').innerHTML = '';
    const p = document.createElement('div'); p.className = 'panel'; p.innerHTML = html;
    $('overlay').appendChild(p); return p;
  }
  function closePanel() { $('overlay').classList.add('hidden'); }
  function actions(p, options) {
    const row = document.createElement('div'); row.className = 'actions';
    for (const o of options) row.appendChild(button(o.label, o.action, o.primary ? 'primary' : ''));
    p.appendChild(row);
  }
  function stop() {
    ui.token++; ui.running = false; ui.mode = null; ui.review = null; ui.waitingResult = false;
    if (ui.game) ui.game.cancelled = true;
    if (ui.pending) ui.pending(); if (ui.resultResolve) ui.resultResolve();
    ui.pending = null; ui.discardResolve = null; ui.resultResolve = null;
    $('review-controls').classList.add('hidden');
    $('review-timeline').classList.add('hidden'); $('table').classList.remove('review-mode');
  }
  function lobby() {
    const p = panel('<div class="eyebrow">RIICHI MAHJONG / FOUR PLAYERS</div><h1>翠卓</h1><p>静かな卓で、一打を考える。<br>3人のAIと打つ、四人打ちリーチ麻雀。</p><label class="field">対局形式</label>');
    let mode = 'tonpu';
    const grid = document.createElement('div'); grid.className = 'choice-grid';
    const east = button('', () => { mode = 'tonpu'; east.classList.add('selected'); south.classList.remove('selected'); }, 'selected');
    east.innerHTML = '<strong>東風戦</strong><small>東1局 → 東4局</small>';
    const south = button('', () => { mode = 'hanchan'; south.classList.add('selected'); east.classList.remove('selected'); });
    south.innerHTML = '<strong>半荘戦</strong><small>東1局 → 南4局</small>';
    grid.appendChild(east); grid.appendChild(south); p.appendChild(grid);
    const label = document.createElement('label'); label.className = 'field'; label.textContent = '対戦AI'; p.appendChild(label);
    const select = document.createElement('select'); select.innerHTML = '<option value="strong">思考型 — 先読み・牌効率・押し引き</option><option value="standard">標準 — 向聴数・受入枚数重視</option>'; select.value = ui.level; p.appendChild(select);
    const note = document.createElement('p'); note.textContent = '25,000点持ち / 赤5各1枚 / 頭ハネ / 親テンパイ連荘。ツモ牌は各プレイヤーから見て左端に置きます。'; p.appendChild(note);
    actions(p, [{ label: '牌譜を読み込む', action: () => $('replay-file').click() }, { label: '対局をはじめる →', primary: true, action: () => { MJ.audio.unlock(); ui.level = select.value; closePanel(); startMatch(mode); } }]);
  }
  function rules() {
    const wasHidden = $('overlay').classList.contains('hidden');
    const p = panel('<div class="eyebrow">HOW TO PLAY</div><h2>ルールと操作</h2><ul class="rule-list"><li>手牌をクリックして打牌。リーチはボタンを押してから宣言牌を選択。</li><li>ツモ牌は自分から見て左端。河の小さな点はツモ切り、金枠は直前の捨て牌。</li><li>四人打ち・東風 / 半荘。赤各1枚、喰いタン・後付けあり。喰い替えは禁止。</li><li>複数ロンは頭ハネ。親の和了・テンパイで連荘。流局ごとに本場が増えます。</li><li>飛び終了あり。オーラスの和了やめ・西入 / 南入なし。残った供託はトップへ。</li><li>四風連打・四人リーチ・複数人の四槓は流局。九種九牌・流し満貫は採用していません。</li><li>ダブル役満は大四喜・四暗刻単騎ロン。数え役満あり、役満は複合加算。</li><li>JSON牌譜は全牌山、手牌、ツモ切り、AI評価、検討メモを含みます。読み込むと一手ずつ再生できます。</li></ul><p>牌字：GL-MahjongTile © Gutenberg Labo<br>AIは公開情報を用いた探索・評価型です。</p>');
    actions(p, [{ label: '閉じる', primary: true, action: () => { closePanel(); if (ui.waitingResult) showResultPanel(ui.game, ui.game.result); else if (!wasHidden && !ui.running) lobby(); } }]);
  }
  function download(name, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type })), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  function exportRecord() {
    if (!ui.record || !ui.record.hands.length) { toast('対局開始後に牌譜を保存できます'); return; }
    const p = panel('<div class="eyebrow">EXPORT GAME RECORD</div><h2>牌譜を保存</h2><p>AIの打牌を検討するときは、JSON牌譜と局番号・イベント番号をお知らせください。対局途中でも保存できます。</p>');
    const name = 'suitaku-' + ui.record.createdAt.replace(/[:.]/g, '-');
    const save = (json) => { download(name + (json ? '.json' : '.txt'), json ? JSON.stringify(ui.record, null, 2) : MJ.record.text(ui.record), json ? 'application/json' : 'text/plain'); };
    actions(p, [{ label: 'JSON（再生・検討用）', primary: true, action: () => save(true) }, { label: 'テキスト', action: () => save(false) }]);
    actions(p, [{ label: '閉じる', action: () => { closePanel(); if (ui.waitingResult) showResultPanel(ui.game, ui.game.result); else if (!ui.running && !ui.review) lobby(); } }]);
  }
  function annotate() {
    if (!ui.record || !ui.game || !ui.game.lastDiscard) { toast('打牌後にメモを残せます'); return; }
    const d = ui.game.lastDiscard, hand = ui.review ? ui.review.hand : ui.record.hands.length - 1;
    const p = panel(`<div class="eyebrow">REVIEW NOTE</div><h2>打牌に検討メモ</h2><p>局 #${hand + 1} / イベント #${d.eventIndex} / ${NAMES[d.seat]} ${T.label(d.tileId >> 2)}</p>`);
    const input = document.createElement('textarea'); input.rows = 5; input.placeholder = '例：ここはドラを残して、現物の東を切るほうがよいのでは？'; p.appendChild(input);
    actions(p, [{ label: '戻る', action: closePanel }, { label: '牌譜に記録', primary: true, action: () => {
      if (input.value.trim()) { ui.record.annotations = ui.record.annotations || []; ui.record.annotations.push({ hand, eventIndex: d.eventIndex, text: input.value.trim() }); autosave(); }
      closePanel(); toast('メモを牌譜に記録しました');
    } }]); input.focus();
  }
  function autosave() {
    try { localStorage.setItem('suitaku-last-record', JSON.stringify(ui.record)); } catch (_) { /* Export remains available if storage is full or unavailable. */ }
  }
  function resultHtml(game, res) {
    if (res.type === 'draw') {
      const reasons = { 'four-kans': '四槓散了', 'four-riichi': '四家立直', 'four-winds': '四風連打', exhaustive: '荒牌流局' };
      return `<div class="eyebrow">HAND COMPLETE</div><h2>${reasons[res.reason] || '流局'}</h2><p>${res.reason === 'exhaustive' ? res.tenpai.length ? 'テンパイ：' + res.tenpai.map((s) => NAMES[s]).join('・') : '全員ノーテン' : '親は連荘します'}</p>`;
    }
    const sc = res.score;
    return `<div class="eyebrow">HAND COMPLETE</div><h2>${NAMES[res.winner]} の${res.tsumo ? 'ツモ' : 'ロン'}</h2><div id="result-tiles" class="result-tiles"></div><div class="score-big">${sc.yakuman ? (sc.han / 13 > 1 ? sc.han / 13 + '倍役満' : '役満') : sc.han + '翻 ' + sc.fu + '符'} <br>+ ${res.received.toLocaleString()} 点</div><div class="yaku-list">${sc.yaku.map((y) => `<span>${y.name}</span><span>${y.yakuman ? '役満' : y.han + '翻'}</span>`).join('')}${sc.dora ? `<span>ドラ・赤・裏 合計</span><span>${sc.dora}翻</span>` : ''}</div><div id="result-ura" class="result-tiles"></div>`;
  }
  function showResultPanel(game, res) {
    const p = panel(resultHtml(game, res));
    if (res.type === 'win') {
      const winner = game.players[res.winner];
      const ids = winner.hand.filter((id) => id !== res.winTile);
      for (const id of MJ.sortHand(ids)) appendTile($('result-tiles'), id, { mini: true });
      appendTile($('result-tiles'), res.winTile, { mini: true, highlight: true });
      for (const m of winner.melds) for (const id of m.tiles) appendTile($('result-tiles'), id, { mini: true });
      if (res.uraIndicators.length) {
        const label = document.createElement('span'); label.textContent = '裏ドラ表示牌 '; $('result-ura').appendChild(label);
        for (const id of res.uraIndicators) appendTile($('result-ura'), id, { mini: true });
      }
    }
    actions(p, [{ label: '牌譜を保存', action: exportRecord }, { label: '次へ →', primary: true, action: () => { closePanel(); ui.waitingResult = false; if (ui.resultResolve) ui.resultResolve(); ui.resultResolve = null; } }]);
  }
  async function startMatch(mode) {
    stop(); const token = ui.token;
    ui.running = true; ui.fast = $('speed-fast').checked; ui.record = MJ.record.create(mode, ui.level);
    ui.animationKey = null; $('log').innerHTML = ''; $('match-label').textContent = `${mode === 'hanchan' ? '半荘戦' : '東風戦'} / ${ui.level === 'strong' ? '思考型AI' : '標準AI'}`;
    let state = { hand: 0, dealer: 0, honba: 0, mode }, scores = [25000, 25000, 25000, 25000], sticks = 0;
    try {
      while (!state.ended && token === ui.token) {
        const game = new MJ.Game({ agents: [humanAgent(token), pacedAI(1, token), pacedAI(2, token), pacedAI(3, token)],
          onUpdate: () => { if (token === ui.token) render(game); }, onEvent: (msg, data) => { if (token === ui.token) { appendLog(msg, data); if (data?.type) MJ.audio.play(data.type); } } });
        ui.game = game; ui.animationKey = null; ui.waitingResult = false;
        appendLog(`── ${state.hand < 4 ? '東' : '南'}${state.dealer + 1}局 ${state.honba}本場 ──`);
        const playing = game.playHand({ roundWind: 27 + Math.floor(state.hand / 4), dealer: state.dealer, honba: state.honba, riichiSticks: sticks, scores: scores.slice() });
        ui.record.hands.push(game.recording);
        const res = await playing;
        if (token !== ui.token || !res) return;
        scores = game.players.map((p) => p.score); sticks = game.riichiSticks;
        autosave(); render(game); ui.mode = null;
        await new Promise((resolve) => { ui.resultResolve = resolve; ui.waitingResult = true; showResultPanel(game, res); });
        if (token !== ui.token) return;
        state = MJ.match.advance(state, res, scores);
      }
      if (token !== ui.token) return;
      const ranked = scores.map((score, seat) => ({ score, seat })).sort((a, b) => b.score - a.score || a.seat - b.seat);
      if (sticks) { scores[ranked[0].seat] += sticks * 1000; ranked[0].score += sticks * 1000; }
      ui.record.finalScores = scores; ui.record.finished = true; autosave(); ui.running = false;
      const p = panel('<div class="eyebrow">MATCH COMPLETE</div><h2>終局</h2>' + ranked.map((r, i) => `<div class="ranking-row"><span>${i + 1}位　${NAMES[r.seat]}</span><strong>${r.score.toLocaleString()} 点</strong></div>`).join(''));
      actions(p, [{ label: '牌譜を保存', action: exportRecord }, { label: '牌譜を検討', action: () => startReview(ui.record) }, { label: '新しい対局', primary: true, action: lobby }]);
    } catch (err) {
      if (token !== ui.token) return;
      ui.running = false; ui.mode = null; autosave();
      const p = panel(`<h2>対局を停止しました</h2><p>${escape(err.message)}</p><p>牌譜を保存すると、この局の状態を確認できます。</p>`);
      actions(p, [{ label: '牌譜を保存', action: exportRecord }, { label: '戻る', action: lobby }]);
      console.error(err);
    }
  }
  function startReview(data) {
    MJ.record.validate(data); stop(); ui.record = data;
    ui.review = { hand: 0, position: 0, reveal: false, analyses: new Map() }; closePanel();
    $('match-label').textContent = '牌譜検討 / REPLAY'; $('controls').innerHTML = '<span class="hint">盤面の左半分で戻る・右半分で進む（← → キーも対応）</span>';
    renderReview();
  }
  function stepReview(delta) {
    if (!ui.review || !$('overlay').classList.contains('hidden')) return;
    const r = ui.review, max = ui.record.hands[r.hand].events.length - 1;
    r.position = Math.max(0, Math.min(max, r.position + delta)); renderReview();
  }
  function renderTimeline(hand) {
    const root = $('review-timeline'), r = ui.review;
    root.classList.remove('hidden');
    if (!root.querySelector('input')) {
      root.innerHTML = '<div class="timeline-header"><span id="timeline-position"></span><div class="review-buttons" id="timeline-buttons"></div></div>';
      $('timeline-buttons').appendChild(button('← 前', () => stepReview(-1)));
      $('timeline-buttons').appendChild(button('次 →', () => stepReview(1)));
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = 0; slider.id = 'replay-slider';
      slider.setAttribute('aria-label', '牌譜イベント位置');
      slider.oninput = () => { ui.review.position = Number(slider.value); renderReview(); }; root.appendChild(slider);
      const hint = document.createElement('div'); hint.className = 'timeline-hint'; hint.textContent = '盤面左側：前へ / 盤面右側：次へ · 暗い捨て牌はツモ切り'; root.appendChild(hint);
    }
    const slider = $('replay-slider'); slider.max = hand.events.length - 1; slider.value = r.position;
    $('timeline-position').textContent = `イベント ${r.position} / ${hand.events.length - 1}`;
    const buttons = $('timeline-buttons').children; buttons[0].disabled = r.position === 0; buttons[1].disabled = r.position === hand.events.length - 1;
  }
  function showAnalysis(root, analysis) {
    if (!analysis) return;
    const candidates = analysis.candidates;
    const summary = document.createElement('div'); summary.className = 'analysis-summary';
    if (analysis.kind === 'call') {
      const pct = analysis.advantagePercent;
      summary.textContent = `${pct >= 0 ? '鳴き' : '見送り'}優位 ${Math.abs(pct).toFixed(1)}%（推定） / 差 ${analysis.delta >= 0 ? '+' : ''}${Math.round(analysis.delta)}点`;
      root.appendChild(summary);
      const table = document.createElement('table'); table.className = 'analysis-table';
      table.innerHTML = '<tr><th>選択</th><th>向聴</th><th>受入</th><th>推定収支</th></tr>' + analysis.alternatives.map((c) => `<tr><td>${escape(c.label)}</td><td>${escape(c.sh)}</td><td>${escape(c.ukeire)}</td><td>${Math.round(c.expectedNet)}</td></tr>`).join(''); root.appendChild(table);
      const note = document.createElement('p'); note.className = 'muted'; note.textContent = '勝率ではありません。% = (最良鳴きEV − 見送りEV) ÷ max(100, |両EV|) × 100。将来の他家の手・鳴き・放銃は近似評価です。'; root.appendChild(note);
    } else if (candidates) {
      const modern = analysis.version === MJ.ai.version;
      const table = document.createElement('table'); table.className = 'analysis-table';
      table.innerHTML = `<tr><th>候補</th><th>向聴</th><th>受入</th><th>${modern ? '放銃%¹' : '旧危険度'}</th>${modern ? '<th>推定収支</th>' : ''}</tr>` + candidates.slice(0, 8).map((c) => `<tr><td>${escape(T.label(c.t))}</td><td>${escape(c.sh)}</td><td>${escape(c.ukeire)}</td><td>${escape(c.danger)}</td>${modern ? `<td>${Math.round(c.expectedNet)}</td>` : ''}</tr>`).join('');
      const scroll = document.createElement('div'); scroll.className = 'analysis-scroll'; scroll.appendChild(table); root.appendChild(scroll);
      if (modern) {
        const best = candidates[0], note = document.createElement('p'); note.className = 'muted';
        note.textContent = `${best.blocks}ブロック候補 / 雀頭${best.blockPlans.head ? 'あり' : 'なし'} / 次ツモ後平均受入 ${best.futureUkeire ?? '—'}枚。¹放銃率・期待収支は公開情報からのモデル推定（実測値ではありません）。`; root.appendChild(note);
      }
    }
    if (analysis.unseen) {
      const details = document.createElement('details'); details.innerHTML = '<summary>判断時の未見牌枚数</summary>';
      const tiles = document.createElement('div'); tiles.className = 'unseen-tiles';
      analysis.unseen.forEach((n, t) => { const s = document.createElement('span'); s.textContent = T.label(t) + ':' + n; tiles.appendChild(s); });
      details.appendChild(tiles); root.appendChild(details);
    }
  }
  async function recalculateReview(buttonEl, targetPos) {
    const r = ui.review, token = ui.token, handIndex = r.hand, h = ui.record.hands[handIndex], e = h.events[targetPos];
    buttonEl.disabled = true; buttonEl.textContent = '公開情報で再計算中…';
    await new Promise((resolve) => setTimeout(resolve, 20));
    try {
      const g = MJ.record.snapshot(h, targetPos - 1), view = g.buildView(e.seat);
      let analysis;
      if (e.type === 'discard') analysis = MJ.ai.analyzeDiscard(view, 'strong');
      else {
        const options = e.options || g.callOptions(e.seat, e.from, e.tileId, e.robKan);
        if (!options || options.ron) { toast('この応答は和了判断、または鳴き候補がありません'); return; }
        analysis = MJ.ai.analyzeCall({ ...view, callTile: e.tileId, callFrom: e.from }, options);
      }
      if (token !== ui.token || ui.review !== r) return;
      r.analyses.set(handIndex + ':' + targetPos, analysis);
      renderReview();
    } catch (e) { toast('再計算できませんでした：' + e.message); }
    finally { if (buttonEl.isConnected) { buttonEl.disabled = false; buttonEl.textContent = '現AIで再計算'; } }
  }
  function renderReview() {
    const r = ui.review, h = ui.record.hands[r.hand];
    r.position = Math.max(0, Math.min(r.position, h.events.length - 1));
    ui.game = MJ.record.snapshot(h, r.position); render();
    renderTimeline(h);
    const root = $('review-controls'); root.classList.remove('hidden'); root.innerHTML = '<div class="section-label">REPLAY <span>牌譜検討</span></div>';
    const select = document.createElement('select');
    ui.record.hands.forEach((hand, i) => { const option = document.createElement('option'); option.value = i; option.textContent = `#${i + 1} ${WINDS[hand.config.roundWind - 27]}${hand.config.dealer + 1}局 ${hand.config.honba || 0}本場`; select.appendChild(option); });
    select.value = r.hand; select.onchange = () => { r.hand = Number(select.value); r.position = 0; renderReview(); }; root.appendChild(select);
    const check = document.createElement('label'); check.className = 'subtle-check';
    const input = document.createElement('input'); input.type = 'checkbox'; input.checked = r.reveal;
    input.onchange = () => { r.reveal = input.checked; render(); }; check.appendChild(input); check.appendChild(document.createTextNode(' 全員の手牌を表示')); root.appendChild(check);
    const event = h.events[r.position];
    const description = document.createElement('p'); description.className = 'muted'; description.textContent = `イベント #${event.index} / ${event.type}`; root.appendChild(description);
    let targetPos = r.position;
    if (event.type === 'call') {
      for (let i = r.position - 1; i >= 0 && h.events[i].type !== 'discard'; i--) {
        if (h.events[i].type === 'response' && h.events[i].seat === event.seat) { targetPos = i; break; }
      }
    }
    const target = h.events[targetPos], recalculated = r.analyses.get(r.hand + ':' + targetPos);
    if (recalculated) { const label = document.createElement('p'); label.className = 'muted'; label.textContent = '現AIによる再解析（対局当時の判断とは別）'; root.appendChild(label); }
    showAnalysis(root, recalculated || target.analysis);
    if (['discard', 'response'].includes(target.type) && !target.analysis?.forced) {
      const recalc = button('現AIで再計算', () => recalculateReview(recalc, targetPos), 'text-button'); root.appendChild(recalc);
      if (!target.analysis && target.type === 'response') { const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = '旧牌譜の鳴き比較は再計算すると表示されます。'; root.appendChild(hint); }
    }
    $('log').innerHTML = '';
    for (const e of h.events.slice(0, r.position + 1).filter((e) => e.type === 'discard').slice(-16)) appendLog(`P${e.seat + 1} ${e.tsumogiri ? 'ツモ切り' : '手出し'} ${T.label(e.tileId >> 2)}${e.riichi ? ' リーチ宣言' : ''}`, { eventIndex: e.index });
    const notes = (ui.record.annotations || []).filter((n) => n.hand === r.hand && n.eventIndex === event.index);
    notes.forEach((n) => { appendLog('メモ：' + n.text); const text = document.createElement('div'); text.className = 'review-note'; text.textContent = n.text; root.appendChild(text); });
  }
  ui.startMatch = startMatch; ui.startReview = startReview; ui.render = render; ui.stop = stop;
  window.addEventListener('DOMContentLoaded', () => {
    $('table').addEventListener('click', (e) => {
      if (!ui.review) return;
      const rect = $('table').getBoundingClientRect();
      stepReview(e.clientX < rect.left + rect.width / 2 ? -1 : 1);
    });
    window.addEventListener('keydown', (e) => {
      if (!ui.review || !['ArrowLeft', 'ArrowRight'].includes(e.key) || /INPUT|TEXTAREA|SELECT|BUTTON/.test(e.target.tagName)) return;
      e.preventDefault(); stepReview(e.key === 'ArrowLeft' ? -1 : 1);
    });
    document.addEventListener('pointerdown', () => MJ.audio.unlock());
    $('sound-enabled').onchange = () => { MJ.audio.enabled = $('sound-enabled').checked; if (MJ.audio.enabled) { MJ.audio.unlock(); MJ.audio.play('discard'); } };
    $('btn-voices').onclick = () => {
      const p = panel('<h2>発声WAVを読み込む</h2><p>riichi.wav / pon.wav / chi.wav / kan.wav / ron.wav / tsumo.wav を選択してください。日本語の「リーチ.wav」なども使えます。現在のタブを閉じるまで保持します。</p>');
      actions(p, [{ label: '閉じる', action: closePanel }, { label: 'WAVを選ぶ', primary: true, action: () => $('voice-files').click() }]);
    };
    $('voice-files').onchange = async (e) => {
      try { const n = await MJ.audio.load(e.target.files); toast(`${n}種類の発声を読み込みました`); closePanel(); }
      catch (err) { toast(err.message); } finally { e.target.value = ''; }
    };
    const resize = () => { const width = $('table').parentElement.clientWidth; $('table').style.transform = `scale(${width / 900})`; };
    window.addEventListener('resize', resize); if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe($('table').parentElement); resize();
    $('btn-new').onclick = () => {
      if (!ui.running) { stop(); lobby(); return; }
      const p = panel('<h2>新しい対局を始めますか？</h2><p>現在の対局を終了します。途中の牌譜も保存できます。</p>');
      actions(p, [{ label: '対局に戻る', action: closePanel }, { label: '牌譜を保存', action: exportRecord }, { label: '新規対局', primary: true, action: () => { autosave(); stop(); lobby(); } }]);
    };
    $('btn-rules').onclick = rules; $('btn-export').onclick = exportRecord; $('btn-note').onclick = annotate;
    $('show-guide').onchange = () => { if (ui.game) guide(ui.game); };
    $('speed-fast').onchange = () => { ui.fast = $('speed-fast').checked; };
    $('replay-file').onchange = async (e) => {
      const file = e.target.files[0]; if (!file) return;
      try { if (file.size > 30 * 1024 * 1024) throw new Error('牌譜は30MB以下にしてください'); const data = JSON.parse(await file.text()); startReview(data); }
      catch (err) { toast(err.message); } finally { e.target.value = ''; }
    };
    for (let i = 0; i < 5; i++) $('dora-info').appendChild(tileEl(0, { small: true, back: true }));
    lobby();
    try {
      const last = localStorage.getItem('suitaku-last-record');
      if (last) {
        const p = $('overlay').firstChild;
        actions(p, [{ label: '前回の牌譜を検討', action: () => { try { startReview(JSON.parse(last)); } catch (e) { toast(e.message); } } }]);
      }
    } catch (_) {}
  });
})();
