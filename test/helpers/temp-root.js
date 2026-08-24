'use strict';
// Ownership rules for the suite's temporary fixture directories.
//
// WHY THIS EXISTS
//
// Every test process used to scatter its fixtures directly into the system
// temp root and remove none of them. A `cleanup()` was written and exported,
// but of the 79 files that build fixtures only 20 ever wired it, so a single
// suite run left 160 directories and 103 MB behind and nothing ever removed
// them. Every run of anything added to the pile permanently, and a day of runs
// reached 10,087 directories and then 20,708. The disk hit 100 percent twice,
// and the failures did not arrive labelled as disk failures:
// two mutation runs reported 293 and 32 tests red that were out-of-space
// rather than unguarded. A harness that calls a mutation caught because the
// disk refused the write is worse than one that reports nothing.
//
// THE SHAPE OF THE FIX
//
// One root per test process, named with the pid that owns it, and every
// fixture nested inside that root. The owner removes the whole root on its way
// out, so the tidying belongs to whatever created the directory. The pid in
// the name is what lets a LATER run finish the job when the owner never got
// the chance, which is the only cover that exists for a process that is killed
// outright.

const fs = require('node:fs');
const path = require('node:path');

const PREFIX = 'rundock-test-';

// A root this module made: rundock-test-p<pid>-<mkdtemp suffix>. The pid is in
// the name rather than in a file inside the directory because reading it must
// not depend on the directory still being readable or complete: a root left by
// a process killed mid-write is exactly the case this has to handle.
const OWNED = /^rundock-test-p(\d+)-/;

// Roots in the older, un-owned shape are swept too, otherwise the tens of
// thousands already on disk stay there forever. They carry no pid, so liveness
// cannot be asked about them and age is the only signal available. An hour is
// far longer than the 39-second suite, so a pre-fix run happening concurrently
// in another checkout keeps its fixtures.
const LEGACY_STALE_AFTER_MS = 60 * 60 * 1000;

// Above this many roots, something is wrong rather than busy. After this fix a
// machine holds one root per live test process, and the harnesses run their
// suites one after another, so the honest working number is single digits.
const SANE_ROOT_LIMIT = 100;

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the pid exists and belongs to another user. Treating that as
    // dead would try to remove a directory that is both in use and not ours.
    return err.code === 'EPERM';
  }
}

// Every fixture root directly under `tmpRoot`, with the pid that owns it where
// the name carries one. Non-recursive by design: nested fixtures belong to
// their root and are removed with it.
function listRoots(tmpRoot) {
  let names;
  try {
    names = fs.readdirSync(tmpRoot);
  } catch {
    return [];
  }
  const roots = [];
  for (const name of names) {
    if (!name.startsWith(PREFIX)) continue;
    const owned = OWNED.exec(name);
    roots.push({
      name,
      full: path.join(tmpRoot, name),
      pid: owned ? Number(owned[1]) : null,
    });
  }
  return roots;
}

function countRoots(tmpRoot) {
  return listRoots(tmpRoot).length;
}

/**
 * Remove fixture roots whose owner is gone.
 *
 * Safe to run concurrently from every test process at once: a root belonging
 * to a live pid is never touched, and two sweepers racing on the same dead
 * root both succeed because `force` swallows the ENOENT of the loser.
 *
 * @param {string} tmpRoot - directory holding the fixture roots
 * @param {object} [opts]
 * @param {number} [opts.now] - epoch ms, injected so age is testable
 * @param {number} [opts.legacyStaleAfterMs] - age at which a pid-less root is stale
 * @returns {{removed: string[], kept: string[]}}
 */
function sweepStale(tmpRoot, opts = {}) {
  const now = opts.now ?? Date.now();
  const staleAfter = opts.legacyStaleAfterMs ?? LEGACY_STALE_AFTER_MS;
  const removed = [];
  const kept = [];
  for (const root of listRoots(tmpRoot)) {
    if (root.pid === null) {
      let mtime;
      try {
        mtime = fs.statSync(root.full).mtimeMs;
      } catch {
        continue; // vanished under us; nothing to do
      }
      if (now - mtime < staleAfter) {
        kept.push(root.name);
        continue;
      }
    } else if (isAlive(root.pid)) {
      kept.push(root.name);
      continue;
    }
    try {
      fs.rmSync(root.full, { recursive: true, force: true });
      removed.push(root.name);
    } catch {
      kept.push(root.name); // another user's, or a race we lost
    }
  }
  return { removed, kept };
}

/**
 * Decide whether a mutation harness should start.
 *
 * A harness runs a suite once per guard, so it is the tool that turns a nearly
 * full disk into hundreds of misreported red tests. It sweeps first,
 * because a machine dirtied by pre-fix runs repairs itself and should not be
 * made to stop for a condition that no longer holds. It refuses only when
 * roots remain that it cannot account for.
 *
 * @param {string} tmpRoot
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @param {object} [opts.sweep] - options forwarded to sweepStale
 * @returns {{ok: boolean, count: number, swept: number, limit: number, message: string|null}}
 */
function preflight(tmpRoot, opts = {}) {
  const limit = opts.limit ?? SANE_ROOT_LIMIT;
  const { removed } = sweepStale(tmpRoot, opts.sweep);
  const count = countRoots(tmpRoot);
  if (count <= limit) {
    return { ok: true, count, swept: removed.length, limit, message: null };
  }
  return {
    ok: false,
    count,
    swept: removed.length,
    limit,
    message:
      `${count} test fixture roots are still under ${tmpRoot} after sweeping `
      + `${removed.length}, and the sane ceiling is ${limit}.\n`
      + 'Refusing to start. This harness runs a suite once per guard, so on a '
      + 'machine in this state it fills the disk and then reports the resulting '
      + 'write failures as guards nobody was watching. Those numbers would be wrong '
      + 'in the direction that looks like work to do.\n'
      + `Remove them, then re-run:  rm -rf ${path.join(tmpRoot, `${PREFIX}*`)}`,
  };
}

module.exports = {
  PREFIX,
  SANE_ROOT_LIMIT,
  LEGACY_STALE_AFTER_MS,
  isAlive,
  listRoots,
  countRoots,
  sweepStale,
  preflight,
};
