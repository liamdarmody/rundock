'use strict';
// What a mutation run leaves in the working tree when it does not finish.
//
// WHAT WAS MEASURED. The mutation harnesses under test/tools break a source
// file on purpose, run a suite, and put the file back in a `finally`. A
// `finally` runs when the body returns or throws. It does not run when the
// process is killed, and these runs are killed often: they are the slowest
// step in the pre-commit gate, so they meet timeouts, interrupts and closed
// laptops more than anything else here. A run cut short that way left a
// mutated source file on disk in a piece of work that never touched that file.
// The next gate run then failed on an unrelated test, which reads as if the
// current change broke something.
//
// WHY THAT IS WORSE THAN A CONFUSING FAILURE. A mutated source file is an
// ordinary working-tree modification. `git add -A` stages it without comment,
// and staging everything before running the gate is exactly what this project
// tells people to do, so the broken file rides into a commit belonging to
// somebody who thought they were committing their own work.
//
// HOW THESE ARE PROVEN, because it is not by reverting the source. Most of
// what follows is a PROHIBITION, "no mutated file outlives the run", and
// taking the fix away makes these fail because the module they call has
// vanished rather than because a file survived. A prohibition is proven the
// other way round: commit the forbidden act and watch the test go red for the
// reason it names. That was done before the fix was written, with a stand-in
// harness that restored in a `finally` only, and it left the mutated file
// behind on every signal. Two of the cases below still assert the defect
// directly rather than its absence: the file IS mutated at the moment the
// signal is sent, and it IS still mutated after an uncatchable kill, so a fix
// that quietly stopped mutating at all would fail here rather than pass.
//
// NOTHING HERE TOUCHES THE REAL CHECKOUT. Every case builds a throwaway
// repository with one source file and drives a stand-in harness against it, so
// a case that fails half way through cannot leave the repository this suite
// runs in mutated, which is the very thing being fixed.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { inspect, markerPath } = require('../tools/mutation-run.js');
const { makeTempDir } = require('../helpers/workspace.js');

const MODULE = path.join(__dirname, '..', 'tools', 'mutation-run.js');

// The one line the stand-in harness breaks, and what it becomes. Distinct
// enough that a partial write cannot be mistaken for either.
const GUARD = 'const GUARD = true;';
const BROKEN = 'const GUARD = false;';
const SOURCE = `'use strict';\n${GUARD}\nmodule.exports = { GUARD };\n`;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

/**
 * A throwaway repository holding one committed source file, plus a stand-in
 * harness OUTSIDE it.
 *
 * The harness is written outside the repository on purpose: a script written
 * inside it would be an untracked file, and a case about what the working tree
 * looks like should not have to explain away its own scaffolding.
 */
function scratch(t, mode) {
  const dir = makeTempDir('mutation-run-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  // Named explicitly: `git init` takes its branch name from init.defaultBranch,
  // so a fixture that says nothing gets whatever the host is configured for.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const src = path.join(repo, 'src.js');
  fs.writeFileSync(src, SOURCE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const harness = path.join(dir, 'harness.js');
  fs.writeFileSync(harness, standIn(mode));
  return { dir, repo, src, harness, git };
}

/**
 * A harness shaped like the real ones: arm, read the original through the
 * session, break the file, and restore in a `finally`.
 *
 * In `hang` mode it stops after mutating and never returns, which is the state
 * every real harness spends nearly all of its time in: file broken, suite
 * running. That is the window a signal has to arrive in for any of this to
 * matter, so it is the window the cases below aim at.
 */
function standIn(mode) {
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { beginMutationRun } = require(${JSON.stringify(MODULE)});
const root = process.argv[2];
const src = path.join(root, 'src.js');
(async () => {
  const session = beginMutationRun({ root, files: [src] });
  try {
    fs.writeFileSync(src, session.original(src).replace(${JSON.stringify(GUARD)}, ${JSON.stringify(BROKEN)}));
    process.stdout.write('mutated\\n');
    // A timer rather than a promise nobody settles. An unsettled promise does
    // not hold the event loop open, so the process would exit immediately and
    // the case would be signalling something that had already finished.
    if (${JSON.stringify(mode)} === 'hang') await new Promise((r) => setTimeout(r, 600000));
  } finally {
    session.finish();
  }
})();
`;
}

/** Start the stand-in and resolve once it says the file is broken. */
async function mutating(t, fixture) {
  const kid = spawn(process.execPath, [fixture.harness, fixture.repo],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  kid.stdout.on('data', (b) => { stdout += b.toString(); });
  kid.stderr.on('data', (b) => { stderr += b.toString(); });
  const exited = new Promise((resolve) => kid.on('exit', (code, signal) => resolve({ code, signal })));
  t.after(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } });
  const started = await until(() => stdout.includes('mutated'));
  assert.equal(started, true,
    `the harness never reported a mutation, so nothing was under way when it was signalled\n${stderr}`);
  return { kid, exited, stderr: () => stderr };
}

function runStandIn(fixture) {
  return spawnSync(process.execPath, [fixture.harness, fixture.repo],
    { encoding: 'utf8', timeout: 30000 });
}

const read = (file) => fs.readFileSync(file, 'utf8');
const marker = (repo) => JSON.parse(read(markerPath(repo)));

describe('a mutation run that is killed leaves no mutated file behind', () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    test(`${signal} restores the file it broke`, async (t) => {
      const fixture = scratch(t, 'hang');
      const { kid, exited, stderr } = await mutating(t, fixture);

      // The defect, asserted directly. Without this the case would pass for a
      // harness that had stopped mutating altogether.
      assert.equal(read(fixture.src), SOURCE.replace(GUARD, BROKEN),
        'the file must actually be broken at the moment the signal is sent');
      assert.equal(fs.existsSync(markerPath(fixture.repo)), true,
        'a run in flight must be recorded while it is in flight');

      kid.kill(signal);
      const how = await exited;
      t.diagnostic(`the harness exited with code ${how.code} signal ${how.signal}`);
      t.diagnostic(`its stderr was: ${stderr().trim() || '(empty)'}`);

      assert.equal(read(fixture.src), SOURCE,
        `${signal} left the source mutated in the working tree`);
      // The signal is re-raised rather than turned into an exit code, so a
      // caller reading the wait status still sees a process that died of the
      // signal it sent. A tool that swallowed the signal and exited 0 would
      // tell a script driving it that the run had succeeded.
      assert.equal(how.signal, signal,
        `the harness must still die of ${signal}, not exit normally`);
      assert.equal(fs.existsSync(markerPath(fixture.repo)), false,
        'the record of a run in flight must go when the run does');
    });
  }

  test('an ordinary finish restores the file and clears the record', (t) => {
    const fixture = scratch(t, 'quick');
    const run = runStandIn(fixture);
    assert.equal(run.status, 0, `the run should have finished: ${run.stderr}`);
    assert.equal(read(fixture.src), SOURCE, 'a finished run left the source mutated');
    assert.equal(fs.existsSync(markerPath(fixture.repo)), false,
      'a finished run left its record behind, which stops the next one for nothing');
  });
});

describe('a mutation run refuses to start where a restore would be ambiguous', () => {
  test('it refuses when a file it would mutate has unstaged changes, and names it', (t) => {
    const fixture = scratch(t, 'quick');
    const mine = SOURCE.replace('module.exports', 'const mine = 1;\nmodule.exports');
    fs.writeFileSync(fixture.src, mine);

    const run = runStandIn(fixture);

    assert.equal(run.status, 2,
      `the run should have refused with exit 2, got ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /Refusing to start/, 'it refused without saying so');
    // NAMED, not counted. The person reading this is looking at a stopped tool
    // and nothing else, and the whole point of the refusal is that the state is
    // diagnosable rather than mysterious.
    assert.match(run.stderr, /src\.js/, 'the refusal must name the file it stopped for');
    assert.equal(read(fixture.src), mine,
      'a refusal must leave the working tree exactly as it found it');
    assert.equal(fs.existsSync(markerPath(fixture.repo)), false,
      'a run that never started must not record one');
  });

  test('a staged change is not a refusal, because the index holds a copy to come back to', (t) => {
    // This is what keeps the pre-commit gate runnable. That gate stages
    // everything and then runs the mutation harnesses, so a change that touches
    // a mutated file is the ordinary case rather than the exception. A staged
    // file is safe in the way an unstaged one is not: if the run dies, `git
    // checkout -- <file>` puts back the work, where for an unstaged edit the
    // same command throws it away.
    const fixture = scratch(t, 'quick');
    const staged = SOURCE.replace('module.exports', 'const staged = 1;\nmodule.exports');
    fs.writeFileSync(fixture.src, staged);
    fixture.git('add', 'src.js');

    const run = runStandIn(fixture);

    assert.equal(run.status, 0,
      `a staged change should not stop a run: ${run.stdout}\n${run.stderr}`);
    assert.equal(read(fixture.src), staged,
      'the run restored something other than what it read');
  });

  test('it refuses while another run is in flight, and says which', async (t) => {
    const fixture = scratch(t, 'hang');
    await mutating(t, fixture);

    const second = runStandIn(fixture);

    assert.equal(second.status, 2,
      `a second run should have refused, got ${second.status}\n${second.stderr}`);
    assert.match(second.stderr, /already in flight/, 'it refused without saying why');
    assert.match(second.stderr, /src\.js/, 'the refusal must name the files at stake');
    // Two runs mutating the same file both restore what they read, and the
    // second reads the first one's mutation.
    assert.equal(read(fixture.src), SOURCE.replace(GUARD, BROKEN),
      'the refusal must not have touched the file the first run is holding');
  });
});

describe('a run killed in a way nothing can catch', () => {
  test('leaves the file mutated, and leaves a record that says so by name', async (t) => {
    // WHAT THIS DOES NOT COVER, stated as a test rather than as a note because
    // the record only earns its keep here. SIGKILL is delivered to nothing, so
    // the mutation survives and no restore can run. What stops that from
    // reading as an unrelated broken file days later is the record: the next
    // run finds it, refuses, and names the files a dead run was holding.
    const fixture = scratch(t, 'hang');
    const { kid, exited } = await mutating(t, fixture);
    kid.kill('SIGKILL');
    await exited;

    assert.equal(read(fixture.src), SOURCE.replace(GUARD, BROKEN),
      'SIGKILL cannot be caught, so the mutation is expected to survive it');
    const record = marker(fixture.repo);
    assert.deepEqual(record.files, ['src.js'], 'the record must name what the dead run was holding');
    assert.ok(record.pid > 0, 'the record must name the process that was holding it');

    const next = runStandIn(fixture);
    assert.equal(next.status, 2,
      `the next run should have refused, got ${next.status}\n${next.stderr}`);
    assert.match(next.stderr, /never finished/, 'the refusal must say a previous run died');
    assert.match(next.stderr, /src\.js/, 'the refusal must name the file that may hold a mutation');
    // Says how to get out of it. A stop with no way forward is how a tool gets
    // deleted from the gate rather than fixed.
    assert.match(next.stderr, /git checkout/, 'the refusal must say how to put the file back');
    assert.match(next.stderr, /\.mutation-run\.json/, 'the refusal must say how to clear the record');
  });
});

describe('the verdict, without starting anything', () => {
  // The subprocess cases above prove the wiring. These prove the decision, and
  // they are cheap enough to cover the corners that are awkward to stage for
  // real.
  test('a clean tree is a start', (t) => {
    const fixture = scratch(t, 'quick');
    const verdict = inspect({ root: fixture.repo, files: [fixture.src] });
    assert.equal(verdict.ok, true, verdict.message);
    assert.deepEqual(verdict.blocked, []);
  });

  test('a file the run does not touch is not its business', (t) => {
    const fixture = scratch(t, 'quick');
    const other = path.join(fixture.repo, 'other.js');
    fs.writeFileSync(other, 'module.exports = {};\n');
    fixture.git('add', '-A');
    fixture.git('commit', '-q', '-m', 'other');
    fs.writeFileSync(other, 'module.exports = { changed: true };\n');
    const verdict = inspect({ root: fixture.repo, files: [fixture.src] });
    assert.equal(verdict.ok, true,
      'an edit elsewhere in the tree cannot be confused with a mutation of these files');
  });

  test('a deleted file is as ambiguous as a modified one', (t) => {
    const fixture = scratch(t, 'quick');
    fs.rmSync(fixture.src);
    const verdict = inspect({ root: fixture.repo, files: [fixture.src] });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.blocked, ['src.js']);
  });

  test('a record it cannot read stops the run rather than being stepped over', (t) => {
    const fixture = scratch(t, 'quick');
    fs.writeFileSync(markerPath(fixture.repo), 'not json');
    const verdict = inspect({ root: fixture.repo, files: [fixture.src] });
    assert.equal(verdict.ok, false, 'an unreadable record is not an absent one');
    assert.match(verdict.message, /\.mutation-run\.json/);
  });

  test('outside a repository it starts, and says it could not check', (t) => {
    // Refusing here would make the harnesses unrunnable from an archive
    // download, which is a real way people get this source. The check is a
    // safety rail over git, and where there is no git there is no rail: say so
    // rather than pretend either way.
    const dir = makeTempDir('mutation-run-nogit-');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    const src = path.join(dir, 'src.js');
    fs.writeFileSync(src, SOURCE);
    const verdict = inspect({ root: dir, files: [src] });
    assert.equal(verdict.ok, true);
    assert.match(verdict.note, /could not be checked/);
  });
});
