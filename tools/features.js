'use strict';
// Build supervised-learning samples from 翠卓 / mjai / Tenhou replays.
//
//   node tools/features.js <input> <out.jsonl> [--limit N]
//
// Each JSONL line contains the 34×C tile tensor, global scalars, and an action label.
// Use pandas/pyarrow in Python to convert JSONL shards to Parquet if needed.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'mjai', 'features']) {
  require(path.join(__dirname, '..', 'src', file + '.js'));
}
const MJ = globalThis.MJ, F = MJ.features;
const readText = (file) => {
  const buf = fs.readFileSync(file);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};
const args = process.argv.slice(2);
const input = args[0], output = args[1];
const limitIndex = args.indexOf('--limit');
const limit = limitIndex >= 0 ? Number(args[limitIndex + 1]) : undefined;
if (!input || !output) {
  console.error('usage: node tools/features.js <suitaku.json|mjai.jsonl|tenhou.mjlog> <out.jsonl> [--limit N]');
  process.exit(2);
}

try {
  const text = readText(input), lower = input.toLowerCase();
  let record, external = false;
  if (text.trimStart().startsWith('<') || lower.endsWith('.mjlog') || lower.endsWith('.xml')) {
    record = MJ.mjai.toSuitaku(MJ.mjai.fromTenhou(text), { source: 'tenhou' });
    external = true;
  } else {
    try { record = JSON.parse(text); } catch (_) {}
    if (!record || !Array.isArray(record.hands)) {
      record = MJ.mjai.toSuitaku(MJ.mjai.parse(text), { source: 'mjai' });
      external = true;
    }
  }
  if (external) {
    const check = MJ.mjai.validate(record);
    for (const warning of check.warnings) console.warn('warning:', warning);
  }
  const samples = F.dataset(record, { limit });
  fs.writeFileSync(output, F.toJSONL(samples));
  const counts = {};
  for (const s of samples) counts[s.label.kind] = (counts[s.label.kind] || 0) + 1;
  console.log(`wrote ${samples.length} samples -> ${output}`);
  console.log('labels:', counts);
  if (samples.length) console.log('tensor:', samples[0].x.shape, 'total floats:', samples[0].x.data.length);
} catch (error) {
  console.error('feature extraction failed:', error.message);
  process.exit(1);
}
