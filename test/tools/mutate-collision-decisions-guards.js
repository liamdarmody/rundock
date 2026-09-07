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
    "    if (msg.status === 'stale') {\n      return { state: { phase: 'stale', ...carry, token: state.token, installed: state.installed || null } };\n    }",
    ''],
  // A reply is matched to the request that produced it: an evaluate reply
  // still in flight when confirm is pressed must not be read as the apply
  // this phase is actually waiting on, even though both share one envelope.
  // The one correlation rule at the reply entry is what holds this, by
  // operation, token and request id; without it the phase alone decides.
  [MODEL, 'an apply reply is matched to the request that asked for it, not just the phase',
    "    if (!correlated(state, msg)) return { state };\n",
    ''],
  // The same identity check on the other side: a decision made after this
  // projection was asked for supersedes it, and the superseded reply must
  // not overwrite the newer one it lost the race to.
  [MODEL, 'an evaluate reply is matched to the request that asked for it, not just the phase',
    "    if (msg.operation !== 'evaluate' || msg.requestId !== state.evaluateRequestId) return { state };\n",
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
  // The zero-write shortcut governs destination files, never the decision
  // record: an all-skip apply is remembered.
  [APPLY, 'an all-skip apply writes a receipt',
    '  if (options.receipt && (evaluation.writes.length > 0 || evaluation.skipped.length > 0)) {',
    '  if (options.receipt && evaluation.writes.length > 0) {'],
  // The counts are the projection's: a byte-identical collision decided
  // overwrite is unchanged, never an overwrite.
  [MODEL, 'the overwrite count comes from the projection, not from local decisions',
    '      overwrites: p.writes.filter((id) => colliding.has(id)).length,',
    "      overwrites: state.plan.items.filter((i) => i.collision && state.decisions[i.id] === 'overwrite').length,"],
  [MODEL, 'an unchanged row is marked from the projection\'s own membership',
    '        unchanged: !!(state.projection && state.projection.unchanged.indexOf(item.id) !== -1),',
    '        unchanged: false,'],
  // REVIEW_TONES is what renders, not a table the rendering restates.
  [MODEL, 'the rendered tone is read from REVIEW_TONES',
    '        tone: REVIEW_TONES[rowClass],',
    "        tone: rowClass === 'blocked' ? 'attention' : rowClass === 'willAdd' ? 'success' : 'neutral',"],
  // One cause, one vocabulary: the confirm note's clause is reasonWords'.
  [MODEL, 'the confirm note says the blocked cause through reasonWords',
    "          ? `${count(counts.blocked, 'item')} will not be written because ${blockedCauses(state)}.`",
    "          ? `${count(counts.blocked, 'item')} will not be written until the default conflict clears.`"],
  // A click that decided nothing asks nothing: no projection request, no
  // blanked counts.
  [MODEL, 'pressing the selected option changes nothing and sends nothing',
    "    if (state.decisions[id] === decision) return { state };\n",
    ''],
  // The plan reply's guards: a stray refusal for another operation is
  // refused by the correlation rule's operation half, and a result sharing
  // no field with a plan is refused rather than read.
  [MODEL, 'a refusal stamped for another operation is not the plan failing',
    "    if (!waiting || !msg || msg.operation !== waiting.operation) return false;\n",
    "    if (!waiting || !msg) return false;\n"],
  [MODEL, 'only a package_import_plan carrying a plan lands the offer',
    "    if (msg.type !== 'package_import_plan' || !msg.plan) return { state };\n",
    ''],
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
