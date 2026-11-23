const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// --fast is the smoke subset used by `npm test`: initial render, hidden-hand
// masking, river layout and responsive width. `npm run test:full` plays a full
// hanchan and exercises export/import/review as well.
const FAST = process.argv.includes('--fast');

(async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve(__dirname, '../mahjong.html')).href);
    await page.getByRole('button', { name: '対局をはじめる →' }).click();
    await page.waitForFunction(() => MJ.ui.mode === 'discard' || MJ.ui.mode === 'choice');
    await page.evaluate(() => document.fonts.ready);
    assert(await page.evaluate(() => document.fonts.check('40px Mahjong')));
    assert.equal(await page.locator('#dora-info .tile').count(), 5);
    assert.equal(await page.locator('#dora-info .back').count(), 4);
    assert.equal(await page.locator('#seat-0 .hand-row > :first-child.drawn').count(), 1);
    // The raw game object is not reachable from the console in the built page.
    assert.equal(await page.evaluate(() => MJ.ui.game), null);
    // While the match is running the public record is already masked.
    assert.equal(await page.evaluate(() => MJ.ui.record.redacted), true);
    assert.equal(await page.evaluate(() => JSON.stringify(MJ.ui.record).includes('"wall"')), false);
    // The log / aria-live / toast regions must not mention an opponent's hand.
    const hiddenText = await page.evaluate(() => {
      window.__SUITAKU_DEBUG__ = true;
      const labels = new Set();
      for (let seat = 1; seat < 4; seat++) for (const id of MJ.ui.game.players[seat].hand) labels.add(MJ.tiles.label(id >> 2));
      const log = [...document.querySelectorAll('#log > div')].filter((n) => !n.textContent.startsWith('──')).map((n) => n.textContent).join('\n');
      const text = log + '\n' + document.querySelector('#toast').textContent;
      return [...labels].filter((label) => text.includes(label));
    });
    assert.deepEqual(hiddenText, [], 'the visible log must not name an opponent tile');
    // Opponent hands must be opaque in the DOM: no suit, honor, red or tile-name metadata.
    for (let seat = 1; seat < 4; seat++) {
      const tiles = await page.locator(`#seat-${seat} .hand-row .tile`).evaluateAll((nodes) => nodes.map((n) => ({
        classes: n.className.split(/\s+/).filter(Boolean), title: n.title, aria: n.getAttribute('aria-label') })));
      assert(tiles.length > 0, `seat ${seat} has hidden hand tiles`);
      for (const tile of tiles) {
        assert(!tile.classes.some((c) => ['red', 'm', 'p', 's'].includes(c)), `seat ${seat} leaks a suit or red class`);
        assert(!tile.classes.some((c) => /^h(2[7-9]|3[0-3])$/.test(c)), `seat ${seat} leaks an honor class`);
        assert.equal(tile.title, '伏せ牌', `seat ${seat} leaks a tile name in title`);
        assert.equal(tile.aria, '伏せ牌', `seat ${seat} leaks a tile name in aria-label`);
      }
    }
    // Concealed kan containing the red five: only the public tile type may be rendered.
    await page.evaluate(() => {
      window.__SUITAKU_DEBUG__ = true;
      const p = MJ.ui.game.players[1];
      window.savedMelds = p.melds;
      p.melds = [{ kind: 'kan', type: 4, open: false, tiles: [16, 17, 18, 19] }];
      MJ.ui.render();
    });
    assert.equal(await page.locator('#seat-1 .meld .back').count(), 2);
    assert.equal(await page.locator('#seat-1 .meld .red').count(), 0);
    const kanBacks = await page.locator('#seat-1 .meld .back').evaluateAll((nodes) => nodes.map((n) => ({ classes: n.className.split(/\s+/), title: n.title })));
    for (const tile of kanBacks) {
      assert(!tile.classes.some((c) => ['red', 'm', 'p', 's'].includes(c)));
      assert.equal(tile.title, '伏せ牌');
    }
    await page.evaluate(() => { MJ.ui.game.players[1].melds = window.savedMelds; MJ.ui.render(); });
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/table-desktop.png'), fullPage: true });
    // Construct a long river and verify the exact 6 / 6 / overflow grouping and rotated declaration.
    await page.evaluate(() => {
      const g = MJ.ui.game, p = g.players[1];
      window.savedHistory = p.discardHistory;
      p.discardHistory = Array.from({ length: 22 }, (_, i) => ({ tileId: i * 4, tsumogiri: i % 2 === 0, riichi: i === 5, eventIndex: i, called: false }));
      MJ.ui.render();
    });
    assert.deepEqual(await page.locator('#river-1 .river-row').evaluateAll((rows) => rows.map((r) => r.children.length)), [6, 6, 10]);
    assert.equal(await page.locator('#river-1 .sideways-slot').count(), 1);
    await page.evaluate(() => { MJ.ui.game.players[1].discardHistory = window.savedHistory; MJ.ui.render(); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.resolve(__dirname, '../test-results/table-mobile.png'), fullPage: true });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await page.setViewportSize({ width: 1440, height: 1100 });
    // Fixed seating: human seat 0 is North when seat 1 is the East-1 dealer.
    const north = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await north.goto(pathToFileURL(path.resolve(__dirname, '../mahjong.html')).href);
    await north.evaluate(() => { MJ.ui.startDealer = 1; MJ.ui.matchSeed = 12345; });
    await north.getByRole('button', { name: '対局をはじめる →' }).click();
    await north.waitForFunction(() => MJ.ui.mode === 'discard' || MJ.ui.mode === 'choice');
    assert.equal(await north.locator('#seat-0 .wind').textContent(), '北', 'human is North when seat 1 is dealer');
    assert.equal(await north.locator('#seat-1 .dealer-mark').count(), 1, 'the dealer mark follows the current dealer');
    assert((await north.locator('.center-round').textContent()).replace(/\s+/g, ' ').trim().startsWith('東 1'),
      'the round number comes from dealer moves, not the dealer seat');
    await north.close();
    // Riichi ankan UI: the human gets a kan / tsumogiri choice with a fixed delay.
    const kanPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await kanPage.goto(pathToFileURL(path.resolve(__dirname, '../mahjong.html')).href);
    await kanPage.getByRole('button', { name: '対局をはじめる →' }).click();
    await kanPage.waitForFunction(() => MJ.ui.mode === 'discard');
    const kanButtons = await kanPage.evaluate(async () => {
      window.__SUITAKU_DEBUG__ = true;
      const ui = MJ.ui; ui.fast = true;
      const view = { ...ui.view, riichi: true };
      window.kanChoice = undefined;
      ui.game.agents[0].wantKan(view, [{ kind: 'ankan', tile: 0 }]).then((value) => { window.kanChoice = value; });
      await new Promise((resolve) => setTimeout(resolve, 40));
      return { mode: ui.mode, labels: [...document.querySelectorAll('#controls button')].map((b) => b.textContent) };
    });
    assert.equal(kanButtons.mode, 'choice');
    assert(kanButtons.labels.some((label) => label.startsWith('暗槓')), 'riichi ankan button is offered');
    assert(kanButtons.labels.includes('ツモ切り'), 'tsumogiri remains available');
    await kanPage.getByRole('button', { name: 'ツモ切り', exact: true }).click();
    await kanPage.waitForFunction(() => window.kanChoice === null);
    await kanPage.close();
    if (FAST) {
      assert.deepEqual(errors, []);
      console.log('Browser UI fast OK: desktop/mobile, font, river layout, hidden hands');
      return;
    }
    // New match cancellation while a human decision is pending must not leak the old game loop.
    await page.getByRole('button', { name: '新規対局', exact: true }).click();
    await page.locator('#overlay').getByRole('button', { name: '新規対局', exact: true }).click();
    await page.getByRole('button', { name: '半荘戦' }).click();
    await page.locator('#overlay select').selectOption('standard');
    await page.getByRole('button', { name: '対局をはじめる →' }).click();
    await page.locator('#speed-fast').check();
    await page.waitForFunction(() => MJ.ui.mode === 'discard' || MJ.ui.mode === 'choice');
    assert.equal(await page.evaluate(() => MJ.ui.record.mode), 'hanchan');
    // Use the real UI buttons with an AI selecting the human's legal discard until final ranking.
    for (let steps = 0; steps < 2500; steps++) {
      if (await page.locator('#overlay h2').filter({ hasText: /^終局$/ }).count()) break;
      const state = await page.evaluate(async () => {
        const ui = MJ.ui;
        if (ui.waitingResult) return 'result';
        if (ui.mode === 'discard' && ui.discardResolve) {
          const d = await MJ.ai.create(0, { level: 'standard' }).chooseDiscard(ui.view);
          const nodes = Array.from(document.querySelectorAll('#seat-0 .hand-row > *'));
          const p = ui.game.players[0]; const ids = MJ.sortHand(p.hand.filter((id) => id !== p.drawnTile));
          if (p.drawnTile != null) ids.unshift(p.drawnTile);
          nodes[ids.indexOf(d.tileId)].click(); return 'played';
        }
        if (ui.mode === 'choice') {
          const buttons = Array.from(document.querySelectorAll('#controls button'));
          const win = buttons.find((b) => b.textContent === 'ツモ' || b.textContent === 'ロン');
          (win || buttons[buttons.length - 1]).click(); return 'played';
        }
        return 'wait';
      });
      if (state === 'result') await page.getByRole('button', { name: '次へ →', exact: true }).click();
      else if (state === 'wait') await page.waitForFunction(() => MJ.ui.mode === 'discard' || MJ.ui.mode === 'choice' || MJ.ui.waitingResult || !MJ.ui.running, { timeout: 30000 });
    }
    assert.equal(await page.locator('#overlay h2').textContent(), '終局');
    const record = await page.evaluate(() => MJ.ui.record);
    assert(record.finished);
    assert.equal(record.finalScores.reduce((a, b) => a + b), 100000);
    await page.getByRole('button', { name: '牌譜を検討', exact: true }).click();
    await page.locator('#review-timeline input[type=range]').fill('10');
    await page.getByRole('button', { name: '次 →', exact: true }).click();
    assert.equal(await page.evaluate(() => MJ.ui.review.position), 11);
    const board = await page.locator('#table').boundingBox();
    await page.mouse.click(board.x + board.width * 0.75, board.y + board.height * 0.5);
    assert.equal(await page.evaluate(() => MJ.ui.review.position), 12);
    await page.mouse.click(board.x + board.width * 0.25, board.y + board.height * 0.5);
    assert.equal(await page.evaluate(() => MJ.ui.review.position), 11);
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => MJ.ui.review.position), 12);
    const timelineBox = await page.locator('#review-timeline').boundingBox();
    assert(timelineBox.y >= board.y + board.height - 1, 'slider is below board');
    const tsumogiriPosition = record.hands[0].events.findIndex((e) => e.type === 'discard' && e.tsumogiri);
    if (tsumogiriPosition >= 0) {
      await page.locator('#replay-slider').fill(String(tsumogiriPosition));
      assert.equal(await page.locator('.river .tsumogiri').first().evaluate((el) => getComputedStyle(el).filter), 'brightness(0.76) saturate(0.8)');
    }
    const callPosition = record.hands[0].events.findIndex((e) => e.type === 'response' && e.analysis?.kind === 'call');
    if (callPosition >= 0) {
      await page.locator('#replay-slider').fill(String(callPosition));
      assert((await page.locator('#review-controls').textContent()).includes('優位'));
    }
    await page.getByRole('button', { name: '牌譜を保存', exact: true }).click();
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: 'JSON（再生・検討用）' }).click();
    const download = await downloading; assert(download.suggestedFilename().endsWith('.json'));
    await page.getByRole('button', { name: '閉じる', exact: true }).click();
    await page.locator('#replay-file').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(record)) });
    await page.waitForFunction(() => MJ.ui.review && MJ.ui.review.position === 0);
    // External mjai JSON Lines can be opened directly from the same file input.
    const mjaiText = await page.evaluate(() => MJ.mjai.stringify(MJ.mjai.fromSuitaku(MJ.ui.record)));
    await page.locator('#replay-file').setInputFiles({ name: 'roundtrip.jsonl', mimeType: 'application/json', buffer: Buffer.from(mjaiText) });
    await page.waitForFunction(() => MJ.ui.review && MJ.ui.review.position === 0 && MJ.ui.record.ai === 'imported');
    assert.equal(await page.evaluate(() => MJ.ui.record.format), 'suitaku-riichi');
    // Exercise the original commented v1 record if supplied; keep it read-only.
    if (process.argv[2]) {
      await page.locator('#replay-file').setInputFiles(process.argv[2]);
      await page.waitForFunction(() => MJ.ui.record.createdAt === '2026-10-12T20:33:19.457Z');
      await page.locator('#replay-slider').fill('4');
      assert((await page.locator('.review-note').textContent()).includes('どう考えても字牌'));
      await page.getByRole('button', { name: '現AIで再計算', exact: true }).click();
      await page.waitForFunction(() => MJ.ui.review.analyses.has('0:4'));
      assert.equal(await page.evaluate(() => MJ.ui.review.analyses.get('0:4').candidates[0].t), 30);
      const response = await page.evaluate(() => MJ.ui.record.hands[0].events.findIndex((e) => e.type === 'response' && !e.robKan && e.action?.type !== 'ron'));
      await page.locator('#replay-slider').fill(String(response));
      await page.getByRole('button', { name: '現AIで再計算', exact: true }).click();
      await page.waitForFunction(() => !!document.querySelector('.analysis-summary'));
      assert((await page.locator('.analysis-summary').textContent()).includes('優位'));
      await page.screenshot({ path: path.resolve(__dirname, '../test-results/review-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    }
    // Separate page: forced riichi discard needs no click; tsumo still needs explicit confirmation.
    const auto = await browser.newPage();
    await auto.goto(pathToFileURL(path.resolve(__dirname, '../mahjong.html')).href);
    await auto.getByRole('button', { name: '対局をはじめる →' }).click();
    await auto.waitForFunction(() => MJ.ui.mode === 'discard');
    const automated = await auto.evaluate(async () => {
      window.__SUITAKU_DEBUG__ = true;
      const ui = MJ.ui, agent = ui.game.agents[0], view = { ...ui.view, riichi: true };
      const result = await agent.chooseDiscard(view);
      window.tsumoAccepted = null;
      agent.wantTsumo(view).then((value) => { window.tsumoAccepted = value; });
      return { result, drawnTile: view.drawnTile, mode: ui.mode, accepted: window.tsumoAccepted };
    });
    assert.equal(automated.result.tileId, automated.drawnTile);
    assert(automated.result.analysis.automatic);
    assert.equal(automated.mode, 'choice'); assert.equal(automated.accepted, null);
    await auto.getByRole('button', { name: 'ツモ', exact: true }).click();
    await auto.waitForFunction(() => window.tsumoAccepted === true);
    assert.equal(await auto.evaluate(() => MJ.audio.context?.state), 'running');
    await auto.locator('#sound-enabled').uncheck();
    assert.equal(await auto.evaluate(() => MJ.audio.enabled), false);
    await auto.close();
    assert.deepEqual(errors, []);
    console.log(`Browser UI OK: desktop/mobile, font, river, restart, ${record.hands.length} hands, export/import/replay`);
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
