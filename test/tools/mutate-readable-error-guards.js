#!/usr/bin/env node
'use strict';
// Break each rule that keeps a system error readable and report which tests
// notice (public/readable-error.js and the surfaces that say it).
//
// Every rule here can be deleted with the product still showing SOMETHING: a
// sentence with the path pasted on is still a sentence, a domain code
// re-worded still reads, a Details control that is never filled is just
// absent. So each is broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-readable-error-guards.js            # report
//   node test/tools/mutate-readable-error-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-pins-guards.js), deliberately a separate copy.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MAPPER = { src: path.join(ROOT, 'public', 'readable-error.js'), suite: 'test/unit/readable-error.test.js' };
const FILES = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'files.js'), suite: 'test/unit/files-handler-edges.test.js' };
const PACKAGES = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/extension-install.test.js' };
const SOURCES = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'sources.js'), suite: 'test/unit/readable-error-surfaces.test.js' };
const RUN_DETAIL = { src: path.join(ROOT, 'public', 'run-detail-model.js'), suite: 'test/unit/run-detail-view.test.js' };
const ROUTINES = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view.test.js' };
const INSTALL_MODEL = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: 'test/unit/extension-install.test.js' };

const MUTATIONS = [
  // ===== THE SENTENCE =====
  // Paste the raw message on and every path the error named is in the
  // sentence, which is the defect the card names.
  [MAPPER, 'the sentence is built from fixed words, never the error\'s message',
    "    return { message: `Rundock couldn't ${action} because ${reason}. ${next}`, detail: detailOf(err, code), code };",
    "    return { message: `Rundock couldn't ${action} because ${reason}. ${next} ${messageOf(err)}`, detail: detailOf(err, code), code };"],
  // Ignore the system call and the card's own example names the install, not
  // the file it could not remove.
  [MAPPER, 'a precise system call names the operation',
    '    const op = syscall && Object.prototype.hasOwnProperty.call(OPERATIONS, syscall) ? OPERATIONS[syscall] : null;',
    '    const op = null;'],
  // Drop the spawn case and a missing program reads as a moved file.
  [MAPPER, 'a program that cannot be started is said as missing',
    "    if (syscall === 'spawn' && code === 'ENOENT') {",
    '    if (false) {'],
  // ===== WHAT COUNTS AS A SYSTEM ERROR =====
  // Take any code and a domain code a client classifies by is re-worded.
  [MAPPER, 'a domain code is not a system code',
    "      if (typeof err.code === 'string' && err.code) return isSystemCode(err.code) ? err.code : null;",
    "      if (typeof err.code === 'string' && err.code) return err.code;"],
  // Accept any capitalised word from a message and ordinary prose is re-worded.
  [MAPPER, 'only a known code is read from a message',
    '    return m && Object.prototype.hasOwnProperty.call(CODES, m[1]) ? m[1] : null;',
    '    return m ? m[1] : null;'],
  // Node's ERR_ codes are programming errors, not the system's.
  [MAPPER, 'Node\'s own ERR_ codes are not system codes',
    "    return (/^E[A-Z][A-Z0-9_]+$/.test(code) && !/^ERR_/.test(code)) || code === 'UNKNOWN';",
    "    return /^E[A-Z][A-Z0-9_]+$/.test(code) || code === 'UNKNOWN';"],
  // ===== DETAILS =====
  // Lose the code from a message that lacked it and Details cannot say which.
  [MAPPER, 'the detail carries the code even when the message does not',
    '    return text.indexOf(code) === -1 ? `${code}: ${text}` : text;',
    '    return text;'],
  // Unescaped, a detail holding markup is markup.
  [MAPPER, 'the Details markup escapes the raw words',
    '<code class="permission-detail">${escapeHtml(detail)}</code></details>`;',
    '<code class="permission-detail">${detail}</code></details>`;'],

  // ===== THE SURFACES =====
  // Throw again and a refused save is logged by the dispatcher and the editor
  // keeps saying Unsaved.
  [FILES, 'a save the system refuses is answered',
    "        // saying it is saving. Said plainly, with the raw words as detail.\n        ws.send(JSON.stringify({ type: 'file_save_failed', path: msg.path, ...readable(e, { action: 'save this file' }) }));",
    '        // saying it is saving. Said plainly, with the raw words as detail.\n        throw e;'],
  [PACKAGES, 'an install error is said through the mapper',
    "    requestId,\n    ...readableFor(operation, error),",
    "    requestId,\n    message: error && error.message ? error.message : String(error),"],
  [SOURCES, 'a source save the system refuses carries its detail',
    "    send(ws, { type: 'source_save_refused', path: notePath, source, reason: r.message, detail: r.detail });",
    "    send(ws, { type: 'source_save_refused', path: notePath, source, reason: r.message });"],
  [RUN_DETAIL, 'a run\'s system error is said in plain words',
    '    return described ? described.message : `The reason it gave: ${reason}`;',
    '    return `The reason it gave: ${reason}`;'],
  [ROUTINES, 'a routine refusal keeps its detail for Details',
    "  pendingProblemDetail = reply && typeof reply.detail === 'string' && reply.detail ? reply.detail : null;",
    '  pendingProblemDetail = null;'],
  [INSTALL_MODEL, 'the install failure card keeps its detail',
    "      return { state: { phase: 'failed', ...carry, message: msg.message || 'The package could not be read.', detail: detailOf(msg) } };",
    "      return { state: { phase: 'failed', ...carry, message: msg.message || 'The package could not be read.' } };"],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: refused as a named row rather than thrown, so the report says
    // which mutation was in flight instead of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
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
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const results = run();
  const failed = report(results, process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(exitCodeFor(failed, results));
  }
}

module.exports = { MUTATIONS, run };
