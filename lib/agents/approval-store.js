'use strict';
// WHERE A ROUTINE'S APPROVAL COUNTS: on this install, in the workspace where
// it was given, and nowhere else.
//
// An approval used to be only a field in the agent file, so it travelled with
// the file: a copied folder, a cloned repository, a template, or an agent
// editing its own file could each arrive with a routine already approved, and
// the hash in that field is one anyone can compute. The field stays, as a
// readable record and for older versions, but it no longer grants anything.
// What grants is a record here, in Rundock's own folder outside every
// workspace (beside the recent-workspaces file), which no workspace carries
// and which the sandbox keeps agents from writing.
//
// A record names the workspace (by its real path), the agent file, the
// routine (by name and which of its namesakes), the plan hash approved, and
// when. A routine is approved while its CURRENT plan still hashes to the
// recorded one, so editing what it does still lapses the approval as before.
//
// Each workspace also has a state, decided once, the first time this install
// opens it:
//   - 'adopted': this machine opened it at this path before this record
//     existed. Both must say so: the workspace's own .rundock/state.json, and
//     this install's recent-workspaces list as it stood when this record was
//     created (kept here, outside every workspace). A state file alone could
//     have been written by anyone. Its existing approvals are copied in, and
//     routines written before approvals existed keep running. Nobody is asked.
//   - 'unseen': anything else. Nothing it carries is approved here, and the
//     routines that would otherwise have run are listed for the one-line
//     strip, until the person allows them or closes it.

const fs = require('node:fs');
const path = require('node:path');

let storeFile = null;
let memory = { workspaces: {}, recentBeforeStore: [] };
// The parsed file, kept until the file changes: asked once per routine on
// every discovery and every tick.
let cache = { mtimeMs: -1, data: null };
function storePath() { return storeFile; }

// `recentPaths` is this install's recent-workspaces list, read only when the
// record is first created: what was opened here before this record existed
// is the only thing an upgrade carries over.
function configureApprovalStore(filePath, { recentPaths = () => [] } = {}) {
  storeFile = filePath || null;
  memory = { workspaces: {}, recentBeforeStore: [] };
  cache = { mtimeMs: -1, data: null };
  if (storeFile && !fs.existsSync(storeFile)) {
    let recent = [];
    try { recent = (recentPaths() || []).filter((p) => typeof p === 'string').map(workspaceKey); } catch (e) { recent = []; }
    write({ workspaces: {}, recentBeforeStore: recent });
  }
}

// A fresh copy each call: callers change what they read and write it back.
function read() {
  if (!storeFile) return memory;
  let stat;
  try { stat = fs.statSync(storeFile); } catch (e) { return { workspaces: {}, recentBeforeStore: [] }; }
  if (stat.mtimeMs !== cache.mtimeMs || !cache.data) {
    let data;
    try { data = JSON.parse(fs.readFileSync(storeFile, 'utf-8')); } catch (e) { data = null; }
    if (!data || typeof data.workspaces !== 'object' || !data.workspaces) data = { workspaces: {}, recentBeforeStore: [] };
    if (!Array.isArray(data.recentBeforeStore)) data.recentBeforeStore = [];
    cache = { mtimeMs: stat.mtimeMs, data };
  }
  return JSON.parse(JSON.stringify(cache.data));
}

// Whether this install had opened `dir` before it kept this record.
function wasRecentBeforeStore(dir) {
  const key = workspaceKey(dir);
  return !!key && read().recentBeforeStore.includes(key);
}

// For a test or fixture standing in for that history: add `dir` to it.
function markRecentBeforeStore(dir) {
  const data = read();
  const key = workspaceKey(dir);
  if (key && !data.recentBeforeStore.includes(key)) data.recentBeforeStore.push(key);
  write(data);
}

function write(data) {
  if (!storeFile) { memory = data; return; }
  fs.mkdirSync(path.dirname(storeFile), { recursive: true });
  const tmp = `${storeFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, storeFile);
  cache = { mtimeMs: -1, data: null };
}

// The key a workspace is kept under: its real path, so two spellings of one
// folder are one workspace, falling back to the resolved path for a folder
// that no longer exists (a workspace that has been moved away).
function workspaceKey(dir) {
  if (!dir) return null;
  // The nearest folder that still exists, by its real path, plus the rest:
  // a moved-away workspace is found under the key it had while it existed.
  let current = path.resolve(dir);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(current), ...rest.reverse()); } catch (e) { /* not there */ }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(dir);
    rest.push(path.basename(current));
    current = parent;
  }
}

function entryFor(data, dir) {
  const key = workspaceKey(dir);
  return key ? data.workspaces[key] || null : null;
}

function ensureEntry(data, dir, state) {
  const key = workspaceKey(dir);
  if (!data.workspaces[key]) data.workspaces[key] = { state, approvals: [], held: [], stripClosed: false };
  return data.workspaces[key];
}

// Which routine a record is for. `source` is attached by discovery: the agent
// file relative to the workspace, and which namesake in that file.
function sameRoutine(record, file, name, occurrence) {
  return record.file === file && record.name === name && record.occurrence === occurrence;
}

function identityOf(routine) {
  const source = routine && routine.source;
  if (!source || typeof source.file !== 'string' || !Number.isInteger(source.occurrence)) return null;
  return { file: source.file, name: routine.name, occurrence: source.occurrence };
}

function workspaceState(dir) {
  const entry = entryFor(read(), dir);
  return entry ? entry.state : null;
}

// Record that `routine` (with its source) is approved over `hash` in `dir`,
// at `at` (an ISO time, or null for an approval carried over at upgrade, which
// owes every slot it owed before). Replaces any earlier record for it.
function recordApproval(dir, { file, name, occurrence }, hash, at) {
  const data = read();
  const entry = ensureEntry(data, dir, 'adopted');
  entry.approvals = entry.approvals.filter((r) => !sameRoutine(r, file, name, occurrence));
  entry.approvals.push({ file, name, occurrence, hash, at: at || null });
  entry.held = (entry.held || []).filter((r) => !sameRoutine(r, file, name, occurrence));
  write(data);
}

function recordFor(dir, routine) {
  const id = identityOf(routine);
  if (!id) return null;
  const entry = entryFor(read(), dir);
  if (!entry) return null;
  return entry.approvals.find((r) => sameRoutine(r, id.file, id.name, id.occurrence)) || null;
}

// Is this routine approved here, for the plan it has now?
function approvedHere(dir, routine, currentHash) {
  const record = recordFor(dir, routine);
  return !!record && typeof currentHash === 'string' && record.hash === currentHash;
}

// Has anybody approved this routine here, for any plan.
function approvedHereBefore(dir, routine) {
  return !!recordFor(dir, routine);
}

// When the approval was given, as a Date, or null. A slot earlier than this
// was never owed: approving a routine never runs it on the click.
function approvedAt(dir, routine) {
  const record = recordFor(dir, routine);
  if (!record || !record.at) return null;
  const at = new Date(record.at);
  return isNaN(at.getTime()) ? null : at;
}

// Decide a workspace's state the first time this install opens it. Returns
// the entry's state, and whether it was decided just now.
function noteWorkspaceOpened(dir, { seenHere, adopt = () => [], wouldHaveRun = () => [] }) {
  const data = read();
  const existing = entryFor(data, dir);
  if (existing) return { state: existing.state, decidedNow: false };
  if (seenHere) {
    const entry = ensureEntry(data, dir, 'adopted');
    entry.approvals = adopt().map((r) => ({ ...r, at: null }));
  } else {
    const entry = ensureEntry(data, dir, 'unseen');
    entry.held = wouldHaveRun();
  }
  write(data);
  return { state: entryFor(data, dir).state, decidedNow: true };
}

// A workspace moved from `from` (gone now) to `to`: its records follow it.
function moveWorkspace(from, to) {
  const data = read();
  const fromKey = workspaceKey(from);
  const toKey = workspaceKey(to);
  if (!data.workspaces[fromKey] || data.workspaces[toKey]) return false;
  data.workspaces[toKey] = data.workspaces[fromKey];
  delete data.workspaces[fromKey];
  write(data);
  return true;
}

// The routines the strip names: held at first open and not yet allowed, or
// nothing once the strip was closed.
function heldRoutines(dir) {
  const entry = entryFor(read(), dir);
  if (!entry || entry.stripClosed) return [];
  return (entry.held || []).slice();
}

function closeStrip(dir) {
  const data = read();
  const entry = entryFor(data, dir);
  if (!entry) return;
  entry.stripClosed = true;
  write(data);
}

module.exports = {
  configureApprovalStore, storePath, wasRecentBeforeStore, markRecentBeforeStore, workspaceKey, workspaceState, identityOf,
  recordApproval, approvedHere, approvedHereBefore, approvedAt,
  noteWorkspaceOpened, moveWorkspace, heldRoutines, closeStrip,
};
