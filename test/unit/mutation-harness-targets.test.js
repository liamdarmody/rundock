'use strict';
// A mutation harness loads the source of every target its rows name before it
// breaks anything. When that list was kept by hand beside the rows, rows were
// added naming targets it did not load: the harness crashed at the first of
// them, and none of those rows had ever been run. The list is now derived from
// the rows, and a row naming anything that is not a loaded target is refused
// before a file is touched.
//
// Loading the boundary harness is safe: it runs only under `require.main`.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const harness = require('../tools/mutate-workspace-boundary-guards.js');
const ROOT = path.join(__dirname, '..', '..');

test('every row of the boundary harness names a loaded target with a source that exists', () => {
  const targets = harness.targetsFor(harness.MUTATIONS);
  assert.ok(targets.length > 0);
  for (const [target, label] of harness.MUTATIONS) {
    assert.ok(targets.includes(target), `${label}: its target is loaded`);
  }
});

test('a row whose target was never defined is refused, not skipped', () => {
  const real = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/boundary.test.js' };
  assert.throws(() => harness.targetsFor([[undefined, 'a row added before its target', 'x', 'y']]), /names no target/);
  assert.throws(() => harness.targetsFor([[{ src: real.src }, 'a target with no suite', 'x', 'y']]), /names no target/);
  assert.throws(() => harness.targetsFor([[{ src: path.join(ROOT, 'no-such-file.js'), suite: real.suite }, 'a moved source', 'x', 'y']]), /does not exist/);
  assert.deepStrictEqual(harness.targetsFor([[real, 'a', 'x', 'y'], [real, 'b', 'x', 'y']]), [real], 'each target once');
});

// ---------------------------------------------------------------------------
// Every harness: rows as the one source of truth, and safe to load.
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');
const {
  targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
} = require('../tools/mutation-run.js');

const TOOLS = path.join(ROOT, 'test', 'tools');
const HARNESS_FILES = fs.readdirSync(TOOLS).filter((n) => /^mutate-.*-guards\.js$/.test(n)).sort();

test('every harness runs only under require.main and exports the rows it runs', () => {
  // The scope reads rows by requiring each harness. A harness that ran on
  // require would start rewriting source inside a tool that only asked what
  // it touches, so the guard is checked on every harness, not assumed.
  assert.ok(HARNESS_FILES.length >= 14, `only ${HARNESS_FILES.length} harnesses found`);
  for (const name of HARNESS_FILES) {
    const src = fs.readFileSync(path.join(TOOLS, name), 'utf8');
    assert.match(src, /if \(require\.main === module\) \{/, `${name} runs when loaded`);
    assert.match(src, /module\.exports = \{[^}]*\bMUTATIONS\b/, `${name} does not export its rows`);
  }
});

test('requiring every harness executes nothing: no run record, no tracked file changed', () => {
  // Driven in a child process, so a harness that did run on require cannot
  // take this suite down with it, and what it left behind is observable.
  const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' });
  const before = status();
  const markers = path.join(ROOT, '.mutation-runs');
  const markersBefore = fs.existsSync(markers) ? fs.readdirSync(markers).sort() : [];
  const script = `
    const path = require('node:path');
    const { targetsFromRows } = require(${JSON.stringify(path.join(TOOLS, 'mutation-run.js'))});
    let rows = 0;
    for (const name of ${JSON.stringify(HARNESS_FILES)}) {
      const mod = require(path.join(${JSON.stringify(TOOLS)}, name));
      targetsFromRows(mod.MUTATIONS, { fallback: mod.TARGET });
      rows += mod.MUTATIONS.length;
    }
    process.stdout.write(String(rows));
  `;
  const run = spawnSync(process.execPath, ['-e', script], { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(run.status, 0, `loading the harnesses failed:\n${run.stderr}`);
  assert.ok(Number(run.stdout) > 500, `sanity: the rows were read (${run.stdout})`);
  const markersAfter = fs.existsSync(markers) ? fs.readdirSync(markers).sort() : [];
  assert.deepStrictEqual(markersAfter, markersBefore, 'a harness started a mutation run when it was only loaded');
  assert.strictEqual(status(), before, 'a harness changed the working tree when it was only loaded');
});

describe('targetsFromRows: what a run arms over comes from its rows', () => {
  const real = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/boundary.test.js' };

  test('each target once, identity kept, and a fallback for rows with no target', () => {
    assert.deepStrictEqual(targetsFromRows([[real, 'a', 'x', 'y'], [real, 'b', 'x', 'y']]), [real]);
    assert.deepStrictEqual(targetsFromRows([['a', 'x', 'y']], { fallback: real }), [real]);
  });

  test('a missing source, a missing suite, or no target at all throws, naming the row', () => {
    assert.throws(() => targetsFromRows([[{ src: path.join(ROOT, 'nope.js'), suite: real.suite }, 'moved', 'x', 'y']]),
      /"moved" names .*nope\.js, which does not exist/);
    assert.throws(() => targetsFromRows([[{ src: real.src, suite: 'test/unit/nope.test.js' }, 'gone suite', 'x', 'y']]),
      /"gone suite" names the suite test\/unit\/nope\.test\.js, which does not exist/);
    assert.throws(() => targetsFromRows([['label only', 'x', 'y']]), /names no target/);
    assert.throws(() => targetsFromRows([]), /no rows/);
  });

  test('a suite naming one test after # is checked by its file', () => {
    const named = { src: real.src, suite: 'test/unit/boundary.test.js#some test' };
    assert.deepStrictEqual(targetsFromRows([[named, 'a', 'x', 'y']]), [named]);
  });

  test('a run whose rows name a missing target fails before it writes anything', (t) => {
    // The failure has to come first. A harness that armed and then crashed on
    // its twelfth row has already rewritten eleven files' worth of state.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mutation-rows-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'kept.js'), 'kept\n');
    fs.mkdirSync(path.join(dir, 'test', 'unit'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'test', 'unit', 's.test.js'), '\n');
    const harness = path.join(dir, 'mutate-planted-guards.js');
    fs.writeFileSync(harness, `
      const path = require('node:path');
      const fs = require('node:fs');
      const { beginMutationRun, targetsFromRows } = require(${JSON.stringify(path.join(TOOLS, 'mutation-run.js'))});
      const root = __dirname;
      const KEPT = { src: path.join(root, 'kept.js'), suite: 'test/unit/s.test.js' };
      const GONE = { src: path.join(root, 'gone.js'), suite: 'test/unit/s.test.js' };
      const MUTATIONS = [[KEPT, 'first', 'kept', 'broken'], [GONE, 'second', 'x', 'y']];
      const targets = targetsFromRows(MUTATIONS, { root });
      beginMutationRun({ root, files: targets.map((t) => t.src) });
      fs.writeFileSync(KEPT.src, 'broken\\n');
    `);
    const run = spawnSync(process.execPath, [harness], { cwd: dir, encoding: 'utf8', timeout: 30000 });
    assert.notStrictEqual(run.status, 0, 'a missing target must fail the run');
    assert.match(run.stderr, /"second" names .*gone\.js, which does not exist/);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'kept.js'), 'utf8'), 'kept\n', 'a file was mutated first');
    assert.strictEqual(fs.existsSync(path.join(dir, '.mutation-runs')), false, 'a run record was written first');
  });
});

describe('rowsForShard: one harness split across CI shards', () => {
  const rows = ['a', 'b', 'c', 'd', 'e'];
  test('no --rows means every row', () => {
    assert.strictEqual(rowsForShard(rows, ['node', 'x.js', '--markdown']), rows);
  });
  test('--rows a:b is the slice, start inclusive and end exclusive', () => {
    assert.deepStrictEqual(rowsForShard(rows, ['node', 'x.js', '--rows', '1:3']), ['b', 'c']);
    assert.deepStrictEqual(rowsForShard(rows, ['node', 'x.js', '--rows', '0:5']), rows);
  });
  test('a slice outside the rows, or one that does not parse, throws rather than running nothing', () => {
    for (const bad of ['3:3', '4:2', '0:6', '1-3', '', 'x:y']) {
      assert.throws(() => rowsForShard(rows, ['node', 'x.js', '--rows', bad]), /--rows/, bad);
    }
  });
});

describe('exitCodeFor: pass, fail and no verdict are three outcomes', () => {
  test('nothing failed is a pass', () => {
    assert.strictEqual(exitCodeFor(0, [{ red: ['t'] }]), 0);
  });
  test('a guard nothing noticed is a failure, even beside an unreadable row', () => {
    assert.strictEqual(exitCodeFor(1, [{ red: [] }]), 1);
    assert.strictEqual(exitCodeFor(2, [{ red: [] }, { unparsable: true }]), 1);
  });
  test('only unreadable rows is no verdict, which is 3', () => {
    assert.strictEqual(NO_VERDICT, 3);
    assert.strictEqual(exitCodeFor(2, [{ unparsable: true }, { unparsable: true }, { red: ['t'] }]), NO_VERDICT);
  });
});
