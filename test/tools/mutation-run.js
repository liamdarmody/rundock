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
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

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
 * WHAT IS ON DISK IS KEPT FIRST. To git, the mutation being undone and an
 * edit a person made after the run died are the same kind of change, and a
 * restore from the index wipes both. So every held file that differs from the
 * index is copied under `<record dir>/recovered/<pid>-<time>-<suffix>/` before
 * it is put back: named for the time as well as the pid, because a pid is
 * reused, and a later sweep must never overwrite a copy kept earlier.
 *
 * Returns `{ files, kept }`, the files put back and the folder holding the
 * copies (null when nothing differed), or null when the restore could not be
 * done, in which case the caller falls back to telling a person what to run.
 */
function recoverAbandoned(root, held, pid) {
  if (!held.length) return { files: [], kept: null };
  const present = held.filter((f) => { try { return fs.existsSync(path.resolve(root, f)); } catch { return false; } });
  if (!present.length) return null;
  const differing = unstaged(root, present.map((f) => path.resolve(root, f)));
  if (differing === null) return null;
  let keptDir = null;
  try {
    if (differing.length) {
      const stamp = new Date().toISOString().replace(/[-:.]/g, '');
      fs.mkdirSync(path.join(markerDir(root), 'recovered'), { recursive: true });
      keptDir = fs.mkdtempSync(path.join(markerDir(root), 'recovered', `${pid}-${stamp}-`));
    }
    for (const f of differing) {
      const kept = path.join(keptDir, f);
      fs.mkdirSync(path.dirname(kept), { recursive: true });
      fs.copyFileSync(path.resolve(root, f), kept);
    }
  } catch { return null; }
  const out = spawnSync('git', ['checkout', '--', ...held], { cwd: root, encoding: 'utf8' });
  if (out.error || out.status !== 0) return null;
  return { files: held, kept: keptDir && relative(root, keptDir) };
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

/** The one-line refusal for files a run would mutate that carry unstaged changes. */
function unstagedRefusal(prefix, files) {
  const them = files.length === 1 ? 'it' : 'them';
  return `${prefix}: ${files.join(', ')} ${files.length === 1 ? 'has' : 'have'} unstaged changes and `
    + `would be mutated in place; commit or stage ${them} first (git add), then run again.`;
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
    const put = recoverAbandoned(root, held, r.pid);
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
    swept.push({ pid: r.pid, files: put.files, kept: put.kept });
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
  // ONE LINE, because the reader is looking at a tool that stopped. The
  // reason it matters: if a run dies before it restores, the mutation and the
  // edit are one change in the working tree, and the way back from a mutation
  // (git checkout -- <file>) also throws the edit away. Staged is enough: the
  // index then holds the copy a restore comes back to.
  if (blocked.length) {
    return {
      ok: false,
      blocked,
      swept,
      reason: 'unstaged',
      message: unstagedRefusal('Refusing to start a mutation run', blocked),
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
function beginMutationRun({ root = ROOT, files: declared = [], suites = [] } = {}) {
  // Asked before anything is read or recorded: a run whose suites would skip
  // has no verdict to give, so it is not started.
  const fixture = fixtureRootProblem(suites, { root });
  if (fixture) {
    console.error(`Refusing to start a mutation run: ${fixture}`);
    process.exit(NO_VERDICT);
  }
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
      + 'back from the index'
      + (s2.kept ? `, and what they held before is kept in ${s2.kept}/ (compare, keep what is yours, then delete it)` : '')
      + `:\n${list(s2.files)}`);
  }

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
    const usable = fixture === null && suites.some((suite) => readsFixture(root, suite))
      ? ', and the Code-mode fixture folder is usable' : '';
    console.error(`mutation run armed over ${files.length} file(s)${usable}:\n${list(record.files)}`);
    session.finish();
    process.exit(0);
  }

  return session;
}

/** Does this suite build its fixture with the Code-mode fixture helper? */
function readsFixture(root, suite) {
  try { return fs.readFileSync(path.resolve(root, suiteFile(suite)), 'utf8').includes('code-mode-fixture'); } catch { return false; }
}

/**
 * Why the suites a run reads would skip for want of a fixture folder, as one
 * line, or null when none of them needs one or the folder is usable.
 *
 * WITHOUT THE FOLDER THOSE SUITES SKIP, a skipped suite turns nothing red, and
 * every row aimed at one reads as a guard nobody watches. That was diagnosed
 * afresh on each first run. The folder is probed the way the suites probe it,
 * and the probe removed; under CI the helper throws, which is the same answer.
 */
function fixtureRootProblem(suites, { root = ROOT, env = process.env, candidates } = {}) {
  if (!suites.some((suite) => readsFixture(root, suite))) return null;
  const { outsideTempRoot, NO_ROOT } = require('../helpers/code-mode-fixture.js');
  let probe;
  try { probe = outsideTempRoot({ env, candidates, quiet: true }); } catch { probe = { skip: NO_ROOT }; }
  if (probe.skip) {
    return `the Code-mode suites it reads would skip and their rows would turn nothing red; the fixture ${NO_ROOT}.`;
  }
  fs.rmSync(probe.dir, { recursive: true, force: true });
  return null;
}

// THREE OUTCOMES, NOT TWO. A harness exits 0 when every guard it broke turned
// a test red, 1 when one did not (or a row was ambiguous or its text was
// missing), and NO_VERDICT when it could not find out: a suite whose output
// could not be read, or a temp root it refused to run on. Folding the third
// into the second would send a reader looking for an unguarded guard that may
// not exist; folding it into the first would be a pass nothing earned.
const NO_VERDICT = 3;

// A suite may name one test inside it after a '#' (a real-engine row runs one
// named browser test). The file is everything before it.
function suiteFile(suite) {
  return String(suite).split('#')[0];
}

/**
 * The targets a harness's rows name, each once, checked BEFORE anything is
 * mutated.
 *
 * THE ROWS ARE THE SOURCE OF TRUTH for what a harness touches. A list kept by
 * hand beside them drifted: rows were added naming targets the list did not
 * load, and the harness crashed at the first of them with none of those rows
 * ever run. The scope reads the same rows to decide which harnesses a change
 * can reach, so the list a run arms over and the list a selection is made
 * from are one list.
 *
 * A row is `[target, label, ...]` with `target = { src, suite }`, `src` an
 * absolute path and `suite` repository-relative. A harness whose rows all
 * break one file may leave the target off and pass it as `fallback`.
 *
 * Returns the target objects themselves (identity kept, so a harness can key
 * its originals by them). Throws, naming the row, when a target is missing,
 * malformed, or names a file or suite that does not exist: a run must fail
 * before it has written anything, not partway through.
 */
function targetsFromRows(rows, { fallback = null, root = ROOT } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('a harness with no rows has nothing to run');
  const targets = [];
  for (const row of rows) {
    const named = Array.isArray(row) && row[0] && typeof row[0] === 'object' ? row[0] : null;
    const target = named || fallback;
    const label = Array.isArray(row) ? row.find((v) => typeof v === 'string') : String(row);
    if (!target || typeof target !== 'object' || typeof target.src !== 'string' || typeof target.suite !== 'string') {
      throw new Error(`mutation row "${label}" names no target with a src and a suite; define the target before the row`);
    }
    if (!fs.existsSync(target.src)) throw new Error(`mutation row "${label}" names ${target.src}, which does not exist`);
    if (!fs.existsSync(path.resolve(root, suiteFile(target.suite)))) {
      throw new Error(`mutation row "${label}" names the suite ${suiteFile(target.suite)}, which does not exist`);
    }
    if (!targets.includes(target)) targets.push(target);
  }
  return targets;
}

/**
 * The rows this invocation runs: all of them, or the slice `--rows a:b` names
 * (a inclusive, b exclusive, by index into the harness's own row list).
 *
 * This is how CI splits a large harness across shards without the harness
 * knowing anything about shards. A slice that falls outside the rows, or does
 * not parse, throws rather than quietly running nothing: an empty slice would
 * report a pass for rows nobody ran.
 */
function rowsForShard(rows, argv = process.argv) {
  const at = argv.indexOf('--rows');
  if (at === -1) return rows;
  const given = String(argv[at + 1] || '');
  const parts = given.split(':');
  const digits = (v) => v !== '' && [...v].every((c) => c >= '0' && c <= '9');
  if (parts.length !== 2 || !digits(parts[0]) || !digits(parts[1])) {
    throw new Error(`--rows takes start:end, got "${given}"`);
  }
  const start = Number(parts[0]);
  const end = Number(parts[1]);
  if (!(start < end) || end > rows.length) {
    throw new Error(`--rows ${start}:${end} is not a slice of this harness's ${rows.length} rows`);
  }
  return rows.slice(start, end);
}

/**
 * The exit code for a finished run: 0 pass, 1 fail, NO_VERDICT when every
 * failing row is one whose suite could not be read. `failed` is the count the
 * harness's own report returned, which already counts an unreadable row as a
 * failure; this only decides which kind of not-a-pass it was.
 */
function exitCodeFor(failed, results) {
  if (!failed) return 0;
  // Every harness ends through here, so this is where a row with no verdict
  // gets the end of what its suite printed: once, for all of them.
  const said = noVerdictOutput(results);
  if (said) console.log(said);
  // A row whose suite did not finish is no verdict too: a hang is not a test
  // noticing, and it is not a guard nobody watches either.
  const unreadable = (results || []).filter((r) => r && (r.unparsable || r.didNotFinish)).length;
  return unreadable >= failed ? NO_VERDICT : 1;
}

/**
 * The end of what each row with no verdict had its suite print, by the row's
 * label, or '' when no such row carries any.
 *
 * WITHOUT IT, A NO-VERDICT ROW SAYS ONLY THAT. Its suite failed with output
 * the harness could not read, or ran out of time, and what the suite printed
 * went with the row, so the cause was a guess until the row was run again; on
 * CI a rerun was the only way to see it at all. The `output` a row carries is
 * the runner's (see suiteOutput), already cut to its end and with paths
 * outside the repository taken out.
 */
function noVerdictOutput(results) {
  const rows = (results || []).filter((r) => r && (r.unparsable || r.didNotFinish) && r.output);
  if (!rows.length) return '';
  const stream = (name, text) => (text
    ? `  ${name}:\n${text.split('\n').map((l) => `    ${l}`).join('\n')}`
    : `  ${name}: (nothing)`);
  return '\nThe end of what each suite with no verdict printed, with paths outside the repository taken out:\n'
    + rows.map((r) => `\n${r.label}\n${stream('stdout', r.output.stdout)}\n${stream('stderr', r.output.stderr)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Running a row's suite, bounded
// ---------------------------------------------------------------------------
//
// WHAT THIS REPLACES. Every harness ran a row's suite with a synchronous call
// and no limit, so a row whose broken guard left a test waiting on a promise,
// a timer or a deadline of its own held the run for as long as anything let
// it: once for six hours, with the mutation in the source until the run was
// stopped by hand. Two things made a plain limit on that call not enough.
//
// A SYNCHRONOUS CALL WAITS FOR EVERY HOLDER OF ITS OUTPUT PIPE. Its limit ends
// the direct child, and then the call goes on waiting for the pipe to close,
// which a grandchild the suite started can keep open for ever.
//
// AND WHILE IT WAITS, NO SIGNAL LISTENER IN THE HARNESS CAN RUN. The restore
// above is a listener, so a harness told to stop while a suite hung neither
// stopped nor put its file back until the suite ended, which it never did.
//
// So a suite is started here, asynchronously, in a process group of its own,
// and at its limit the whole group is ended: its leader held, SIGTERM, a grace
// for the rest of the group's tidying (test fixtures are removed from SIGTERM
// handlers), then SIGKILL. The wait is on the direct child's exit and a short
// drain, never on the pipes closing, so nothing a suite leaves behind can hold
// the runner. A group is only ever signalled while its leader is held (see
// endSuiteGroup), so a signal can never reach a group whose id has been handed
// to another process.

// THE LIMIT, one for every row of a kind. A node:test suite that runs past it
// is stuck rather than slow: the slowest real rows measured locally took
// minutes only because a test was waiting out a deadline of its own. Suites
// under test/electron/ start the desktop app and print a JSON report; they
// keep the limit they always had.
const SUITE_LIMIT_SECONDS = 300;
const ELECTRON_SUITE_LIMIT_SECONDS = 240;

// How long an ended suite's group gets between SIGTERM and SIGKILL. The same
// grace the pre-commit gate gives a step, for the same reason: the suites
// under it remove their fixtures from SIGTERM handlers.
const SUITE_END_GRACE_MS = 5000;

// How long a suite's last lines get to arrive after it exits. The wait is
// bounded because a process the suite left behind can hold the pipes open.
const SUITE_DRAIN_MS = 250;

// How much of each stream is kept: the end, which is where the spec reporter
// writes the failures a harness reads. Bounds memory for a suite that prints
// without stopping until its limit.
const SUITE_OUTPUT_KEPT = 8 * 1024 * 1024;

// How much of the end of each stream a row with no verdict shows: enough for
// an error and the lines that led to it, little enough for a CI log.
const SUITE_TAIL_CHARS = 400;

const POSIX = process.platform !== 'win32';

// A path outside the repository, as a suite prints one: from a slash, or a
// drive letter, to the next space or quote. One that follows a letter, a
// colon or a slash is inside a word or a web address and is left alone.
const OUTSIDE_PATH = /(?<![\w.~:/@%+-])\/(?:[\w.@%+~-]+\/)+[\w.@%+~-]*|\b[A-Za-z]:\\(?:[^\\\s'"`()<>|]+\\)+[^\\\s'"`()<>|]*/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `text` as a CI log may show it: the repository's own paths made relative
 * to it, under either spelling it is reached by, and every other absolute
 * path replaced with `<path>`.
 *
 * THESE LINES ARE PRINTED WHERE ANYONE CAN READ THEM, so what a suite says
 * about the machine it ran on, a home folder or a temp folder, stays out. A
 * path is taken to end at a space, so one with a space in it keeps what
 * follows the space.
 */
function scrubPaths(text, root = ROOT) {
  // A file URL is a path: without its scheme it is read as one below.
  let out = String(text).replace(/file:\/\//g, '');
  let real = root;
  try { real = fs.realpathSync(root); } catch { /* no such folder: its own spelling only */ }
  for (const r of [...new Set([path.resolve(root), path.resolve(real)])].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`${escapeRe(r)}(?:${escapeRe(path.sep)}|(?![\\w.@%+~/-]))`, 'g'),
      (m) => (m === r ? '.' : ''));
  }
  return out.replace(OUTSIDE_PATH, '<path>');
}

/**
 * The end of a suite's stream as a row with no verdict shows it: at most
 * SUITE_TAIL_CHARS characters, starting at a line, scrubbed (see scrubPaths).
 *
 * Scrubbed before it is cut, from a generous end that starts at a line, so a
 * path is never halved where it can no longer be recognised.
 */
function outputTail(text, { root = ROOT, chars = SUITE_TAIL_CHARS } = {}) {
  const fromLine = (s, cut) => {
    if (!cut) return s;
    const nl = s.indexOf('\n');
    if (nl !== -1 && nl < s.length - 1) return s.slice(nl + 1);
    const space = s.search(/\s/);
    return space === -1 ? s : s.slice(space + 1);
  };
  const raw = String(text || '');
  const wide = chars * 8;
  let end = fromLine(raw.length > wide ? raw.slice(-wide) : raw, raw.length > wide);
  end = scrubPaths(end, root).replace(/\s+$/, '');
  return end.length > chars ? fromLine(end.slice(-chars), true) : end;
}

// WHAT THE SUITE RUN LAST PRINTED, the end of each stream, set as it settles
// and cleared as the next one starts, so a row is never shown another row's
// output. A harness takes it for a row with no verdict (suiteOutput) right
// after the row's suite returns.
let lastOutput = null;

/** The end of each stream of the suite run last, or null while one runs. */
function suiteOutput() {
  return lastOutput;
}

/** The limit for a suite, from the arguments that start it. */
function suiteLimitSeconds(args) {
  return args.some((a) => String(a).startsWith('test/electron/')) ? ELECTRON_SUITE_LIMIT_SECONDS : SUITE_LIMIT_SECONDS;
}

/**
 * The environment a suite runs in: the one given, with TMPDIR set to the real
 * path of the temp folder.
 *
 * The verdict must not depend on the host. Where the temp folder is reached
 * through a link (macOS's default) and not on a machine where it is not (CI's
 * Linux runners), tests that compare a path they built against a path the
 * product resolved can see a mutation in one place and miss it in the other,
 * so a row could pass locally and survive in CI. Every suite is given the
 * canonical folder, as CI's already is.
 */
function suiteEnv(env) {
  const out = { ...env };
  try { out.TMPDIR = fs.realpathSync(env.TMPDIR || os.tmpdir()); } catch { /* no such folder: left as given */ }
  return out;
}

// THE GROUPS OF THE SUITES RUNNING NOW, keyed by group id, and the only thing
// the listeners below ever signal. An entry leaves the moment its leader is
// seen to exit, and after the SIGKILL that ends it, and never comes back.
const liveSuites = new Map();
// Set once this process has been told to stop. A suite ended for that reason
// has no verdict for anyone, and its row must not hand control back to a
// harness loop that would mutate the next row on the way out.
let stopping = null;

// How often an ending looks to see whether the leader was killed from outside
// during the grace.
const SUITE_POLL_MS = 100;

// THE WAITS ON A SUITE'S PROCESSES RUN ON THE WALL CLOCK, captured here. A
// process does not run on a mocked clock, so a test that mocks the clock to
// reach a limit without waiting minutes must still see the processes it ends
// watched in real time. The limit itself is read from the clock in use.
const { setTimeout: wallSetTimeout, clearTimeout: wallClearTimeout } = globalThis;
const nap = (ms) => new Promise((resolve) => { wallSetTimeout(resolve, ms); });

/**
 * End a suite's process group: hold its leader, SIGTERM the group, give the
 * rest of it the grace, then SIGKILL the group, and return.
 *
 * A GROUP IS SIGNALLED ONLY WHILE ITS LEADER IS HELD. A group's id is its
 * leader's pid, and once Node has collected the leader that number can be
 * handed to any process started afterwards, which may lead a group of its
 * own. Until the leader's 'exit' event it is running, or dead and not yet
 * collected, and either way its pid, and so the group's id, is still the
 * suite's. So the leader is stopped first, and SIGTERM cannot end it: the
 * SIGKILL at the end of the grace goes to a group whose id is provably still
 * the suite's. A leader seen to exit meanwhile, killed from outside, ends the
 * ending there, and nothing signals its group again; anything of the suite's
 * still running then is left to finish on its own.
 *
 * The rest of the group gets SIGTERM and the grace for its tidying: under
 * node --test the tests run in a process of their own, and that is where
 * their SIGTERM handlers remove fixtures. The leader, stopped, gets none,
 * which is the price of the guarantee, and the grace is waited in full, since
 * a group holding its stopped leader never empties on its own.
 *
 * NO WAIT AFTER SIGKILL. Nothing in the group can run again once it is sent,
 * so the next row may start at once, and the call that timed out returns
 * within its limit plus the grace. The kernel drops the killed processes, and
 * Node collects the leader, on their own time.
 */
async function endSuiteGroup(pgid, live) {
  const send = (target, signal) => {
    if (live.released) return;
    try { process.kill(target, signal); } catch { /* gone */ }
  };
  send(pgid, 'SIGSTOP');
  send(-pgid, 'SIGTERM');
  for (const deadline = Date.now() + live.graceMs; Date.now() < deadline;) {
    await nap(SUITE_POLL_MS);
    if (live.released) return;
  }
  send(-pgid, 'SIGKILL');
}

/**
 * Forget a suite's group for good, so nothing signals it again: the moment
 * its leader is seen to exit, and after the SIGKILL that ends it.
 */
function releaseSuite(pgid, live) {
  live.released = true;
  if (liveSuites.get(pgid) === live) liveSuites.delete(pgid);
  if (!liveSuites.size && !stopping) disarmSuites();
}

/** End one live suite and everything it started, then forget it. */
async function endSuite(pgid) {
  const live = liveSuites.get(pgid);
  if (!live) return;
  if (POSIX) await endSuiteGroup(pgid, live);
  else if (!live.released) { try { live.kid.kill('SIGKILL'); } catch { /* gone */ } }
  releaseSuite(pgid, live);
}

// Kill every live suite outright. Each entry's leader has not been seen to
// exit, so each group id is still its suite's.
function killLiveSuites() {
  for (const [pgid, live] of liveSuites) {
    if (live.released) continue;
    if (POSIX) { try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ } }
    else { try { live.kid.kill('SIGKILL'); } catch { /* gone */ } }
    live.released = true;
  }
  liveSuites.clear();
}

// The way out that cannot wait: by 'exit' the event loop has finished, and a
// suite given a grace here would outlive the process that was to end it. So a
// suite still running when this process exits is killed outright.
function onSuitesExit() {
  killLiveSuites();
}

function reRaise(signal) {
  if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  // Another module kept the process alive. Whatever it does next, this run
  // reached no verdict, so it must not end looking like a pass.
  else if (!process.exitCode) process.exitCode = NO_VERDICT;
}

/**
 * Told to stop while a suite runs: end it, then die of the signal.
 *
 * This and the restore's listener above can run in either order. This one
 * stays registered until the suite has gone, so the restore's never finds the
 * process unattended and re-raises early; then this re-raises, and the process
 * still dies of the signal it was sent, with the file put back and the suite
 * gone. A second signal while the suite is being ended means now: the groups
 * are killed outright.
 */
function onSuitesSignal(signal) {
  if (stopping) {
    killLiveSuites();
    disarmSuites();
    reRaise(signal);
    return;
  }
  stopping = signal;
  Promise.all([...liveSuites.keys()].map(endSuite)).then(() => {
    liveSuites.clear();
    disarmSuites();
    reRaise(signal);
  });
}

function armSuites() {
  process.on('exit', onSuitesExit);
  for (const signal of SIGNALS) process.on(signal, onSuitesSignal);
}

function disarmSuites() {
  process.removeListener('exit', onSuitesExit);
  for (const signal of SIGNALS) process.removeListener(signal, onSuitesSignal);
}

/** The line a harness reports for a row whose suite did not finish. */
function didNotFinishWhy(seconds) {
  return `no verdict: the suite did not finish in ${seconds} s and was ended, so no test was seen to notice `
    + 'this mutation; make the test that waits fail fast rather than raising the limit';
}

/**
 * Run one row's suite, the one way every harness does.
 *
 * The contract is the synchronous call's it replaces, awaited: the suite's
 * stdout when it exits 0, otherwise an Error carrying `stdout`, `stderr`,
 * `status` and `signal`, so a harness reads its results exactly as it did.
 * A suite that runs past its limit is ended with everything it started, and
 * the Error then carries `didNotFinish`, the limit in seconds, which a harness
 * reports as its own outcome: never caught, never survived.
 *
 * The wait is on the suite's exit and a short drain, never on its pipes
 * closing, so a process it left behind holding them cannot hold the runner.
 * A suite that exits on its own is not signalled afterwards: its group's id
 * can be handed to another process from the moment it is collected, so
 * whatever it left running is left to finish on its own, as before.
 *
 * A suite that runs past its limit returns within the limit plus the grace,
 * since the ending does not wait for the kernel to drop what it killed.
 *
 * Once it settles, the end of each of its streams is what suiteOutput
 * returns, for a harness to hand a row with no verdict.
 *
 * `limitMs` and `graceMs` exist for this module's own tests, which cannot wait
 * minutes for a limit. No harness passes them: a row's limit is the runner's.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, limitMs?: number, graceMs?: number}} [options]
 * @returns {Promise<string>}
 */
function runSuite(command, args, { cwd = ROOT, env = process.env, limitMs, graceMs = SUITE_END_GRACE_MS } = {}) {
  // Cleared before anything can fail, so a suite that never starts shows no
  // output rather than the row before it's.
  lastOutput = null;
  const limit = limitMs === undefined ? suiteLimitSeconds(args) * 1000 : limitMs;
  const seconds = limit / 1000;
  return new Promise((resolve, reject) => {
    const kid = spawn(command, args, { cwd, env: suiteEnv(env), stdio: ['ignore', 'pipe', 'pipe'], detached: POSIX });
    // Recorded on the line the child is created: from here on there is a
    // group on this machine that only this map knows about.
    const live = kid.pid ? { kid, graceMs, released: false } : null;
    if (live) {
      if (!liveSuites.size) armSuites();
      liveSuites.set(kid.pid, live);
    }
    let stdout = '';
    let stderr = '';
    const keep = (text) => (text.length > SUITE_OUTPUT_KEPT * 2 ? text.slice(-SUITE_OUTPUT_KEPT) : text);
    kid.stdout.setEncoding('utf8');
    kid.stderr.setEncoding('utf8');
    kid.stdout.on('data', (s) => { stdout = keep(stdout + s); });
    kid.stderr.on('data', (s) => { stderr = keep(stderr + s); });

    let ending = false;
    let exited = null;
    let drain = null;
    // Ends the suite's group, then settles with what `outcome` makes of what
    // the suite wrote. Told to stop meanwhile, it never settles: that suite
    // was ended for the stop, its row has no outcome, and a harness handed one
    // would move on to mutate the next row on its way out.
    const settle = async (outcome) => {
      if (ending || stopping) return;
      ending = true;
      clearTimeout(timer);
      wallClearTimeout(drain);
      if (kid.pid) await endSuite(kid.pid);
      kid.stdout.destroy();
      kid.stderr.destroy();
      if (stopping) return;
      lastOutput = { stdout: outputTail(stdout, { root: cwd }), stderr: outputTail(stderr, { root: cwd }) };
      outcome();
    };
    const fail = (message, fields) => Object.assign(new Error(message), { stdout, stderr, ...fields });

    const timer = setTimeout(() => {
      if (ending || stopping) return;
      console.error(`[mutation-run] ${args.join(' ')} did not finish in ${seconds} s; ending it and everything it started`);
      settle(() => reject(fail(`the suite did not finish in ${seconds} s`, { didNotFinish: seconds, status: null, signal: null })));
    }, limit);
    kid.on('error', (err) => settle(() => reject(Object.assign(err, { stdout, stderr }))));
    kid.on('exit', (status, signal) => {
      // COLLECTED. From here the suite's pid, its group's id, can be handed to
      // a process started after it, so the group is released and nothing
      // signals it again.
      if (live) releaseSuite(kid.pid, live);
      exited = { status, signal };
      drain = wallSetTimeout(finished, SUITE_DRAIN_MS);
    });
    kid.on('close', () => finished());
    function finished() {
      if (!exited) return;
      const { status, signal } = exited;
      settle(() => (status === 0 ? resolve(stdout) : reject(fail(`the suite exited with ${signal || status}`, { status, signal }))));
    }
  });
}

module.exports = {
  beginMutationRun, inspect, markerPath, markerDir, readMarkers, recoverAbandoned, MARKER, MARKER_DIR, ROOT,
  targetsFromRows, rowsForShard, exitCodeFor, suiteFile, NO_VERDICT, unstaged, unstagedRefusal, fixtureRootProblem,
  runSuite, didNotFinishWhy, SUITE_LIMIT_SECONDS, ELECTRON_SUITE_LIMIT_SECONDS, SUITE_END_GRACE_MS,
  suiteOutput, outputTail, noVerdictOutput, SUITE_TAIL_CHARS,
};
