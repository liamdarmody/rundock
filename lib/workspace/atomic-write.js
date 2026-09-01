'use strict';
// A staged, journaled multi-destination write: every destination lands, or
// none does, including across process death. The journal under
// `.rundock/import/` is the single source of truth for an interrupted run;
// `recoverPendingWrites` reads it and either discards run-owned temporary
// state (`preparing`) or restores every original destination (`committing`).
// The journal never stores payload bytes: payloads live in the run's staging
// directory and originals in its backup directory until the run completes.

const fs = require('node:fs');
const path = require('node:path');

const IMPORT_SUBDIR = path.join('.rundock', 'import');
const JOURNAL_NAME = 'journal.json';
const JOURNAL_VERSION = 1;
const RUN_DIR = 'run';
const PHASES = ['preparing', 'committing'];

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

function assertInside(root, destination, label) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination)) {
    throw new TypeError(`${label} must be an absolute path inside the workspace`);
  }
  const resolved = path.resolve(destination);
  const relative = path.relative(root, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new TypeError(`${label} must be inside the workspace`);
  }
  const stateRelative = path.relative(importRoot(root), resolved);
  if (!stateRelative || (!stateRelative.startsWith(`..${path.sep}`) && stateRelative !== '..')) {
    throw new TypeError(`${label} cannot use transaction state`);
  }
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
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.destination)) throw new TypeError('duplicate destination in one transaction');
    seen.add(entry.destination);
  }
  for (const entry of entries) {
    for (const other of entries) {
      if (entry === other) continue;
      const between = path.relative(entry.destination, other.destination);
      if (between && !between.startsWith(`..${path.sep}`) && between !== '..' && !path.isAbsolute(between)) {
        throw new TypeError('one destination cannot contain another in the same transaction');
      }
    }
  }
  // Existence and type checks come after every shape check, so a rejected
  // plan is rejected for its first structural fault with nothing touched.
  for (const entry of entries) {
    entry.priorType = priorTypeAt(entry.destination, entry.type);
  }
  return { root, entries };
}

// Ancestor directories the run will have to create, deepest first, so
// recovery can remove exactly what the run added and nothing beside it.
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
  const between = path.relative(root, resolved);
  if (!between || between === '..' || between.startsWith(`..${path.sep}`) || path.isAbsolute(between)) {
    throw invalidJournal(`${label} escapes the workspace`);
  }
  return resolved;
}

function invalidJournal(reason) {
  const error = new Error(`the pending-write journal cannot be trusted (${reason}); it was left in place and blocks writes until repaired`);
  error.code = 'ERR_ATOMIC_JOURNAL';
  return error;
}

// The journal always lands whole: written beside its final name, then
// renamed over it, so no reader can ever observe a half-written journal.
function writeJournal(root, journal) {
  const target = journalPath(root);
  const temporary = `${target}.tmp`;
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

function removeState(root) {
  fs.rmSync(journalPath(root), { force: true });
  fs.rmSync(runRoot(root), { recursive: true, force: true });
  // A completed transaction leaves no residue: the state directories go too,
  // unless something else now lives in them.
  for (const dir of [importRoot(root), path.join(root, '.rundock')]) {
    try { fs.rmdirSync(dir); } catch { /* non-empty or absent: leave it */ }
  }
}

// Every required backup is checked before any destination is touched, so a
// recovery that cannot finish is a recovery that never started.
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

// Put every destination back the way the journal records it: originals are
// copied out of the backup set, destinations the run created are removed.
// Copy rather than rename, so the operation can be repeated after any
// interruption from the same backups.
function restoreFromJournal(root, journal) {
  for (const entry of journal.entries) {
    const destination = fromRelative(root, entry.destination, 'entry destination');
    fs.rmSync(destination, { recursive: true, force: true });
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

function writeAsUnit(workspace, writes, options = {}) {
  const { root, entries } = normalisePlan(workspace, writes, options);
  if (entries.length === 0) return { written: [] };
  const afterStep = options.afterStep || (() => {});
  if (fs.existsSync(journalPath(root))) {
    throw new Error('another write transaction is pending; run recovery before writing');
  }
  // A run directory without a journal is leftover temporary state from a run
  // that never became recoverable; it holds no originals, so clear it.
  fs.rmSync(runRoot(root), { recursive: true, force: true });
  fs.mkdirSync(path.join(runRoot(root), 'staging'), { recursive: true });
  fs.mkdirSync(path.join(runRoot(root), 'backup'), { recursive: true });

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
  };

  try {
    writeJournal(root, journal);
    afterStep({ phase: 'prepare', action: 'journal' });
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
    // Nothing outside the transaction state has been touched, so the state
    // itself is the only thing to undo.
    removeState(root);
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
    restoreFromJournal(root, journal);
    removeState(root);
    throw commitFailure;
  }

  removeState(root);
  return { written: entries.map((entry) => entry.destination) };
}

function recoverPendingWrites(workspace) {
  const root = assertWorkspace(workspace);
  const journal = readJournal(root);
  if (journal === null) return { recovered: 0 };
  if (journal.phase === 'preparing') {
    // Preparation never mutates a destination, so recovery here owns nothing
    // but the run's own temporary state.
    removeState(root);
    return { recovered: 1 };
  }
  assertRestorable(root, journal);
  restoreFromJournal(root, journal);
  removeState(root);
  return { recovered: 1 };
}

module.exports = { writeAsUnit, recoverPendingWrites, journalPath, IMPORT_SUBDIR, JOURNAL_NAME, JOURNAL_VERSION };
