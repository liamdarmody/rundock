'use strict';
// A mutation row whose suite never finishes fails in bounded time instead of
// holding the run.
//
// WHAT WAS MEASURED. Each harness under test/tools ran a row's suite with a
// synchronous call and no time limit, so a row whose broken guard left a test
// waiting held its run for as long as anything let it: once for six hours,
// with the mutation still in the source until the run was stopped by hand.
// A time limit on that synchronous call would not have been enough either,
// because such a call also waits for every process holding its output pipe,
// and a grandchild the suite started can hold it for ever.
//
// WHAT HOLDS NOW, and is pinned here:
//
// - one runner, in test/tools/mutation-run.js, starts every row's suite, in a
//   process group of its own, with a limit from one named constant;
// - at the limit the whole group is ended, SIGTERM and then SIGKILL after a
//   grace, and the runner returns, whatever the group's members do;
// - a row that ran out of time is its own outcome, "did not finish", never
//   caught and never survived, and the harness puts the file back, runs the
//   rest and exits non-zero;
// - a harness signalled while a suite runs puts the file back and ends the
//   suite too;
// - a suite sees TMPDIR as the real path of the temp folder, as it does on a
//   machine whose temp folder is not a link.
//
// That every real harness starts its suites through this runner is pinned in
// mutation-harness-runner.test.js.
//
// NOTHING HERE TOUCHES THE REAL CHECKOUT. The harness cases drive a fixture
// harness, shaped like the real ones, over a throwaway repository. Every case
// that starts a process bounds itself and kills what it started, so a
// regression shows as a failure rather than a hang.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const mutationRun = require('../tools/mutation-run.js');
const { makeTempDir } = require('../helpers/workspace.js');

const REPO = path.join(__dirname, '..', '..');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'mutation-row-limit');
const HARNESS = path.join(FIXTURES, 'harness.js');
const fixture = (name) => path.join(FIXTURES, name);

// How much later than the limit plus the grace a return may come and still be
// "within the grace". Ending a group is SIGTERM, a wait of at most the grace,
// then SIGKILL and the kernel's reaping of the entries; this is room for that
// last step and for a loaded machine, not for any further waiting.
const SLACK_MS = 3000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return predicate();
}
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
// A process just killed can stay listed until its parent collects it, which
// is a matter of the parent's event loop rather than of the kill; this waits
// for the listing to go rather than reading it once.
const gone = (pid) => until(() => !alive(pid), 10000);

/** The folder fixture processes record themselves in, killed and removed after the case. */
function pidFolder(t) {
  const dir = makeTempDir('row-limit-pids-');
  t.after(() => {
    for (const { pid } of recorded(dir)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
  });
  return dir;
}
function recorded(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => !n.startsWith('seen.')).map((n) => {
    const [role, pid] = n.split('.');
    return { role, pid: Number(pid) };
  });
}
function seen(dir) {
  return fs.readdirSync(dir).filter((n) => n.startsWith('seen.')).map((n) => fs.readFileSync(path.join(dir, n), 'utf8'));
}

// A child's environment. NODE_TEST_CONTEXT is left out: a nested node --test
// that inherits it reports in a form nobody here reads and still exits 0.
function childEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

describe('the runner every harness starts a row\'s suite with', () => {
  const { runSuite } = mutationRun;
  const settle = (p) => p.then((out) => ({ out }), (error) => ({ error }));

  test('a suite that finishes is read as before: its output when it passes, both streams and its status when it fails', { timeout: 60000 }, async () => {
    const passed = await settle(runSuite(process.execPath, ['-e', "process.stdout.write('green\\n')"], { cwd: REPO, env: childEnv() }));
    assert.strictEqual(passed.out, 'green\n', 'a passing suite gives its stdout');
    const failed = await settle(runSuite(process.execPath,
      ['-e', "process.stdout.write('out\\n'); process.stderr.write('err\\n'); process.exit(1)"], { cwd: REPO, env: childEnv() }));
    assert.ok(failed.error, 'a failing suite is an error, as a synchronous call made it');
    assert.strictEqual(failed.error.stdout, 'out\n');
    assert.strictEqual(failed.error.stderr, 'err\n');
    assert.strictEqual(failed.error.status, 1);
    assert.strictEqual(failed.error.didNotFinish, undefined, 'and a suite that finished is never one that did not');
  });

  test('a node:test suite is given 300 s and a desktop-app suite 240 s, from named constants', { timeout: 60000 }, async (t) => {
    // Driven through the runner on a suite that never ends, with the clock
    // mocked, so the limit the runner applies is observed rather than a
    // function that computes it.
    assert.strictEqual(mutationRun.SUITE_LIMIT_SECONDS, 300);
    assert.strictEqual(mutationRun.ELECTRON_SUITE_LIMIT_SECONDS, 240);
    const dir = makeTempDir('row-limit-default-');
    t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
    fs.mkdirSync(path.join(dir, 'test', 'electron'), { recursive: true });
    const never = "'use strict';\nsetInterval(() => {}, 1000);\n";
    fs.writeFileSync(path.join(dir, 'never.js'), never);
    fs.writeFileSync(path.join(dir, 'test', 'electron', 'never.cjs'), never);

    for (const [args, seconds] of [
      [['--test', '--test-reporter', 'spec', 'never.js'], mutationRun.SUITE_LIMIT_SECONDS],
      [['test/electron/never.cjs'], mutationRun.ELECTRON_SUITE_LIMIT_SECONDS],
    ]) {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      try {
        let outcome = null;
        const running = settle(runSuite(process.execPath, args, { cwd: dir, env: childEnv(), graceMs: 500 }));
        running.then((o) => { outcome = o; });
        t.mock.timers.tick(seconds * 1000 - 1);
        await new Promise(setImmediate);
        assert.strictEqual(outcome, null, `${args.join(' ')} was ended before ${seconds} s`);
        t.mock.timers.tick(1);
        const { error } = await running;
        assert.ok(error, `${args.join(' ')} was not ended at ${seconds} s`);
        assert.strictEqual(error.didNotFinish, seconds, `${args.join(' ')} names its limit`);
      } finally {
        t.mock.timers.reset();
      }
    }
  });

  test('at the limit the whole tree is ended, a grandchild that ignores SIGTERM and holds stdout included, within the grace', { timeout: 60000 }, async (t) => {
    const pids = pidFolder(t);
    const limitMs = 2000;
    const graceMs = 1500;
    const started = Date.now();
    const { error } = await settle(runSuite(process.execPath, [fixture('holds-output.js')],
      { cwd: REPO, env: childEnv({ MUTATION_FIXTURE_PIDS: pids }), limitMs, graceMs }));
    const took = Date.now() - started;
    t.diagnostic(`returned after ${took} ms`);

    const roles = recorded(pids).map((r) => r.role).sort();
    assert.deepStrictEqual(roles, ['grandchild', 'suite'], 'the suite and its grandchild were both running');
    assert.ok(error && error.didNotFinish === limitMs / 1000, `the suite is reported as not finishing in ${limitMs / 1000} s: ${error && error.message}`);
    assert.match(error.stdout, /grandchild holding stdout/, 'what the tree wrote before it was ended is kept');
    assert.ok(took >= limitMs, `it returned before the limit, at ${took} ms`);
    assert.ok(took < limitMs + graceMs + SLACK_MS, `it returned ${took - limitMs} ms after the limit, past the ${graceMs} ms grace`);
    for (const { role, pid } of recorded(pids)) {
      assert.ok(await gone(pid), `the ${role} (pid ${pid}) is still running`);
    }
  });

  test('a suite that ignores SIGTERM is killed when the grace runs out, and the runner returns', { timeout: 60000 }, async (t) => {
    const pids = pidFolder(t);
    const limitMs = 1000;
    const graceMs = 1500;
    const started = Date.now();
    const { error } = await settle(runSuite(process.execPath, [fixture('ignores-term.js')],
      { cwd: REPO, env: childEnv({ MUTATION_FIXTURE_PIDS: pids }), limitMs, graceMs }));
    const took = Date.now() - started;
    assert.ok(error && error.didNotFinish, 'the suite did not finish');
    assert.ok(took >= limitMs + graceMs - 100, `it was given its grace before the kill (${took} ms)`);
    assert.ok(took < limitMs + graceMs + SLACK_MS, `and the runner returned soon after (${took} ms)`);
    const [suite] = recorded(pids);
    assert.ok(suite, 'the suite ran');
    assert.ok(await gone(suite.pid), 'and is gone');
  });

  // EVERY SIGNAL THE RUNNER SENDS A GROUP, CHECKED AS IT IS SENT. A group's id
  // is its leader's pid, and once the runner has collected the leader that
  // number can be handed to any process started afterwards, which may lead a
  // group of its own. Until then the leader is running, or dead and not yet
  // collected, and either way still holds the number. So a group signal is
  // safe only while the leader's pid is still held, and this records every one
  // sent after it was not.
  function watchGroupSignals(t) {
    const real = process.kill;
    const late = [];
    process.kill = function kill(pid, signal) {
      if (pid < 0 && signal !== 0) {
        let held = true;
        try { real.call(process, -pid, 0); } catch (e) { held = e.code === 'EPERM'; }
        if (!held) late.push(`${signal} to group ${-pid}, after its leader was collected`);
      }
      return real.apply(process, arguments);
    };
    t.after(() => { process.kill = real; });
    return late;
  }

  test('a group is never signalled after its leader has been collected, when the suite runs out of time', { timeout: 60000 }, async (t) => {
    // The suite here dies of SIGTERM and its grandchild ignores it, so the
    // grandchild can only be ended by a SIGKILL sent to the group after the
    // suite's own SIGTERM: the leader must still be held when it is sent.
    const late = watchGroupSignals(t);
    const pids = pidFolder(t);
    const { error } = await settle(runSuite(process.execPath, [fixture('holds-output.js')],
      { cwd: REPO, env: childEnv({ MUTATION_FIXTURE_PIDS: pids }), limitMs: 1500, graceMs: 1000 }));
    assert.ok(error && error.didNotFinish, 'the suite did not finish');
    assert.deepStrictEqual(late, [], 'no group was signalled once its id could belong to another process');
    for (const { role, pid } of recorded(pids)) assert.ok(await gone(pid), `the ${role} (pid ${pid}) is still running`);
  });

  test('a suite that finishes on its own is never signalled afterwards, and what it left running is left alone', { timeout: 60000 }, async (t) => {
    // Its group id is free to be handed out from the moment it is collected,
    // so the process it left behind, holding none of its output, is not the
    // runner's to end: a signal sent to that id could reach someone else's.
    const late = watchGroupSignals(t);
    const pids = pidFolder(t);
    const out = await runSuite(process.execPath, [fixture('leaves-a-process.js')],
      { cwd: REPO, env: childEnv({ MUTATION_FIXTURE_PIDS: pids }), limitMs: 30000, graceMs: 1000 });
    assert.strictEqual(out, 'suite finished, leaving a process behind\n', 'the suite is read as having passed');
    await wait(500);
    assert.deepStrictEqual(late, [], 'no group was signalled once its id could belong to another process');
    const leftover = recorded(pids).find((r) => r.role === 'leftover');
    assert.ok(leftover, 'the suite started a process before it finished');
    assert.ok(alive(leftover.pid), 'and that process was never signalled; this case ends it');
  });

  test('a suite sees TMPDIR as the real path of the temp folder, even when it was given a link', { timeout: 60000 }, async (t) => {
    const base = makeTempDir('row-limit-tmp-');
    t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* gone */ } });
    fs.mkdirSync(path.join(base, 'real'));
    const real = fs.realpathSync(path.join(base, 'real'));
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    const told = await runSuite(process.execPath, [fixture('reports-tmpdir.js')], { cwd: REPO, env: childEnv({ TMPDIR: link }) });
    assert.strictEqual(told.trim(), `TMPDIR=${real}`, 'a TMPDIR passed as a link reaches the suite as its real path');

    // And with no environment passed, which is how most harnesses call it:
    // the harness's own TMPDIR, a link, reaches the suite as its real path.
    const before = process.env.TMPDIR;
    process.env.TMPDIR = link;
    let inherited;
    try {
      inherited = await runSuite(process.execPath, [fixture('reports-tmpdir.js')], { cwd: REPO });
    } finally {
      if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    }
    assert.strictEqual(inherited.trim(), `TMPDIR=${real}`, 'the harness\'s own linked TMPDIR reaches the suite as its real path');
  });
});

// ---------------------------------------------------------------------------
// A harness with a row that does not finish, driven for real.
// ---------------------------------------------------------------------------

const GUARD = 'const GUARD = true;';
const SOURCE = `'use strict';\n${GUARD}\nconst SPARE = 0;\nmodule.exports = { GUARD, SPARE };\n`;
const HANG = { suite: 'hangs.js', label: 'a row whose suite never ends', guard: 'const SPARE = 0;', without: 'const SPARE = 1;' };
const CATCH = { suite: 'reads-src.js', label: 'a row a test notices', guard: GUARD, without: 'const GUARD = false;' };
const SURVIVE = { suite: 'reads-src.js', label: 'a row no test notices', guard: 'module.exports = { GUARD, SPARE };', without: 'module.exports = { SPARE, GUARD };' };

/** A throwaway repository holding src.js, committed. */
function repo(t) {
  const dir = makeTempDir('row-limit-repo-');
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ } });
  const root = path.join(dir, 'repo');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const src = path.join(root, 'src.js');
  fs.writeFileSync(src, SOURCE);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root, src, config: (body) => JSON.stringify(body) };
}

/** Start the fixture harness; resolves with how it ended. Killed if it outlives the case. */
function start(t, fx, config, { args = ['--markdown'], pids, within = 45000 } = {}) {
  const kid = spawn(process.execPath, [HARNESS, fx.root, config, ...args],
    { cwd: REPO, env: childEnv(pids ? { MUTATION_FIXTURE_PIDS: pids } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  kid.stdout.on('data', (b) => { stdout += b; });
  kid.stderr.on('data', (b) => { stderr += b; });
  const ended = new Promise((resolve) => {
    const limit = setTimeout(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } }, within);
    kid.on('exit', (status, signal) => {
      clearTimeout(limit);
      // The streams can still hold the last lines after 'exit'.
      setTimeout(() => resolve({ status, signal, stdout, stderr }), 100);
    });
  });
  t.after(() => { try { kid.kill('SIGKILL'); } catch { /* gone */ } });
  return { kid, ended, stdout: () => stdout, stderr: () => stderr };
}

const markers = (root) => mutationRun.readMarkers(root);
const lineFor = (out, label) => out.split('\n').find((l) => l.startsWith(`| ${label} |`));

describe('a harness whose row does not finish in time', () => {
  test('the row fails as not finishing, by name, neither caught nor survived; the file is put back, the next row starts from the original, and the harness exits non-zero', { timeout: 90000 }, async (t) => {
    const fx = repo(t);
    const pids = pidFolder(t);
    const run = await start(t, fx, fx.config({ rows: [HANG, CATCH], limitMs: 2000, graceMs: 1000 }), { pids }).ended;
    t.diagnostic(`exit ${run.status} ${run.signal || ''}\n${run.stdout}\n${run.stderr}`);

    const hung = lineFor(run.stdout, HANG.label);
    assert.ok(hung, `the row that did not finish is reported by its label:\n${run.stdout}`);
    assert.match(hung, /did not finish in 2 s/, 'as a suite that did not finish, naming the limit');
    assert.doesNotMatch(hung, /nothing turned red|could not be parsed/, 'never as a guard that survived, or as unreadable output');
    assert.doesNotMatch(hung, /\| \d+ \|/, 'and never as caught');

    // THE REMAINING ROWS RUN, and the next one starts from the original.
    assert.match(lineFor(run.stdout, CATCH.label) || '', /\| 1 \| `the guard holds` \|/, 'the row after it ran and was caught');
    assert.deepStrictEqual(seen(pids), [SOURCE.replace(GUARD, CATCH.without)],
      'the next row\'s suite saw the original with only its own mutation, not the row that ran out of time');

    assert.strictEqual(run.signal, null);
    assert.strictEqual(run.status, mutationRun.NO_VERDICT, 'a row that did not finish is no verdict, so the harness exits non-zero');
    assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE, 'the file is byte-identical to its original');
    assert.deepStrictEqual(markers(fx.root), [], 'and the run left no record');
    for (const { role, pid } of recorded(pids)) assert.ok(await gone(pid), `the hung suite's ${role} (pid ${pid}) is still running`);
  });

  test('without --markdown the row is reported the same way, by name', { timeout: 60000 }, async (t) => {
    const fx = repo(t);
    const run = await start(t, fx, fx.config({ rows: [HANG], limitMs: 1500, graceMs: 1000 }), { args: [] }).ended;
    const at = run.stdout.indexOf(HANG.label);
    assert.ok(at !== -1, `the row is named:\n${run.stdout}`);
    assert.match(run.stdout.slice(at), /^.*\n\s+NO VERDICT: THE SUITE DID NOT FINISH IN 1\.5 S/, 'and said not to have finished');
    assert.strictEqual(run.status, mutationRun.NO_VERDICT);
    assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE);
  });

  test('a row whose suite finishes inside the limit is judged as before: caught, or nothing turned red', { timeout: 60000 }, async (t) => {
    const fx = repo(t);
    const run = await start(t, fx, fx.config({ rows: [CATCH, SURVIVE], limitMs: 30000 })).ended;
    assert.match(lineFor(run.stdout, CATCH.label) || '', /\| 1 \| `the guard holds` \|/, `caught:\n${run.stdout}`);
    assert.match(lineFor(run.stdout, SURVIVE.label) || '', /\*\*nothing turned red\*\*/, 'survived');
    assert.strictEqual(run.status, 1, 'a survivor fails the run, as it always has');
    assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE);
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    test(`a harness sent ${signal} while a row's suite runs puts the file back, ends the suite's tree, and dies of ${signal}`, { timeout: 60000 }, async (t) => {
      const fx = repo(t);
      const pids = pidFolder(t);
      const harness = start(t, fx, fx.config({ rows: [HANG, CATCH], limitMs: 120000, graceMs: 2000 }), { pids });
      assert.ok(await until(() => recorded(pids).length >= 2), `the row's suite never started:\n${harness.stderr()}`);
      // The defect, asserted directly: the file IS mutated when the signal goes.
      assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE.replace(HANG.guard, HANG.without),
        'the file must be mutated at the moment the signal is sent');

      harness.kid.kill(signal);
      const run = await harness.ended;
      t.diagnostic(`exit ${run.status} ${run.signal}\n${run.stdout}\n${run.stderr}`);

      assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE, `${signal} left the source mutated`);
      assert.strictEqual(run.signal, signal, `the harness must die of ${signal}, not exit normally`);
      assert.deepStrictEqual(markers(fx.root), [], 'the record of the run goes with it');
      for (const { role, pid } of recorded(pids)) assert.ok(await gone(pid), `the suite's ${role} (pid ${pid}) outlived the harness`);
      assert.deepStrictEqual(seen(pids), [], 'and no later row was started');
    });
  }

  test('the same harness run again straight after a timed-out run, or one stopped by a signal, starts cleanly', { timeout: 90000 }, async (t) => {
    const fx = repo(t);
    const pids = pidFolder(t);
    const timedOut = await start(t, fx, fx.config({ rows: [HANG], limitMs: 1500, graceMs: 1000 }), { pids }).ended;
    assert.strictEqual(timedOut.status, mutationRun.NO_VERDICT, timedOut.stderr);

    const stopped = start(t, fx, fx.config({ rows: [HANG], limitMs: 120000, graceMs: 1000 }), { pids });
    assert.ok(await until(() => recorded(pids).length >= 4), 'the second run\'s suite never started');
    stopped.kid.kill('SIGTERM');
    assert.strictEqual((await stopped.ended).signal, 'SIGTERM');

    const again = await start(t, fx, fx.config({ rows: [CATCH] })).ended;
    assert.doesNotMatch(again.stderr, /Refusing to start/, 'no leftover record refuses it');
    assert.doesNotMatch(again.stderr, /never finished/, 'and nothing had to be swept');
    assert.strictEqual(again.status, 0, `it ran and passed:\n${again.stdout}\n${again.stderr}`);
    assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE, 'no mutation is left in the source');
    for (const { role, pid } of recorded(pids)) assert.ok(await gone(pid), `an earlier run's ${role} (pid ${pid}) is still running`);
  });

  test('a runner that throws while starting a suite makes the row no verdict, and the harness exits non-zero', { timeout: 60000 }, async (t) => {
    const fx = repo(t);
    const run = await start(t, fx, fx.config({ rows: [CATCH], spawnThrows: true })).ended;
    assert.match(lineFor(run.stdout, CATCH.label) || '', /no verdict/, `the row is no verdict:\n${run.stdout}\n${run.stderr}`);
    assert.notStrictEqual(run.status, 0, 'never a pass');
    assert.strictEqual(run.status, mutationRun.NO_VERDICT);
    assert.strictEqual(fs.readFileSync(fx.src, 'utf8'), SOURCE);
    assert.deepStrictEqual(markers(fx.root), []);
  });
});
