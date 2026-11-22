'use strict';
// Extract hand-start states (scores, dealer, honba, deposits, hand index) from
// Tenhou mjlog files and write them as JSONL for:
//
//   node tools/evaluate.js --start-states data/start-states.jsonl --seeds 1000
//
// The default keeps South 3 and South 4 starts, where rank-point pressure is
// strongest and the remaining-hand count is small. This is the mode used to
// validate rankBias on real standings instead of a synthetic handicap.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'mjai']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ, M = MJ.mjai;

const usage = [
  'usage: node tools/start-states.js <mjlog...> --out <states.jsonl> [options]',
  '  --out FILE     output JSONL (required)',
  '  --hands LIST   comma-separated hand indices to keep (default: 6,7 = South 3-4)',
  '  --all          keep every hand start',
  '  --meta FILE    metadata JSON (default: <out>.meta.json)',
  '  --help'
].join('\n');

function parseArgs(argv) {
  const args = { files: [], hands: [6, 7], all: false, out: null, meta: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--all') { args.all = true; continue; }
    if (key === '--out') args.out = argv[++i];
    else if (key === '--meta') args.meta = argv[++i];
    else if (key === '--hands') args.hands = argv[++i].split(',').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 7);
    else if (key.startsWith('-')) throw new Error('unknown option: ' + key);
    else args.files.push(key);
  }
  return args;
}

function expand(files) {
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error('not found: ' + file);
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file)) if (/\.(mjlog(\.gz)?|json)$/.test(name)) out.push(path.join(file, name));
    } else out.push(file);
  }
  return out;
}

const readText = (file) => {
  const buf = fs.readFileSync(file);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); process.exit(0); }
  if (!args.out || !args.files.length) { console.error(usage); process.exit(2); }
  const keep = new Set(args.hands);
  const rows = [];
  let files = 0, rounds = 0, skipped = 0;
  for (const file of expand(args.files)) {
    // A finished 翠卓 record also carries each hand's starting scores/dealer.
    if (/\.json$/i.test(file) && !/\.jsonl$/i.test(file)) {
      let record;
      try { record = JSON.parse(readText(file)); } catch (error) {
        console.warn('skip', file, '-', error.message);
        skipped++;
        continue;
      }
      if (record.redacted) { skipped++; continue; }
      const mode = record.mode === 'hanchan' ? 'hanchan' : 'tonpu';
      (record.hands || []).forEach((hand, index) => {
        const config = hand.config || {};
        const handIndex = Number.isInteger(config.hand) ? config.hand : index;
        if (!args.all && !keep.has(handIndex)) return;
        if (!Array.isArray(config.scores) || config.scores.length !== 4) { skipped++; return; }
        rows.push({ scores: config.scores.map(Number), dealer: config.dealer | 0, honba: config.honba || 0,
          riichiSticks: config.riichiSticks || 0, handIndex, roundWind: 27 + Math.floor(handIndex / 4),
          kyoku: handIndex % 4 + 1, mode, source: path.basename(file) });
        rounds++;
      });
      files++;
      continue;
    }
    let events;
    try { events = M.fromTenhou(readText(file)); } catch (error) {
      console.warn('skip', file, '-', error.message);
      skipped++;
      continue;
    }
    const mode = (events.find((e) => e.type === 'start_game') || {}).rule?.mode === 'hanchan' ? 'hanchan' : 'tonpu';
    for (const event of events) {
      if (event.type !== 'start_kyoku') continue;
      const handIndex = (event.bakaze === 'S' ? 4 : 0) + (event.kyoku - 1);
      if (!args.all && !keep.has(handIndex)) continue;
      const scores = event.scores.map(Number);
      if (scores.length !== 4 || !scores.every(Number.isFinite)) { skipped++; continue; }
      rows.push({
        scores,
        dealer: event.oya,
        honba: event.honba || 0,
        riichiSticks: event.kyotaku || 0,
        handIndex,
        roundWind: event.bakaze === 'S' ? 28 : 27,
        kyoku: event.kyoku,
        mode,
        source: path.basename(file)
      });
      rounds++;
    }
    files++;
  }
  if (!rows.length) throw new Error('no start states found (check --hands)');
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const meta = {
    format: 'suitaku-start-states', version: M.version, hands: args.all ? 'all' : args.hands,
    files, rounds, samples: rows.length, skippedFiles: skipped,
    note: 'Scores exclude riichi deposits. Use with tools/evaluate.js --start-states.'
  };
  const metaFile = args.meta || args.out + '.meta.json';
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${rows.length} start states from ${files} files -> ${args.out}`);
  console.log(`metadata -> ${metaFile}`);
} catch (error) {
  console.error('start-states failed:', error.message);
  process.exit(1);
}
