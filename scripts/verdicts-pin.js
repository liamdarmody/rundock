#!/usr/bin/env node
'use strict';
// The verdicts an adopted harness reports, pinned to what it reported before the
// baseline check existed.
//
// WHY THIS IS NOT A UNIT TEST. A mutation harness rewrites source files on disk
// and puts them back. Run inside `npm test`, it corrupts whatever sibling suite
// happens to be reading those files at the time, which is why the harnesses are
// deliberately not part of the ordinary suite. An earlier version of this check
// lived in test/unit and did exactly that: it turned the very suite the
// install-flow harness mutates red, mid-run.
//
// WHY IT EXISTS AT ALL. Adding a baseline pass in front of every harness is a
// change to shared machinery, and the claim that it leaves the verdicts alone is
// worth more than an assurance. The generic mechanism is covered by
// test/unit/mutation-baseline.test.js against a throwaway harness. This covers
// the other half: that a REAL harness still concludes exactly what it concluded
// before. A regression in ordering, timing or environment around the new check
// would leave the generic tests green while quietly changing what is reported.
//
// A row moving here is either a deliberate behaviour change, in which case this
// list is updated in the same commit, or this machinery breaking a promise.
//
//   node scripts/verdicts-pin.js

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');

const PINNED = {
  tool: 'test/tools/mutate-install-flow-guards.js',
  rows: [
    ['a colliding plan can never produce an apply message', '1', '1'],
    ['cancel sends nothing at all', '1', '1'],
    ['the approval comes through the shared decide module, not a local copy', '1', '1'],
    ['every item is decided add before the shared decide runs', '1', '1'],
    ['the nothing-usable state is classified by its code, never by prose', '1', '1'],
    ['blocked items are rendered, not dropped', '1', '1'],
  ],
};

function main() {
  // SCRUBBED. A nested `node --test` inherits NODE_TEST_CONTEXT from whatever
  // spawned it and misreports its own results, so a harness invoked from inside
  // a runner draws the wrong conclusions. Same reason preflight scrubs it.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;

  const r = spawnSync(process.execPath, [path.join(ROOT, PINNED.tool), '--markdown'],
    { cwd: ROOT, encoding: 'utf8', env });
  if (r.status !== 0) {
    console.error(`verdicts-pin: ${PINNED.tool} did not complete, so its verdicts could not be read.\n`
      + `${(r.stderr || '').trim().slice(0, 800)}`);
    process.exit(1);
  }

  const rows = r.stdout.split('\n')
    .filter((l) => l.startsWith('| ') && !l.startsWith('| Guard broken') && !l.startsWith('|---'))
    .map((l) => l.split('|').slice(1, 4).map((c) => c.trim()));

  const actual = JSON.stringify(rows, null, 1);
  const expected = JSON.stringify(PINNED.rows, null, 1);
  if (actual !== expected) {
    console.error(`verdicts-pin: ${PINNED.tool} no longer reports what it reported before the\n`
      + 'baseline check was added. Either a guard genuinely changed, in which case update the\n'
      + 'pinned list in this file in the same commit, or the machinery around it altered a\n'
      + 'verdict without anyone deciding to.\n\n'
      + `expected:\n${expected}\n\nactual:\n${actual}`);
    process.exit(1);
  }
  console.log(`verdicts-pin: ${rows.length} verdicts unchanged in ${PINNED.tool}`);
}

main();
