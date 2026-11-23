'use strict';
// Game Result Prediction dataset: one row per seat at each hand start.
//
//   node tools/grp-dataset.js "Saved Data/*.json" --out data/grp.jsonl
//   node tools/grp-dataset.js game.json --out data/grp.jsonl --rank tenhou
//
// Each row is { v, hand, seat, x, rank, finalScore, scoreDelta }. The feature
// order is MJ.grp.FEATURES (grp-v1); the label is the final placement.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'mjai', 'grp']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ, G = MJ.grp, M = MJ.mjai;

const usage = [
  'usage: node tools/grp-dataset.js <record.json|mjlog...> --out <rows.jsonl> [options]',
  '  --out FILE       output JSONL (required)',
  '  --meta FILE      feature metadata JSON (default: <out>.meta.json)',
  '  --rank NAME      tenhou|mleague|raw label config (default: tenhou)',
  '  --allow-diffs    convert Tenhou rule-difference matches instead of skipping',
  '  --help'
].join('\n');

function parseArgs(argv) {
  const args = { files: [], rank: 'tenhou', out: null, meta: null, allowDiffs: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--allow-diffs') { args.allowDiffs = true; continue; }
    if (key === '--out') args.out = argv[++i];
    else if (key === '--meta') args.meta = argv[++i];
    else if (key === '--rank') args.rank = argv[++i];
    else if (key.startsWith('-')) throw new Error('unknown option: ' + key);
    else args.files.push(key);
  }
  return args;
}

function expand(files) {
  const out = [];
  for (const file of files) {
    if (!fs.existsSync(file)) throw new Error('not found: ' + file);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) if (/\.(json|mjlog\.gz|mjlog)$/.test(name)) out.push(path.join(file, name));
    } else out.push(file);
  }
  return out.sort();
}
const readText = (file) => {
  const buf = fs.readFileSync(file);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); process.exit(0); }
  if (!args.out || !args.files.length) { console.error(usage); process.exit(2); }
  const rows = [];
  let records = 0, tenhou = 0, skipped = 0;
  for (const file of expand(args.files)) {
    let record;
    if (/\.mjlog(\.gz)?$/i.test(file)) {
      try {
        const events = M.fromTenhou(readText(file));
        record = args.allowDiffs ? M.toSuitaku(events, { source: 'tenhou' }) : M.toSuitaku(events, { strict: true, source: 'tenhou' });
        tenhou++;
      } catch (error) {
        skipped++;
        continue;
      }
    } else {
      record = JSON.parse(readText(file));
      if (!record || !Array.isArray(record.hands) || !record.hands.length) { skipped++; continue; }
      if (record.redacted) throw new Error('masked records have no final result and cannot train a GRP: ' + file);
    }
    const matchId = record.createdAt || record.matchId || path.basename(file);
    rows.push(...G.dataset(record, { rankConfig: args.rank, matchId, source: path.basename(file) }));
    records++;
  }
  if (!rows.length) throw new Error('no GRP samples found');
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, G.toJSONL(rows));
  const meta = {
    format: 'suitaku-grp-dataset', version: G.version, featureCount: G.FEATURES.length,
    features: G.FEATURES.slice(), label: 'final rank 1..4', rankConfig: args.rank,
    records, tenhouRecords: tenhou, skipped, samples: rows.length, createdAt: new Date().toISOString(),
    source: '翠卓 record / converted Tenhou mjlog (see tools/mjai-convert.js)'
  };
  const metaFile = args.meta || args.out + '.meta.json';
  fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2) + '\n');
  console.log(`wrote ${rows.length} GRP samples from ${records} records (${tenhou} Tenhou, skipped ${skipped}) -> ${args.out}`);
  console.log(`metadata -> ${metaFile}`);
} catch (error) {
  console.error('grp-dataset failed:', error.message);
  process.exit(1);
}
