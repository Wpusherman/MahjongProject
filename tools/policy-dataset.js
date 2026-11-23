'use strict';
// Build obs-v2 policy-training samples from a directory of Tenhou mjlog files.
//
//   node tools/policy-dataset.js data/tenhou --out test-results/policy-tenhou.jsonl
//
// Calls and passes are reconstructed for records that have no `response` events
// (Tenhou conversions record only actual `call` events). Rule-difference matches
// are excluded in strict mode and counted by reason. Replay data is not committed.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'mjai', 'features']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ, F = MJ.features, M = MJ.mjai;

const usage = [
  'usage: node tools/policy-dataset.js <mjlog-dir-or-files...> --out FILE [options]',
  '  --out FILE        output JSONL (required)',
  '  --report FILE     report JSON (default: <out>.report.json)',
  '  --limit N         process at most N matches',
  '  --allow-diffs     convert Tenhou rule-difference matches instead of excluding',
  '  --help'
].join('\n');

function parseArgs(argv) {
  const args = { files: [], out: null, report: null, limit: Infinity, allowDiffs: false };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--allow-diffs') { args.allowDiffs = true; continue; }
    if (key === '--out') args.out = argv[++i];
    else if (key === '--report') args.report = argv[++i];
    else if (key === '--limit') args.limit = Number(argv[++i]);
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
      for (const name of fs.readdirSync(file)) if (/\.mjlog(\.gz)?$/.test(name)) out.push(path.join(file, name));
    } else out.push(file);
  }
  return out.sort();
}
const readText = (file) => {
  const buf = fs.readFileSync(file);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};
const REASONS = [[/三麻/, 'sanma'], [/九種九牌/, 'nine_terminals'], [/流し満貫/, 'nagashi_mangan'],
  [/包（/, 'pao'], [/複数ロン/, 'multiple_hora'], [/赤なし/, 'red_mismatch'], [/喰いタンなし/, 'no_kuitan']];

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); process.exit(0); }
  if (!args.out || !args.files.length) { console.error(usage); process.exit(2); }
  const files = expand(args.files).slice(0, Number.isFinite(args.limit) ? args.limit : undefined);
  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, '');
  const started = Date.now();
  const counts = {}, excluded = {}, failures = {};
  let converted = 0, matches = 0, hands = 0, samples = 0, riichiPositives = 0;
  for (const file of files) {
    let record;
    try {
      const events = M.fromTenhou(readText(file));
      try {
        record = args.allowDiffs ? M.toSuitaku(events, { source: 'tenhou' }) : M.toSuitaku(events, { strict: true, source: 'tenhou' });
      } catch (error) {
        let flags = [];
        try { flags = M.toSuitaku(events, { source: 'tenhou' }).mjai.flags || []; } catch (_) {}
        const reason = flags.length ? flags.join('+') : (REASONS.find(([re]) => re.test(error.message)) || ['other'])[0];
        excluded[reason] = (excluded[reason] || 0) + 1;
        continue;
      }
    } catch (error) {
      failures[(REASONS.find(([re]) => re.test(error.message)) || ['parse'])[0]] =
        (failures[(REASONS.find(([re]) => re.test(error.message)) || ['parse'])[0]] || 0) + 1;
      continue;
    }
    converted++;
    hands += record.hands.length;
    try {
      const rows = F.dataset(record);
      for (const row of rows) {
        const kind = row.label.kind;
        counts[kind] = (counts[kind] || 0) + 1;
        if (kind === 'discard' && row.label.riichi) riichiPositives++;
      }
      samples += rows.length;
      fs.appendFileSync(args.out, F.toJSONL(rows));
    } catch (error) {
      failures.features = (failures.features || 0) + 1;
    }
  }
  matches = converted;
  const report = {
    format: 'suitaku-policy-dataset', version: F.version, files: files.length, converted, excluded: Object.values(excluded).reduce((a, b) => a + b, 0),
    excludedByReason: excluded, failures, notes: 'Tenhou Phoenix logs; replay data not committed',
    matches, hands, samples, labels: counts, riichiPositives,
    strict: !args.allowDiffs, elapsedMs: Date.now() - started
  };
  const reportFile = args.report || args.out + '.report.json';
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`converted ${converted}/${files.length}, ${hands} hands, ${samples} samples -> ${args.out}`);
  console.log('labels:', counts, 'riichi+', riichiPositives);
  console.log(`excluded ${report.excluded} (${JSON.stringify(excluded)}), failed ${JSON.stringify(failures)}`);
  console.log(`report -> ${reportFile} (${(report.elapsedMs / 1000).toFixed(1)} s)`);
} catch (error) {
  console.error('policy dataset failed:', error && error.stack ? error.stack : error);
  process.exit(1);
}
