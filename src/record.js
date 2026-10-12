(function () {
  const MJ = globalThis.MJ;
  const copy = (x) => JSON.parse(JSON.stringify(x));
  const R = MJ.record = {
    create(mode, level) {
      return { format: 'suitaku-riichi', version: 1, createdAt: new Date().toISOString(), mode, ai: level,
        rules: { players: 4, initialScore: 25000, redFives: 3, openTanyao: true, ron: 'atamahane',
          dealerTenpaiRepeat: true, agariYame: false, extension: false, kuikae: false,
          nineTerminals: false, nagashiMangan: false }, hands: [], annotations: [] };
    },
    validate(data) {
      if (!data || data.format !== 'suitaku-riichi' || data.version !== 1 || !Array.isArray(data.hands) || !data.hands.length || data.hands.length > 500) throw new Error('翠卓のJSON牌譜を選んでください。');
      const tile = (id) => Number.isInteger(id) && id >= 0 && id < 136;
      const ids = (a) => Array.isArray(a) && a.length <= 136 && a.every(tile);
      const nonnegative = (n) => n == null || (Number.isInteger(n) && n >= 0 && n <= 100000);
      for (const h of data.hands) {
        if (!h || !h.config || !nonnegative(h.config.honba) || !nonnegative(h.config.riichiSticks)) throw new Error('本場・供託が不正です。');
        if (!ids(h.wall) || new Set(h.wall).size !== 136 || !h.config || !Number.isInteger(h.config.dealer) || h.config.dealer < 0 || h.config.dealer > 3 || ![27, 28].includes(h.config.roundWind) || !Array.isArray(h.config.scores) || h.config.scores.length !== 4 || !h.config.scores.every(Number.isFinite) || !Array.isArray(h.initialHands) || h.initialHands.length !== 4 || !h.initialHands.every(ids) || !Array.isArray(h.events) || h.events.length > 2000) throw new Error('牌譜の局データが不正です。');
        for (const e of h.events) {
          if (!e || !['start', 'draw', 'discard', 'response', 'call', 'kan', 'dora', 'riichi', 'end'].includes(e.type)) throw new Error('牌譜のイベントが不正です。');
          if (e.seat != null && (!Number.isInteger(e.seat) || e.seat < 0 || e.seat > 3)) throw new Error('席番号が不正です。');
          if (['draw', 'discard', 'riichi', 'call', 'kan'].includes(e.type) && e.seat == null) throw new Error('席番号がありません。');
          if (['draw', 'discard'].includes(e.type) && !tile(e.tileId)) throw new Error('牌IDが不正です。');
          if (e.type === 'call' && (!e.meld || !ids(e.meld.tiles) || !Number.isInteger(e.from) || e.from < 0 || e.from > 3)) throw new Error('副露データが不正です。');
          if (e.type === 'kan' && (!Array.isArray(e.melds) || !e.melds.every((m) => ids(m.tiles)))) throw new Error('槓データが不正です。');
          if (e.type === 'dora' && !ids(e.doraIndicators)) throw new Error('ドラが不正です。');
          if (e.type === 'end' && (!Array.isArray(e.scores) || e.scores.length !== 4 || !e.scores.every(Number.isFinite))) throw new Error('点数が不正です。');
          if (e.type === 'end' && !nonnegative(e.riichiSticks)) throw new Error('供託が不正です。');
        }
      }
      return data;
    },
    snapshot(hand, position) {
      const g = new MJ.Game({ agents: [] });
      g.setup({ ...hand.config, wall: hand.wall });
      g.players.forEach((p, i) => { p.hand = hand.initialHands[i].slice(); });
      for (const e of hand.events.slice(0, position + 1)) {
        const p = g.players[e.seat];
        if (p) g.currentSeat = e.seat;
        if (e.type === 'draw') {
          p.hand.push(e.tileId); p.drawnTile = e.tileId; p.drawCount++; p.tempFuriten = false; g.lastDrawRinshan = !!e.rinshan;
          if (e.rinshan) { g.rinshanIndex++; g.liveEnd--; } else g.wallIndex++;
        } else if (e.type === 'discard') {
          p.hand = p.hand.filter((id) => id !== e.tileId); p.drawnTile = null;
          p.forbidden = []; if (p.riichi) p.ippatsu = false;
          const d = { ...e, eventIndex: e.index, called: false };
          p.discards.push(e.tileId); p.river.push(d); p.discardHistory.push(d);
          g.lastDiscard = d; g.turnCount++;
        } else if (e.type === 'call') {
          const source = g.players[e.from]; source.discards.pop();
          const d = source.river.pop(); if (d) d.called = true;
          p.hand = p.hand.filter((id) => !e.meld.tiles.includes(id)); p.drawnTile = null;
          p.melds.push(copy(e.meld));
          g.anyCall = true; g.players.forEach((x) => { x.ippatsu = false; });
          p.forbidden = e.action.type === 'kan' ? [] : g.callForbidden(e.action);
        } else if (e.type === 'kan') {
          p.melds = copy(e.melds); const used = p.melds.flatMap((m) => m.tiles);
          p.hand = p.hand.filter((id) => !used.includes(id)); p.drawnTile = null;
          g.anyCall = true; g.players.forEach((x) => { x.ippatsu = false; });
        } else if (e.type === 'dora') {
          g.doraRevealed = e.doraIndicators.length; g.syncDora();
        } else if (e.type === 'riichi') {
          p.riichi = true; p.riichiTurn = e.turn; p.doubleRiichi = !!e.doubleRiichi; p.ippatsu = true; p.score -= 1000; g.riichiSticks++;
        } else if (e.type === 'response' && p) {
          const ron = e.options ? e.options.ron : g.callOptions(e.seat, e.from, e.tileId, e.robKan)?.ron;
          if (ron && (!e.action || e.action.type !== 'ron')) { p.tempFuriten = true; if (p.riichi) p.riichiFuriten = true; }
        } else if (e.type === 'end') {
          g.players.forEach((p, s) => { p.score = e.scores[s]; }); g.ended = true; g.result = e.result;
          g.riichiSticks = e.riichiSticks;
        }
      }
      return g;
    },
    text(data) {
      const T = MJ.tiles, lines = ['翠卓 牌譜 v1', data.createdAt, data.mode === 'hanchan' ? '半荘' : '東風'];
      data.hands.forEach((h, i) => {
        lines.push(`\n局 #${i + 1} ${h.config.roundWind === 27 ? '東' : '南'}${h.config.dealer + 1}局 ${h.config.honba || 0}本場`);
        for (const e of h.events) {
          if (e.type === 'discard') lines.push(`[${e.index}] P${e.seat + 1} ${e.tsumogiri ? 'ツモ切り' : '手出し'} ${T.isRed(e.tileId) ? '赤' : ''}${T.label(e.tileId >> 2)}${e.riichi ? ' リーチ宣言' : ''}`);
          else if (e.type === 'draw') lines.push(`[${e.index}] P${e.seat + 1} ${e.rinshan ? '嶺上' : ''}ツモ ${T.label(e.tileId >> 2)}`);
          else if (e.type === 'call' || e.type === 'kan') lines.push(`[${e.index}] P${e.seat + 1} ${JSON.stringify(e.action)}`);
          else if (e.type === 'response' && e.analysis?.kind === 'call') lines.push(`[${e.index}] P${e.seat + 1} 鳴き比較: ${e.analysis.advantagePercent}% / 推定期待収支差 ${e.analysis.delta}点 (勝率ではない)`);
          else if (e.type === 'end') lines.push(`結果: ${JSON.stringify(e.result)}\n点数: ${e.scores.join(' / ')}`);
        }
      });
      lines.push('\n検討メモ', JSON.stringify(data.annotations || [], null, 2));
      return lines.join('\n');
    }
  };
})();
