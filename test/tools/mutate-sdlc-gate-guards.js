#!/usr/bin/env node
'use strict';
// Break each of the gate-hardening guards in turn and report which tests
// notice.
//
// The rules this lane leaves behind are rules about the instruments
// themselves: a documented destructive step must carry its caution, a
// source-walking extraction must be registered with a fail-loud property, an
// unparsable mutation result must refuse rather than crash, and the
// reference scanner must know the acceptance-label shape. Every one of them
// polices an absence, and an absence nobody can break is an absence nobody
// is checking, so each is broken here on purpose and a test must go red.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-sdlc-gate-guards.js            # report
//   node test/tools/mutate-sdlc-gate-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-truth-guards.js and is
// deliberately a separate copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The evidence document whose destructive commands carry cautions, watched by
// the scan that requires the caution beside the command.
const EVIDENCE = { src: path.join(ROOT, 'docs', 'evidence', 'setup-race-flakes-evidence.md'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The mutation envelope, watched for its stated limitation.
const ENVELOPE = { src: path.join(ROOT, 'test', 'tools', 'mutation-run.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The focused suite itself, mutated only in the put-something-back direction:
// its registry is emptied so its own registration check must fire, proving
// the detector finds files and the equality bites rather than agreeing with
// whatever it happens to hold.
const FOCUSED = { src: path.join(ROOT, 'test', 'unit', 'sdlc-gate-hardening.test.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// One harness, reverted to the crash it no longer has, watched by the
// uniformity walk that drives every harness's parser.
const TRUTH_HARNESS = { src: path.join(ROOT, 'test', 'tools', 'mutate-routines-truth-guards.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The reference scanner, watched by the tests that drive its rule table.
const SCANNER = { src: path.join(ROOT, 'scripts', 'check-internal-refs.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };
// The one harness that proved parser and report can drift apart, watched by
// the report-path uniformity tests.
const ROLLBACK_HARNESS = { src: path.join(ROOT, 'test', 'tools', 'mutate-workspace-rollback-guards.js'), suite: 'test/unit/sdlc-gate-hardening.test.js' };

const MUTATIONS = [
  // ===== A DESTRUCTIVE STEP WITHOUT ITS CAUTION =====
  // Delete the first caution sentence and the command it excuses stands
  // alone, which is the exact document shape that cost a reader their
  // working tree.
  [EVIDENCE, 'a documented destructive command keeps its caution beside it',
    ' (A caution before repeating that revert: it\nrestores the committed file by throwing away whatever is in the working copy, so\nif you carry uncommitted work in that file it is erased, not restored. Copy the\nfile aside before making the break, and put the copy back instead.)',
    ''],

  // ===== THE RESIDUE LIMITATION =====
  // Remove the statement and a reader is back to trusting a clean tree.
  [ENVELOPE, 'the envelope states that a clean tree cannot prove work was not erased',
    'the scan cannot tell\n// untouched from erased',
    'the scan reports\n// the tree state'],

  // ===== THE ENUMERATION REGISTRY =====
  // Empty the registry and every detected extraction is unregistered, so the
  // registration check must fire for all of them. A check that stayed green
  // here would be comparing the detector against nothing and agreeing.
  [FOCUSED, 'the registration check reads the registry and the detector finds files',
    'const ENUMERATIONS = [',
    'const ENUMERATIONS = [] || ['],

  // ===== THE UNPARSABLE REFUSAL =====
  // Put the crash back in one harness and the uniformity walk must name it.
  [TRUTH_HARNESS, 'an unparsable suite result refuses instead of crashing',
    '    return { unparsable: true };',
    "    throw new Error('unparsable suite output');"],

  // ===== THE ACCEPTANCE-LABEL RULE =====
  // Remove the rule and a new file can ship the label shape again.
  [SCANNER, 'the scanner knows the acceptance-label shape',
    "    re: /\\bAC-[A-Z]?[0-9]+\\b/,\n    amnesty: AC_LABEL_AMNESTY,",
    "    re: /\\bNEVER-MATCHES-ANYTHING-[0-9]+\\b/,\n    amnesty: AC_LABEL_AMNESTY,"],
  // Remove the amnesty consult and every legacy file fails the gate at once,
  // which is the ratchet collapsing into a flag day nobody scheduled.
  // ===== A REFUSAL MISREPORTED AS A DEFINITE RESULT =====
  // Remove the report branch and a parser refusal falls through to the
  // nothing-turned-red case: a definite verdict about a mutation for which
  // no verdict exists, in the one harness that already drifted this way once.
  [ROLLBACK_HARNESS, 'a parser refusal reaches the report as no verdict, never as nothing-turned-red',
    "    if (unparsable) {\n      failed++;\n      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '\n        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';\n      lines.push(markdown ? `| ${label} | ${matches} | **${why}** | |` : `${label}\\n  ${why.toUpperCase()}`);\n      continue;\n    }\n",
    ''],

  [SCANNER, 'the amnesty is consulted before the rule fires',
    '      if (rule.amnesty && rule.amnesty.has(label)) continue;',
    '      if (rule.amnesty && false) continue;'],
];

const REPORTER = ['--test-reporter', 'spec'];

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
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
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
  const targets = [EVIDENCE, ENVELOPE, FOCUSED, TRUTH_HARNESS, SCANNER, ROLLBACK_HARNESS];
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
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
// mutate-routines-guards.js for the runs that taught this: a full temp root
// surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
