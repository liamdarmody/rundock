'use strict';
// What the pre-commit gate leaves behind after it is gone.
//
// WHAT WAS MEASURED, and it is three defects rather than one.
//
// 1. NOTHING IS EVER SIGNALLED. The gate ran each step with execFileSync, which
//    hands back no child handle, and it installed no listener for a terminating
//    signal. A signal delivered to the gate alone therefore took Node's default
//    handling: the gate died at once and `npm`, the shell it started and the
//    mutation harness running inside that shell carried on. The per-script
//    restore each harness gained earlier is armed for exactly this and never
//    fired, because nothing sent it anything.
//
// 2. A STEP'S OWN LEFTOVERS OUTLIVE A RUN THAT FINISHED NORMALLY. execFileSync
//    returns the moment the DIRECT child exits and waits for nothing else. A
//    step whose runner started a child of its own left that child running, and
//    the gate went on to print PASS over it. Measured at six milliseconds
//    between the step "finishing" and the gate returning with the child still
//    on the machine.
//
// 3. THE ONE KILL THE GATE ASKED FOR REACHED ONLY PART OF THE TREE. execFileSync
//    caps captured output at one megabyte, and on overflow it SIGTERMs the
//    direct child and raises ENOBUFS. The direct child is `npm`; the shell
//    chain and the harness currently rewriting a source file are not it. So a
//    step that merely talked too much was reported as FAILED while its subtree
//    kept mutating. This is not hypothetical headroom: `test:coverage` writes
//    574,755 bytes on a fully GREEN run, so it sits at 55% of the cap before a
//    single failure has printed a diff or a stack, and a failing run is the run
//    a developer is actually reading.
//
// HOW THESE ARE PROVEN, because the reverting check cannot prove them. Every
// criterion here is a PROHIBITION, "no process outlives the gate", and taking
// the fix away makes these fail because the mechanism they call has vanished
// rather than because something survived. A prohibition is proven the other way
// round: commit the forbidden act, run the test, watch it go red for the reason
// it names. That was done for each case below and the runs are recorded in
// .review/precommit-gate-orphans-evidence.md.
//
// EXISTING IS NOT RUNNING. A pid that answers `kill(pid, 0)` may be a process
// that has already exited and is only waiting to be collected. `running()`
// below asks the process table for a state and treats an exited entry as gone,
// which is what lets every assertion here be made IMMEDIATELY after the gate
// exits rather than after a settling window that would also forgive a gate that
// signalled and walked away.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { STEPS, STEP_END_GRACE_MS } = require('../../scripts/precommit-gate.js');
const { END_GRACE_MS } = require('../../scripts/lib/process-group.js');

const GATE = path.join(__dirname, '..', '..', 'scripts', 'precommit-gate.js');
const MUTATION_RUN = path.join(__dirname, '..', 'tools', 'mutation-run.js');

// The gate's own alarm for a group it could not end. Asserted against on every
// path that ends a live subtree, because a warning nobody looks at is how a
// false alarm on every interrupt goes unnoticed, and a real one goes unnoticed
// with it.
const SURVIVOR_WARNING = /survived being ended/;

// What the gate says when it has had to put a harness's files back itself,
// because the harness could not dispatch the signal that would have done it.
const GATE_RESTORED = /a mutation harness was ended mid-run holding \d+ file\(s\) rewritten/;

function noWarning(out, where) {
  assert.doesNotMatch(String(out), SURVIVOR_WARNING,
    `${where}: the gate reported a survivor when everything it started was ended\n${out}`);
}

// The step this card is about. Named once so the tests below read as being
// about the gate's slowest, file-rewriting step rather than about a string.
const MUTATE = 'mutate:guards';

// How long the stand-in children below sleep for. Deliberately an odd number of
// seconds rather than a round one: reproducing a measurement by hand means
// matching these processes on their command line, and a round duration would
// match a stranger's sleep on a shared machine as well as this file's.
const LONG = 600000 + (process.pid % 991);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, ms = 20000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}

/**
 * Is this pid a process that is still RUNNING, rather than one that has exited
 * and not yet been collected?
 *
 * Where the process table cannot be read at all, the strict answer is given, so
 * this never quietly forgives a genuine leak.
 */
function running(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  const out = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (out.error) return true;
  const state = String(out.stdout || '').trim().split('\n')[0].trim();
  if (!state) return false;
  return !state.startsWith('Z');
}

function pidsIn(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

/**
 * The process table for a set of pids.
 *
 * `ps -p` exits non-zero when none of the listed pids exist, which is a
 * successful lookup that found nothing rather than a failure to run ps.
 */
function table(pids) {
  if (!pids.length) return '(no pids recorded)';
  const live = pids.map(p => `${p}=${running(p) ? 'running' : 'gone'}`).join(' ');
  const out = spawnSync('ps', ['-o', 'pid,ppid,pgid,stat,command', '-p', pids.join(',')],
    { encoding: 'utf8' });
  if (out.error) return `${live}\n(no process table: ps could not be run here: ${out.error.code})`;
  const rows = String(out.stdout || '').trim().split('\n').filter(Boolean);
  if (rows.length <= 1) return `${live}\n(process table empty: none of these pids exist)`;
  return `${live}\n${rows.join('\n')}`;
}

// Nothing here may end a process it did not start, including in its own
// cleanup, so every teardown signals only the pids this file recorded.
function reap(pids) {
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
}

// A package.json whose scripts are exactly the steps the gate will run, DERIVED
// FROM STEPS rather than listed here. Listed, the fixture drifts the day a step
// is added or renamed: every test below would fail with a missing npm script
// and say nothing about the leak they exist to check.
function allStepsPass() {
  return Object.fromEntries(STEPS.map(step => [step.name, 'node -e "0"']));
}

/**
 * A step shaped like a package runner: it starts a child of its own, detaches
 * that child's stdio so the runner is not held open by it, and then finishes.
 * The child stays in the runner's process group, which is what makes this the
 * case the criteria name: ending the direct child alone leaves the child of the
 * child running.
 *
 * `$!` is the background child, `$$` the shell npm started. Both are recorded
 * so a failure can say which of the two survived.
 */
function runnerLeaving(file, tail = 'exit 0') {
  return `sleep ${LONG} >/dev/null 2>&1 & echo $! >> ${JSON.stringify(file)}; `
    + `echo $$ >> ${JSON.stringify(file)}; ${tail}`;
}

function scratch(name) {
  return path.join(os.tmpdir(), `precommit-gate-orphans-${name}-${process.pid}-${Date.now()}`);
}

/**
 * A throwaway repository on a feature branch, staged, whose npm scripts are the
 * gate's own steps.
 *
 * Staged and not committed, because the gate refuses to run at all when the
 * working tree does not match the index, and a fixture that skipped that would
 * be testing a path no real run takes.
 */
function repoWithScripts(scripts, extraFiles = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precommit-gate-orphans-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  // Named explicitly: `git init` takes its branch name from init.defaultBranch,
  // so a fixture that says nothing gets whatever the host is configured for,
  // and the gate refuses to run on the default branch.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'first\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'fix/card');
  for (const [name, body] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  fs.writeFileSync(path.join(dir, 'package.json'),
    JSON.stringify({ name: 'tmp', version: '1.0.0', scripts }, null, 2));
  // The marker a mutation run writes while it holds files mutated must never be
  // swept into the index by the `add -A` the gate's own instructions ask for.
  fs.writeFileSync(path.join(dir, '.gitignore'), '.mutation-run.json\n.precommit-gate.json\n');
  git('add', '-A');
  return { dir, git };
}

function cleanup(dir, files) {
  for (const f of files) fs.rmSync(f, { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The gate, run to completion, the way npm runs it. */
function runGate(dir) {
  const res = spawnSync(process.execPath, [GATE], {
    env: { ...process.env, PRECOMMIT_GATE_ROOT: dir }, encoding: 'utf8', timeout: 120000,
  });
  return { code: res.status, signal: res.signal, out: `${res.stdout || ''}${res.stderr || ''}` };
}

describe('what the gate gives a step on the way out', () => {
  test('a step gets longer than the shared default, because its group may hold a file mutated', () => {
    // Pinned, because the two numbers exist for different reasons and the
    // reason is not visible from either one alone. The shared default is short
    // on purpose: the tool it was written for spawns a test command with
    // nothing to skip on the way out. This gate's group is a mutation harness
    // holding a real source file rewritten on disk, whose restore runs from its
    // SIGTERM handler, and escalating to SIGKILL before that handler has run
    // leaves the file mutated. Taking the override away would pass every
    // process assertion in this file and lose the thing the card is about.
    assert.ok(STEP_END_GRACE_MS > END_GRACE_MS,
      `a step's group is given ${STEP_END_GRACE_MS}ms, which is not more than the `
      + `${END_GRACE_MS}ms default it is meant to override`);
  });
});

describe('no process outlives the pre-commit gate', () => {
  test('a run that finishes normally leaves nothing the step started running', async (t) => {
    // Defect 2, and the one the card's evidence could not be explained without.
    // No signal, no timeout, no interruption of any kind: the step ran to
    // completion and returned zero, and its own child was still on the machine
    // when the gate printed PASS.
    const file = scratch('normal');
    const { dir } = repoWithScripts({ ...allStepsPass(), [MUTATE]: runnerLeaving(file) });
    try {
      const r = runGate(dir);
      assert.strictEqual(r.code, 0, `the gate must have passed\n${r.out}`);
      assert.match(r.out, /\[precommit\] PASS/, `the gate must have reached its verdict\n${r.out}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the step must have started something to leave behind: ${pids}`);
      t.diagnostic(`once the gate had exited:\n${table(pids)}`);

      // Asserted with no settling window. Anything still running at the moment
      // the gate is gone is a survivor; a gate that signalled and walked away
      // without waiting would fail here, which a window would have forgiven.
      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a normal run left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.out, 'normal run');
    } finally {
      reap(pidsIn(file));
      cleanup(dir, [file]);
    }
  });

  test('a step that fails after starting something still leaves nothing running', async (t) => {
    // The other ordinary exit. A step failing is the path the gate exists to
    // take, and it is taken with `process.exit(1)` from inside the loop, which
    // unwinds nothing at all.
    const file = scratch('failing');
    const { dir } = repoWithScripts({ ...allStepsPass(), [MUTATE]: runnerLeaving(file, 'exit 1') });
    try {
      const r = runGate(dir);
      assert.notStrictEqual(r.code, 0, `a failing step must fail the gate\n${r.out}`);
      assert.match(r.out, new RegExp(`${MUTATE} failed`), `and must say which step\n${r.out}`);
      assert.ok(!fs.existsSync(path.join(dir, '.precommit-gate.json')),
        'no record is written when a step failed');

      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the step must have started something to leave behind: ${pids}`);
      t.diagnostic(`once the gate had exited:\n${table(pids)}`);
      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a failed step left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.out, 'failed step');
    } finally {
      reap(pidsIn(file));
      cleanup(dir, [file]);
    }
  });

  test('a step that writes more than the capture buffer is not failed for it, and orphans nothing', async (t) => {
    // Defect 3. execFileSync caps capture at a megabyte and, on overflow,
    // SIGTERMs the DIRECT child and raises ENOBUFS. The direct child is the
    // package runner; the shell chain beneath it and whatever that shell is
    // running are not, so they carry on while the gate prints FAILED for a step
    // that had done nothing wrong.
    //
    // BOTH halves are asserted. A fix that only stopped the orphan would still
    // leave a passing step reported as a failure, and a fix that only stopped
    // the false failure would still leave the subtree behind on any other kill.
    const file = scratch('noisy');
    const noisy = "const c = 'x'.repeat(1024);\nfor (let i = 0; i < 1400; i++) console.log(c);\n";
    const { dir } = repoWithScripts(
      { ...allStepsPass(), [MUTATE]: runnerLeaving(file, 'node noisy.js; exit 0') },
      { 'noisy.js': noisy },
    );
    try {
      const r = runGate(dir);
      assert.strictEqual(r.code, 0,
        `a step that merely wrote 1.4MB must not be reported as a failure\n${r.out.slice(0, 2000)}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the step must have started something to leave behind: ${pids}`);
      t.diagnostic(`once the gate had exited:\n${table(pids)}`);
      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a noisy step left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.out, 'noisy step');
    } finally {
      reap(pidsIn(file));
      cleanup(dir, [file]);
    }
  });
});

/**
 * Start the gate, wait until its `mutate:guards` step has recorded that it is
 * under way, then send ONE signal to the gate's own pid and let it go.
 *
 * The signal goes to the gate ALONE, not to a process group, and that is the
 * whole point: a group-directed interrupt from a terminal would have reached
 * the harness anyway, and the case that cost four attempts to land a two-line
 * change is a supervisor that times out and ends the one process it started.
 */
async function gateInterruptedBy(signal, dir, file, expected = 2) {
  const kid = spawn(process.execPath, [GATE], {
    env: { ...process.env, PRECOMMIT_GATE_ROOT: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  kid.stdout.on('data', b => { out += b.toString(); });
  kid.stderr.on('data', b => { out += b.toString(); });
  const closed = new Promise(resolve => kid.on('close', (code, sig) => resolve({ code, sig })));

  const started = await until(() => pidsIn(file).length >= expected);
  assert.ok(started, `the step never reported that it had started: ${pidsIn(file)}`);

  process.kill(kid.pid, signal);
  const end = await closed;
  return { out, ...end };
}

describe('the gate cannot exit while its mutate:guards subtree is alive', () => {
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    test(`${signal} to the gate alone leaves no part of the step running`, async (t) => {
      const file = scratch(`signal-${signal}`);
      const { dir } = repoWithScripts({
        ...allStepsPass(),
        [MUTATE]: runnerLeaving(file, `sleep ${LONG}`),
      });
      try {
        const r = await gateInterruptedBy(signal, dir, file);
        const pids = pidsIn(file);
        assert.ok(pids.length >= 2, `the step must have been under way: ${pids}`);
        t.diagnostic(`once the gate had gone:\n${table(pids)}`);
        const survivors = pids.filter(running);
        assert.deepStrictEqual(survivors, [],
          `${signal} left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
        noWarning(r.out, String(signal));
      } finally {
        reap(pidsIn(file));
        cleanup(dir, [file]);
      }
    });
  }

  test('a step that ignores SIGTERM is ended anyway, which is what the escalation is for', async (t) => {
    // The only case where escalating to SIGKILL is what keeps the subtree from
    // outliving the gate. Every other stand-in here dies on the first signal,
    // so without this the escalation could be deleted and nothing would notice.
    //
    // An ignored disposition survives fork and exec, so the `sleep` started
    // after the trap ignores SIGTERM too.
    const file = scratch('stubborn');
    const { dir } = repoWithScripts({
      ...allStepsPass(),
      [MUTATE]: `trap '' TERM; ${runnerLeaving(file, `sleep ${LONG}`)}`,
    });
    try {
      const r = await gateInterruptedBy('SIGTERM', dir, file);
      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the step must have been under way: ${pids}`);
      t.diagnostic(`once the gate had gone:\n${table(pids)}`);
      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a step ignoring SIGTERM outlived the gate: ${survivors.join(', ')}`);
      noWarning(r.out, 'step ignoring SIGTERM');
    } finally {
      reap(pidsIn(file));
      cleanup(dir, [file]);
    }
  });
});

/**
 * A mutation harness, cut down to the part that matters here: it runs inside
 * the real envelope from test/tools/mutation-run.js, rewrites a tracked source
 * file, says so, and then waits. Nothing about the restore is reimplemented,
 * because the point is which of the two puts the file back.
 *
 * `yields` decides that, and it is the difference the card turned on.
 *
 * A harness that YIELDS is idle in the event loop, so the SIGTERM listener the
 * envelope registered is dispatched, the harness restores its own file and
 * re-raises the signal. Which of the two did the restoring is readable from the
 * gate's own output rather than from a breadcrumb here, because the gate says
 * so when it has had to step in.
 *
 * A harness that does NOT yield is the real shape. Every one under test/tools/
 * is a synchronous loop of `execFileSync` calls from top to bottom, and Node
 * dispatches a JavaScript signal handler from the event loop, which does not
 * turn until that loop has finished. Measured on the real thing: a
 * `mutate-render-guards.js` sent SIGTERM directly absorbed it for thirty
 * seconds, restored nothing, and died to SIGKILL with the file still mutated.
 * `Atomics.wait` on the main thread reproduces that exactly, and it is why
 * ending the group cannot be the whole fix.
 */
function harnessSource(pidFile, { yields = false } = {}) {
  const park = yields
    ? 'setInterval(() => {}, 1000);'
    : 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600000);';
  return `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { beginMutationRun } = require(${JSON.stringify(MUTATION_RUN)});
const root = __dirname;
const target = path.join(root, 'src.js');
beginMutationRun({ root, files: [target] });
fs.writeFileSync(target, '// MUTATED BY THE HARNESS\\n');
fs.appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n');
${park}
`;
}

describe('a gate cut short leaves no mutated source and no stale marker', () => {
  // The criterion this card was written for, end to end, and it is two cases
  // rather than one because the harness's own restore is reachable in only one
  // of them. Both must come out the same way: file back, record cleared,
  // nothing running.

  /** Run the gate against a stand-in harness, interrupt it mid-mutation. */
  async function cutShort(t, opts) {
    const file = scratch(opts.yields ? 'mutating-yields' : 'mutating-blocks');
    const original = 'module.exports = () => 1;\n';
    const { dir } = repoWithScripts(
      { ...allStepsPass(), [MUTATE]: 'node harness.js' },
      { 'harness.js': harnessSource(file, opts), 'src.js': original },
    );
    // Wait for the harness's own pid, which it writes only AFTER the file is
    // mutated, so the interrupt cannot land before the window it is about.
    const r = await gateInterruptedBy('SIGTERM', dir, file, 1);
    t.diagnostic(`harness pid(s) once the gate had gone:\n${table(pidsIn(file))}`);
    return {
      out: r.out,
      dir,
      file,
      original,
      target: path.join(dir, 'src.js'),
      marker: path.join(dir, '.mutation-run.json'),
    };
  }

  function assertPutBack(c) {
    // THE FILE FIRST, because it is what the card is about and because the
    // order decides what a failure says. Asserting the process first reports a
    // survivor, which is true and is the cause rather than the cost; the cost
    // is a source file nobody edited quietly saying something else.
    assert.strictEqual(fs.readFileSync(c.target, 'utf8'), c.original,
      'the gate exited leaving a source file holding a mutation');
    assert.strictEqual(fs.existsSync(c.marker), false,
      `a record of a run that is over was left at ${c.marker}`);
    assert.deepStrictEqual(pidsIn(c.file).filter(running), [],
      'the harness outlived the gate');
    noWarning(c.out, 'gate cut short mid-mutation');
  }

  test('a harness that can dispatch the signal restores its own file, and the gate waits for it', async (t) => {
    // The polite path, and what the grace period buys. This harness is idle in
    // the event loop, so the listener the envelope registered is dispatched and
    // it puts the file back itself. A gate that SIGKILLed the group straight
    // away would satisfy every process assertion in this file and leave the
    // tree mutated, which is why the gate's own recovery message is asserted
    // ABSENT here: the file being back has to be the harness's doing rather
    // than the recovery below having quietly covered for a grace that is too
    // short to be worth having.
    const c = await cutShort(t, { yields: true });
    try {
      assertPutBack(c);
      assert.doesNotMatch(c.out, GATE_RESTORED,
        'the gate had to put the file back, so the harness never got to run its own '
        + `handler and the grace bought nothing\n${c.out}`);
    } finally {
      reap(pidsIn(c.file));
      cleanup(c.dir, [c.file]);
    }
  });

  test('a harness that never yields, which is every real one, is put back by the gate', async (t) => {
    // The real shape, and the reason ending the group is not the whole fix. A
    // mutation harness is a synchronous loop from top to bottom, so the SIGTERM
    // it is sent is recorded and never dispatched: measured on the real
    // mutate-render-guards.js, which absorbed one for thirty seconds, restored
    // nothing, and died to SIGKILL holding the file.
    //
    // The gate reads the record the run wrote and restores those paths from the
    // INDEX, which is safe because a mutation run refuses to start where a file
    // it will rewrite has unstaged changes. Without that recovery this test
    // fails on its first assertion with the file still mutated, which is
    // exactly what the real gate did before it existed.
    const c = await cutShort(t, { yields: false });
    try {
      assertPutBack(c);
      // Named, not merely tolerated. A tool that rewrites a file in the working
      // tree and says nothing is one nobody can check afterwards, and this is
      // also what tells the two cases apart: silence here would mean the
      // stand-in had yielded after all and was not standing in for a real one.
      assert.match(c.out, GATE_RESTORED,
        `the gate put a file back without saying so\n${c.out}`);
      assert.match(c.out, /\bsrc\.js\b/, `and without naming it\n${c.out}`);
    } finally {
      reap(pidsIn(c.file));
      cleanup(c.dir, [c.file]);
    }
  });
});
