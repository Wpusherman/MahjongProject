'use strict';
// mjai / Tenhou replay converter.
//
//   node tools/mjai-convert.js to-mjai <suitaku.json> <out.jsonl>
//   node tools/mjai-convert.js from-mjai <in.jsonl> <out.json> [--strict]
//   node tools/mjai-convert.js tenhou <in.mjlog[.gz]> <out.jsonl>
//   node tools/mjai-convert.js tenhou-to-suitaku <in.mjlog[.gz]> <out.json> [--strict]
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
for (const file of ['tiles', 'shanten', 'agari', 'yaku', 'score', 'rank', 'ai', 'game', 'record', 'mjai']) require(path.join(__dirname, '..', 'src', file + '.js'));
const MJ = globalThis.MJ, M = MJ.mjai;

const readText = (file) => {
  const buf = fs.readFileSync(file);
  return buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf).toString('utf8') : buf.toString('utf8');
};
const usage = [
  'usage: node tools/mjai-convert.js <command> <input> <output> [--strict]',
  '  to-mjai           翠卓 JSON -> mjai JSON Lines [--seat N --mask-other-draws]',
  '  from-mjai         mjai JSON Lines -> 翠卓 JSON',
  '  tenhou            天鳳 mjlog(XML/gzip) -> mjai JSON Lines',
  '  tenhou-to-suitaku 天鳳 mjlog -> 翠卓 JSON',
  '  --verify-wall     reproduce the Tenhou wall from SHUFFLE and compare it with the log'
].join('\n');

const [command, input, output, ...rest] = process.argv.slice(2);
if (!command || !input || !output) { console.error(usage); process.exit(2); }
const strict = rest.includes('--strict');
const seatIndex = rest.indexOf('--seat');
const seat = seatIndex >= 0 ? Number(rest[seatIndex + 1]) : null;
const maskOtherDraws = rest.includes('--mask-other-draws');
const verifyWall = rest.includes('--verify-wall');

try {
  if (command === 'to-mjai') {
    const record = JSON.parse(readText(input));
    if (maskOtherDraws && !(Number.isInteger(seat) && seat >= 0 && seat < 4)) throw new Error('--mask-other-draws requires --seat 0..3');
    const events = M.fromSuitaku(record, { seat, maskOtherDraws });
    fs.writeFileSync(output, M.stringify(events));
    console.log(`wrote ${events.length} mjai events -> ${output}`);
  } else if (command === 'from-mjai') {
    const record = M.toSuitaku(M.parse(readText(input)), { strict });
    const validation = M.validate(record);
    fs.writeFileSync(output, JSON.stringify(record, null, 2));
    console.log(`wrote ${record.hands.length} hands -> ${output}`);
    if (!validation.ok) { for (const w of validation.warnings) console.warn('warning:', w); process.exitCode = 1; }
  } else if (command === 'tenhou' || command === 'tenhou-to-suitaku') {
    const xml = readText(input);
    const events = M.fromTenhou(xml);
    if (command === 'tenhou') {
      fs.writeFileSync(output, M.stringify(events));
      console.log(`wrote ${events.length} mjai events -> ${output}`);
    } else {
      const record = M.toSuitaku(events, { strict, source: 'tenhou' });
      const validation = M.validate(record);
      fs.writeFileSync(output, JSON.stringify(record, null, 2));
      console.log(`wrote ${record.hands.length} hands -> ${output}`);
      if (!validation.ok) { for (const w of validation.warnings) console.warn('warning:', w); process.exitCode = 1; }
    }
    if (verifyWall) {
      const record = command === 'tenhou' ? M.toSuitaku(events, { source: 'tenhou' }) : M.toSuitaku(events, { strict, source: 'tenhou' });
      const check = M.verifyTenhouWall(xml, record);
      for (const round of check.rounds) {
        if (!round.ok) console.warn(`wall round ${round.index + 1}:`, round.errors.join(' / '));
      }
      console.log(`wall verification: ${check.ok ? 'OK' : 'MISMATCH'} (${check.rounds.length} rounds)`);
      if (!check.ok) process.exitCode = 1;
    }
  } else {
    console.error(usage); process.exit(2);
  }
} catch (error) {
  console.error('conversion failed:', error.message);
  process.exit(1);
}
