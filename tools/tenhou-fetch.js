'use strict';
// Download public Tenhou Phoenix-table (鳳凰卓) replays for the offline pipeline.
//
//   node tools/tenhou-fetch.js --hours 6 --out data/tenhou
//
// The hourly indexes (sccYYYYMMDDHH.html.gz) link four-player Phoenix games
// with red fives and kuitan. Only those links are downloaded; three-player and
// other rule sets are skipped. Replay files are NOT committed (see .gitignore).
// The player names inside a replay are not used by the converter.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const usage = [
  'usage: node tools/tenhou-fetch.js [options]',
  '  --out DIR        replay directory (default: data/tenhou)',
  '  --hours N        most recent N hourly index files (default: 3)',
  '  --logs N         cap downloaded replays (default: 240)',
  '  --date YYYYMMDD  only this day\'s hourly index',
  '  --rate MS        delay between requests (default: 350)',
  '  --dry-run        list the selected replay ids without downloading',
  '  --help'
].join('\n');

function parseArgs(argv) {
  const args = { out: path.join('data', 'tenhou'), hours: 3, logs: 240, date: null, rate: 350, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--dry-run') { args.dryRun = true; continue; }
    if (key === '--out') args.out = argv[++i];
    else if (key === '--hours') args.hours = Math.max(1, Number(argv[++i]));
    else if (key === '--logs') args.logs = Math.max(1, Number(argv[++i]));
    else if (key === '--date') args.date = String(argv[++i]);
    else if (key === '--rate') args.rate = Math.max(0, Number(argv[++i]));
    else throw new Error('unknown option: ' + key);
  }
  return args;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const LIST_URL = 'https://tenhou.net/sc/raw/list.cgi';
const INDEX_URL = (file) => 'https://tenhou.net/sc/raw/dat/' + file;
const LOG_URL = (id) => 'https://tenhou.net/0/log/?' + id;

async function fetchBuffer(url) {
  const response = await fetch(url, { headers: { 'user-agent': 'suitaku-research/1.0' } });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}
function decode(buffer) {
  return buffer[0] === 0x1f && buffer[1] === 0x8b ? zlib.gunzipSync(buffer).toString('utf8') : buffer.toString('utf8');
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); return; }
  const listText = decode(await fetchBuffer(LIST_URL));
  const files = [...listText.matchAll(/file:'([^']+)'/g)].map((m) => m[1])
    .filter((file) => /^scc\d{10}\.html\.gz$/.test(file))
    .filter((file) => !args.date || file.startsWith('scc' + args.date))
    .sort()
    .slice(-args.hours);
  if (!files.length) throw new Error('no Phoenix hourly index found (check --date)');
  console.log(`indexes: ${files.join(', ')}`);
  const ids = [];
  for (const file of files) {
    await sleep(args.rate);
    const html = decode(await fetchBuffer(INDEX_URL(file)));
    for (const line of html.split(/<br\s*\/?>/i)) {
      if (!line.includes('四鳳')) continue;
      const match = line.match(/log=([0-9A-Za-z-]+)/);
      if (match && !ids.includes(match[1])) ids.push(match[1]);
    }
  }
  const selected = ids.slice(0, args.logs);
  console.log(`found ${ids.length} four-player Phoenix ids, downloading ${selected.length}`);
  if (args.dryRun) { console.log(selected.join('\n')); return; }
  fs.mkdirSync(args.out, { recursive: true });
  let downloaded = 0, skipped = 0, failed = 0;
  for (const id of selected) {
    const target = path.join(args.out, id + '.mjlog');
    if (fs.existsSync(target) && fs.statSync(target).size > 0) { skipped++; continue; }
    try {
      await sleep(args.rate);
      const buffer = await fetchBuffer(LOG_URL(id));
      const text = decode(buffer);
      if (!text.startsWith('<mjloggm')) throw new Error('not an mjlog');
      fs.writeFileSync(target, text);
      downloaded++;
    } catch (error) {
      failed++;
      console.warn('skip', id, '-', error.message);
    }
  }
  const manifest = { format: 'suitaku-tenhou-fetch', version: 1, fetchedAt: new Date().toISOString(),
    indexes: files, found: ids.length, selected: selected.length, downloaded, skipped, failed,
    note: 'Public Phoenix replays. Not committed. Rule-difference filtering happens in tools/tenhou-pipeline.js.' };
  fs.writeFileSync(path.join(args.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`downloaded ${downloaded}, skipped ${skipped}, failed ${failed} -> ${args.out}`);
})().catch((error) => { console.error('tenhou fetch failed:', error && error.stack ? error.stack : error); process.exit(1); });
