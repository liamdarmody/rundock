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
];

// Checks that are already their own commands, and already fast.
const CHECKS = [
  { name: 'check:refs', args: ['run', 'check:refs'] },
  { name: 'lint:styles', args: ['run', 'lint:styles'] },
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

module.exports = { REGISTRY_SUITES, CHECKS };

if (require.main === module) process.exit(main());
