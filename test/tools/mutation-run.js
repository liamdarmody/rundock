'use strict';
// The safety envelope every mutation harness runs inside.
//
// WHAT A MUTATION HARNESS DOES, and why it needs one. Each harness under this
// directory breaks a real source file on purpose, runs a suite, and puts the
// file back. Every one of them did that with a `finally`, which covers a
// return and a throw and nothing else. These runs are the slowest step in the
// pre-commit gate, so they are the code here most likely to meet a timeout, an
// interrupt or a machine going to sleep, and a process killed that way never
// unwinds. A run cut short left a mutated source file on disk in a piece of
// work that never touched that file, and the next gate run failed on an
// unrelated test, reading as if the current change had broken something.
//
// The expensive part is not the confusing failure. A mutated source file is an
// ordinary working-tree modification: `git add -A` stages it without comment,
// and staging everything before running the gate is exactly what this project
// tells people to do, so a file nobody edited can ride into somebody else's
// commit.
//
// WHAT THIS ADDS, in the order the failures happen.
//
// 1. A restore on the ways out that do not unwind. Handlers for SIGINT,
//    SIGTERM and SIGHUP put every file back and then re-raise the signal, and
//    an 'exit' listener covers an exit taken from somewhere else in the
//    process while a mutation is applied.
//
// 2. A refusal to start where the restore would be ambiguous. This rewrites
//    tracked files, so it must be able to tell its own edit from somebody
//    else's.
//
// 3. A record of the run while it is in flight, because the one way out that
//    cannot be handled is the one that matters most. SIGKILL is delivered to
//    nothing. The mutation survives it, and without the record the only
//    evidence is a source file that quietly says something different from what
//    its author wrote. With it, the next run stops and names the file.
//
// WHY THE REFUSAL IS ABOUT UNSTAGED CHANGES AND NOT ABOUT A DIRTY TREE. The
// harnesses restore from bytes they read at the start, so a file that already
// carried changes is restored correctly on every path that runs at all. The
// ambiguity is entirely about what happens after a run dies: a mutated file in
// the working tree looks like an edit, and the way back from it, `git checkout
// -- <file>`, is also the way to destroy an edit. A file whose changes are
// STAGED is safe from that, because the index holds a copy that the checkout
// restores rather than discards. An unstaged edit has no such copy, so that is
// where the line is drawn. It has to be drawn there for a second reason: the
// pre-commit gate stages everything and then runs these harnesses, so refusing
// on any modification at all would refuse every change that touches a file a
// harness mutates, which is most of them.
//
// WHAT A CLEAN TREE DOES NOT PROVE, stated here because this is the check a
// reader will trust. A residue scan asks whether the tree matches HEAD. Work
// that was never committed and then erased produces a clean tree,
// indistinguishable from a tree that was never touched: the scan cannot tell
// untouched from erased, and it once reported clean over a builder's
// destroyed, uncommitted implementation. That blindness is structural, not a
// bug to fix here, and it is the whole reason the refusal above exists: the
// only defence for uncommitted work is to refuse before anything destructive
// starts, because afterwards there is nothing left to detect.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// Beside `.precommit-gate.json` and `.release-gate.json` rather than inside
// `.rundock/`: this is the development tooling's own local state, and
// `.rundock/` is a product directory that happens to be gitignored. Ignored in
// .gitignore, which is not a tidiness point here: a record of a run that died
// mid-mutation must never itself become the thing `git add -A` sweeps up.
// ONE RECORD PER RUN, not one for the whole repository.
//
// A single shared marker made concurrency impossible: two runs would overwrite
// each other's record, and that record is what recovers a source file from a run
// which died holding it mutated. So the tool refused to start while any other
// was in flight, whatever the two were touching, and eighteen harnesses ran one
// after another. Measured on the gate this serves: mutation is 93% of a run.
//
// Per-run records make the refusal precise rather than blanket. Two runs that
// mutate DIFFERENT files cannot corrupt each other's restore, so they may run
// together; two that would hold the same file must not, and only those are
// refused now. The directory is swept of dead runs on every start, so an
// abandoned record cannot accumulate into a permanent refusal.
const MARKER_DIR = '.mutation-runs';
// The name the gate cleans up after a run it started.
const MARKER = MARKER_DIR;

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function markerDir(root) {
  return path.join(root, MARKER_DIR);
}

function markerPath(root, pid = process.pid) {
  return path.join(markerDir(root), `${pid}.json`);
}

/** Every run's record, live or abandoned, with unreadable ones surfaced. */
function readMarkers(root) {
  let names = [];
  try { names = fs.readdirSync(markerDir(root)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(markerDir(root), name);
    let record;
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { out.push({ file, unreadable: true }); continue; }
    if (!record || typeof record.pid !== 'number') { out.push({ file, unreadable: true }); continue; }
    out.push({ ...record, file });
  }
  return out;
}

/**
 * Put back the files an abandoned run left mutated, from the git INDEX.
 *
 * SIGKILL cannot be caught, so the handlers below are not the whole answer and
 * never can be: a run killed outright leaves a mutant on disk and a record
 * naming it. Measured three times in one session, once on a release gate where
 * the survivor stripped the tier tags off a permission card. The dangerous part
 * is not the mutant, it is that the next `git add -A` commits it.
 *
 * THE INDEX IS THE RIGHT SOURCE, and it is safe precisely because of the check
 * this tool already makes: a run refuses to start while a file it mutates has
 * unstaged changes, so every held file was identical to its staged copy when the
 * run began. Restoring from the index therefore returns the author's own work,
 * not an older commit's. Restoring from HEAD would discard staged work, which is
 * why it is not what happens here.
 *
 * Returns the files put back, or null when the restore could not be done, in
 * which case the caller falls back to telling a person what to run by hand.
 */
function recoverAbandoned(root, held) {
  if (!held.length) return [];
  const present = held.filter((f) => { try { return fs.existsSync(path.resolve(root, f)); } catch { return false; } });
  if (!present.length) return null;
  const out = spawnSync('git', ['checkout', '--', ...held], { cwd: root, encoding: 'utf8' });
  if (out.error || out.status !== 0) return null;
  return held;
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists and belongs to another user, which is a
    // running process this must not step over.
    return err.code === 'EPERM';
  }
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * Which of `files` differ between the working tree and the index.
 *
 * Two questions rather than one parse of `git status`. `git diff --name-only`
 * is exactly "working tree against index", including deletions, and
 * `ls-files --others` catches a target that is not tracked at all, which has
 * no index copy to come back to either. Reading the XY columns of a porcelain
 * status would answer the same question through a format with quoting and
 * rename pairs in it, for nothing.
 *
 * Returns null where the question cannot be asked: no git on the machine, or a
 * source tree that is not a checkout. Both are real ways to have this source.
 */
function unstaged(root, files) {
  const wanted = new Set(files.map((f) => relative(root, f)));
  const paths = [...wanted];
  let out;
  try {
    out = git(root, ['diff', '--name-only', '--relative', '--', ...paths])
      + git(root, ['ls-files', '--others', '--exclude-standard', '--', ...paths]);
  } catch {
    return null;
  }
  const dirty = out.split('\n').map((l) => l.trim()).filter(Boolean);
  // Intersected with what was asked about, so nothing this run does not touch
  // can ever end up in a refusal that names files.
  return [...new Set(dirty.filter((p) => wanted.has(p)))];
}

function readMarker(root) {
  let text;
  try {
    text = fs.readFileSync(markerPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(text);
    if (!record || typeof record.pid !== 'number') throw new Error('no pid');
    return record;
  } catch {
    return { unreadable: true };
  }
}

function list(items) {
  return items.map((f) => `  ${f}`).join('\n');
}

/**
 * May a run start here, and if not, what does the person looking at a stopped
 * tool need to be told?
 *
 * Separate from the arming below so the decision can be exercised directly.
 * Every refusal names files rather than counting them: the reader is looking
 * at a tool that stopped and nothing else, and a refusal that does not say
 * which file is at stake has moved the mystery rather than removed it.
 */
function inspect({ root = ROOT, files = [] } = {}) {
  const wanted = new Set(files.map((f) => relative(root, f)));
  const records = readMarkers(root);

  // An unreadable record may still describe a run holding files, so it is never
  // swept and never reasoned past.
  const unreadable = records.filter((r) => r.unreadable);
  if (unreadable.length) {
    return {
      ok: false,
      blocked: [],
      reason: 'unreadable-record',
      message: 'Refusing to start a mutation run.\n\n'
        + unreadable.map((r) => r.file).join('\n') + '\n'
        + 'exists but cannot be read as a record of a run. A record is written while a\n'
        + 'run holds files mutated, so an unreadable one is not the same as none.\n'
        + 'Check the files this harness mutates against git, then delete it and run again.',
    };
  }

  // A LIVE run blocks only an OVERLAPPING one. Two runs mutating different files
  // cannot corrupt each other's restore, and refusing them regardless is what
  // made this step serial.
  for (const r of records.filter((x) => x.pid !== process.pid && isAlive(x.pid))) {
    const held = Array.isArray(r.files) ? r.files : [];
    const clash = held.filter((f) => wanted.has(f));
    if (clash.length) {
      return {
        ok: false,
        blocked: clash,
        reason: 'in-flight',
        message: 'Refusing to start a mutation run.\n\n'
          + 'Another run (pid ' + r.pid + ', started ' + r.startedAt + ') is holding these\n'
          + 'files mutated, and this run would mutate them too:\n' + list(clash) + '\n\n'
          + 'Two runs over the same file cannot both restore correctly: the second reads\n'
          + "the first one's mutation and would put that back as the original.\n"
          + 'Wait for it, or stop it, then run this again.',
      };
    }
  }

  // Abandoned runs are SWEPT, not reported. The files are known, the copy to put
  // back is known, and the run that held them is gone, so asking a person to run
  // three commands only means the mutation sits on disk until they do, and what
  // happens in between is `git add -A`.
  const swept = [];
  for (const r of records.filter((x) => x.pid !== process.pid && !isAlive(x.pid))) {
    const held = Array.isArray(r.files) ? r.files : [];
    const put = held.length ? recoverAbandoned(root, held) : [];
    if (put === null) {
      return {
        ok: false,
        blocked: held,
        reason: 'abandoned',
        message: 'Refusing to start a mutation run.\n\n'
          + 'A previous run (pid ' + r.pid + ', started ' + r.startedAt + ') never finished,\n'
          + 'and its files could not be put back automatically:\n' + list(held) + '\n\n'
          + 'Check them:            git diff HEAD -- ' + held.join(' ') + '\n'
          + 'Put one back:          git checkout HEAD -- <file>\n'
          + 'Then clear the record: rm ' + r.file,
      };
    }
    swept.push({ pid: r.pid, files: put });
    try { fs.rmSync(r.file, { force: true }); } catch { /* the next start will say */ }
  }

  const blocked = unstaged(root, files);
  if (blocked === null) {
    return {
      ok: true,
      blocked: [],
      swept,
      reason: 'unchecked',
      note: 'note: the working tree could not be checked (no git, or not a checkout), '
        + 'so this run started without the check that a file it mutates is not already modified.',
    };
  }
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      swept,
      reason: 'unstaged',
      message: 'Refusing to start a mutation run.\n\n'
        + 'These files have unstaged changes, and this run mutates them in place:\n'
        + list(blocked) + '\n\n'
        + 'If the run is killed before it restores, the mutation and your edit are\n'
        + 'the same thing in the working tree, and the way back from a mutation\n'
        + '(git checkout -- <file>) is also the way to throw your edit away.\n\n'
        + 'Stage them (git add), commit them, or stash them, then run this again.\n'
        + 'Staged is enough: the index holds the copy a restore comes back to.',
    };
  }
  return { ok: true, blocked: [], swept, reason: 'clean' };
}

/**
 * Arm the envelope and hand back the originals.
 *
 * The originals are read HERE rather than by the caller, so what the restore
 * puts back is by construction what the check above was made against. A
 * harness that read its own copy could be restoring from bytes taken before
 * the refusal had a chance to run.
 *
 * A refusal ends the process rather than throwing. It is the same contract as
 * the temp-root preflight each harness already runs, and it means a harness
 * cannot forget to act on the verdict.
 */
/**
 * Run each suite once, unmutated, and require it to pass.
 *
 * WITHOUT THIS, A DEAD HARNESS AND A CLEAN ONE READ THE SAME. The report says,
 * for each guard removed, which tests went red. If a suite cannot load at all,
 * every mutation "turns tests red" for reasons that have nothing to do with the
 * mutation, and the run reports a full table over machinery that never ran.
 *
 * Measured on 2026-09-09: the eighteen harnesses were timed in a worktree with no
 * node_modules. Every suite needing a dependency exited immediately, all
 * eighteen ran to completion, and the reported total was 88 seconds against a
 * real cost of 1628. That number was believed, acted on, and produced a wrong
 * decision about where mutation should run.
 *
 * The env is scrubbed for the same reason preflight scrubs it: a nested
 * `node --test` inherits NODE_TEST_CONTEXT from the runner that spawned it and
 * misreports its own results.
 */
function baselineGreen(root, suites) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  for (const suite of suites) {
    const r = spawnSync(process.execPath, ['--test', suite], { cwd: root, encoding: 'utf8', env });
    if (r.status !== 0) {
      // EXIT BEFORE ANY MUTATION, AND BEFORE ANY TABLE. A failed baseline must
      // never reach the report: a table printed after this point would be read
      // as verdicts, which is the exact confusion this exists to end.
      console.error(
        `mutation run REFUSED: ${suite} does not pass before anything is mutated, so no verdict `
        + 'from this harness would mean anything. NO MUTATION WAS APPLIED and no results are '
        + 'reported.\nFix the suite, or the environment it needs, and run again.\n'
        + `Check it:  node --test ${suite}`);
      process.exit(3);
    }
  }
}

function beginMutationRun({ root = ROOT, files: declared = [], suites: declaredSuites = [] } = {}) {
  // Deduplicated, because a harness names one target per guard and several
  // guards of the same file are ordinary. Left in, the same path would be read
  // twice, restored twice, and listed twice in a refusal that is supposed to be
  // read by a person.
  const files = [...new Set(declared)];
  const verdict = inspect({ root, files });
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(2);
  }
  if (verdict.note) console.error(verdict.note);
  // ANNOUNCED, ALWAYS. A tool that quietly rewrites source is worse than the
  // problem it is fixing, so a sweep names every run it cleaned up and every
  // file it put back.
  for (const s2 of verdict.swept || []) {
    console.error(`A previous mutation run (pid ${s2.pid}) never finished. Its files have been put `
      + `back from the index:\n${list(s2.files)}`);
  }

  // BEFORE THE ORIGINALS ARE READ, and so before any mutation can be written.
  // Deduplicated: a harness names one suite per target and several targets
  // sharing a suite is ordinary, so the cost is bounded by the number of
  // DISTINCT suites rather than by the number of guards.
  if (declaredSuites.length) baselineGreen(root, [...new Set(declaredSuites)]);

  const originals = new Map();
  for (const file of files) originals.set(file, fs.readFileSync(file, 'utf8'));

  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    tool: path.basename(process.argv[1] || 'unknown'),
    files: files.map((f) => relative(root, f)),
  };
  fs.mkdirSync(markerDir(root), { recursive: true });
  fs.writeFileSync(markerPath(root), `${JSON.stringify(record, null, 2)}\n`);

  let released = false;
  const restoreAll = () => {
    if (released) return;
    released = true;
    for (const [file, text] of originals) {
      try {
        fs.writeFileSync(file, text);
      } catch (e) {
        // Say which file, and keep going. One unwritable path must not leave
        // the rest of them mutated, and this is often running on the way out.
        console.error(`could not restore ${file}: ${e.message}`);
      }
    }
    // ONLY THIS RUN'S RECORD. Removing the directory would delete the records
    // of runs still holding files mutated, which is the corruption per-run
    // records exist to prevent.
    try { fs.rmSync(markerPath(root), { force: true }); } catch { /* leaving anyway */ }
  };

  const onExit = () => restoreAll();
  const onSignal = (signal) => {
    restoreAll();
    detach();
    // Re-raised rather than turned into an exit code. A caller reading the wait
    // status sees a process that died of the signal it sent, which is what a
    // shell, a test runner and a CI job all key off. Exiting 0 here would tell
    // whatever drove this run that it had succeeded; exiting with a fixed code
    // would be right for one signal and wrong for the others.
    //
    // Only where nothing else is listening, which is the rule the fixture
    // remover in test/helpers/workspace.js already follows for the same reason:
    // dying now would skip another module's tidying, and that is the same class
    // of bug as the one this file exists to fix.
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  function detach() {
    process.removeListener('exit', onExit);
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  }
  process.on('exit', onExit);
  for (const signal of SIGNALS) process.on(signal, onSignal);

  const session = {
    original(file) {
      if (!originals.has(file)) {
        throw new Error(`${file} was not declared to beginMutationRun, so nothing will restore it`);
      }
      return originals.get(file);
    },
    restoreAll,
    finish() {
      restoreAll();
      detach();
    },
  };

  // Arm and stop, so the test that proves a harness runs this does not have to
  // let the harness loose to prove it. Without the flag the only way to observe
  // a MISSING envelope is to watch a harness start mutating and then kill it,
  // which is the exact act that leaves a source file mutated in the working
  // tree. Read AFTER arming, so a harness that has lost its call never reaches
  // this and fails that test rather than passing it.
  if (process.argv.includes('--guard-only')) {
    console.error(`mutation run armed over ${files.length} file(s):\n${list(record.files)}`);
    session.finish();
    process.exit(0);
  }

  return session;
}

module.exports = { beginMutationRun, baselineGreen, inspect, markerPath, markerDir, readMarkers, recoverAbandoned, MARKER, MARKER_DIR, ROOT };
