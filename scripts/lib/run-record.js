'use strict';
// A long run this repository's tools start, recorded in the checkout while it
// runs, so `npm run lane-done` can tell work still in progress from work done.
//
// WHY A FILE AND NOT THE PROCESS TABLE. A change was once reported done while
// a mutation run it had started was still writing mutants into the checkout.
// The check that would have caught it cannot rely on `ps`, which some
// sandboxes will not spawn, so a run says it is running here, by pid, and
// liveness is asked of the kernel with signal 0.
//
// One file per run, named for its pid, removed when the run exits. A run
// killed outright leaves its file behind; a later record sweeps it, and a
// reader skips it, because a dead pid is not a run in progress.

const fs = require('node:fs');
const path = require('node:path');

// Beside .mutation-runs/ and .precommit-gate/, and ignored like them.
const RUN_DIR = '.tool-runs';

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the pid exists and belongs to someone else, so it is running.
    return err.code === 'EPERM';
  }
}

/** Every record in `root`, with whether its process is still alive. */
function readRuns(root) {
  const dir = path.join(root, RUN_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({ ...r, file, alive: isAlive(r.pid) });
    } catch { /* a half-written or foreign file names no run */ }
  }
  return out;
}

/** Record this process as running `what` in `root` until it exits. */
function recordRun(root, what) {
  for (const old of readRuns(root).filter((r) => !r.alive)) fs.rmSync(old.file, { force: true });
  const file = path.join(root, RUN_DIR, `${process.pid}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, what, startedAt: new Date().toISOString() })}\n`);
  } catch {
    return () => {};
  }
  const release = () => { try { fs.rmSync(file, { force: true }); } catch { /* already gone */ } };
  process.on('exit', release);
  return release;
}

module.exports = { RUN_DIR, isAlive, readRuns, recordRun };
