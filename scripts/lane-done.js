#!/usr/bin/env node
'use strict';

/**
 * The last check before a change is reported done: `npm run lane-done`.
 *
 * WHY. Work was reported done while a mutation run it had started was still
 * writing mutants into the checkout as the work was committed, and with files
 * the report never mentioned left unstaged. Each condition below is one that
 * was checked by hand and, once, was not. It passes only when:
 *
 *   - no long run this repository's tools start is still going here: a
 *     mutation harness (.mutation-runs/), a mutation run as a whole
 *     (.tool-runs/), or a red-first run (its record in the temp folder);
 *   - nothing is uncommitted: nothing staged, nothing unstaged, and no
 *     untracked file outside .gitignore;
 *   - every commit since the merge base with origin/main has a passing
 *     pre-commit record for its tree (scripts/precommit-gate.js keeps one per
 *     tree in .precommit-gate/);
 *   - the leak scan over those commits is clean.
 *
 * Each failed condition prints one line saying what to do, and the exit is 1.
 * Whether a run is live is asked of the kernel by signal 0, never of `ps`,
 * which some sandboxes will not spawn.
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { readMarkers, MARKER_DIR } = require('../test/tools/mutation-run.js');
const { readRuns, isAlive, groupAlive } = require('./lib/run-record.js');
const { runRecordPath } = require('./red-first.js');

// Overridable ONLY so the command can be exercised against a throwaway
// repository, as the pre-commit gate's root is.
const ROOT = process.env.LANE_DONE_ROOT ? path.resolve(process.env.LANE_DONE_ROOT) : path.resolve(__dirname, '..');
const AGAIN = 'then run lane-done again';

const names = (files) => (files.length > 10 ? `${files.slice(0, 10).join(', ')} and ${files.length - 10} more` : files.join(', '));

/** Every file under the sweep's kept copies, as `<dir>/<path>`. */
function keptCopies(dir, prefix = '') {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, prefix), { withFileTypes: true }); } catch { return []; }
  return entries.flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    return e.isDirectory() ? keptCopies(dir, rel) : [rel];
  });
}

function runsInProgress(root) {
  const out = [];
  // A PID IS REUSED, so a record that outlived its run can name an unrelated
  // process: every line names its record and says what to do then.
  for (const r of readRuns(root).filter((x) => x.alive)) {
    const group = Number.isInteger(r.group) && r.group > 0 ? `, process group ${r.group}` : '';
    const rel = path.relative(root, r.file);
    out.push(`a run of ${r.what} (pid ${r.pid}${group}) is still going in this checkout (${rel}): wait for it to finish, or stop it, `
      + `${AGAIN}; if no such run is going, delete ${rel}.`);
  }
  for (const m of readMarkers(root)) {
    const rel = path.relative(root, m.file);
    const files = Array.isArray(m.files) ? m.files : [];
    if (m.unreadable) out.push(`${rel} cannot be read as a mutation run record: check the files the harnesses mutate against git, then delete it.`);
    else if (isAlive(m.pid)) {
      out.push(`a mutation harness (pid ${m.pid}, ${m.tool}) is still running in this checkout (${rel}): wait for it to finish, `
        + `or stop it, ${AGAIN}; if no such run is going, check ${names(files)} with git diff, then delete ${rel}.`);
    }
    // NEVER A BARE CHECKOUT FIRST: to git the leftover mutation and an edit
    // made since are one change, and a checkout throws both away.
    else out.push(`a mutation run (pid ${m.pid}) never finished, and ${rel} names ${names(files)}, which may still hold its mutation: `
      + `let the next mutation harness run put them back (it keeps a copy of each in ${MARKER_DIR}/recovered/ first), `
      + `or copy them aside, then git checkout -- ${files.join(' ')} and delete ${rel}; ${AGAIN}.`);
  }
  const kept = keptCopies(path.join(root, MARKER_DIR, 'recovered'));
  if (kept.length) {
    const [dir, file] = [kept[0].slice(0, kept[0].indexOf('/')), kept[0].slice(kept[0].indexOf('/') + 1)];
    out.push(`${MARKER_DIR}/recovered/ holds what a sweep kept of files a dead mutation run had held (${names(kept)}), `
      + `which may be your edits: compare each with its file (git diff --no-index ${MARKER_DIR}/recovered/${dir}/${file} ${file}), `
      + `keep what is yours, then delete ${MARKER_DIR}/recovered/; ${AGAIN}.`);
  }
  let held = null;
  const claim = runRecordPath(root);
  try { held = JSON.parse(fs.readFileSync(claim, 'utf8')); } catch { /* none */ }
  if (held && (isAlive(held.pid) || groupAlive(held.group))) {
    out.push(`a red-first run (pid ${held.pid}) is still going in this checkout (${claim}): wait for it to finish, or stop it, `
      + `${AGAIN}; if no such run is going, delete ${claim}.`);
  }
  return out;
}

function uncommitted(git) {
  // Every untracked file, whatever status.showUntrackedFiles says.
  const lines = git(['status', '--porcelain=v1', '--untracked-files=all']).split('\n').filter(Boolean);
  const kinds = { staged: [], unstaged: [], untracked: [] };
  for (const l of lines) {
    if (l.startsWith('??')) { kinds.untracked.push(l.slice(3)); continue; }
    if (l[0] !== ' ') kinds.staged.push(l.slice(3));
    if (l[1] !== ' ') kinds.unstaged.push(l.slice(3));
  }
  const out = [];
  if (kinds.staged.length) out.push(`staged but not committed: ${names(kinds.staged)}: commit them.`);
  if (kinds.unstaged.length) out.push(`unstaged changes: ${names(kinds.unstaged)}: commit them, or restore them if they are not part of the change.`);
  if (kinds.untracked.length) out.push(`untracked files: ${names(kinds.untracked)}: commit them, add them to .gitignore if a tool writes them, or delete them.`);
  return out;
}

/** Was the gate passed on this tree? Its per-tree record, or the latest one. */
function gated(root, tree) {
  for (const file of [path.join(root, '.precommit-gate', `${tree}.json`), path.join(root, '.precommit-gate.json')]) {
    try { if (JSON.parse(fs.readFileSync(file, 'utf8')).tree === tree) return true; } catch { /* not this one */ }
  }
  return false;
}

function realLeakScan(root, range) {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'leak-scan.js'), '--range', range], { cwd: root, encoding: 'utf8' });
  return { ok: r.status === 0 };
}

function laneDone({ root = ROOT, leakScan = realLeakScan } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  try { git(['rev-parse', '--is-inside-work-tree']); } catch {
    return { failures: [`${root} is not inside a git checkout: run lane-done from the checkout the change was made in.`], commits: 0 };
  }
  const failures = [...runsInProgress(root), ...uncommitted(git)];
  let base;
  try { base = git(['merge-base', 'HEAD', 'origin/main']).trim(); } catch {
    const remotes = git(['remote']).split('\n').filter(Boolean);
    failures.push(remotes.includes('origin')
      ? `origin/main is not known in this checkout, so there is no merge base to check from: run git fetch origin, ${AGAIN}.`
      : `this checkout has no remote named origin (its remotes: ${remotes.join(', ') || 'none'}), so there is no origin/main `
        + `to check from: add the repository the change will merge into as origin and fetch it, ${AGAIN}.`);
    return { failures, commits: 0 };
  }
  const commits = git(['rev-list', `${base}..HEAD`]).split('\n').filter(Boolean);
  const ungated = commits.filter((c) => !gated(root, git(['rev-parse', `${c}^{tree}`]).trim())).map((c) => c.slice(0, 8));
  if (ungated.length) {
    failures.push(`no passing pre-commit record for the tree of ${names(ungated)}: check out each one, run npm run precommit, `
      + `switch back to the branch, ${AGAIN}.`);
  }
  const range = `${base}..HEAD`;
  if (!leakScan(root, range).ok) {
    failures.push(`the leak scan is not clean for ${range}: run node scripts/leak-scan.js --range ${range} to see the findings, `
      + 'then reword or amend those commits.');
  }
  return { failures, commits: commits.length };
}

if (require.main === module) {
  let outcome;
  try { outcome = laneDone(); } catch (e) {
    console.error(`lane-done: the checks could not finish (${String((e && e.message) || e).split('\n')[0]}), so nothing is known.`);
    process.exit(1);
  }
  const { failures, commits } = outcome;
  for (const line of failures) console.error(`lane-done: ${line}`);
  if (!failures.length) {
    console.log(`lane-done: pass. Nothing running, nothing uncommitted, ${commits} commit(s) since the merge base with `
      + 'origin/main each passed the pre-commit gate, and the leak scan is clean.');
  }
  process.exit(failures.length ? 1 : 0);
}

module.exports = { laneDone };
