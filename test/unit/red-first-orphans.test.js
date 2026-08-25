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
// case below and the run is recorded in .review/red-first-orphans-evidence.md.
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
// THE SECOND EDGE, which is why the last test here is not optional. The obvious
// remedy for a leak like this is a pattern kill across the machine, and that
// reaches processes this tool never started. `a suite this tool did not start
// is left alone, and is still working afterwards` fails if the cleanup ever
// widens that far, and it is paired with an assertion that the tool's OWN
// leftovers really did go, so that doing nothing at all cannot pass it either.
// It asks whether the foreign suite is still WORKING rather than whether its
// pid can still be signalled, for a reason its own comment gives at length.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const { redFirst, runRecordPath } = require('../../scripts/red-first.js');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'red-first.js');

// How long the stand-in suites below sleep for. Deliberately an odd number of
// seconds rather than a round one: reproducing the `AC-8` measurement by hand
// means matching these processes on their command line, and a round duration
// would match a stranger's sleep on a shared machine as well as this file's.
const LONG = 600000 + (process.pid % 997);

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

// Where a run leaves the pids it started, OUTSIDE the repository, because
// anything written inside it dirties the tree the tool is about to check.
function pidFile(name) {
  return path.join(os.tmpdir(), `red-first-orphans-${name}-${process.pid}-${Date.now()}.pids`);
}

function pidsIn(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return false; } };

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, ms = 5000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(50);
  }
  return predicate();
}

// The process table for a set of pids, when this machine will give one. Under a
// command sandbox that blocks spawning, `ps` is unavailable and the liveness
// answer below is the whole record. Liveness is what every assertion here uses;
// the table is printed alongside it so a reader of a run has the same view the
// measurements were taken from.
function table(pids) {
  const live = pids.map(p => `${p}=${alive(p) ? 'alive' : 'gone'}`).join(' ');
  if (!pids.length) return '(no pids recorded)';
  try {
    const out = execFileSync('ps', ['-o', 'pid,ppid,pgid,command', '-p', pids.join(',')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `${live}\n${out}`;
  } catch (e) {
    return `${live} (no process table: ps is unavailable here)`;
  }
}

// A test command shaped like a package runner: it starts a child of its own,
// detaches that child's stdio so the runner is not held open by it, and then
// finishes. The child stays in the runner's process group, which is what makes
// this the case AC-4 names: ending the direct child alone leaves the child of
// the child running.
//
// `$!` is the background child, `$$` the shell itself. Both are recorded so a
// failure can say which of the two survived.
function packageRunnerLeaving(file, tail = 'exit 0') {
  return `sleep ${LONG} >/dev/null 2>&1 & echo $! >> ${JSON.stringify(file)}; `
    + `echo $$ >> ${JSON.stringify(file)}; ${tail}`;
}

// Nothing here may end a process it did not start, including in its own
// cleanup, so every teardown signals only the pids this file recorded.
function reap(pids) {
  for (const pid of pids) {
    try { process.kill(-pid, 'SIGKILL'); } catch (e) { /* not a group leader */ }
    try { process.kill(pid, 'SIGKILL'); } catch (e) { /* already gone */ }
  }
}

function cli(dir, tests) {
  return spawnSync(process.execPath,
    [SCRIPT, '--repo', dir, '--base', 'main', '--tests', tests], { encoding: 'utf8' });
}

describe('no suite outlives the tool', () => {
  test('AC-1, AC-4, AC-7: a normal exit leaves no suite running, including the runner\'s own child', async (t) => {
    const dir = repo();
    const file = pidFile('normal');
    try {
      const r = cli(dir, packageRunnerLeaving(file));
      // The run really did complete rather than dying early, or the absence of
      // survivors would prove nothing about a normal exit.
      assert.match(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|INCONCLUSIVE)/,
        `the tool must have reached a conclusion\n${r.stdout}\n${r.stderr}`);

      const pids = pidsIn(file);
      // Two runs, each leaving a background child and a shell.
      assert.ok(pids.length >= 2, `the runner must have started something to leave behind: ${pids}`);
      t.diagnostic(`immediately after the tool exited:\n${table(pids)}`);

      await until(() => pids.every(p => !alive(p)));
      const survivors = pids.filter(alive);
      t.diagnostic(`after settling:\n${table(pids)}`);
      assert.deepStrictEqual(survivors, [],
        `a normal exit left ${survivors.length} process(es) running: ${survivors.join(', ')}`);

      // The record of a run that has finished must go with it. Left behind, it
      // names a pid that is gone, and the refusal at the top of the tool would
      // turn every later start in this repository into a refusal until somebody
      // deleted the file by hand. The guard against piling on load must not
      // become an outage of its own.
      assert.strictEqual(fs.existsSync(runRecordPath(dir)), false,
        `a finished run left its record at ${runRecordPath(dir)}`);
    } finally {
      reap(pidsIn(file));
      fs.rmSync(file, { force: true });
      fs.rmSync(runRecordPath(dir), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-2: an error exit leaves no suite running', async (t) => {
    const dir = repo();
    const file = pidFile('error');
    try {
      // The runner destroys the repository's git directory once it has started
      // its background child, so the restore that follows throws and the tool
      // leaves by its error path rather than by returning an outcome. This is
      // the exit nobody thinks to check, which is why it is driven here rather
      // than reasoned about.
      const r = cli(dir, packageRunnerLeaving(file, 'rm -rf .git; exit 0'));
      assert.notStrictEqual(r.status, 0, 'the tool must have failed');
      assert.doesNotMatch(r.stdout, /\[red-first\] (PROVEN|NOT-DISCRIMINATING|REFUSED)/,
        `the tool must have crashed rather than concluded\n${r.stdout}`);

      const pids = pidsIn(file);
      assert.ok(pids.length >= 1, `the runner must have started something to leave behind: ${pids}`);
      t.diagnostic(`immediately after the tool exited:\n${table(pids)}`);

      await until(() => pids.every(p => !alive(p)));
      const survivors = pids.filter(alive);
      t.diagnostic(`after settling:\n${table(pids)}`);
      assert.deepStrictEqual(survivors, [],
        `an error exit left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
    } finally {
      reap(pidsIn(file));
      fs.rmSync(file, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('AC-3: a signal during the FIRST run leaves no suite running', async (t) => {
    // The first run is the longest window the tool has and it was the one with
    // no handler at all: the listeners went on after it, so a signal arriving
    // while the first suite ran took Node's default handling, which terminates
    // without unwinding and abandons a detached process group.
    const dir = repo();
    const file = pidFile('signal');
    let pids = [];
    try {
      const kid = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main', '--tests', packageRunnerLeaving(file, 'sleep 30')],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const exited = new Promise(resolve => kid.on('exit', (code, signal) => resolve({ code, signal })));

      const started = await until(() => pidsIn(file).length >= 2, 15000);
      assert.strictEqual(started, true, 'the first run must be in flight before it is signalled');
      pids = pidsIn(file);
      t.diagnostic(`with the first run in flight:\n${table(pids)}`);

      kid.kill('SIGTERM');
      const how = await exited;
      t.diagnostic(`the tool exited with code ${how.code} signal ${how.signal}`);

      await until(() => pids.every(p => !alive(p)));
      const survivors = pids.filter(alive);
      t.diagnostic(`after the tool exited:\n${table(pids)}`);
      assert.deepStrictEqual(survivors, [],
        `a signal during the first run left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
    } finally {
      reap(pids.concat(pidsIn(file)));
      fs.rmSync(file, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
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
    const file = pidFile('inflight');
    let pids = [];
    try {
      const driver = `
        const { redFirst } = require(${JSON.stringify(SCRIPT)});
        redFirst({ repo: ${JSON.stringify(dir)}, base: 'main',
                   tests: ${JSON.stringify(packageRunnerLeaving(file, 'sleep 30'))} })
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
      t.diagnostic(`immediately after the exit:\n${table(pids)}`);

      await until(() => pids.every(p => !alive(p)));
      const survivors = pids.filter(alive);
      t.diagnostic(`after settling:\n${table(pids)}`);
      assert.deepStrictEqual(survivors, [],
        `an exit taken mid-run left ${survivors.length} process(es) running: ${survivors.join(', ')}`);
    } finally {
      reap(pids.concat(pidsIn(file)));
      fs.rmSync(file, { force: true });
      fs.rmSync(runRecordPath(dir), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('starting on top of a run that is still going', () => {
  test('AC-5, AC-6: a second start is refused, and the refusal names the run it found', async (t) => {
    // Driven end to end against a real first run rather than a hand-written
    // record, because a hand-written one only proves the reader can read the
    // test's idea of a record.
    const dir = repo();
    const file = pidFile('refuse');
    let first = null;
    let pids = [];
    try {
      first = spawn(process.execPath,
        [SCRIPT, '--repo', dir, '--base', 'main', '--tests', packageRunnerLeaving(file, 'sleep 25')],
        { stdio: ['ignore', 'pipe', 'pipe'] });
      const firstExited = new Promise(resolve => first.on('exit', resolve));

      const started = await until(() => pidsIn(file).length >= 2, 15000);
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
      assert.strictEqual(alive(written.group), true,
        'the refusal must not end the run it found');

      first.kill('SIGTERM');
      await firstExited;
      first = null;
      await until(() => pids.every(p => !alive(p)));
      assert.strictEqual(fs.existsSync(record), false,
        'the record must not outlive the run it describes, or every later start is refused');
    } finally {
      if (first) first.kill('SIGKILL');
      reap(pids.concat(pidsIn(file)));
      fs.rmSync(file, { force: true });
      fs.rmSync(runRecordPath(dir), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  test('AC-5: a run that has not spawned its suite yet is live too', async (t) => {
    // The gap between a run starting and its first suite existing. A start made
    // in that gap has no group to find, and letting it through would put two
    // reverters on one working tree, each checking files out from under the
    // other. Covered here rather than by racing two real runs, because the gap
    // is a few milliseconds wide and a test that has to hit it would be a flake
    // rather than a check.
    //
    // The record is written by hand, and the thing under test is the reader of
    // it. The process it names is a real live one, so the liveness answer is
    // measured rather than stubbed.
    const dir = repo();
    const holder = spawn('sh', ['-c', `sleep ${LONG}`], { detached: true, stdio: 'ignore' });
    holder.unref();
    try {
      await until(() => alive(holder.pid));
      fs.writeFileSync(runRecordPath(dir), JSON.stringify({
        pid: holder.pid, group: null, tests: 'npm test',
        repo: dir, startedAt: new Date().toISOString(),
      }));

      const r = await redFirst({ repo: dir, base: 'main', tests: 'true' });
      t.diagnostic(`outcome: ${r.outcome}: ${r.reason}`);
      assert.strictEqual(r.outcome, 'refused', r.reason);
      assert.match(r.reason, new RegExp(`\\b${holder.pid}\\b`),
        'the refusal must name the run it found even with no suite under it');
      assert.match(r.reason, /no suite under it yet/, r.reason);
    } finally {
      reap([holder.pid]);
      fs.rmSync(runRecordPath(dir), { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
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
    const file = pidFile('foreign');
    const beat = path.join(os.tmpdir(), `red-first-orphans-beat-${process.pid}-${Date.now()}`);
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
      await until(() => pids.every(p => !alive(p)));
      assert.deepStrictEqual(pids.filter(alive), [],
        'the tool must really have cleaned up its own, or this proves nothing');

      const before = beats();
      const advanced = await until(() => beats() > before, 10000);
      t.diagnostic(`foreign suite after: ${table([foreign.pid])} counted ${before} then ${beats()}`);
      assert.strictEqual(advanced, true,
        `the tool ended or stopped a process it never started (pid ${foreign.pid}); `
        + `its count stood still at ${before}`);
    } finally {
      reap(pidsIn(file));
      reap([foreign.pid]);
      fs.rmSync(file, { force: true });
      fs.rmSync(beat, { force: true });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
