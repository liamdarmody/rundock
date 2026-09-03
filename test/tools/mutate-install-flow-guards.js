#!/usr/bin/env node
'use strict';
// Take the install flow model's guards apart one at a time and report which
// tests notice. Nothing-silent and collisions-fail-closed are promises about
// what is NOT sent, which is exactly the kind of promise a green suite can
// quietly stop checking.
//
//   node test/tools/mutate-install-flow-guards.js            # report
//   node test/tools/mutate-install-flow-guards.js --markdown # as a table
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

const MODEL = {
  src: path.join(ROOT, 'public', 'packages-install-model.js'),
  suite: 'test/unit/packages-install-model.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // THE FAIL-CLOSED GUARD IS GONE BECAUSE ITS RULE IS. A colliding plan now
  // enters the review surface with every collision decided skip, and that
  // rule has its own guards in mutate-collision-decisions-guards.js (the
  // skip default, the decided approval on the wire, and the rest). A guard
  // kept here would pin the overturned shape and report its own target as
  // unmutated forever.
  [MODEL, 'a fresh collision is decided skip, never anything writable',
    "    for (const item of items) decisions[item.id] = item.collision ? 'skip' : 'add';\n",
    "    for (const item of items) decisions[item.id] = item.collision ? 'overwrite' : 'add';\n"],
  [MODEL, 'cancel sends nothing at all',
    '  function cancel() {\n    return { state: initial() };\n  }',
    "  function cancel() {\n    return { state: initial(), send: { type: 'apply_package_import' } };\n  }"],
  [MODEL, 'the approval comes through the shared decide module, not a local copy',
    "      send: { type: 'apply_package_import', sourcePath: state.sourcePath, approval: sharedDecide()(state.plan, decisionsFor(state)) },",
    "      send: { type: 'apply_package_import', sourcePath: state.sourcePath, approval: { schema: state.plan.schema, source: state.plan.source, manifest: state.plan.manifest, items: state.plan.items.map((item) => ({ ...item, decision: decisionsFor(state)[item.id] })) } },"],
  [MODEL, 'the nothing-usable state is classified by its code, never by prose',
    "      if (msg.code === 'empty-package') {",
    '      if (false) {'],
  [MODEL, 'blocked items are rendered, not dropped',
    '      blockedLines: state.blocked.map((b) => `${b.slug}: not added, because ${b.reason}`),',
    '      blockedLines: [],'],
];

// Guards deliberately NOT mutated, each with the reason.
const NOT_MUTATED = [
  {
    what: 'the view rendering in views/settings.js',
    why: 'the browser spec pins the rendered states against the real server, and mutating a file '
      + 'the slow e2e suite watches would make this harness minutes-long for guards the model '
      + 'already proves; the model is where every decision this flow makes lives.',
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
  const targets = [MODEL];
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
