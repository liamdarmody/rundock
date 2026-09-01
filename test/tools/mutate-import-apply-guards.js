#!/usr/bin/env node
'use strict';
// Take the import apply adapter's guards apart one at a time and report which
// tests notice. The adapter's whole job is refusing to write what it cannot
// verify and executing exactly what the evaluator allowed, and every one of
// those refusals could be deleted with the happy path still green unless a
// test is proven to notice.
//
//   node test/tools/mutate-import-apply-guards.js            # report
//   node test/tools/mutate-import-apply-guards.js --markdown # as a table
//
// The harness is the same shape as mutate-atomic-write-guards.js and is
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

const ADAPTER = {
  src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'),
  suite: 'test/unit/package-import-apply.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  [ADAPTER, 'an interrupted prior transaction is recovered before anything else',
    '  recoverPendingWrites(workspace);\n',
    ''],
  [ADAPTER, 'only a ready evaluation reaches the filesystem',
    "  if (evaluation.status !== 'ready') return { ...evaluation, written: [] };",
    "  if (evaluation.status === 'ready') return { ...evaluation, written: [] };"],
  [ADAPTER, 'bytes that do not hash to the approved digest are never written',
    '    if (digestFile(transformed) !== write.approvedDigest) {\n'
    + '      throw new Error(`bytes for ${write.id} do not match the approved digest; refusing to write`);\n'
    + '    }\n',
    ''],
  [ADAPTER, 'the provenance transformation is actually applied to written agents',
    "    const transformed = Buffer.from(withProvenance(bytes.toString('utf8'), sourceId), 'utf8');",
    '    const transformed = bytes;'],
  [ADAPTER, 'a directory digest covers where each file lives, not only its bytes',
    '      hash.update(`${relative}\\0`);\n',
    ''],
];

// Guards deliberately NOT mutated, each with the reason.
const NOT_MUTATED = [
  {
    what: 'the source-digest verification in materialise',
    why: 'the digest it checks was already matched against the same file by the snapshot moments '
      + 'earlier in the same call, so no fixture can make it fire without a race seam the module '
      + 'deliberately does not expose. It is defence in depth for the window between snapshot and '
      + 'read-back; a mutation nothing can honestly discharge is noise. Left as a named gap.',
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
    throw new Error(
      'the suite failed but its output carries no "failing tests:" summary, so no '
      + 'test names could be read. The spec reporter\'s format is what this parses; '
      + 'if it changed, fix this parser rather than trusting the empty result.');
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [ADAPTER];
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
      results.push({ label, applied: true, matches, red: redTests(target.suite) });
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
  for (const { label, applied, red, ambiguous, matches } of results) {
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
