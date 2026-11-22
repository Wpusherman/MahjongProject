'use strict';
// Dependency-free mjai JSONL smoke test, plus an optional external-tool hook.
//
//   node tools/mjai-smoke.js out.jsonl
//   node tools/mjai-smoke.js out.jsonl --command "npx mjai-reviewer"
//
// The command receives the JSONL path as its last argument. This catches gross
// schema incompatibilities before feeding a log to Mortal-family tools; it does
// not replace running the real tool.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const TYPES = new Set(['start_game', 'start_kyoku', 'tsumo', 'dahai', 'chi', 'pon', 'daiminkan',
  'ankan', 'kakan', 'dora', 'reach', 'reach_accepted', 'hora', 'ryukyoku', 'end_kyoku', 'end_game']);
const PAIS = /^(?:[1-9][mps]r?|[ESWNPFC])$/;

function parseArgs(argv) {
  const args = { file: null, command: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--command') args.command = argv[++i];
    else if (!args.file) args.file = argv[i];
    else throw new Error('unknown argument: ' + argv[i]);
  }
  return args;
}

function check(events) {
  const errors = [];
  let started = false, ended = false, rounds = 0, horas = 0;
  events.forEach((event, index) => {
    const at = `event ${index}`;
    if (!event || typeof event !== 'object') { errors.push(`${at}: not an object`); return; }
    if (!TYPES.has(event.type)) { errors.push(`${at}: unknown type ${event.type}`); return; }
    for (const key of ['actor', 'target']) if (event[key] != null && (!Number.isInteger(event[key]) || event[key] < 0 || event[key] > 3)) {
      errors.push(`${at}: ${key} is not a seat`);
    }
    if (event.pai != null && event.pai !== '?' && !PAIS.test(event.pai)) errors.push(`${at}: bad pai ${event.pai}`);
    if (Array.isArray(event.consumed)) for (const pai of event.consumed) if (!PAIS.test(pai)) errors.push(`${at}: bad consumed ${pai}`);
    if (event.type === 'start_game') {
      if (started) errors.push(`${at}: duplicate start_game`);
      started = true;
      if (!event.rule || typeof event.rule !== 'object') errors.push(`${at}: missing rule`);
    } else if (!started) errors.push(`${at}: event before start_game`);
    if (event.type === 'start_kyoku') {
      rounds++;
      if (!Array.isArray(event.tehais) || event.tehais.length !== 4 || event.tehais.some((h) => !Array.isArray(h) || h.length !== 13)) {
        errors.push(`${at}: tehais must be four 13-tile arrays`);
      }
      if (!Array.isArray(event.scores) || event.scores.length !== 4) errors.push(`${at}: scores must have four values`);
      else if (event.scores.reduce((a, b) => a + b, 0) + (event.kyotaku || 0) * 1000 !== 100000) {
        errors.push(`${at}: scores + kyotaku do not sum to 100000`);
      }
      if (event.dora_marker != null && !PAIS.test(event.dora_marker)) errors.push(`${at}: bad dora_marker`);
    }
    if (event.type === 'hora') {
      horas++;
      if (event.scores && event.scores.reduce((a, b) => a + b, 0) !== 100000) errors.push(`${at}: hora scores do not sum to 100000`);
    }
    if (event.type === 'end_kyoku') {
      if (!rounds) errors.push(`${at}: end_kyoku before start_kyoku`);
    }
    if (event.type === 'end_game') ended = true;
  });
  if (!started) errors.push('start_game is missing');
  if (!ended) errors.push('end_game is missing');
  if (!rounds) errors.push('no rounds');
  return { errors, rounds, horas };
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) { console.error('usage: node tools/mjai-smoke.js <events.jsonl> [--command "..."]'); process.exit(2); }
  const text = fs.readFileSync(args.file, 'utf8');
  const events = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { events.push(JSON.parse(line)); } catch (e) { throw new Error(`line ${i + 1}: ${e.message}`); }
  });
  const result = check(events);
  if (result.errors.length) {
    for (const error of result.errors.slice(0, 30)) console.error('error:', error);
    if (result.errors.length > 30) console.error(`... ${result.errors.length - 30} more`);
    process.exit(1);
  }
  console.log(`mjai smoke OK: ${events.length} events, ${result.rounds} rounds, ${result.horas} wins, ${args.file}`);
  if (args.command) {
    const parts = args.command.split(/\s+/).filter(Boolean);
    const run = spawnSync(parts[0], [...parts.slice(1), args.file], { stdio: 'inherit' });
    if (run.error) throw run.error;
    if (run.status !== 0) { console.error(`external tool exited with ${run.status}`); process.exit(run.status || 1); }
    console.log('external mjai tool accepted the file');
  }
} catch (error) {
  console.error('mjai smoke failed:', error.message);
  process.exit(1);
}
