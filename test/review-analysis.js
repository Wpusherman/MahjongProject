// Analyze user-supplied records without modifying the source JSON.
const fs = require('node:fs');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'ai', 'game', 'record']) require('../src/' + file + '.js');
const MJ = globalThis.MJ;
const data = MJ.record.validate(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
(async () => {
  for (const note of data.annotations || []) {
    const hand = data.hands[note.hand], pos = hand.events.findIndex((e) => e.index === note.eventIndex), e = hand.events[pos];
    const g = MJ.record.snapshot(hand, pos - 1), v = g.buildView(e.seat);
    const label = (id) => (MJ.tiles.isRed(id) ? '赤' : '') + MJ.tiles.label(id >> 2);
    console.log(`\n#${e.index} P${e.seat + 1} ${e.type} ${e.tileId != null ? label(e.tileId) : ''} / ${note.text}`);
    console.log('手牌:', v.hand.map(label).join(' '), '副露:', v.melds.map((m) => m.tiles.map(label).join('')).join('/'));
    if (e.type === 'discard') {
      const start = performance.now(), result = await MJ.ai.create(e.seat).chooseDiscard(v);
      console.log('推奨:', label(result.tileId), '立直:', result.riichi, 'ms:', Math.round(performance.now() - start));
      console.log((result.analysis?.candidates || []).slice(0, 4).map((c) => ({ tile: MJ.tiles.label(c.t), sh: c.sh, uk: c.ukeire, score: Math.round(c.score), ev: c.expectedNet, growth: c.shape, future: c.futureUkeire, improved: c.improvedUkeire, danger: c.danger })));
    }
  }
})().catch((e) => { console.error(e); process.exit(1); });
