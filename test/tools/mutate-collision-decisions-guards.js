#!/usr/bin/env node
'use strict';
// Break each of the collision decision surface's guards in turn and report
// which tests notice. The rules this lane leaves behind are all promises
// about what a person is protected from: nothing silently overwritten, the
// only alarm on the one state that deserves it, no overwrite offered as a
// way out of a block, an apply that is all-or-nothing, and a receipt that
// remembers what was decided. Every one can be deleted with the surface
// still rendering SOMETHING, which is why each is broken on purpose here.
//
//   node test/tools/mutate-collision-decisions-guards.js            # report
//   node test/tools/mutate-collision-decisions-guards.js --markdown # table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and is deliberately a separate
// copy rather than a shared module, for the reason stated there: pulling
// them together means editing an instrument already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = {
  src: path.join(ROOT, 'public', 'packages-install-model.js'),
  suite: 'test/unit/collision-decisions.test.js',
};
const APPLY = {
  src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'),
  suite: 'test/unit/collision-decisions.test.js',
};
// The same file watched by the suite that PRESSES the recovery rule: the
// apply suite plants a genuinely half-committed journal and proves recovery
// runs before the snapshot. This lane's own suite exercises the seam through
// a mid-apply failure, which the primitive rolls back in-process, so only
// the planted-journal test can notice recovery going missing.
const APPLY_RECOVERY = {
  src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'),
  suite: 'test/unit/package-import-apply.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // Nothing is silently overwritten: the review opens with every collision
  // decided skip, and overwrite always requires a deliberate switch.
  [MODEL, 'a fresh collision opens decided skip',
    "    for (const item of items) decisions[item.id] = item.collision ? 'skip' : 'add';\n",
    "    for (const item of items) decisions[item.id] = item.collision ? 'overwrite' : 'add';\n"],
  // The evaluator's result shape and this surface's rendering map are one
  // list: drop a bucket's home and the walk must fail naming it.
  [MODEL, 'every evaluator bucket has a home on this surface',
    "    blocked: 'the blocked treatment on the rows the projection names',\n",
    ''],
  // The review-void state is the only danger on a surface that executes
  // nothing.
  [MODEL, 'only the voided review carries the danger tone',
    "    stale: 'danger',",
    "    stale: 'attention',"],
  // A wire reason reaches the person as plain words, never as the literal.
  [MODEL, 'the blocked reason is said in plain words',
    "    if (reason === 'default-conflict') return 'this would give your team a second default agent';\n",
    ''],
  // Never overwrite as the way out: the blocked row's one action is skip.
  [MODEL, 'the blocked row\'s one action is skipping',
    "          : { label: 'Skip this item', decision: 'skip' },",
    "          : { label: 'Overwrite anyway', decision: 'overwrite' },"],
  // A stale projection voids the whole review rather than quietly carrying
  // decisions whose basis has moved.
  [MODEL, 'a stale projection voids the review',
    "    if (msg.status === 'stale') {\n      return { state: { phase: 'stale', sourcePath: state.sourcePath } };\n    }",
    ''],
  // The apply transaction recovers any interrupted predecessor before it
  // looks, so a half-committed workspace can never be read as current truth.
  [APPLY_RECOVERY, 'an interrupted transaction is recovered before anything is read',
    '  recoverPendingWrites(workspace);\n',
    ''],
  // The receipt remembers what was decided, beside each item it governed.
  [APPLY, 'receipt entries carry the decision that governed them',
    '  const entry = (outcome) => (o) => ({ id: o.id, kind: o.kind, destination: o.destination, decision: decisions.get(o.id), outcome });',
    '  const entry = (outcome) => (o) => ({ id: o.id, kind: o.kind, destination: o.destination, outcome });'],
];

// Guards deliberately NOT mutated, each with the reason.
const NOT_MUTATED = [
  {
    what: 'the review card rendering in views/settings.js',
    why: 'the browser spec pins the rendered review against the real server in both themes; the model '
      + 'owns every decision and every word, and the harness watches the model.',
  },
  {
    what: 'the decided approval travelling through the shared decide module',
    why: 'pinned by mutate-install-flow-guards.js, whose suite tags the shared module singleton; a '
      + 'second row here would mutate the same line for the same proof.',
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
  const targets = [MODEL, APPLY, APPLY_RECOVERY];
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
      // A guard that matches more than once is refused rather than taking
      // the first, for the reason set out in the sibling harnesses.
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
      lines.push(markdown ? `| ${label} | ${matches} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
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
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
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
