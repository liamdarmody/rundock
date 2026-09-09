#!/usr/bin/env node
'use strict';

/**
 * The cheap half of the gate, run first, reported all at once.
 *
 * WHY THIS EXISTS, measured rather than supposed. One release cost about a
 * dozen gate runs and most of a day. The gate found no product defect in any of
 * them. The three failures it did report were its own bookkeeping: a
 * source-walking test that was not registered, an innerHTML assignment that was
 * not classified, and two counts beside it. Every one of those is decidable in
 * under a second. Every one of them cost a full run, because they live inside
 * the test suite, the suite runs under coverage instrumentation, and the
 * mutation harnesses run after that.
 *
 * TWO PROPERTIES, AND THE SECOND IS THE ONE PEOPLE FORGET.
 *
 * First: these run before anything expensive, so a tree that will fail for a
 * bookkeeping reason never reaches the suite or the harnesses.
 *
 * Second: they all run even when one fails, and every failure is reported
 * together. Stopping at the first would trade one slow discovery for several
 * fast ones, which is the same day back in smaller pieces. On the release this
 * was written for, the three failures arrived one per run, three runs apart.
 *
 * This adds no check and weakens none. Everything here also runs later in the
 * full suite, on the same tree, exactly as before.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

/**
 * Suites that bind a registry, a pinned count, or a document to the code.
 *
 * The rule for belonging here: it fails on a tree with no product defect,
 * because something was added and not written down. That is precisely the class
 * a person can fix in seconds once told, and precisely the class that is most
 * expensive to be told about slowly.
 *
 * A suite that tests BEHAVIOUR does not belong here, however fast it is. This
 * list is not "the quick tests", it is "the bookkeeping", and keeping that
 * distinction is what stops it growing into a second full suite.
 */
const REGISTRY_SUITES = [
  // Every source-walking extraction is registered with a fail-loud property.
  'test/unit/sdlc-gate-hardening.test.js',
  // Every innerHTML assignment is classified, and the totals beside it.
  'test/unit/innerhtml-inventory.test.js',
  // Documents that state the code's own numbers, names and lists.
  'test/unit/doc-claims.test.js',
  'test/unit/design-doc.test.js',
  'test/unit/doc-links.test.js',
  // The client's global namespace and its stylesheet manifest.
  'test/unit/client-namespace.test.js',
  'test/unit/client-styles.test.js',
  // Manifest equality over discovered call sites and doors. Each of these fails
  // when something is ADDED and not written down, which is the membership rule,
  // and each was previously reported only after the suite had run under coverage.
  // Chosen by the rule rather than by which ones happened to bite: the three that
  // cost a release a run each are no more deserving than the ones that have not
  // bitten yet.
  'test/unit/navigation-doors.test.js',
  'test/unit/routine-editor-doors.test.js',
  'test/unit/run-detail-doors.test.js',
  'test/unit/routines-view-doors.test.js',
  'test/unit/scheduler-lifecycle-doors.test.js',
  'test/unit/app-retentions.test.js',
  'test/unit/token-references.test.js',
  // Registry-to-document equality, both directions.
  'test/unit/workspace-boundary.test.js',
  'test/unit/extension-host.test.js',
  'test/unit/packaging.test.js',
  'test/unit/config.test.js',
  'test/unit/map-foothold.test.js',
  // Pinned counts and set-equality bindings the repository's own extraction
  // registry classifies as such. Named here rather than left out because a
  // broken pinned count in any of them is decidable in the same second as the
  // ones above, and waiting for the suite to report it costs the same full run.
  'test/unit/regression.test.js',
  'test/unit/workspace-modes.test.js',
  'test/unit/routines-truth.test.js',
  'test/unit/session-transcript-capture.test.js',
  'test/unit/renderer-registry.test.js',
  'test/unit/scaffold-integrity.test.js',
  'test/unit/style-drift.test.js',
  'test/unit/markdown-render.test.js',
  // Pure, and it decides what the expensive step is allowed to skip.
  'test/unit/mutation-scope.test.js',
];

/**
 * Registry suites deliberately NOT in the cheap phase, each with its reason.
 *
 * THE LIST ABOVE IS CHECKED AGAINST THE REPOSITORY'S OWN INVENTORY, so a suite
 * that inventory classifies as a pinned count or a set-equality binding must be
 * in one list or the other. Being absent from both fails, on the day it is
 * added, which is the same rule this phase exists to enforce on everything else.
 * A phase that decides its own membership by hand is the unregistered-check
 * pathology wearing the uniform of the fix for it.
 */
const NOT_CHEAP = {
  // Add an entry here only with a reason a reader can check.
  //
  // Every one of these is inventoried as carrying a pinned count, and every one
  // of them is primarily a BEHAVIOUR suite that happens to pin something. The
  // membership rule for the cheap phase is narrow on purpose: it fails on a tree
  // with no product defect, because something was added and not written down.
  // A suite that boots a document, writes files, or drives a flow does not meet
  // that rule however fast it happens to be, and admitting them would grow this
  // phase into a second full suite, which is the thing the phase must not become.
  'test/unit/approve-once.test.js': 'behaviour: drives the permission grant flow, not a bookkeeping check',
  'test/unit/permissions.test.js': 'behaviour: grades real command text against the risk rules',
  'test/unit/working-folders-view.test.js': 'behaviour: boots a document and presses controls',
  'test/unit/package-import-apply.test.js': 'behaviour: writes agent files and reads them back',
  'test/unit/profile-boxes.test.js': 'behaviour: boots a document and renders panels',
  'test/unit/routine-schedule-edit.test.js': 'behaviour: edits a routine and asserts what was written',
  'test/unit/routine-timezone.test.js': 'behaviour: resolves schedules against a constructed clock',
  'test/unit/routine-write.test.js': 'behaviour: writes routine files and reads them back',
  'test/unit/routines-end-to-end.test.js': 'behaviour: drives a routine from creation to run',
  'test/unit/routines-view.test.js': 'behaviour: boots a document and presses the routine rows',
  'test/unit/run-detail-model.test.js': 'behaviour: reduces run events into the shape a screen renders',
  'test/unit/team-sidebar.test.js': 'behaviour: boots a document and renders the roster',
  'test/unit/style-resolve-diff.test.js': 'deliberately not wired into the gate at all, so the cheap phase '
    + 'is not where it starts running',
  'test/unit/guide-name.test.js': 'behaviour: resolves the workspace guide by type against real agent files',
  // THE PHASE CANNOT CHECK ITSELF FROM INSIDE ITSELF. This suite reads the
  // inventory to prove the list below is complete; running it inside the very
  // phase it audits would mean a failure there reported by the thing it is
  // auditing. It runs in the suite, where an independent step reports it.
  'test/unit/preflight.test.js': 'audits this phase, so it is reported by the suite rather than by the phase it checks',
  'test/unit/routine-editor-view.test.js': 'behaviour: boots a document and drives the routine editor',
  'test/unit/routines-panel.test.js': 'behaviour: boots a document and renders the routines panel',
  'test/unit/run-detail-view.test.js': 'behaviour: boots a document and renders a run',
  'test/unit/skills-empty.test.js': 'behaviour: boots a document and renders the empty skills state',
};

// Checks that are already their own commands, and already fast.
const CHECKS = [
  { name: 'check:refs', args: ['run', 'check:refs'] },
  { name: 'lint:styles', args: ['run', 'lint:styles'] },
  // A BROKEN TYPE IS A CHEAP FAILURE TOO, and leaving it as a later step meant
  // a tree with a registry problem and a type error reported one on this run
  // and the other on the next: the one-per-run pattern this phase exists to
  // end, reproduced inside the fix for it. It costs a third of a second.
  { name: 'typecheck', args: ['run', 'typecheck'] },
];

function run(label, command, args) {
  const started = Date.now();
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const ms = Date.now() - started;
  const ok = r.status === 0;
  process.stdout.write(`[preflight] ${label}... ${ok ? 'ok' : 'FAILED'} (${(ms / 1000).toFixed(1)}s)\n`);
  return { label, ok, ms, output: `${r.stdout || ''}${r.stderr || ''}` };
}

function main() {
  const results = [];
  for (const c of CHECKS) results.push(run(c.name, 'npm', c.args));
  // One process for all the registry suites: they are small, and the node test
  // runner reports each file's failures without stopping at the first.
  results.push(run('registries', process.execPath, ['--test', '--test-reporter=spec', ...REGISTRY_SUITES]));

  const failed = results.filter(r => !r.ok);
  const total = results.reduce((sum, r) => sum + r.ms, 0);
  if (!failed.length) {
    process.stdout.write(`[preflight] PASS in ${(total / 1000).toFixed(1)}s. `
      + 'The expensive steps are worth starting.\n');
    return 0;
  }

  // NAMED TOGETHER, WITH THEIR OUTPUT. The point of running them all is that a
  // person fixes everything in one pass, so everything has to be on the screen
  // at once rather than one thing per run.
  process.stdout.write(`\n[preflight] ${failed.length} of ${results.length} failed, `
    + `in ${(total / 1000).toFixed(1)}s. All of them, so this is one pass rather than several:\n\n`);
  for (const f of failed) {
    process.stdout.write(`──── ${f.label} ────\n${f.output.trim()}\n\n`);
  }
  process.stdout.write('[preflight] Nothing expensive was started. Fix these and run again.\n');
  return 1;
}

module.exports = { REGISTRY_SUITES, CHECKS, NOT_CHEAP };

if (require.main === module) process.exit(main());
