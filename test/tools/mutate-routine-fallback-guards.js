#!/usr/bin/env node
'use strict';
// Break each rule of when a routine falls back to a plain session, and how its
// ending is settled, in turn, and report which tests notice. A plain session
// runs without the agent file's tools: line, so each of these rules either
// keeps a run from widening its own reach or keeps a run from being left open,
// and each can be deleted with every run still ending somehow. Same shape as
// its siblings, deliberately a separate copy.
//
//   node test/tools/mutate-routine-fallback-guards.js [--markdown]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
// The reading of an agent file, watched by the file that proves each of its
// refusals on a specimen.
const READER = { src: path.join(ROOT, 'lib', 'agents', 'claude-code-load.js'), suite: 'test/unit/routine-values-load-in-claude-code.test.js' };
// The scheduler's ending, watched by the unit file that drives it with a
// stand-in child and stands in for the reader.
const ENDING = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/scheduler-lib.test.js' };
// The cut that keeps the capture small, watched by the file that drives it one
// look at a time, so a row here is judged by the same looks on every run.
const CUT = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/scheduler-capture-cut.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== THE CHECK NEVER THROWS =====
  [READER, 'a code point past U+10FFFF is a refusal the reader makes, not a throw',
    '    if (point > 0x10ffff) fail(line, ',
    '    if (false) fail(line, '],
  [ENDING, 'a reader that throws is a file the check cannot judge',
    "    console.error('[Scheduler] Could not check the agent file:', e && e.message ? e.message : e);\n    return { refused: false, unchecked: { line: null } };",
    '    throw e;'],
  // ===== EVERY CLOSE ENDS IN AN OUTCOME =====
  [ENDING, 'a throw while settling an ending is caught in the handler',
    "        failure = err;\n        console.error('[Scheduler] Could not settle how the routine ended:'",
    "        throw err;\n        console.error('[Scheduler] Could not settle how the routine ended:'"],
  [ENDING, 'an ending that was not handed on is always recorded',
    '        if (!handedOn) {',
    '        if (false) {'],
  // ===== WHAT IS KEPT OF STDERR IS ITS END =====
  [ENDING, 'the ending reads the end of what the child wrote',
    '    const now = readTail(capture.fd, fs.fstatSync(capture.fd).size, CAPTURE_BYTES);',
    '    const now = readTail(capture.fd, Math.min(CAPTURE_BYTES, fs.fstatSync(capture.fd).size), CAPTURE_BYTES);'],
  [ENDING, 'a cut keeps in memory the tail it read',
    '      capture.kept = tail;',
    '      capture.kept = null;'],
  [ENDING, 'a cut empties the file rather than keeping its start',
    '      fs.ftruncateSync(capture.fd, 0);',
    '      fs.ftruncateSync(capture.fd, CAPTURE_BYTES);'],
  [ENDING, 'the capture is cut back at all',
    '      if (size <= CAPTURE_BYTES) return;',
    '      return;'],
  // ===== A WRITE THAT LANDS WHILE THE FILE IS BEING CUT IS KEPT =====
  [CUT, 'the cut looks at the size again after reading the tail',
    '      for (let look = 0; look < 3; look++) {\n        const now = deps.captureSize(capture.fd);\n'
      + '        if (now === size) break;\n        size = now;\n        tail = readTail(capture.fd, size, CAPTURE_BYTES);\n      }\n',
    ''],
  [CUT, 'the looks stop when the size holds, not when it grows',
    '        if (now === size) break;',
    '        if (now !== size) break;'],
  [CUT, 'the tail kept is the one read at the last look, not the first',
    '        size = now;\n        tail = readTail(capture.fd, size, CAPTURE_BYTES);',
    '        size = now;'],
  // ===== A FILE RUNDOCK COULD NOT CHECK IS A FAILED RUN, AND SAYS WHY =====
  [ENDING, 'YAML the rules do not model is never called refused',
    '    return read.unmodeled ? { refused: false, unchecked: { line: read.line } } : { refused: true };',
    '    return { refused: true };'],
  [ENDING, 'a file that could not be checked is given the reason that says what to do',
    '    return { ok: false, err: { message: judged.unchecked ? uncheckedStop(agent, judged.unchecked) : UNREAD_STOP } };',
    '    return { ok: false, err: { message: UNREAD_STOP } };'],
  [ENDING, 'the line the reason names is the line in the file, not in its frontmatter',
    '  const where = unchecked.line ? ` (at line ${unchecked.line + 1} of the file)` : \'\';',
    '  const where = unchecked.line ? ` (at line ${unchecked.line} of the file)` : \'\';'],
];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', '--test-reporter', 'spec', suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) return failed ? { unparsable: true } : [];
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: targets.map((t) => t.src) });
  const originals = new Map(targets.map((t) => [t, session.original(t.src)]));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches !== 1) { results.push({ label, applied: false, ambiguous: matches > 1 ? matches : 0, red: [] }); continue; }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable ? { label, applied: true, unparsable: true, red: [] } : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    let why = null;
    if (unparsable) why = 'no verdict: the suite failed but its output could not be parsed';
    else if (ambiguous) why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
    else if (!applied) why = 'the guard text was not found, so nothing was mutated';
    else if (red.length === 0) why = 'nothing turned red';
    if (why) {
      failed++;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
  }
  for (const line of lines) console.log(markdown ? line : `\n${line}`);
  return failed;
}
if (require.main === module) {
  const verdict = preflight(os.tmpdir());
  if (!verdict.ok) { console.error(verdict.message); process.exit(NO_VERDICT); }
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded.`);
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
