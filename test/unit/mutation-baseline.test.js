'use strict';
// A mutation run proves its environment before it reports anything.
//
// THE FAILURE THIS CLOSES. The report says, for each guard removed, which tests
// went red. If a suite cannot load at all, every mutation "turns tests red" for
// reasons unrelated to the mutation, and the run prints a full table over
// machinery that never ran. A green result and a result from a dead harness are
// indistinguishable, so nothing forces the question.
//
// Measured on 2026-09-09: the eighteen harnesses were timed in a worktree with
// no node_modules, every dependent suite exited immediately, all eighteen ran to
// completion, and the reported total was 88 seconds against a real cost of 1628.
// The number was believed and acted on.
//
// Driven through a REAL harness process rather than by calling the function,
// because the property under test is what the process does on its way out: exit
// code, what it prints, and above all what it does NOT print.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const made = [];

function tmp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(d);
  return d;
}

process.on('exit', () => {
  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* going anyway */ } }
});

/**
 * A throwaway harness that declares one target file and the suites named here,
 * then prints a table. The table is the thing that must not appear when a
 * baseline suite fails.
 */
function harness(dir, suites, targetRel) {
  const file = path.join(dir, 'harness.js');
  fs.writeFileSync(file, `
    const { beginMutationRun } = require(${JSON.stringify(path.join(ROOT, 'test', 'tools', 'mutation-run.js'))});
    const session = beginMutationRun({
      root: ${JSON.stringify(dir)},
      files: [${JSON.stringify(path.join(dir, targetRel))}],
      suites: ${JSON.stringify(suites)},
    });
    console.log('| Guard removed | Tests red |');
    console.log('MUTATION-APPLIED');
    session.finish();
  `);
  return file;
}

function workspace() {
  const dir = tmp('mut-baseline-');
  fs.mkdirSync(path.join(dir, 'suites'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'target.js'), 'module.exports = 1;\n');
  return dir;
}

function writeSuite(dir, name, passes) {
  const rel = path.join('suites', name);
  fs.writeFileSync(path.join(dir, rel), `
    const { test } = require('node:test');
    const assert = require('node:assert');
    test('${name}', () => { assert.strictEqual(${passes ? 1 : 2}, 1); });
  `);
  return rel;
}

function run(file, dir) {
  return spawnSync(process.execPath, [file], { cwd: dir, encoding: 'utf8' });
}

describe('a mutation run proves its environment before it reports', () => {
  test('a failing baseline suite ends the run before any mutation, and reports no verdicts', () => {
    const dir = workspace();
    const bad = writeSuite(dir, 'bad.test.js', false);
    const r = run(harness(dir, [bad], 'target.js'), dir);

    // NOTHING WAS MUTATED. The harness prints this marker only after
    // beginMutationRun returns, so its absence is the proof.
    assert.ok(!r.stdout.includes('MUTATION-APPLIED'),
      'the run ended before the harness could mutate anything');
    // A run that proved nothing must not look like success to a caller.
    assert.notStrictEqual(r.status, 0, 'a run that proved nothing must not exit 0');
    // NO RESULTS TABLE. A table printed after a failed baseline would be read
    // as verdicts, which is the confusion this exists to end.
    assert.ok(!r.stdout.includes('| Guard removed |'),
      'no results table is printed, so a failed baseline cannot be read as a set of verdicts');
    // The message has to name the suite and say plainly that nothing was mutated,
    // or the reader cannot tell this from an ordinary test failure.
    assert.ok(r.stderr.includes(bad), `the message names the failing suite (got: ${r.stderr.slice(0, 200)})`);
    assert.ok(/NO MUTATION WAS APPLIED/i.test(r.stderr),
      'and says plainly that no mutation was applied');
  });

  test('a suite that cannot even load is caught, which is the shape that was actually missed', () => {
    // The measured incident was not a failing assertion. It was a suite whose
    // dependency was absent, so it exited before running anything. A baseline
    // that only caught assertion failures would have missed the real case.
    const dir = workspace();
    const rel = path.join('suites', 'unloadable.test.js');
    fs.writeFileSync(path.join(dir, rel), "require('a-dependency-that-is-not-installed');\n");
    const r = run(harness(dir, [rel], 'target.js'), dir);
    assert.notStrictEqual(r.status, 0);
    assert.ok(!r.stdout.includes('MUTATION-APPLIED'), 'nothing was mutated');
    assert.ok(r.stderr.includes(rel), 'and the unloadable suite is named');
  });

  test('when every baseline suite passes, the run proceeds unchanged', () => {
    const dir = workspace();
    const a = writeSuite(dir, 'a.test.js', true);
    const b = writeSuite(dir, 'b.test.js', true);
    const r = run(harness(dir, [a, b], 'target.js'), dir);
    assert.strictEqual(r.status, 0, `a green baseline lets the run continue (stderr: ${r.stderr.slice(0, 300)})`);
    assert.ok(r.stdout.includes('MUTATION-APPLIED'), 'the harness reached its own work');
    assert.ok(r.stdout.includes('| Guard removed |'), 'and printed its table as it does today');
  });

  test('each distinct suite is run once, however many guards name it', () => {
    // The cost added is bounded by the number of DISTINCT suites, not by the
    // number of guards, or a baseline would cost as much as the run it guards.
    // A harness naming one suite per target repeats them heavily.
    const dir = workspace();
    const counter = path.join(dir, 'runs.log');
    const rel = path.join('suites', 'counted.test.js');
    fs.writeFileSync(path.join(dir, rel), `
      const fs = require('node:fs');
      const { test } = require('node:test');
      fs.appendFileSync(${JSON.stringify(counter)}, 'x');
      test('counted', () => {});
    `);
    const r = run(harness(dir, [rel, rel, rel, rel], 'target.js'), dir);
    assert.strictEqual(r.status, 0, 'the run completed');
    assert.strictEqual(fs.readFileSync(counter, 'utf8').length, 1,
      'the suite ran exactly once despite being named four times');
  });

  test('a harness that declares no suites is unaffected, so adoption can be incremental', () => {
    // The eighteen harnesses adopt this one at a time. Until a harness passes
    // its suites, it behaves exactly as it does today rather than failing.
    const dir = workspace();
    const r = run(harness(dir, [], 'target.js'), dir);
    assert.strictEqual(r.status, 0);
    assert.ok(r.stdout.includes('MUTATION-APPLIED'), 'it runs as before');
  });
});
