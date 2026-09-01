'use strict';
// A staged, journaled multi-destination write: every destination lands, or
// none does, including across process death. The journal under
// `.rundock/import/` is the sole truth for an interrupted run;
// `recoverPendingWrites` discards run-owned state (`preparing`) or restores
// every original (`committing`). The journal never stores payload bytes:
// payloads stage and originals back up in the run directory until done.
//
// Contract: destinations must not be written by anyone else during a call.
// The primitive locks its journal, not the destinations, so a file another
// writer creates at a destination recorded absent is replaced, unbacked.

const fs = require('node:fs');
const path = require('node:path');

const STATE_SUBDIR = '.rundock';
const IMPORT_SUBDIR = path.join(STATE_SUBDIR, 'import');
const JOURNAL_NAME = 'journal.json';
const JOURNAL_VERSION = 1;
const RUN_DIR = 'run';
const PHASES = ['preparing', 'committing'];
// State dirs, deepest first, recorded per run when created.
const STATE_DIRS = [IMPORT_SUBDIR, STATE_SUBDIR].map((dir) => dir.split(path.sep).join('/'));

function importRoot(workspace) {
  return path.join(workspace, IMPORT_SUBDIR);
}

function journalPath(workspace) {
  return path.join(importRoot(workspace), JOURNAL_NAME);
}

function runRoot(workspace) {
  return path.join(importRoot(workspace), RUN_DIR);
}

function assertWorkspace(workspace) {
  if (typeof workspace !== 'string' || workspace.length === 0) {
    throw new TypeError('workspace must be a non-empty path');
  }
  const root = path.resolve(workspace);
  if (!fs.statSync(root).isDirectory()) throw new TypeError('workspace must be a directory');
  return root;
}

// Identity for path comparison: case and Unicode form are folded
// unconditionally, a superset of any volume's own folding, so the state and
// duplicate rules hold on insensitive filesystems without probing. The
// deliberate cost: no case-twin paths in one call anywhere.
function foldKey(p) {
  return p.normalize('NFC').toLowerCase();
}

// Is `child` strictly inside `parent`? Never true for equality, an escape,
// or a path on another root; callers fold both sides for identity questions.
function strictlyInside(parent, child) {
  const between = path.relative(parent, child);
  return Boolean(between) && between !== '..' && !between.startsWith(`..${path.sep}`) && !path.isAbsolute(between);
}

// THE one path-safety rule, applied identically to caller destinations and
// journal records, so nothing recovery acts on can be a path the writer
// would refuse: strictly inside the workspace, clear of the state root
// `.rundock` (not it, not inside it, not containing it, compared folded),
// and no existing component on the way down a symlink, which would carry a
// lexically-inside path outside the workspace.
function assertSafePath(root, resolved, raise) {
  if (!strictlyInside(root, resolved)) raise('must stay inside the workspace');
  const state = foldKey(path.join(root, STATE_SUBDIR));
  const folded = foldKey(resolved);
  if (folded === state || strictlyInside(state, folded) || strictlyInside(folded, state)) {
    raise('cannot use transaction state');
  }
  let current = root;
  for (const part of path.relative(root, resolved).split(path.sep)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return; // nothing further down exists yet, so nothing can be a symlink
    }
    if (stat.isSymbolicLink()) raise('passes through a symlink, which writes never follow');
  }
}

function assertInside(root, destination, label) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new TypeError(`${label} must be an absolute path inside the workspace`);
  }
  const resolved = path.resolve(destination);
  assertSafePath(root, resolved, (why) => {
    throw new TypeError(`${label} ${why}`);
  });
  return resolved;
}

// What is currently at a destination, by lstat so a symlink is seen as
// itself rather than as what it points to. Anything that is not a regular
// file, a directory, or absent is refused before any state is created.
function priorTypeAt(destination, wanted) {
  let stat;
  try {
    stat = fs.lstatSync(destination);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) throw new TypeError('destination is a symlink, which writes never follow or replace');
  if (stat.isFile()) {
    if (wanted === 'dir') throw new TypeError('directory destination is currently a file');
    return 'file';
  }
  if (stat.isDirectory()) {
    if (wanted === 'file') throw new TypeError('file destination is currently a directory');
    return 'dir';
  }
  throw new TypeError('destination is an unsupported filesystem entry type');
}

function normalisePlan(workspace, writes, options) {
  const root = assertWorkspace(workspace);
  if (!Array.isArray(writes)) throw new TypeError('writes must be an array');
  const replaceDirs = options.replaceDirs === undefined ? [] : options.replaceDirs;
  if (!Array.isArray(replaceDirs)) throw new TypeError('replaceDirs must be an array');
  if (options.afterStep !== undefined && typeof options.afterStep !== 'function') {
    throw new TypeError('afterStep must be a function');
  }
  const entries = [];
  for (const write of writes) {
    if (!write || !Object.hasOwn(write, 'content') || !(typeof write.content === 'string' || Buffer.isBuffer(write.content))) {
      throw new TypeError('file content must be a string or Buffer');
    }
    entries.push({ type: 'file', destination: assertInside(root, write.path, 'destination'), content: write.content });
  }
  for (const replacement of replaceDirs) {
    if (!replacement || !Array.isArray(replacement.files)) throw new TypeError('replacement files must be an array');
    const files = replacement.files.map((file) => {
      if (!file || typeof file.rel !== 'string' || !file.rel || path.isAbsolute(file.rel)) {
        throw new TypeError('replacement file path must be relative');
      }
      const normal = path.normalize(file.rel);
      if (normal === '..' || normal.startsWith(`..${path.sep}`)) throw new TypeError('replacement file path must stay inside its directory');
      if (!(typeof file.content === 'string' || Buffer.isBuffer(file.content))) {
        throw new TypeError('replacement file content must be a string or Buffer');
      }
      return { relative: normal, content: file.content };
    });
    entries.push({ type: 'dir', destination: assertInside(root, replacement.path, 'destination'), files });
  }
  // Destination identity is decided folded, same as the state rule.
  const seen = new Set();
  for (const entry of entries) {
    const key = foldKey(entry.destination);
    if (seen.has(key)) throw new TypeError('duplicate destination in one transaction');
    seen.add(key);
  }
  for (const entry of entries) {
    for (const other of entries) {
      if (entry !== other && strictlyInside(foldKey(entry.destination), foldKey(other.destination))) {
        throw new TypeError('one destination cannot contain another in the same transaction');
      }
    }
  }
  // Existence and type checks come after every shape check.
  for (const entry of entries) {
    entry.priorType = priorTypeAt(entry.destination, entry.type);
  }
  return { root, entries };
}

// Ancestor directories the run must create, deepest first (ancestors are
// prefixes, so longer means deeper within a chain; cross-chain order does
// not affect removal), so recovery removes exactly what the run added.
function plannedParents(root, entries) {
  const planned = new Set();
  for (const entry of entries) {
    let dir = path.dirname(entry.destination);
    while (dir !== root && !fs.existsSync(dir)) {
      planned.add(dir);
      dir = path.dirname(dir);
    }
  }
  return [...planned].sort((a, b) => b.length - a.length).map((dir) => toRelative(root, dir));
}

function toRelative(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function fromRelative(root, relative, label) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative)) {
    throw invalidJournal(`${label} must be a relative path`);
  }
  const resolved = path.resolve(root, relative.split('/').join(path.sep));
  assertSafePath(root, resolved, (why) => {
    throw invalidJournal(`${label} ${why}`);
  });
  return resolved;
}

function invalidJournal(reason) {
  const error = new Error(`the pending-write journal cannot be trusted (${reason}); it was left in place and blocks writes until repaired`);
  error.code = 'ERR_ATOMIC_JOURNAL';
  return error;
}

// The exclusive create IS the single-transaction guard: two runs racing it
// cannot both win, and the loser leaves what is there byte-for-byte.
function createJournal(root, journal) {
  fs.mkdirSync(importRoot(root), { recursive: true });
  try {
    fs.writeFileSync(journalPath(root), `${JSON.stringify(journal, null, 2)}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code === 'EEXIST' || e.code === 'EISDIR') {
      throw new Error('another write transaction is pending; run recovery before writing');
    }
    throw e;
  }
}

// A journal update lands whole: written under a run-unique temporary name,
// then renamed over, so nothing observes a half-written journal.
function writeJournal(root, journal) {
  const target = journalPath(root);
  const temporary = `${target}.${journal.runId}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(journal, null, 2)}\n`);
  fs.renameSync(temporary, target);
}

function readJournal(root) {
  let text;
  try {
    text = fs.readFileSync(journalPath(root), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw invalidJournal(`unreadable: ${e.message}`);
  }
  let journal;
  try {
    journal = JSON.parse(text);
  } catch {
    throw invalidJournal('malformed JSON');
  }
  if (!journal || typeof journal !== 'object') throw invalidJournal('not an object');
  if (journal.version !== JOURNAL_VERSION) throw invalidJournal(`unsupported version ${JSON.stringify(journal.version)}`);
  if (!PHASES.includes(journal.phase)) throw invalidJournal(`unknown phase ${JSON.stringify(journal.phase)}`);
  if (typeof journal.runId !== 'string' || !journal.runId) throw invalidJournal('missing run identity');
  if (!Array.isArray(journal.entries) || !Array.isArray(journal.createdDirs)) throw invalidJournal('missing entry or directory records');
  if (!Array.isArray(journal.createdState) || journal.createdState.some((dir) => !STATE_DIRS.includes(dir))) {
    throw invalidJournal('missing or unsafe state-ownership record');
  }
  for (const entry of journal.entries) {
    if (!entry || !['file', 'dir'].includes(entry.type)) throw invalidJournal('entry has an unsupported type');
    if (!['file', 'dir', 'absent'].includes(entry.priorType)) throw invalidJournal('entry has an unsupported prior type');
    if (!/^\d+$/.test(String(entry.slot))) throw invalidJournal('entry has an unsafe slot name');
    fromRelative(root, entry.destination, 'entry destination');
  }
  for (const dir of journal.createdDirs) fromRelative(root, dir, 'created directory');
  return journal;
}

function stagingPath(root, slot) {
  return path.join(runRoot(root), 'staging', String(slot));
}

function backupPath(root, slot) {
  return path.join(runRoot(root), 'backup', String(slot));
}

function removeState(root, createdState) {
  fs.rmSync(journalPath(root), { force: true });
  fs.rmSync(runRoot(root), { recursive: true, force: true });
  // A surviving journal temporary is run-owned ephemera by construction.
  let names = [];
  try { names = fs.readdirSync(importRoot(root)); } catch { /* already gone */ }
  for (const name of names) {
    if (name.startsWith(`${JOURNAL_NAME}.`) && name.endsWith('.tmp')) {
      fs.rmSync(path.join(importRoot(root), name), { force: true });
    }
  }
  // The state directories go only when this run recorded creating them, and
  // only while empty: a pre-existing `.rundock` belongs to the workspace.
  for (const relative of createdState) {
    try { fs.rmdirSync(path.join(root, relative.split('/').join(path.sep))); } catch { /* non-empty or absent: leave it */ }
  }
}

// Every backup is checked before any destination is touched.
function assertRestorable(root, journal) {
  for (const entry of journal.entries) {
    if (entry.priorType === 'absent') continue;
    let stat;
    try {
      stat = fs.lstatSync(backupPath(root, entry.slot));
    } catch {
      throw invalidJournal(`backup ${entry.slot} is missing`);
    }
    const wrongType = entry.priorType === 'file' ? !stat.isFile() : !stat.isDirectory();
    if (wrongType) throw invalidJournal(`backup ${entry.slot} is not a ${entry.priorType}`);
  }
}

// Put every destination back as the journal records it: originals COPIED
// from the backup set (never renamed, so the operation repeats after any
// interruption), run-created destinations removed.
function restoreFromJournal(root, journal) {
  for (const entry of journal.entries) {
    const destination = fromRelative(root, entry.destination, 'entry destination');
    fs.rmSync(destination, { recursive: true, force: true });
    if (entry.priorType === 'absent') continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (entry.priorType === 'file') fs.cpSync(backupPath(root, entry.slot), destination);
    if (entry.priorType === 'dir') fs.cpSync(backupPath(root, entry.slot), destination, { recursive: true });
  }
  for (const relative of journal.createdDirs) {
    const dir = fromRelative(root, relative, 'created directory');
    try {
      fs.rmdirSync(dir); // refuses a non-empty directory, which is the point
    } catch { /* foreign content or already gone: leave it */ }
  }
}

// The one undo: a live failure and an interrupted run heal identically.
function undoFromJournal(root, journal) {
  assertRestorable(root, journal);
  restoreFromJournal(root, journal);
  removeState(root, journal.createdState);
}

function writeAsUnit(workspace, writes, options = {}) {
  const { root, entries } = normalisePlan(workspace, writes, options);
  if (entries.length === 0) return { written: [] };
  const afterStep = options.afterStep || (() => {});

  const journal = {
    version: JOURNAL_VERSION,
    runId: `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    phase: 'preparing',
    entries: entries.map((entry, slot) => ({
      slot,
      type: entry.type,
      priorType: entry.priorType,
      destination: toRelative(root, entry.destination),
    })),
    createdDirs: plannedParents(root, entries),
    createdState: STATE_DIRS.filter((dir) => !fs.existsSync(path.join(root, dir.split('/').join(path.sep)))),
  };

  createJournal(root, journal);
  try {
    afterStep({ phase: 'prepare', action: 'journal' });
    // A journal-less run directory holds no originals; clear the leftover.
    fs.rmSync(runRoot(root), { recursive: true, force: true });
    fs.mkdirSync(path.join(runRoot(root), 'staging'), { recursive: true });
    fs.mkdirSync(path.join(runRoot(root), 'backup'), { recursive: true });
    for (const [slot, entry] of entries.entries()) {
      if (entry.type === 'file') {
        fs.writeFileSync(stagingPath(root, slot), entry.content);
      } else {
        fs.mkdirSync(stagingPath(root, slot), { recursive: true });
        for (const file of entry.files) {
          const staged = path.join(stagingPath(root, slot), file.relative);
          fs.mkdirSync(path.dirname(staged), { recursive: true });
          fs.writeFileSync(staged, file.content);
        }
      }
      afterStep({ phase: 'prepare', action: 'stage', destination: entry.destination });
    }
    for (const [slot, entry] of entries.entries()) {
      if (entry.priorType === 'file') fs.cpSync(entry.destination, backupPath(root, slot));
      if (entry.priorType === 'dir') fs.cpSync(entry.destination, backupPath(root, slot), { recursive: true });
      if (entry.priorType !== 'absent') afterStep({ phase: 'prepare', action: 'backup', destination: entry.destination });
    }
  } catch (preparationFailure) {
    // Nothing outside the transaction state has been touched yet.
    removeState(root, journal.createdState);
    throw preparationFailure;
  }

  try {
    journal.phase = 'committing';
    writeJournal(root, journal);
    afterStep({ phase: 'commit', action: 'transition' });
    for (const [slot, entry] of entries.entries()) {
      fs.mkdirSync(path.dirname(entry.destination), { recursive: true });
      if (entry.priorType !== 'absent') {
        fs.rmSync(entry.destination, { recursive: true, force: true });
        afterStep({ phase: 'commit', action: 'remove', destination: entry.destination });
      }
      fs.renameSync(stagingPath(root, slot), entry.destination);
      afterStep({ phase: 'commit', action: 'rename', destination: entry.destination });
    }
  } catch (commitFailure) {
    // The undo preflights the backup set before removing anything; if it
    // cannot proceed, the journal stays and the original failure is `cause`.
    try {
      undoFromJournal(root, journal);
    } catch (rollbackFailure) {
      rollbackFailure.cause = commitFailure;
      throw rollbackFailure;
    }
    throw commitFailure;
  }

  removeState(root, journal.createdState);
  return { written: entries.map((entry) => entry.destination) };
}

function recoverPendingWrites(workspace) {
  const root = assertWorkspace(workspace);
  const journal = readJournal(root);
  if (journal === null) return { recovered: 0 };
  if (journal.phase === 'preparing') {
    // Preparation never mutates a destination: only run-owned state to undo.
    removeState(root, journal.createdState);
    return { recovered: 1 };
  }
  undoFromJournal(root, journal);
  return { recovered: 1 };
}

module.exports = { writeAsUnit, recoverPendingWrites, journalPath, IMPORT_SUBDIR, JOURNAL_NAME, JOURNAL_VERSION };
