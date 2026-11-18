#!/usr/bin/env node
'use strict';
// Break each rule that keeps reading CLAUDE_CONFIG_DIR from the login shell
// safe and report which tests notice (electron/shell-config-dir.js).
//
// Every rule here can be deleted with sign-in still working for the person
// whose profile names the default folder: the value is still taken, the check
// still passes on its retry. What goes is what stops a profile, or whoever can
// write to it, getting more than that one value, or running it more often. So
// each is broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-shell-config-dir-guards.js            # report
//   node test/tools/mutate-shell-config-dir-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-readable-error-guards.js), deliberately a separate
// copy, with one addition: a row may break two places at once, given as two
// lists of the same length, for a rule that holds only because two lines
// agree.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const READER = { src: path.join(ROOT, 'electron', 'shell-config-dir.js'), suite: 'test/unit/shell-config-dir.test.js' };

const MUTATIONS = [
  // ===== ONE VALUE CROSSES =====
  // Print the whole environment and take all of it, and a profile's API key,
  // PATH or anything else it sets lands in the app's environment. It takes
  // both lines: the command decides what is printed and the read what is kept.
  [READER, 'only CLAUDE_CONFIG_DIR is printed and taken, never a second key',
    [
      '"+JSON.stringify(process.env.${KEY}??null)+"',
      '    const value = gate(result.value, { home: deps.home(), platform });',
    ],
    [
      '"+JSON.stringify(process.env)+"',
      '    const value = gate(result.value && result.value[KEY], { home: deps.home(), platform }); if (value) Object.assign(env, result.value);',
    ]],
  // Fixed markers can be printed by the profile ahead of the real block, and
  // an earlier read's markers would still be read.
  [READER, 'each read makes its own markers',
    "  const token = crypto.randomBytes(16).toString('hex');",
    "  const token = 'feedfacefeedfacefeedfacefeedface';"],
  // ===== THE GATE =====
  // Without the comparison with <home>/.claude as written, a path through a
  // linked folder or with .. in it is taken: it leads to the default folder
  // at the check and can be repointed after it. The real-path comparison goes
  // with it, since the comparisons before it now drop everything it would,
  // so dropping it alone turns nothing red.
  [READER, 'the value is taken only when it is the default folder as written, not a path that leads there',
    [
      "    if (bare.slice(0, -name.length) !== own.slice(0, -name.length) || fold(bare.slice(-name.length)) !== name) return null;\n",
      "    if (real !== fold(deps.fs.realpathSync(path.join(home, '.claude')))) return null;\n",
    ],
    ['', '']],
  // Read past a value already in the environment and the shell's replaces
  // one the person set for the app themselves.
  [READER, 'a value already in the environment is kept and the shell is not run',
    '    if (env[KEY]) return false;\n',
    ''],
  // ===== IT FAILS SAFE =====
  // Without the cap, a profile that prints without end is held in memory
  // until the time limit, and one that prints a lot and then the block is
  // read.
  [READER, 'output past the size limit stops the read',
    '      if (bytes > OUTPUT_CAP_BYTES) return stop();\n',
    ''],
  // Kill only the shell and what it started in the background keeps running.
  [READER, "a read that runs too long has the shell's whole process group killed",
    "        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }",
    "        try { child.kill('SIGKILL'); } catch { /* already gone */ }"],
  // ===== WHEN IT RUNS =====
  // Without the once-per-launch limit, every failed check, the wizard's
  // polling included, runs the profile again.
  [READER, 'the shell is read at most once per launch',
    '    if (!allowed || used) return answer;',
    '    if (!allowed) return answer;'],
  // Read on a passing check and a person whose sign-in works has their
  // profile run by the app.
  [READER, 'the shell is read only after a check fails',
    '    if (!failed(answer)) {',
    '    if (false) {'],
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
