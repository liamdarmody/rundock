#!/usr/bin/env node
'use strict';
// Take the protocol boundary's guards apart one at a time and report which
// tests notice. The receipt's membership in the one transaction, the
// zero-write rule, the verbatim approval and the dispatch registrations are
// each the kind of guarantee a green suite could quietly stop checking.
//
//   node test/tools/mutate-import-protocol-guards.js            # report
//   node test/tools/mutate-import-protocol-guards.js --markdown # as a table
//
// The harness is the same shape as mutate-import-plan-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a change is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const APPLY = {
  src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'),
  suite: 'test/unit/package-import-protocol.test.js',
};
const HANDLERS = {
  src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'),
  suite: 'test/unit/package-import-protocol.test.js',
};
const INDEX = {
  src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'index.js'),
  suite: 'test/unit/package-import-protocol.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  [APPLY, 'the receipt is a member of the one transaction, not a separate write',
    '    writes.push({\n'
    + '      path: toAbsolute(workspace, receipt),\n'
    + "      content: `${JSON.stringify(buildReceipt(approval, evaluation, appliedAt), null, 2)}\\n`,\n"
    + '    });',
    "    fs.mkdirSync(path.dirname(toAbsolute(workspace, receipt)), { recursive: true });\n"
    + "    fs.writeFileSync(toAbsolute(workspace, receipt), `${JSON.stringify(buildReceipt(approval, evaluation, appliedAt), null, 2)}\\n`);"],
  [APPLY, 'a zero-write apply writes no receipt',
    '  if (options.receipt && evaluation.writes.length > 0) {',
    '  if (options.receipt) {'],
  [HANDLERS, 'the approval is used exactly as submitted, never repaired',
    '    const result = applyImport(workspace, sourcePathOf(msg), msg.approval, { receipt: {} });',
    "    const result = applyImport(workspace, sourcePathOf(msg), { ...msg.approval, schema: 'rundock.package-import-approval/v1' }, { receipt: {} });"],
  [HANDLERS, 'an absent source path refuses instead of defaulting to the working directory',
    "  if (typeof msg.sourcePath !== 'string' || msg.sourcePath.trim() === '') {\n"
    + "    throw new Error('sourcePath is required: the package source directory to read');\n"
    + '  }\n',
    ''],
  [INDEX, 'the plan operation is registered in the dispatch table',
    '    plan_package_import: packages.handlePlanPackageImport,\n',
    ''],
  [INDEX, 'the apply operation is registered in the dispatch table',
    '    apply_package_import: packages.handleApplyPackageImport,\n',
    ''],
];

// Guards deliberately NOT mutated, each with the reason.
const NOT_MUTATED = [
  {
    what: 'the structured-error wrapper in the handlers',
    why: 'every error test asserts the reply type, operation and message directly, so deleting the '
      + 'wrapper turns those tests red by construction; the mutations here are reserved for the '
      + 'guarantees a green suite could plausibly stop checking.',
  },
];

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
  const targets = [APPLY, HANDLERS, INDEX];
  const session = beginMutationRun({ files: targets.map((target) => target.src) });
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
      // A guard that matches more than once is refused rather than taking the
      // first, for the reason set out in the sibling harnesses.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, matches, unparsable: true, red: [] }
        : { label, applied: true, matches, red });
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
  for (const { label, applied, red, ambiguous, matches, unparsable } of results) {
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
      lines.push(markdown ? `| ${label} | ${ambiguous} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | 0 | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | ${matches} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${matches} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  found in ${matches} place\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Places found | Tests red | Which |');
    console.log('|---|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

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

module.exports = { MUTATIONS, NOT_MUTATED, run };
