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
// One file per run, named for its pid, removed when the run exits or is
// asked to stop by SIGINT, SIGTERM or SIGHUP: a record outliving its run
// reads as a run still going once the pid is reused. A run killed outright
// leaves its file behind; a later record sweeps it, and a reader skips it,
// because a dead pid is not a run in progress.

const fs = require('node:fs');
const path = require('node:path');

// Beside .mutation-runs/ and .precommit-gate/, and ignored like them.
const RUN_DIR = '.tool-runs';
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

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

// A run's suite can head a process group of its own and outlive the run;
// signal 0 to the negated id asks about the whole group.
function groupAlive(group) {
  if (!Number.isInteger(group) || group <= 0) return false;
  try {
    process.kill(-group, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Every record in `root`, alive while its process or the group it names is. */
function readRuns(root) {
  const dir = path.join(root, RUN_DIR);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({ ...r, file, alive: isAlive(r.pid) || groupAlive(r.group) });
    } catch { /* a half-written or foreign file names no run */ }
  }
  return out;
}

/**
 * Record this process as running `what` in `root` until it exits or is asked
 * to stop. Returns `{ file, release, update, keep }`: release removes the
 * record early, update adds fields to it (a suite's process group), and keep
 * leaves it in place past this process, for a group known to have survived.
 */
function recordRun(root, what) {
  for (const old of readRuns(root).filter((r) => !r.alive)) fs.rmSync(old.file, { force: true });
  const file = path.join(root, RUN_DIR, `${process.pid}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ pid: process.pid, what, startedAt: new Date().toISOString() })}\n`);
  } catch {
    return { file: null, release: () => {}, update: () => {}, keep: () => {} };
  }
  let done = false;
  const base = { pid: process.pid, what, startedAt: new Date().toISOString() };
  const keep = () => {
    done = true;
    process.removeListener('exit', release);
    for (const signal of SIGNALS) process.removeListener(signal, onSignal);
  };
  const release = () => {
    try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    keep();
  };
  const update = (fields) => {
    if (done) return;
    try { fs.writeFileSync(file, `${JSON.stringify({ ...base, ...fields })}\n`); } catch { /* the record stays as it was */ }
  };
  // RE-RAISED, so whatever drove the run sees it die of the signal it sent,
  // and only where nothing else is listening, so another module's tidying
  // still runs and ends the process its own way.
  function onSignal(signal) {
    release();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  }
  process.on('exit', release);
  for (const signal of SIGNALS) process.on(signal, onSignal);
  return { file, release, update, keep };
}

module.exports = { RUN_DIR, isAlive, groupAlive, readRuns, recordRun };
