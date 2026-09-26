'use strict';
// Every Rundock UI guard in the code has a mutation row, and the rows that
// stand for real-engine claims run a real engine.
//
// The harness (test/tools/mutate-rundock-ui-guards.js) breaks each guard and
// fails if no named test goes red, and the gate runs it. What this file
// checks is the coverage the harness cannot see about itself: that every
// criterion has a row, that every criterion proved in Chromium has a row that
// runs a named Chromium test, that every row says which criterion it guards
// and names a test that exists, and that the harness is wired into the chain
// the gate runs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const HARNESS = 'test/tools/mutate-rundock-ui-guards.js';
const { MUTATIONS, CRITERIA, CRITERION_NAMES, TABLE_CRITERION_NAMES } = require(path.join(ROOT, HARNESS));

// THE FROZEN CRITERIA, by area (core, surface, evidence). The criteria are
// held here by name and checked against each other: together they must be
// the full list, each in exactly one area. Every criterion that is a guard in
// the code requires a mutation row; the three that are not say why.
const AREAS = {
  core: ['source-scan-forbidden', 'roving-tab-stop', 'arrow-keys-and-radios', 'mode-toggle-tablist', 'menu-focus-and-close', 'board-keyboard-move', 'control-geometry', 'reduced-motion', 'destructive-outline', 'stylesheet-literals-allowlisted', 'version-agreement', 'version-rule', 'starter-extension'],
  surface: ['factory-set-frozen', 'status-and-alert-copy', 'control-semantics', 'chip-line-height', 'icon-button-naming', 'light-theme-contrast', 'fill-color-roles', 'dark-exception-pinned', 'one-source-copies', 'edge-to-edge-opt-out', 'ui-docs', 'gallery-frame-policy'],
  evidence: ['view-built-on-library', 'library-no-way-out', 'library-before-entry', 'every-frame-gets-library', 'failed-install-stops-frame', 'pane-full-bleed', 'frame-paints-pane-color', 'view-note-padding', 'embedded-view-surface', 'mutation-coverage'],
};
const NO_ROW = {
  'ui-docs': 'documentation, judged by reading it against the code; its links and claims are held by the doc-links and doc-claims suites',
  'starter-extension': 'the starter extension is a separate repository and is not part of this diff',
  'mutation-coverage': 'this coverage check itself, with the harness run recorded in docs/evidence/rundock-ui-mutation-run.md',
};
const ALL = CRITERION_NAMES;
const REQUIRES_ROW = ALL.filter((n) => !(n in NO_ROW));

// The criteria whose evidence the frozen criteria name as a real engine
// (Chromium, and Electron where the confinement run covers it).
const REAL_ENGINE = ['view-built-on-library', 'library-no-way-out', 'library-before-entry', 'every-frame-gets-library', 'failed-install-stops-frame', 'roving-tab-stop', 'arrow-keys-and-radios', 'menu-focus-and-close', 'board-keyboard-move', 'control-semantics', 'control-geometry', 'chip-line-height',
  'pane-full-bleed', 'frame-paints-pane-color', 'view-note-padding', 'edge-to-edge-opt-out', 'embedded-view-surface'];

test('the harness has rows, and every row says which criterion it guards', () => {
  assert.ok(MUTATIONS.length >= 100, `only ${MUTATIONS.length} rows read; the harness has shrunk or the read went blind`);
  const labels = MUTATIONS.map((r) => r[1]);
  assert.strictEqual(new Set(labels).size, labels.length, 'two rows share a label, so a report could not tell them apart');
  const untagged = labels.filter((l) => !CRITERIA[l] || CRITERIA[l].length === 0);
  assert.deepStrictEqual(untagged, [], 'a row names no criterion');
  const stale = Object.keys(CRITERIA).filter((l) => !labels.includes(l));
  assert.deepStrictEqual(stale, [], 'the criteria map lists a row that no longer exists');
});

test('the three areas hold every criterion between them, each in exactly one', () => {
  assert.strictEqual(new Set(ALL).size, 35, 'the criteria list has lost or doubled a name');
  const held = Object.values(AREAS).flat();
  assert.strictEqual(new Set(held).size, held.length, 'a criterion is in two areas');
  assert.deepStrictEqual([...held].sort(), [...ALL].sort(), 'the areas do not cover the criteria exactly');
  for (const n of Object.keys(NO_ROW)) assert.ok(ALL.includes(n), `${n} is excused but is not a criterion`);
});

for (const [area, criteria] of Object.entries(AREAS)) {
  test(`every criterion in ${area} that is a guard in the code has a mutation row`, () => {
    const covered = new Set(Object.values(CRITERIA).flat());
    const missing = criteria.filter((n) => REQUIRES_ROW.includes(n) && !covered.has(n));
    assert.deepStrictEqual(missing, [], `these ${area} criteria have no guard a mutation breaks`);
  });
}

test('the gallery page\'s frame policy has its row, mapped to its criterion', () => {
  const row = MUTATIONS.find((r) => r[1] === 'the gallery page carries the frame policy');
  assert.ok(row, 'the row that strips the gallery page\'s frame policy is gone');
  assert.ok(CRITERIA[row[1]].includes('gallery-frame-policy'), 'the gallery policy row no longer maps to its criterion');
  assert.strictEqual(row[0].suite, 'test/unit/http-router-lib.test.js', 'the row runs the route test that serves the gallery');
});

test('every criterion proved in a real engine has a row that runs a named real-engine test', () => {
  const realRows = MUTATIONS.filter((r) => /\.spec\.js#/.test(r[0].suite));
  const covered = new Set(realRows.flatMap((r) => CRITERIA[r[1]]));
  const missing = REAL_ENGINE.filter((n) => !covered.has(n));
  assert.deepStrictEqual(missing, [], 'these real-engine criteria are mutation-proved only by a unit model');
});

test('every row names a suite that exists, and a real-engine row names a test that exists in it', () => {
  for (const [target, label] of MUTATIONS) {
    const [file, title] = target.suite.split('#');
    const full = path.join(ROOT, file);
    assert.ok(fs.existsSync(full), `${label}: its suite ${file} does not exist`);
    assert.ok(fs.existsSync(target.src), `${label}: the file it breaks does not exist`);
    if (title) {
      assert.ok(fs.readFileSync(full, 'utf8').includes(title), `${label}: no test in ${file} matches "${title}"`);
    }
  }
});

test('the harness is wired into the chain the gate runs, and the gate\'s selector sees it', () => {
  const chain = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['mutate:guards:all'];
  assert.ok(chain.includes(`node ${HARNESS}`), 'mutate:guards:all does not run the Rundock UI harness');
  const { harnessFiles } = require(path.join(ROOT, 'scripts', 'mutation-scope.js'));
  assert.ok(harnessFiles(path.join(ROOT, 'test', 'tools')).includes(path.basename(HARNESS)), 'the gate\'s harness selector does not discover it');
});

// The editable table's frozen criteria: fixed widths and editable cells, the
// invariants carried over from the library's earlier work, and the measured,
// resizable column scope approved before freezing. Every one that is a guard
// in this repository has a row mapped to its own name, never folded into
// another's, and every one whose evidence is a real engine has a row that runs
// a named Chromium test. The ones that are not guards here say why.
const TABLE_ALL = TABLE_CRITERION_NAMES;
const TABLE_NO_ROW = {
  'table-evidence': 'this evidence itself: the gallery, the docs, and this coverage check over the harness',
  'table-consumer-adoption': 'a consuming extension\'s own repository, judged on its own diff',
  'table-markup-unchanged': 'an invariant held by the pinned-markup unit test, which fails on any change to the 1.0 markup',
  'table-source-scan': 'the source scan, whose rows are mapped to source-scan-forbidden',
  'table-version': 'the version, whose rows are mapped to version-agreement',
  'table-contrast-and-parity': 'the contrast and parity pins, held by their own suites',
};
const TABLE_REQUIRES_ROW = TABLE_ALL.filter((n) => !(n in TABLE_NO_ROW));
const TABLE_REAL_ENGINE = ['table-widths-and-cell-styling', 'table-edit-keyboard', 'table-cell-naming-and-tab-order', 'table-measured-widths', 'table-spare-room-sharing', 'table-grow-column', 'table-widths-locked-while-editing', 'table-resize-handle', 'table-resize-interaction', 'table-explicit-widths-and-scroll', 'table-resize-reporting', 'card-header-actions', 'table-refusal-line'];

test('the editable-table criteria are 24 distinct names, apart from the library\'s', () => {
  assert.strictEqual(new Set(TABLE_ALL).size, 24, 'the editable-table list has lost or doubled a name');
  assert.deepStrictEqual(TABLE_ALL.filter((n) => ALL.includes(n)), [], 'an editable-table name collides with a library criterion');
  for (const n of Object.keys(TABLE_NO_ROW)) assert.ok(TABLE_ALL.includes(n), `${n} is excused but is not a criterion`);
  for (const n of TABLE_REAL_ENGINE) assert.ok(TABLE_ALL.includes(n), `${n} is claimed real-engine but is not a criterion`);
});

test('every frozen editable-table criterion that is a guard here has a row mapped to its own name', () => {
  const covered = new Set(Object.values(CRITERIA).flat());
  const missing = TABLE_REQUIRES_ROW.filter((n) => !covered.has(n));
  assert.deepStrictEqual(missing, [], 'these editable-table criteria have no guard a mutation breaks');
  const unknown = [...covered].filter((n) => !ALL.includes(n) && !TABLE_ALL.includes(n));
  assert.deepStrictEqual(unknown, [], 'a row names a criterion that is not frozen');
});

test('every editable-table criterion proved in a real engine has a row that runs a named Chromium test', () => {
  const real = new Set(MUTATIONS.filter((r) => /\.spec\.js#/.test(r[0].suite)).flatMap((r) => CRITERIA[r[1]]));
  assert.deepStrictEqual(TABLE_REAL_ENGINE.filter((n) => !real.has(n)), [], 'proved only by a unit model');
});
