#!/usr/bin/env node
'use strict';
// Break each rule that keeps the desktop's Claude Code setup check responsive
// and the User PATH as the person stored it, and report which tests notice
// (electron/setup-check.js).
//
// Every rule here can be deleted with the check still reading ready for a
// person whose copy starts at once and is already on PATH. What goes is what
// keeps the window answering while a first start is slow, what keeps a copy
// that was found from reading as not installed, and what keeps the User PATH
// byte for byte. So each is broken on purpose and a test must go red, one row
// each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-setup-check-guards.js            # report
//   node test/tools/mutate-setup-check-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as mutate-shell-config-dir-guards.js, deliberately a separate copy: a row
// may break two places at once, given as two lists of the same length, for a
// rule that holds only because two lines agree.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const CHECK = { src: path.join(ROOT, 'electron', 'setup-check.js'), suite: 'test/unit/setup-check.test.js' };
// The merge and the two PowerShell scripts, tested as values and text.
const PATH_TEXT = { src: path.join(ROOT, 'electron', 'setup-check.js'), suite: 'test/unit/setup-check-path.test.js' };

const MUTATIONS = [
  // ===== NOTHING HOLDS THE WINDOW =====
  // Run the first start synchronously and the main process answers nothing
  // while Windows scans the new program, so the window reads as a crash.
  [CHECK, 'the version run is started asynchronously, never blocking',
    "      const { stdout } = await runChild(plan.program, [...plan.args, '--version'], startEnv(plan), deps.timeouts.version);",
    "      const stdout = childProcess.execFileSync(plan.program, [...plan.args, '--version'], { env: startEnv(plan), timeout: deps.timeouts.version });"],
  // Start a check per request and the screen's polls each start their own
  // children, queued behind the slow one.
  [CHECK, 'a request while a check of its kind runs joins it',
    '      if (running.has(kind)) {',
    '      if (false) {'],
  // ===== FOUND IS NEVER NOT INSTALLED =====
  // A slow first start would send the person back to the install command for
  // a copy that is there.
  [CHECK, 'a version run that times out reads as found but not started',
    "      log('version', startOutcome(err), start);\n      return { status: 'found-not-started' };",
    "      log('version', startOutcome(err), start);\n      return { status: err.code === 'ETIMEDOUT' ? 'not-installed' : 'found-not-started' };"],
  // Write after the version run and a slow first start leaves PATH unwritten,
  // so a new PowerShell window does not recognise claude either.
  [CHECK, 'on Windows the User PATH is written before the version run starts',
    [
      "    if (platform === 'win32') {\n      const start = deps.now();\n      log('path-write', await writeUserPath(path.win32.dirname(bin)), start);\n    }\n",
      "    log('version', 'started', start);\n",
    ],
    [
      '',
      "    log('version', 'started', start);\n    if (platform === 'win32') log('path-write', await writeUserPath(path.win32.dirname(bin)), deps.now());\n",
    ]],
  // ===== THE USER PATH AS STORED =====
  // Lose the last entry and whatever another program put there stops working.
  [PATH_TEXT, 'the merge keeps every entry, the last included',
    "  const separator = text.endsWith(';') ? '' : ';';\n  return text + separator + folder;",
    "  return text.split(';').slice(0, -1).concat(folder).join(';');"],
  // Expand what it keeps and every %USERPROFILE% entry becomes a fixed path.
  [PATH_TEXT, 'the merge keeps a %NAME% entry unexpanded',
    '  return text + separator + folder;',
    '  return expandNames(text, env) + separator + folder;'],
  // Put the folder in the script and a folder name becomes PowerShell code.
  [CHECK, 'the folder reaches PowerShell as data, never in the script',
    '      const { stdout } = await powershell(WRITE_SCRIPT, {',
    `      const { stdout } = await powershell(WRITE_SCRIPT.split('[string]$env:SETUP_CHECK_PATH_NEW').join("'" + next + "'"), {`],
  // Write REG_SZ and Windows stops expanding the %NAME% entries kept.
  [CHECK, 'the write keeps the kind it read, and creates REG_EXPAND_SZ',
    "        SETUP_CHECK_PATH_WRITE_KIND: kind === 'String' ? 'String' : 'ExpandString',",
    "        SETUP_CHECK_PATH_WRITE_KIND: 'String',"],
  // Without the broadcast a PowerShell window opened from the Start menu
  // keeps the PATH it had.
  [PATH_TEXT, 'a write tells every window the environment changed',
    `  "[void][SetupCheck.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$r)",\n`,
    ''],
  // Without the second read, a change made since the first is overwritten.
  [PATH_TEXT, 'the write writes nothing when the value has changed since it was read',
    `  "if ($kind -cne [string]$env:SETUP_CHECK_PATH_KIND -or $v -cne [string]$env:SETUP_CHECK_PATH_OLD) { [Console]::Out.Write('stale'); exit 0 }",\n`,
    ''],
  // ===== THE ANSWER AND THE LOG =====
  // A sign-in check stopped at its timeout must say so, as it always has.
  [CHECK, 'a sign-in check that times out gives the reason timeout',
    '        signInReason.failed(err);',
    "        signInReason.failed(err.code === 'ETIMEDOUT' ? {} : err);"],
  // A path in the log names the person's account folder.
  [CHECK, 'no path reaches the setup log',
    "      log('lookup', bin ? 'found' : 'none', start);",
    "      log('lookup', bin || 'none', start);"],
  // ===== SIGN IN HAS THE LAST CHECK THAT ENDED =====
  // Clear the copy as a check starts and Sign in during a Check again is not
  // found, for a copy the last check started.
  [CHECK, 'the copy found is kept until the next check ends',
    '    const bin = await lookup();\n',
    '    found = { bin: null, version: null };\n    const bin = await lookup();\n'],
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
