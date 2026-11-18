#!/usr/bin/env node
'use strict';
// Break each rule that keeps the reason for a failed sign-in check safe to
// show and report which tests notice (electron/sign-in-reason.js and the
// wizard's sign-in step, electron/wizard.html).
//
// Every rule here can be deleted with the wizard still showing a line that
// reads well for an ordinary failure. What goes is what stops output Rundock
// did not write from reaching the window as markup, carrying a credential, or
// arriving with characters that hide or reorder what it says. So each is
// broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-sign-in-reason-guards.js            # report
//   node test/tools/mutate-sign-in-reason-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-shell-config-dir-guards.js), deliberately a separate
// copy.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The cleaner, read by its own suite and, for the credentials, by the suite
// that reads the wizard's answer from the main process's handler.
const CLEANER = { src: path.join(ROOT, 'electron', 'sign-in-reason.js'), suite: 'test/unit/sign-in-reason.test.js' };
const ANSWER = { src: path.join(ROOT, 'electron', 'sign-in-reason.js'), suite: 'test/integration/sign-in-reason-check.test.js' };
const WIZARD = { src: path.join(ROOT, 'electron', 'wizard.html'), suite: 'test/unit/wizard-sign-in-reason.test.js' };

const MUTATIONS = [
  // ===== TEXT, NEVER MARKUP =====
  // Set as markup and the line can add elements, and run what they carry.
  [WIZARD, 'the line is set as text, never markup',
    '      el.textContent = text;',
    '      el.innerHTML = text;'],
  // ===== NO CREDENTIAL CROSSES =====
  // Without the replacement, a key or token Claude Code printed reaches the
  // window as written.
  [ANSWER, 'anything shaped like a credential is replaced before the line leaves',
    '  return cut(redact(text));',
    '  return cut(text);'],
  // Cut first and a token across the cap is left as a piece too short to
  // look like one.
  [ANSWER, 'credentials are replaced before the line is cut',
    '  return cut(redact(text));',
    '  return redact(cut(text));'],
  // ===== ONE CLEAN LINE =====
  [CLEANER, 'the line is capped',
    '  return chars.length > MAX_CHARS ?',
    '  return false ?'],
  [CLEANER, 'control characters are removed',
    "    .replace(CONTROL, '')\n",
    ''],
  [CLEANER, 'direction controls are removed',
    "    .replace(BIDI, '')\n",
    ''],
  // ===== THE HINT =====
  // Shown for every line, it tells a person whose check failed for a usage
  // limit or a network error to change their sign-in setup.
  [WIZARD, 'the hint follows only a sign-in line, and only on macOS',
    "      if (reason.signIn === true && window.electronAPI.platform === 'darwin') {",
    '      if (true) {'],
  // ===== IT FAILS SAFE =====
  // When cleaning throws, the answer is the fixed line, never the output.
  [CLEANER, 'a cleaner that throws passes no output through',
    "  } catch {\n    return { kind: 'no-reason' };\n  }",
    "  } catch {\n    return { kind: 'said', text: String(err.stderr), signIn: false };\n  }"],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

async function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = await runSuite('node', ['--test', ...REPORTER, suite], { cwd: ROOT });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
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

async function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      // A row of two places is applied only when each text is found exactly
      // once, so neither half can break the wrong line or nothing at all.
      const guards = [].concat(guard);
      const withouts = [].concat(without);
      const counts = guards.map((text) => original.split(text).length - 1);
      if (counts.some((n) => n === 0) || guards.length !== withouts.length) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      const matches = Math.max(...counts);
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, guards.reduce((src, text, i) => src.replace(text, withouts[i]), original));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] }
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
  for (const { label, applied, red, ambiguous, unparsable, didNotFinish } of results) {
    if (didNotFinish) {
      failed++;
      const why = didNotFinishWhy(didNotFinish);
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
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
  run().then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run };
