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

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// Beside `.precommit-gate.json` and `.release-gate.json` rather than inside
// `.rundock/`: this is the development tooling's own local state, and
// `.rundock/` is a product directory that happens to be gitignored. Ignored in
// .gitignore, which is not a tidiness point here: a record of a run that died
// mid-mutation must never itself become the thing `git add -A` sweeps up.
const MARKER = '.mutation-run.json';

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function markerPath(root) {
  return path.join(root, MARKER);
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
  const record = readMarker(root);
  if (record && record.unreadable) {
    return {
      ok: false,
      blocked: [],
      reason: 'unreadable-record',
      message: `Refusing to start a mutation run.\n\n`
        + `${markerPath(root)} exists but cannot be read as a record of a run.\n`
        + `It is written while a run holds files mutated, so an unreadable one is\n`
        + `not the same as no record at all. Check the files this harness mutates\n`
        + `against git, then delete ${MARKER} and run this again.`,
    };
  }
  if (record) {
    const held = Array.isArray(record.files) ? record.files : [];
    if (isAlive(record.pid)) {
      return {
        ok: false,
        blocked: [],
        reason: 'in-flight',
        message: `Refusing to start a mutation run.\n\n`
          + `Another mutation run is already in flight (pid ${record.pid}, started `
          + `${record.startedAt}).\nIt is holding these files mutated:\n${list(held)}\n\n`
          + `Two runs over the same files cannot both restore correctly: the second\n`
          + `reads the first one's mutation and would put that back as the original.\n`
          + `Wait for it to finish, or stop it, then run this again.`,
      };
    }
    return {
      ok: false,
      blocked: held,
      reason: 'abandoned',
      message: `Refusing to start a mutation run.\n\n`
        + `A previous mutation run (pid ${record.pid}, started ${record.startedAt}) `
        + `never finished.\nIt was mutating these files, and they may still hold a `
        + `mutation rather than\nthe source you wrote:\n${list(held)}\n\n`
        + `Check them:            git diff HEAD -- ${held.join(' ')}\n`
        + `Put one back:          git checkout HEAD -- <file>\n`
        + `Then clear the record: rm ${MARKER}`,
    };
  }

  const blocked = unstaged(root, files);
  if (blocked === null) {
    return {
      ok: true,
      blocked: [],
      reason: 'unchecked',
      // Said out loud rather than assumed either way. Refusing here would make
      // the harnesses unrunnable from an archive download, and staying silent
      // would let a rail nobody has quietly go missing.
      note: 'note: the working tree could not be checked (no git, or not a checkout), '
        + 'so this run started without the check that a file it mutates is not already modified.',
    };
  }
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      reason: 'unstaged',
      message: `Refusing to start a mutation run.\n\n`
        + `These files have unstaged changes, and this run mutates them in place:\n`
        + `${list(blocked)}\n\n`
        + `If the run is killed before it restores, the mutation and your edit are\n`
        + `the same thing in the working tree, and the way back from a mutation\n`
        + `(git checkout -- <file>) is also the way to throw your edit away.\n\n`
        + `Stage them (git add), commit them, or stash them, then run this again.\n`
        + `Staged is enough: the index holds the copy a restore comes back to.`,
    };
  }
  return { ok: true, blocked: [], reason: 'clean' };
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
function beginMutationRun({ root = ROOT, files = [] } = {}) {
  const verdict = inspect({ root, files });
  if (!verdict.ok) {
    console.error(verdict.message);
    process.exit(2);
  }
  if (verdict.note) console.error(verdict.note);

  const originals = new Map();
  for (const file of files) originals.set(file, fs.readFileSync(file, 'utf8'));

  const record = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    tool: path.basename(process.argv[1] || 'unknown'),
    files: files.map((f) => relative(root, f)),
  };
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

module.exports = { beginMutationRun, inspect, markerPath, MARKER, ROOT };
