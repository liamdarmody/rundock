'use strict';
// What the tool leaves behind after it is gone.
//
// Written BEFORE the fix, and it has to be, because none of these can be proven
// the way this project normally proves a test: by reverting the source and
// watching the test go red. Every criterion here is a PROHIBITION, "no suite
// outlives the tool", and taking the fix away makes these tests fail because
// the mechanism they call has vanished rather than because a suite survived.
// A prohibition is proven the other way round: commit the forbidden act, run
// the test, watch it go red for the reason it names. That was done for each
// case below, and the run is recorded with the change's review records.
//
// WHAT WAS MEASURED, which is why this file exists at all. The tool spawns its
// test command detached, and a package runner starts children of its own. On a
// normal exit two suites were left running; on an error exit one; on a signal
// arriving during the FIRST run, both the shell and its child, because the
// signal handlers were installed only once the reverted run was about to
// start and Node's default handling terminates without unwinding. A developer
// whose check came back inconclusive and retried therefore added a whole suite
// to the machine each time.
//
// THE SECOND EDGE, which is why the AC-8 test here is not optional. The obvious
// remedy for a leak like this is a pattern kill across the machine, and that
// reaches processes this tool never started. It asks whether the foreign suite
// is still WORKING rather than whether its pid can still be signalled, for a
// reason its own comment gives at length.
//
// EXISTING IS NOT RUNNING, AND IT IS THE SAME MISTAKE TWICE. A pid that answers
// `kill(pid, 0)` may be a process that has already exited and is only waiting
// to be collected. This file made that mistake once, in the AC-8 check, where a
// pattern kill passed because the corpse still answered; the tool made it too,
// in its own liveness probe, where a corpse kept a group looking alive for the
// whole grace on Linux. So `running()` below asks the process table for a state
// and treats an exited entry as gone, which is what lets every assertion here
// be made IMMEDIATELY after the tool exits rather than after a settling window
// that would also forgive a tool that signalled and walked away.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { redFirst, runRecordPath, groupRunning, endGroup } = require('../../scripts/red-first.js');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'red-first.js');

// How long the stand-in suites below sleep for. Deliberately an odd number of
// seconds rather than a round one: reproducing the `AC-8` measurement by hand
// means matching these processes on their command line, and a round duration
// would match a stranger's sleep on a shared machine as well as this file's.
const LONG = 600000 + (process.pid % 997);

// The tool's own alarm for a group it could not end. Asserted against on every
// path that ends a live suite, because a warning nobody looks at is how a false
// alarm on every interrupt goes unnoticed, and a real one goes unnoticed with
// it.
const SURVIVOR_WARNING = /survived being ended/;

function noWarning(stderr, where) {
  assert.doesNotMatch(String(stderr), SURVIVOR_WARNING,
    `${where}: the tool reported a survivor when everything it started was ended\n${stderr}`);
}

// A throwaway repository whose branch ADDS a source file and a test that needs
// it, so the reverted run genuinely fails and the tool takes its ordinary path
// through both runs rather than short-circuiting.
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-first-orphans-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  git('init', '-q');
  // Named explicitly: `git init` takes its branch name from init.defaultBranch,
  // so a fixture that says nothing gets whatever the host is configured for.
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'diff.renames', 'false');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib.js'), 'module.exports.a = () => 1;\n');
  fs.writeFileSync(path.join(dir, 'test', 'check.js'), 'module.exports = () => {};\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'change');
  fs.writeFileSync(path.join(dir, 'lib2.js'), 'module.exports.b = () => 2;\n');
  fs.writeFileSync(path.join(dir, 'test', 'check.js'),
    "module.exports = () => { require('../lib2.js'); };\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'the change');
  return dir;
}

// Scratch paths OUTSIDE the repository, because anything written inside it
// dirties the tree the tool is about to check.
function scratch(name) {
  return path.join(os.tmpdir(), `red-first-orphans-${name}-${process.pid}-${Date.now()}`);
}

function pidsIn(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

/**
 * Is this pid a process that is still RUNNING, rather than one that has exited
 * and not yet been collected?
 *
 * `kill(pid, 0)` alone cannot tell the two apart, and the difference is the
 * whole point here: the tool ends its own direct child while its event loop is
 * blocked, so on Linux that child is briefly an entry in the table with nothing
 * behind it. Counting that as a survivor would fail every assertion below for a
 * process that is already dead.
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

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

/**
 * The process table for a set of pids.
 *
 * `ps -p` exits non-zero when none of the listed pids exist, which is a
 * successful lookup that found nothing, not a failure to run ps. Reporting the
 * second when it was the first put a false statement about the environment into
 * the committed evidence: it said the table could not be captured in a run
 * where ps was producing tables seconds later.
 */
function table(pids) {
  if (!pids.length) return '(no pids recorded)';
  const live = pids.map(p => `${p}=${running(p) ? 'running' : 'gone'}`).join(' ');
  const out = spawnSync('ps', ['-o', 'pid,ppid,pgid,stat,command', '-p', pids.join(',')],
    { encoding: 'utf8' });
  if (out.error) {
    return `${live}\n(no process table: ps could not be run here: ${out.error.code})`;
  }
  const text = String(out.stdout || '').trim();
  const rows = text.split('\n').filter(Boolean);
  // One line is the column header on its own, which is what ps prints when
  // nothing matches.
  if (rows.length <= 1) return `${live}\n(process table empty: none of these pids exist)`;
  return `${live}\n${text}`;
}

/**
 * A test command shaped like a package runner: it starts a child of its own,
 * detaches that child's stdio so the runner is not held open by it, and then
 * finishes. The child stays in the runner's process group, which is what makes
 * this the case AC-4 names: ending the direct child alone leaves the child of
 * the child running.
 *
 * `$!` is the background child, `$$` the shell itself. Both are recorded so a
 * failure can say which of the two survived.
 *
 * `before` makes the runner write its own process table while both are still
 * alive, which is the only moment a before-table can be taken when the tool is
 * driven synchronously.
 *
 * `ignoreTerm` sets TERM to ignored in the shell before the child is started.
 * An ignored disposition survives fork and exec, so the child ignores SIGTERM
 * too, and only the escalation to SIGKILL can end it.
 */
function packageRunnerLeaving(file, opts = {}) {
  const { tail = 'exit 0', ignoreTerm = false, before = null } = opts;
  const trap = ignoreTerm ? "trap '' TERM; " : '';
  const snap = before
    ? `ps -o pid,ppid,pgid,stat,command -p "$!,$$" >> ${JSON.stringify(before)} 2>&1; `
    : '';
  return `${trap}sleep ${LONG} >/dev/null 2>&1 & echo $! >> ${JSON.stringify(file)}; `
    + `echo $$ >> ${JSON.stringify(file)}; ${snap}${tail}`;
}

// Nothing here may end a process it did not start, including in its own
// cleanup, so every teardown signals only the pids this file recorded.
function reap(pids) {
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
}

/**
 * The teardown every test here shares.
 *
 * Nine tests were repeating this by hand, which made the deliberate differences
 * between them (an extra process to end, a record left on purpose) hard to pick
 * out from the boilerplate around them. What stays in a test's own `finally` is
 * what is particular to that test.
 *
 * Only processes this file started are ever signalled, including here.
 */
function teardown({ dir, pidFiles = [], files = [], pids = [] }) {
  for (const f of pidFiles) reap(pidsIn(f));
  reap(pids);
  for (const f of [...pidFiles, ...files]) fs.rmSync(f, { force: true });
  if (dir) {
    fs.rmSync(runRecordPath(dir), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A pid and a process group that are both certainly gone.
 *
 * Used to build a record that describes a run which has ended, which is the
 * state a crashed or SIGKILLed run leaves behind and the one a later start must
 * be willing to clear.
 */
async function deadGroup() {
  const kid = spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
  await new Promise(resolve => kid.on('exit', resolve));
  const cleared = await until(() => {
    if (running(kid.pid)) return false;
    try { process.kill(-kid.pid, 0); return false; } catch (e) { return true; }
  }, 5000);
  assert.strictEqual(cleared, true, 'the fixture process must be gone before it is used as a dead one');
  return kid.pid;
}

function cli(dir, tests) {
  return spawnSync(process.execPath,
    [SCRIPT, '--repo', dir, '--base', 'main', '--tests', tests], { encoding: 'utf8' });
}

function readRecord(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function readBefore(file) {
  try { return fs.readFileSync(file, 'utf8').trim(); } catch (e) { return '(not written)'; }
}

describe('no suite outlives the tool', () => {
  test('AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner\'s own child', async (t) => {
    const dir = repo();
    const file = scratch('normal');
    const before = scratch('normal-before');
    try {
      const r = cli(dir, packageRunnerLeaving(file, { before }));
      // The run really did complete rather than dying early, or the absence of
      // survivors would prove nothing about a normal exit.
      assert.match(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/,
        `the tool must have reached a conclusion\n${r.stdout}\n${r.stderr}`);

      const pids = pidsIn(file);
      // Two runs, each leaving a background child and a shell.
      assert.ok(pids.length >= 2, `the runner must have started something to leave behind: ${pids}`);
      t.diagnostic(`with the suite live, written by the runner itself:\n${readBefore(before)}`);
      t.diagnostic(`once the tool had exited:\n${table(pids)}`);

      // Asserted with no settling window. Anything still running at the moment
      // the tool is gone is a survivor; a tool that signalled its group and
      // walked away without waiting would fail here, which a window would have
      // forgiven.
      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a normal exit left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.stderr, 'normal exit');

      // The record of a run that has finished must go with it. Left behind, it
      // names a pid that is gone, and the refusal at the top of the tool would
      // turn every later start in this repository into a refusal until somebody
      // deleted the file by hand. The guard against piling on load must not
      // become an outage of its own.
      assert.strictEqual(fs.existsSync(runRecordPath(dir)), false,
        `a finished run left its record at ${runRecordPath(dir)}`);
    } finally {
      teardown({ dir, pidFiles: [file], files: [before] });
    }
  });

  test('AC-1: a suite that ignores SIGTERM is ended anyway, which is what the escalation is for', async (t) => {
    // The only case where the escalation from SIGTERM to SIGKILL is what keeps
    // a suite from outliving the tool. Every other stand-in in this file dies
    // on the first signal, so without this one the escalation could be deleted
    // and nothing here would notice, while the criterion it answers to is
    // unconditional.
    //
    // The shell sets TERM to ignored before starting its background child, and
    // an ignored disposition survives exec, so the `sleep` ignores SIGTERM as
    // well. It is the shape a test runner takes when it traps the signal to
    // flush its reporters and then does not finish.
    const dir = repo();
    const file = scratch('stubborn');
    const before = scratch('stubborn-before');
    try {
      const r = cli(dir, packageRunnerLeaving(file, { ignoreTerm: true, before }));
      assert.match(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/,
        `the tool must have reached a conclusion\n${r.stdout}\n${r.stderr}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the runner must have started something to leave behind: ${pids}`);
      t.diagnostic(`with the stubborn suite live:\n${readBefore(before)}`);
      t.diagnostic(`once the tool had exited:\n${table(pids)}`);

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a suite that ignores SIGTERM outlived the tool: ${survivors.join(', ')}`);
      noWarning(r.stderr, 'stubborn suite');
    } finally {
      teardown({ dir, pidFiles: [file], files: [before] });
    }
  });

  test('AC-2: an error raised while a suite is in flight leaves no suite running', async (t) => {
    // The error exit that matters, and the one the first version of this test
    // missed. Destroying the repository after the run had closed produced an
    // error, but by then the ending after the run had already cleared the
    // group, so the test could not tell "the error path cleans up" from "every
    // run end cleans up". Here the exception is raised while the first suite is
    // still running, so the only thing that can end the group is the path an
    // error takes out of the process.
    const dir = repo();
    const file = scratch('inflight-error');
    let pids = [];
    try {
      const driver = `
        const { redFirst } = require(${JSON.stringify(SCRIPT)});
        redFirst({ repo: ${JSON.stringify(dir)}, base: 'main',
                   tests: ${JSON.stringify(packageRunnerLeaving(file, { tail: `sleep 30` }))} })
          .catch(() => {});
        const fs = require('node:fs');
        const t = setInterval(() => {
          const started = fs.existsSync(${JSON.stringify(file)})
            && fs.readFileSync(${JSON.stringify(file)}, 'utf8').trim().split('\\n').length >= 2;
          if (!started) return;
          clearInterval(t);
          throw new Error('raised while a suite was in flight');
        }, 50);
      `;
      const r = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 60000 });
      assert.notStrictEqual(r.status, 0, `the driver must have failed\n${r.stdout}\n${r.stderr}`);
      assert.match(r.stderr, /raised while a suite was in flight/,
        `the tool must have left by the error, not by returning\n${r.stderr}`);

      pids = pidsIn(file);
      assert.ok(pids.length >= 2, `a suite must have been in flight: ${pids}`);
      t.diagnostic(`once the error had taken the process down:\n${table(pids)}`);

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `an error exit left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.stderr, 'error exit in flight');
      assert.strictEqual(fs.existsSync(runRecordPath(dir)), false,
        'an error exit must still give the claim back');
    } finally {
      teardown({ dir, pidFiles: [file], pids });
    }
  });

  test('AC-2: an error out of the run itself also leaves no suite running', async (t) => {
    // The other shape of error exit: the runner destroys the repository's git
    // directory once it has started its background child, so the restore that
    // follows throws.
    //
    // WHAT THIS REACHES, stated precisely because an earlier version of this
    // comment claimed more. By the time restoreTo throws, the ending inside
    // runAndEnd has already run and cleared the group, so what is exercised
    // here is that ending plus the claim being given back on the way out, not
    // a second ending in the outer `finally`. There is no such second ending:
    // it would be a branch nothing could reach.
    const dir = repo();
    const file = scratch('error');
    const before = scratch('error-before');
    try {
      const r = cli(dir, packageRunnerLeaving(file, { tail: 'rm -rf .git; exit 0', before }));
      assert.notStrictEqual(r.status, 0, 'the tool must have failed');
      // Pinned to the exception, not merely to a non-zero status: an
      // inconclusive result is also non-zero and is an ordinary return.
      assert.match(r.stderr, /\[red-first\][\s\S]*Error/,
        `the tool must have printed the thrown error\n${r.stderr}`);
      assert.doesNotMatch(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|REFUSED|INCONCLUSIVE)/,
        `the tool must have crashed rather than concluded\n${r.stdout}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 1, `the runner must have started something to leave behind: ${pids}`);
      t.diagnostic(`with the suite live, written by the runner itself:\n${readBefore(before)}`);
      t.diagnostic(`once the tool had exited:\n${table(pids)}`);

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `an error exit left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.stderr, 'error exit');
      assert.strictEqual(fs.existsSync(runRecordPath(dir)), false,
        'an error exit must still give the claim back');
    } finally {
      teardown({ dir, pidFiles: [file], files: [before] });
    }
  });

  test('AC-3: a signal during the FIRST run leaves no suite running', async (t) => {
    // The first run is the longest window the tool has and it was the one with
    // no handler at all: the listeners went on after it, so a signal arriving
    // while the first suite ran took Node's default handling, which terminates
    // without unwinding and abandons a detached process group.
    const dir = repo();
    const file = scratch('signal');
    let pids = [];
    try {
      const kid = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main',
          '--tests', packageRunnerLeaving(file, { tail: 'sleep 30' })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      kid.stderr.on('data', (b) => { stderr += b.toString(); });
      const exited = new Promise(resolve => kid.on('exit', (code, signal) => resolve({ code, signal })));

      const started = await until(() => pidsIn(file).length >= 2);
      assert.strictEqual(started, true, 'the first run must be in flight before it is signalled');
      pids = pidsIn(file);
      t.diagnostic(`with the first run in flight:\n${table(pids)}`);

      const sentAt = Date.now();
      kid.kill('SIGTERM');
      const how = await exited;
      const took = Date.now() - sentAt;
      t.diagnostic(`the tool exited with code ${how.code} signal ${how.signal} after ${took}ms`);
      t.diagnostic(`its stderr was: ${stderr.trim() || '(empty)'}`);
      t.diagnostic(`once the tool had exited:\n${table(pids)}`);

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `a signal during the first run left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      // The alarm must stay quiet here. It did not on Linux before the ending
      // learned to tell an exited entry from a running one, and an interrupt is
      // the most common way this tool is stopped.
      noWarning(stderr, 'signal during the first run');
    } finally {
      teardown({ dir, pidFiles: [file], pids });
    }
  });

  test('AC-1: an exit taken while a suite is running leaves nothing behind either', async (t) => {
    // The exit that does not unwind.
    //
    // Every other normal-exit path here leaves through the function's own
    // `finally`, so the ending in that `finally` is enough for them and the
    // 'exit' listener behind it is never reached. This is the case that needs
    // the listener: something else in the process decides to stop while a suite
    // is in flight, the awaited call never settles, and no `finally` of this
    // tool's ever runs. Driven rather than argued, because a backstop nothing
    // reaches is not a backstop, it is a comment.
    const dir = repo();
    const file = scratch('inflight');
    let pids = [];
    try {
      const driver = `
        const { redFirst } = require(${JSON.stringify(SCRIPT)});
        redFirst({ repo: ${JSON.stringify(dir)}, base: 'main',
                   tests: ${JSON.stringify(packageRunnerLeaving(file, { tail: 'sleep 30' }))} })
          .catch(() => {});
        const fs = require('node:fs');
        setInterval(() => {
          const started = fs.existsSync(${JSON.stringify(file)})
            && fs.readFileSync(${JSON.stringify(file)}, 'utf8').trim().split('\\n').length >= 2;
          if (started) process.exit(0);
        }, 50);
      `;
      const r = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(r.status, 0, `the driver must have exited on purpose\n${r.stdout}\n${r.stderr}`);

      pids = pidsIn(file);
      assert.ok(pids.length >= 2, `a suite must have been in flight when it exited: ${pids}`);
      t.diagnostic(`once the exit had been taken:\n${table(pids)}`);

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `an exit taken mid-run left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
      noWarning(r.stderr, 'exit taken mid-run');
    } finally {
      teardown({ dir, pidFiles: [file], pids });
    }
  });
});

describe('telling a process that has exited from one that is still running', () => {
  test('a group whose remaining members have all exited is judged gone', () => {
    // The decision on its own, driven on any machine rather than only on the
    // platform that produces the corpses. On Linux a process this tool has just
    // killed stays listed as a member of its group until its parent collects
    // it, which the tool cannot do while it is blocked in a signal listener; a
    // probe that asks only whether the group id answers therefore keeps saying
    // "alive" for the whole grace and then reports a survivor that is a corpse.
    const holder = spawn('sh', ['-c', `sleep ${LONG}`], { detached: true, stdio: 'ignore' });
    holder.unref();
    try {
      const pgid = holder.pid;
      assert.strictEqual(groupRunning(pgid, () => [{ pid: pgid, state: 'S' }]), true,
        'a member in any state but exited is a running group');
      assert.strictEqual(groupRunning(pgid, () => [{ pid: pgid, state: 'Z+' }]), false,
        'a group whose only member has exited is gone');
      assert.strictEqual(groupRunning(pgid, () => [{ pid: pgid, state: 'Z' }, { pid: pgid + 1, state: 'S' }]), true,
        'one running member among the corpses keeps the group alive');
      assert.strictEqual(groupRunning(pgid, () => []), false,
        'a group the table does not list at all is gone');
      assert.strictEqual(groupRunning(pgid, () => null), null,
        'a machine that will not say gives neither answer');
    } finally {
      reap([holder.pid]);
    }
  });

  test('a group that no longer exists is gone without consulting the process table', async () => {
    // The cheap question is asked first, which cannot be seen in the answer:
    // where both agree they agree. What separates them is the spawn, so that is
    // what is observed.
    const gone = spawn('sh', ['-c', 'exit 0'], { detached: true, stdio: 'ignore' });
    await new Promise(resolve => gone.on('exit', resolve));
    const cleared = await until(() => {
      try { process.kill(-gone.pid, 0); return false; } catch (e) { return true; }
    }, 5000);
    assert.strictEqual(cleared, true, 'the fixture group must be gone before this is asked');

    let asked = 0;
    const answer = groupRunning(gone.pid, () => { asked += 1; return null; });
    assert.strictEqual(answer, false);
    assert.strictEqual(asked, 0, 'the process table must not be read when the group has gone');
  });
});

describe('a refusal describes what it found, not what the record carries', () => {
  test('AC-6: a record naming a finished group reports the live run, not that group', async (t) => {
    // A record names the group of the suite most recently started, and is not
    // rewritten when that suite ends. So between the two suites the record
    // carries a group id that has gone while its tool is still going.
    //
    // Wording the refusal from the record would announce that process group as
    // running, and send the reader to look for a process that is not there,
    // next to advice to delete the record if it had already gone. The refusal
    // is worded from what was actually found alive instead.
    const dir = repo();
    const record = runRecordPath(dir);
    try {
      const gone = await deadGroup();
      // This test process is the live run; the group it names has ended.
      fs.writeFileSync(record, JSON.stringify({
        pid: process.pid, group: gone, tests: 'npm test', repo: dir,
        startedAt: new Date().toISOString(),
      }, null, 2) + '\n');

      const r = cli(dir, 'echo this must never run');
      t.diagnostic(`refusal: ${r.stdout.trim()}`);
      assert.match(r.stdout, /REFUSED/, r.stdout);
      assert.match(r.stdout, /no suite under it yet/,
        `the refusal must report the live run, not the finished group\n${r.stdout}`);
      assert.doesNotMatch(r.stdout, new RegExp(`process group ${gone} running`),
        `the refusal must not say a finished group is running\n${r.stdout}`);
      assert.match(r.stdout, new RegExp(`\\b${process.pid}\\b`),
        `and must name the run it did find\n${r.stdout}`);
    } finally {
      teardown({ dir });
    }
  });

  test('AC-5: a record that cannot be read is refused and left alone, not cleared', async (t) => {
    // The safe direction for a record this run cannot understand. Treating it
    // as stale and deleting it is how the tool would end up running beside
    // whoever wrote it; refusing costs a message and names the file.
    const dir = repo();
    const record = runRecordPath(dir);
    try {
      // Both shapes of unreadable: something that is not a record at all, and
      // an empty file, which is what a reader would see if a record were ever
      // published in place rather than moved into place complete.
      for (const contents of ['this is not a run record\n', '']) {
        fs.writeFileSync(record, contents);
        const probe = cli(dir, 'echo this must never run');
        assert.match(probe.stdout, /REFUSED/,
          `an unreadable record (${JSON.stringify(contents)}) must be refused\n${probe.stdout}`);
        assert.strictEqual(fs.existsSync(record), true,
          'and must be left where it is');
      }

      fs.writeFileSync(record, 'this is not a run record\n');
      const r = cli(dir, 'echo this must never run');
      t.diagnostic(`refusal: ${r.stdout.trim()}`);
      assert.notStrictEqual(r.status, 0, 'an unreadable record must not be waved through');
      assert.match(r.stdout, /REFUSED/, r.stdout);
      assert.match(r.stdout, new RegExp(record.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `the refusal must name the file so it can be inspected\n${r.stdout}`);
      assert.strictEqual(fs.existsSync(record), true,
        'and must leave it where it is rather than deleting what it cannot read');
    } finally {
      teardown({ dir });
    }
  });
});

describe('a machine that will not describe its own process table', () => {
  test('the group is still ended, and nothing is announced that cannot be known', async (t) => {
    // What the tool does where `ps` cannot be spawned, which is the case under a
    // command sandbox. The evidence file claims the ending works unchanged there
    // and that no false alarm is raised; neither was driven by anything until
    // now, so both were claims rather than measurements.
    const file = scratch('unknowable');
    const kid = spawn('sh', ['-c',
      `sleep ${LONG} >/dev/null 2>&1 & echo $! >> ${JSON.stringify(file)}; echo $$ >> ${JSON.stringify(file)}; sleep 30`],
      { detached: true, stdio: 'ignore' });
    kid.unref();
    try {
      const started = await until(() => pidsIn(file).length >= 2, 15000);
      assert.strictEqual(started, true, 'the stand in group must be up');
      const pids = pidsIn(file);
      t.diagnostic(`before: ${table(pids)}`);

      // A reader that answers nothing, which is what a blocked spawn produces.
      const outcome = endGroup(kid.pid, () => null);
      t.diagnostic(`endGroup said ${outcome}; after: ${table(pids)}`);

      // The signals are still sent, so nothing is left running.
      assert.deepStrictEqual(pids.filter(running), [],
        `the group must still be ended when the table cannot be read: ${pids.filter(running).join(', ')}`);
      // And the answer is the honest one rather than an alarm.
      assert.strictEqual(outcome, 'unknown',
        'a machine that will not say must not be reported as a survivor');
    } finally {
      teardown({ pidFiles: [file], pids: [kid.pid] });
    }
  });

  test('AC-5: a suite it cannot describe is treated as live, so a start is refused', async (t) => {
    // The other half of the same ignorance. runIsLive is asked about a record
    // whose owning run has gone and whose group this machine will not describe;
    // the safe answer is that the run is live, because refusing costs a message
    // and proceeding costs a second suite.
    //
    // Driven by taking `ps` off PATH for the second start, rather than by
    // injecting anything: the refusal happens before any git command, so a PATH
    // with nothing on it is enough to reach it.
    const dir = repo();
    const record = runRecordPath(dir);
    const holder = spawn('sh', ['-c', `sleep ${LONG}`], { detached: true, stdio: 'ignore' });
    holder.unref();
    try {
      await until(() => running(holder.pid), 5000);
      const gone = await deadGroup();
      fs.writeFileSync(record, JSON.stringify({
        pid: gone, group: holder.pid, tests: 'npm test', repo: dir,
        startedAt: new Date().toISOString(),
      }, null, 2) + '\n');

      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'no-ps-'));
      const r = spawnSync(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main', '--tests', 'echo this must never run'],
        { encoding: 'utf8', env: { ...process.env, PATH: empty } });
      fs.rmSync(empty, { recursive: true, force: true });
      t.diagnostic(`with no ps on PATH: ${r.stdout.trim()}`);

      assert.notStrictEqual(r.status, 0, 'a suite that cannot be described must not be assumed gone');
      assert.match(r.stdout, /REFUSED/, `${r.stdout}\n${r.stderr}`);
      assert.match(r.stdout, new RegExp(`\\b${holder.pid}\\b`),
        `the refusal must still name the group\n${r.stdout}`);
      assert.strictEqual(running(holder.pid), true, 'and must leave it alone');
    } finally {
      teardown({ dir, pids: [holder.pid] });
    }
  });
});

describe('one checkout reached by two names', () => {
  test('AC-5: is one run record, so a second start through a symbolic link is refused', async (t) => {
    // path.resolve does not follow symbolic links, so the same working tree
    // reached as /tmp/x and /private/tmp/x, or through a symlinked worktree,
    // hashed to two different records. Neither refused the other and both would
    // have reverted the one tree. On this machine os.tmpdir() is itself reached
    // through such a link, which is how the difference shows without contriving
    // one.
    const dir = repo();
    const link = path.join(os.tmpdir(), `red-first-link-${process.pid}-${Date.now()}`);
    fs.symlinkSync(dir, link);
    try {
      assert.strictEqual(runRecordPath(link), runRecordPath(dir),
        'two names for one checkout must be one record');

      const file = scratch('symlink');
      const first = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main',
          '--tests', packageRunnerLeaving(file, { tail: 'sleep 20' })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => first.on('exit', resolve));
      try {
        const up = await until(() => pidsIn(file).length >= 2, 15000);
        assert.strictEqual(up, true, 'the first run must have a live suite');

        const second = cli(link, 'echo this must never run');
        t.diagnostic(`start through the link said: ${second.stdout.trim()}`);
        assert.match(second.stdout, /REFUSED/,
          `a start through the other name must be refused\n${second.stdout}`);
      } finally {
        first.kill('SIGTERM');
        await exited;
        teardown({ pidFiles: [file] });
      }
    } finally {
      // unlink, not rm: this is a symbolic link to a directory, and removing it
      // must not follow it to the repository underneath.
      try { fs.unlinkSync(link); } catch (e) { /* never created */ }
      teardown({ dir });
    }
  });
});

describe('starting on top of a run that is still going', () => {
  test('AC-5, AC-6: a second start is refused, and the refusal names the run it found', async (t) => {
    // Driven end to end against a real first run rather than a hand-written
    // record, because a hand-written one only proves the reader can read the
    // test's idea of a record.
    const dir = repo();
    const file = scratch('refuse');
    let first = null;
    let pids = [];
    try {
      first = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main',
          '--tests', packageRunnerLeaving(file, { tail: 'sleep 25' })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let firstStderr = '';
      first.stderr.on('data', (b) => { firstStderr += b.toString(); });
      const firstExited = new Promise(resolve => first.on('exit', resolve));

      const started = await until(() => pidsIn(file).length >= 2);
      assert.strictEqual(started, true, 'the first run must have a live suite before the second starts');
      pids = pidsIn(file);

      const record = runRecordPath(dir);
      assert.strictEqual(fs.existsSync(record), true,
        `the live run must be recorded somewhere the next start can read: ${record}`);
      const written = JSON.parse(fs.readFileSync(record, 'utf8'));
      t.diagnostic(`record: ${JSON.stringify(written)}`);

      const second = cli(dir, 'echo this must never run');
      t.diagnostic(`second start said: ${second.stdout.trim()}`);
      assert.notStrictEqual(second.status, 0, 'a second start must not exit 0');
      assert.match(second.stdout, /REFUSED/, second.stdout);

      // AC-6: named, not merely refused. A refusal that says "something is
      // running" leaves the reader with the same pkill they would have reached
      // for anyway, which is the second defect this card exists to avoid.
      assert.match(second.stdout, new RegExp(`\\b${written.group}\\b`),
        `the refusal must name the process group it found\n${second.stdout}`);
      assert.match(second.stdout, /sleep 25/,
        `the refusal must name the command that is running\n${second.stdout}`);
      assert.match(second.stdout, new RegExp(`\\b${written.pid}\\b`),
        `the refusal must name the run that owns it\n${second.stdout}`);

      // And the first run is left alone by the refusal: refusing must not be a
      // disguised way of clearing somebody else's work.
      assert.strictEqual(running(written.group), true,
        'the refusal must not end the run it found');

      first.kill('SIGTERM');
      await firstExited;
      first = null;
      t.diagnostic(`the first run's stderr was: ${firstStderr.trim() || '(empty)'}`);
      noWarning(firstStderr, 'first run torn down with SIGTERM');

      const survivors = pids.filter(running);
      assert.deepStrictEqual(survivors, [],
        `tearing the first run down left ${survivors.join(', ')} running`);
      assert.strictEqual(fs.existsSync(record), false,
        'the record must not outlive the run it describes, or every later start is refused');
    } finally {
      if (first) first.kill('SIGKILL');
      teardown({ dir, pidFiles: [file], pids });
    }
  });

  test('AC-5: a run that has not spawned its suite yet is live too', async (t) => {
    // The gap between a run starting and its first suite existing. A start made
    // in that gap has no group to find, and letting it through would put two
    // reverters on one working tree, each checking files out from under the
    // other.
    //
    // Driven against the record the tool itself writes, held open with the
    // injectable runner, rather than against a record this test composed: a
    // fixture built to agree with the test would stay green while the real
    // write drifted away from it.
    const dir = repo();
    let release = null;
    const gate = new Promise(resolve => { release = resolve; });
    try {
      const firstRun = redFirst({
        repo: dir, base: 'main', tests: 'this command is never spawned',
        runner: () => gate.then(() => true),
      });

      const record = runRecordPath(dir);
      const appeared = await until(() => fs.existsSync(record));
      assert.strictEqual(appeared, true, `the run must record itself before it spawns: ${record}`);
      const written = JSON.parse(fs.readFileSync(record, 'utf8'));
      t.diagnostic(`the record the tool wrote: ${JSON.stringify(written)}`);
      assert.strictEqual(written.group, null, 'no suite has been started yet');
      assert.strictEqual(written.pid, process.pid, 'the record names the running tool');

      const second = cli(dir, 'echo this must never run');
      t.diagnostic(`second start said: ${second.stdout.trim()}`);
      assert.notStrictEqual(second.status, 0, 'a second start must not exit 0');
      assert.match(second.stdout, /REFUSED/, second.stdout);
      assert.match(second.stdout, /no suite under it yet/, second.stdout);
      assert.match(second.stdout, new RegExp(`\\b${process.pid}\\b`),
        `the refusal must name the run it found\n${second.stdout}`);

      release();
      await firstRun;
      assert.strictEqual(fs.existsSync(record), false,
        'the claim must be given back when the run ends');
    } finally {
      if (release) release(); // particular to this test: let the held runner finish
      teardown({ dir });
    }
  });
});

describe('a suite the tool could not end', () => {
  test('AC-5: the run record is kept naming it, so the next start has something to refuse on', async (t) => {
    // The one exit where the tool KNOWS it left a suite behind was also the one
    // that erased the record the next start would need in order to refuse. That
    // is the AC-5 scenario arriving by the only route the tool can see coming,
    // and giving the claim back there would let the next run add a second suite
    // on top of the one this run just failed to end.
    //
    // SIGKILL cannot be survived on demand, so the ending is injected: one that
    // reports the group still running and leaves it alone. Nothing here is
    // pretended, then. The suite really does outlive the run, which is the
    // situation, and what is under test is everything the run does about it.
    // The ending that would normally have dealt with it is covered by the
    // stubborn-suite test above.
    const dir = repo();
    const file = scratch('survivor');
    let pids = [];
    try {
      const driver = `
        const { redFirst } = require(${JSON.stringify(SCRIPT)});
        redFirst({ repo: ${JSON.stringify(dir)}, base: 'main',
                   tests: ${JSON.stringify(packageRunnerLeaving(file))},
                   groupEnder: () => 'running' })
          .then((r) => { console.log('OUTCOME ' + r.outcome); process.exit(0); })
          .catch((e) => { console.error(e); process.exit(1); });
      `;
      const r = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 60000 });
      assert.strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
      t.diagnostic(`stderr: ${r.stderr.trim()}`);

      pids = pidsIn(file);
      assert.ok(pids.length >= 1, `the runner must have started something: ${pids}`);

      // THE RUN STOPS HERE. Restoring the source and spawning the reverted
      // suite now would put a second suite on the machine on top of the one
      // just failed, which is the compounding load the whole change exists to
      // prevent, produced by the tool itself.
      assert.match(r.stdout, /OUTCOME inconclusive/,
        `a run that could not end its suite must stop
${r.stdout}`);
      assert.strictEqual(pids.length, 2,
        `exactly one suite must have been started, got ${pids.length} pids: ${pids}`);

      // The alarm fires, and names the group, because here the tool genuinely
      // cannot tell that it ended it.
      assert.match(r.stderr, SURVIVOR_WARNING,
        `a group the tool could not confirm gone must be announced\n${r.stderr}`);

      const record = runRecordPath(dir);
      assert.strictEqual(fs.existsSync(record), true,
        'the record must be kept when the tool knows it may have left a suite behind');
      const held = JSON.parse(fs.readFileSync(record, 'utf8'));
      t.diagnostic(`record kept: ${JSON.stringify(held)}`);
      assert.strictEqual(held.survivedEnding, true, 'the record says why it was kept');
      assert.ok(pids.includes(held.group),
        `the kept record must name a group this run started, got ${held.group} of ${pids}`);
      assert.match(r.stderr, new RegExp(`\\b${held.group}\\b`),
        'the warning names the same group the record does');

      // AC-5 AS WORDED IS ABOUT THIS STATE, and until now nothing started
      // against it. The criterion is a suite from a PREVIOUS run: the tool that
      // owned it has gone and only its group is left, which is the case the
      // refusal exists for and the one an interrupted run leaves behind.
      //
      // Every other refusal test here starts while the first tool is still
      // alive, so the refusal is decided on the recorded pid and the group is
      // never consulted. Asserted first, so that this test cannot pass on the
      // pid branch by accident.
      assert.strictEqual(running(held.pid), false,
        `the run that wrote this record must be gone, so the decision below is `
        + `made on its group rather than on its pid (pid ${held.pid})`);
      // Asked of the GROUP, not of the group's leader. The leader is the shell,
      // which has exited; what is left is the child it started, which is in the
      // group but is not the pid the group is named after.
      assert.strictEqual(groupRunning(held.group), true,
        'and its suite must still be running, or there is nothing to refuse on');

      const second = cli(dir, 'echo this must never run');
      t.diagnostic(`start against the abandoned suite said: ${second.stdout.trim()}`);
      assert.notStrictEqual(second.status, 0, 'a start on top of an abandoned suite must not exit 0');
      assert.match(second.stdout, /REFUSED/, second.stdout);
      assert.match(second.stdout, new RegExp(`\\b${held.group}\\b`),
        `the refusal must name the group left behind\n${second.stdout}`);
      assert.match(second.stdout, /sleep 6/,
        `the refusal must name the command that group is running\n${second.stdout}`);

      // And refusing must not be a disguised way of clearing it.
      assert.strictEqual(groupRunning(held.group), true,
        'the refusal must leave the suite it found alone');
    } finally {
      teardown({ dir, pidFiles: [file] });
    }
  });
});

describe('a record left behind by a run that has ended', () => {
  test('AC-5: is cleared when its suite has gone, and refused while its suite is alive', async (t) => {
    // BOTH DIRECTIONS OF THE SAME DECISION, because each is a defect on its own.
    //
    // Refusing on a record whose run has ended turns the guard against piling on
    // load into an outage: a crashed or SIGKILLed run leaves a record, and every
    // later start in that repository is refused until somebody deletes the file
    // by hand. Clearing a record whose suite is still running does the opposite,
    // and puts a second suite on the machine beside the first.
    //
    // The record here is written by this test rather than by a run, because what
    // is under test is the reading of it and that needs control over exactly
    // which of the two named things is alive. The path where the tool writes the
    // record itself is covered by the test above.
    const dir = repo();
    const file = scratch('stale');
    const record = runRecordPath(dir);
    const holder = spawn('sh', ['-c', `sleep ${LONG}`], { detached: true, stdio: 'ignore' });
    holder.unref();
    let live = null;
    try {
      const gone = await deadGroup();
      await until(() => running(holder.pid), 5000);

      const write = (group) => fs.writeFileSync(record, JSON.stringify({
        pid: gone, group, tests: 'npm test', repo: dir,
        startedAt: new Date().toISOString(),
      }, null, 2) + '\n');

      // Alive: the owning run has gone but its suite has not.
      write(holder.pid);
      const refused = cli(dir, 'echo this must never run');
      t.diagnostic(`with the suite still alive: ${refused.stdout.trim()}`);
      assert.notStrictEqual(refused.status, 0, 'a live suite must still be refused');
      assert.match(refused.stdout, /REFUSED/, refused.stdout);
      assert.match(refused.stdout, new RegExp(`\\b${holder.pid}\\b`),
        `the refusal must name the group it found\n${refused.stdout}`);
      assert.strictEqual(running(holder.pid), true, 'and must leave it running');

      // Gone: both the run and its suite have ended, so the record says nothing.
      reap([holder.pid]);
      await until(() => !running(holder.pid), 5000);
      write(gone);
      assert.strictEqual(fs.existsSync(record), true, 'the stale record is in place');

      live = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main',
          '--tests', packageRunnerLeaving(file, { tail: 'sleep 3' })],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      live.stdout.on('data', (b) => { out += b.toString(); });
      const exited = new Promise(resolve => live.on('exit', resolve));

      // The stale record is not merely tolerated, it is taken over.
      const taken = await until(() => {
        const held = readRecord(record);
        return held !== null && Number(held.pid) === live.pid;
      }, 20000);
      t.diagnostic(`record during the run: ${JSON.stringify(readRecord(record))}`);
      assert.strictEqual(taken, true,
        'the stale record must be replaced by the run that cleared it');

      await exited;
      live = null;
      t.diagnostic(`start over a stale record said: ${out.trim().split('\n').pop()}`);
      assert.doesNotMatch(out, /REFUSED/,
        `a record whose run and suite have both gone must not refuse a start\n${out}`);
      assert.match(out, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/,
        `the start must reach an ordinary conclusion\n${out}`);
      assert.strictEqual(fs.existsSync(record), false,
        'and must give the claim back when it ends');
    } finally {
      if (live) live.kill('SIGKILL'); // particular to this test: the run may still be up
      teardown({ dir, pidFiles: [file], pids: [holder.pid] });
    }
  });
});

describe('two starts at once against one repository', () => {
  test('AC-5: exactly one runs and the other is refused, however close together they are', async (t) => {
    // The window the first version of the refusal left open. It read the record
    // at the top of the run and did not write one until three git commands
    // later, so two starts a few milliseconds apart both saw an empty machine
    // and both went on to revert the SAME working tree, checking files out from
    // under each other. Nothing about the tree can be put right afterwards by a
    // tool that does not know the other one is there.
    const dir = repo();
    const fileA = scratch('raceA');
    const fileB = scratch('raceB');
    try {
      const start = (file) => new Promise((resolve) => {
        const kid = spawn(process.execPath,
          [SCRIPT, '--repo', dir, '--base', 'main',
            '--tests', packageRunnerLeaving(file, { tail: 'sleep 3' })],
          { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        let err = '';
        kid.stdout.on('data', (b) => { out += b.toString(); });
        kid.stderr.on('data', (b) => { err += b.toString(); });
        kid.on('exit', (code) => resolve({ code, out, err }));
      });

      const [a, b] = await Promise.all([start(fileA), start(fileB)]);
      t.diagnostic(`first said:  ${a.out.trim().split('\n').pop()}`);
      t.diagnostic(`second said: ${b.out.trim().split('\n').pop()}`);

      const refused = [a, b].filter(x => /REFUSED: a run of this tool is still live/.test(x.out));
      const concluded = [a, b].filter(x => /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/.test(x.out));
      assert.strictEqual(refused.length, 1,
        `exactly one start must be refused\n${a.out}\n---\n${b.out}`);
      assert.strictEqual(concluded.length, 1,
        `exactly one start must reach a conclusion\n${a.out}\n---\n${b.out}`);

      const pids = pidsIn(fileA).concat(pidsIn(fileB));
      assert.deepStrictEqual(pids.filter(running), [],
        `neither start may leave a suite behind: ${pids.filter(running).join(', ')}`);
      assert.strictEqual(fs.existsSync(runRecordPath(dir)), false,
        'the claim must be given back once both have finished');
    } finally {
      teardown({ dir, pidFiles: [fileA, fileB] });
    }
  });
});

describe('cleanup reaches what this tool started, and stops there', () => {
  test('AC-8: a suite this tool did not start is left alone, and is still working afterwards', async (t) => {
    // The remedy that suggests itself for the leak above is a pattern kill
    // across the machine. That is how a neighbour's mutation harness was ended
    // mid-rewrite, and a harness killed that way skips the restore in its
    // `finally`, so one tool's orphan becomes another tool's silently broken
    // guard in a checkout whose owner saw neither event.
    //
    // THE FOREIGN SUITE IS CHECKED BY WHAT IT DOES, not by whether its pid can
    // still be signalled. Those are different questions and the difference is
    // not academic: this test was first written the second way, and a pattern
    // kill passed it. The process had been killed, but it was the test's own
    // child and had not been reaped, so it sat there defunct with a pid that
    // `kill(pid, 0)` still accepted. A liveness answer that a corpse satisfies
    // is exactly the proxy-for-the-property fault the reverting check exists to
    // catch, and it was in the test for the criterion that matters most here.
    //
    // So the foreign suite counts, out loud, into a file. A count that advances
    // after the tool has been and gone is a process still executing.
    //
    // Its command line also carries the same text as the tool's own leftovers,
    // so nothing can pass this by matching on a command line and calling the
    // match narrow.
    const dir = repo();
    const file = scratch('foreign');
    const beat = scratch('beat');
    const foreign = spawn('sh',
      ['-c', `n=0; while :; do n=$((n+1)); echo $n > ${beat}; sleep 0.2; done # sleep ${LONG}`],
      { detached: true, stdio: 'ignore' });
    foreign.unref();
    const beats = () => {
      try { return Number(fs.readFileSync(beat, 'utf8').trim()); } catch (e) { return 0; }
    };
    try {
      const ticking = await until(() => beats() > 0, 10000);
      assert.strictEqual(ticking, true, 'the foreign suite must be working to begin with');
      t.diagnostic(`foreign suite before: ${table([foreign.pid])} counted ${beats()}`);

      const r = cli(dir, packageRunnerLeaving(file));
      assert.match(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/,
        `the tool must have run\n${r.stdout}\n${r.stderr}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 2, `the tool must have left something of its own to clean up: ${pids}`);

      // Paired on purpose. Without the first assertion, cleanup that does
      // nothing at all passes this test; without the second, a pattern kill
      // passes it. Only cleanup scoped to what this tool started passes both.
      assert.deepStrictEqual(pids.filter(running), [],
        'the tool must really have cleaned up its own, or this proves nothing');
      noWarning(r.stderr, 'run beside a foreign suite');

      const before = beats();
      const advanced = await until(() => beats() > before, 10000);
      t.diagnostic(`foreign suite after: ${table([foreign.pid])} counted ${before} then ${beats()}`);
      assert.strictEqual(advanced, true,
        `the tool ended or stopped a process it never started (pid ${foreign.pid}); `
        + `its count stood still at ${before}`);
    } finally {
      teardown({ dir, pidFiles: [file], files: [beat], pids: [foreign.pid] });
    }
  });
});
