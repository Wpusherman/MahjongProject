'use strict';
// Batch Tenhou -> mjai (strict) -> features pipeline with an exclusion report.
//
//   node tools/tenhou-pipeline.js <mjlog-dir-or-files...> \
//     --out-features data/features/tenhou.jsonl --out-report data/tenhou-report.json
//
// Rule differences that 翠卓 does not implement (nine terminals, nagashi
// mangan, pao, double ron, red-less logs, no-kuitan logs, three-player games)
// are excluded in strict mode and counted by reason. The pipeline does not
// bundle or download replays; point it at files you are allowed to use.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'mjai', 'features']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ, M = MJ.mjai, F = MJ.features;

const usage = [
  'usage: node tools/tenhou-pipeline.js <mjlog...> --out-features FILE --out-report FILE [options]',
  '  --out-features FILE  feature JSONL output (required)',
  '  --out-report FILE    JSON report (default: <out-features>.report.json)',
  '  --limit N            process at most N matches',
  '  --limit-per-match N  cap feature samples per match',
  '  --allow-diffs        convert rule-difference matches instead of excluding them',
  '  --help'
].join('\n');

function parseArgs(argv) {
  const args = { files: [], limit: Infinity, limitPerMatch: undefined, allowDiffs: false, outFeatures: null, outReport: null };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--help' || key === '-h') { args.help = true; continue; }
    if (key === '--out-features') args.outFeatures = argv[++i];
    else if (key === '--out-report') args.outReport = argv[++i];
    else if (key === '--limit') args.limit = Number(argv[++i]);
    else if (key === '--limit-per-match') args.limitPerMatch = Number(argv[++i]);
    else if (key === '--allow-diffs') { args.allowDiffs = true; continue; }
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

const REASONS = [
  ['sanma', /三麻/], ['nine_terminals', /九種九牌/], ['nagashi_mangan', /流し満貫/],
  ['pao', /包（/], ['double_ron', /複数ロン/], ['red_mismatch', /赤なし/],
  ['no_kuitan', /喰いタンなし/], ['validation', /最終点数|合計が100,000|イベント番号|配牌/]
];

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage); process.exit(0); }
  if (!args.outFeatures || !args.files.length) { console.error(usage); process.exit(2); }
  const files = expand(args.files).slice(0, Number.isFinite(args.limit) ? args.limit : undefined);
  fs.mkdirSync(path.dirname(path.resolve(args.outFeatures)), { recursive: true });
  fs.writeFileSync(args.outFeatures, '');
  const excluded = {}, failures = {}, samplesByLabel = {};
  let converted = 0, excludedMatches = 0, failed = 0, hands = 0, samples = 0;
  const started = Date.now();
  for (const file of files) {
    let events;
    try {
      events = M.fromTenhou(readText(file));
    } catch (error) {
      failed++;
      const reason = (REASONS.find(([, re]) => re.test(error.message)) || ['parse'])[0];
      failures[reason] = (failures[reason] || 0) + 1;
      continue;
    }
    let record = null;
    try {
      record = M.toSuitaku(events, { strict: true, source: 'tenhou' });
    } catch (error) {
      let flags = [];
      try { flags = M.toSuitaku(events, { source: 'tenhou' }).mjai.flags || []; } catch (_) {}
      const reasons = flags.length ? flags : [(REASONS.find(([, re]) => re.test(error.message)) || ['other'])[0]];
      if (args.allowDiffs) {
        try { record = M.toSuitaku(events, { source: 'tenhou' }); } catch (again) {
          failed++; failures.other = (failures.other || 0) + 1; continue;
        }
      } else {
        excludedMatches++;
        for (const reason of new Set(reasons)) excluded[reason] = (excluded[reason] || 0) + 1;
        continue;
      }
    }
    converted++;
    hands += record.hands.length;
    try {
      const rows = F.dataset(record, { limit: args.limitPerMatch });
      samples += rows.length;
      for (const row of rows) {
        const kind = row.label && row.label.kind || 'unknown';
        samplesByLabel[kind] = (samplesByLabel[kind] || 0) + 1;
      }
      fs.appendFileSync(args.outFeatures, F.toJSONL(rows));
    } catch (error) {
      failures.features = (failures.features || 0) + 1;
    }
  }
  const elapsedMs = Date.now() - started;
  const report = {
    format: 'suitaku-tenhou-pipeline-report', version: 1,
    files: files.length, converted, excluded: excludedMatches, failed,
    exclusionReasons: excluded, failureReasons: failures,
    hands, samples, samplesByLabel, samplesPerMatch: converted ? samples / converted : 0,
    handsPerMatch: converted ? hands / converted : 0,
    failureRate: files.length ? failed / files.length : 0,
    exclusionRate: files.length ? excludedMatches / files.length : 0,
    strict: !args.allowDiffs, limitPerMatch: args.limitPerMatch || null,
    note: 'Tenhou uses a 30,000-point return (oka 20), recorded in record.mjai.tenhou. Not bundled data.',
    elapsedMs
  };
  const reportFile = args.outReport || args.outFeatures + '.report.json';
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  console.log(`converted ${converted}/${files.length} matches, ${hands} hands, ${samples} samples -> ${args.outFeatures}`);
  console.log(`excluded ${excludedMatches} (${JSON.stringify(excluded)}), failed ${failed} (${JSON.stringify(failures)})`);
  console.log(`report -> ${reportFile} (${(elapsedMs / 1000).toFixed(1)} s)`);
} catch (error) {
  console.error('tenhou pipeline failed:', error.message);
  process.exit(1);
}
