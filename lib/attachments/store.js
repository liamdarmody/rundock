'use strict';
// The files a person attaches to a conversation, kept under
// `.rundock/attachments/<id>/` exactly as they were sent, beside a record of
// each message's files and a fingerprint of each. An agent can write anything
// in the workspace, so every path here is walked with lstat and refused at a
// link, every file is created only where nothing is, and the record and the
// deleted list are read as untrusted.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assertSafePath } = require('../workspace/atomic-write.js');
const { writeLandsInside, writeFileExclusive } = require('../workspace/link-safe-write.js');
const { writeWholeFile } = require('../store/whole-file.js');
const { removeDownloadedFolder } = require('../packages/remove-folder.js');
const { checkFiles, LIMITS } = require('./detect.js');

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const BASE_LENGTH = 60;
const NUMBERED = /^([1-9][0-9]{0,8})-/;
const HIGHEST_NUMBER = 999999999;
// The names the write gives a stored file, and the only ones a check joins to
// a path, so a record naming `../anything` is never opened.
const STORED_NAME = /^[1-9][0-9]{0,8}-[A-Za-z0-9_-]{1,60}\.(png|jpg|gif|webp|pdf|txt|md|csv)$/;
const RECORD_NAME = 'record.json';
const DELETED_NAME = 'deleted.json';
// Never through a link at the name, and never waiting on a FIFO. Each reads
// as 0 where the platform has none, and the lstat walk is the guard there.
const READ_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0);
// The largest file the write accepts, of any type. A record claiming more
// describes a file the store never wrote, so none of it is read.
const LARGEST_FILE = Math.max(LIMITS.imageBytes, LIMITS.pdfBytes, LIMITS.textBytes);
// A stored file is read and fingerprinted this much at a time.
const CHUNK = 65536;
// The refusals this module raises itself, passed on as they are.
const OWN_CODES = new Set(['save-failed', 'deleted']);

// A refusal: an Error carrying a code and, where they apply, the figures.
function refusal(code, fields) {
  return Object.assign(new Error(code), { code }, fields);
}

// The conversation ID is the sender's: a string matching the pattern, or
// refused before anything touches the disk.
function checkId(id) {
  if (typeof id !== 'string') throw refusal('bad-id');
  if (!ID_PATTERN.test(id)) throw refusal('bad-id');
}

// The original name's stem, made safe to store and to quote nowhere: NFC,
// leading dots stripped, the last dot and what follows dropped, anything but
// ASCII letters, digits, - and _ made _, runs of _ made one, 60 characters at
// most, a reserved Windows device name prefixed with _, and `file` for
// nothing left.
function storedBase(name) {
  const text = (typeof name === 'string' ? name : '').normalize('NFC').replace(/^\.+/, '');
  const dot = text.lastIndexOf('.');
  const stem = dot === -1 ? text : text.slice(0, dot);
  const cut = stem.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, BASE_LENGTH);
  const base = RESERVED_DEVICE.test(cut) ? `_${cut}` : cut;
  return base || 'file';
}

// One chain per conversation in this process: each ID's tail promise, gone
// once its last call has settled.
const queues = new Map();

// Runs `fn` once every earlier call for the same ID has settled, and settles
// as it does. One ID never waits on another.
function withConversationLock(id, fn) {
  const before = queues.get(id) || Promise.resolve();
  const run = before.then(() => fn());
  const tail = run.then(() => {}, () => {});
  queues.set(id, tail);
  tail.then(() => { if (queues.get(id) === tail) queues.delete(id); });
  return run;
}

const attachmentsDir = (root) => path.join(root, '.rundock', 'attachments');
const nameOf = (name) => (typeof name === 'string' ? name : '');

// Refuses with `code` unless `target` is inside the workspace and no
// component from the workspace down to it is a link. Called only on
// `.rundock/attachments` and below.
function walk(root, target, code) {
  assertSafePath(root, target, () => { throw refusal(code); });
}

// The parsed JSON at `file`, or undefined when nothing is there. Reached with
// no link on the way, opened without following one, and read only when the
// open handle is a regular file; anything else throws `code`.
function readJsonFile(root, file, code) {
  walk(root, file, code);
  let fd;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (e) {
    if (e && e.code === 'ENOENT') return undefined;
    throw refusal(code);
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw refusal(code);
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (e) {
    throw refusal(code);
  } finally {
    fs.closeSync(fd);
  }
}

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function loadRecord(root, id, code) {
  const value = readJsonFile(root, path.join(attachmentsDir(root), id, RECORD_NAME), code);
  if (value === undefined) return { messages: [], sent: {} };
  if (!isObject(value) || !Array.isArray(value.messages) || !isObject(value.sent)) throw refusal(code);
  return value;
}

// The IDs of deleted conversations: an array of IDs, or nothing there.
function loadDeleted(root, code) {
  const value = readJsonFile(root, path.join(attachmentsDir(root), DELETED_NAME), code);
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && ID_PATTERN.test(entry))) throw refusal(code);
  return value;
}

/**
 * A conversation's record, `{ messages, sent }`, or no messages when there is
 * none. Throws `bad-id` for a bad ID and `record-unreadable` for a record
 * reached through a link, one that is not a regular file, or one that does
 * not parse or has the wrong shape.
 */
function readRecord(workspace, id) {
  checkId(id);
  return loadRecord(path.resolve(workspace), id, 'record-unreadable');
}

// The highest number used by the folder's entries (links and anything else
// included) or the record's stored names.
function highestNumber(folder, record) {
  const names = fs.readdirSync(folder);
  for (const message of record.messages) {
    const files = message && Array.isArray(message.files) ? message.files : [];
    for (const described of files) if (described && typeof described.file === 'string') names.push(described.file);
  }
  return names.reduce((most, name) => {
    const found = NUMBERED.exec(name);
    return found ? Math.max(most, Number(found[1])) : most;
  }, 0);
}

function describeFile(stored, file, kind) {
  const described = { file: stored, name: nameOf(file.name), type: kind.type, bytes: file.bytes.length };
  described.sha256 = crypto.createHash('sha256').update(file.bytes).digest('hex');
  if (kind.width !== undefined) Object.assign(described, { width: kind.width, height: kind.height });
  return described;
}

// Removes the files a failed write created, once the folder is walked again:
// when the walk finds a link, nothing is removed through it.
function discard(root, folder, created) {
  if (created.length === 0) return;
  try { walk(root, folder, 'save-failed'); } catch (e) { return; }
  for (const target of created) {
    try { fs.rmSync(target, { force: true }); } catch (e) { /* the write's own failure is the one to report */ }
  }
}

// The record's bytes as they are before a write replaces it, or null when
// there is none, opened as readJsonFile opens it.
function recordBytes(root, file) {
  walk(root, file, 'save-failed');
  let fd;
  try {
    fd = fs.openSync(file, READ_FLAGS);
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw refusal('save-failed');
  }
  try {
    if (!fs.fstatSync(fd).isFile()) throw refusal('save-failed');
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Puts the record back as it was before a write whose files failed their
// check: its earlier bytes, or no record when the write made the first one.
// Once the folder is walked again, so nothing is written through a link.
function putBack(root, folder, recordFile, before) {
  try { walk(root, folder, 'save-failed'); } catch (e) { return; }
  try {
    if (before === null) fs.rmSync(recordFile, { force: true });
    else writeWholeFile(recordFile, before);
  } catch (e) { /* the failed check is the one to report */ }
}

function failure(e, file) {
  if (e && e.code === 'ENOSPC') return refusal('disk-full', { name: nameOf(file.name) });
  if (e && OWN_CODES.has(e.code)) return e;
  return refusal('save-failed');
}

function writeLocked(root, id, files, kinds, create, admit) {
  const deleted = loadDeleted(root, 'save-failed');
  if (deleted.includes(id)) throw refusal('deleted');
  const folder = path.join(attachmentsDir(root), id);
  const recordFile = path.join(folder, RECORD_NAME);
  walk(root, folder, 'save-failed');
  const previous = loadRecord(root, id, 'save-failed');
  // Asked before anything is written, so its refusal leaves all as it was.
  const admitted = admit ? admit(previous) : undefined;
  const created = [];
  const stored = [];
  let current = files[0];
  try {
    fs.mkdirSync(folder, { recursive: true });
    let next = highestNumber(folder, previous) + 1;
    for (const [index, file] of files.entries()) {
      current = file;
      const base = storedBase(file.name);
      for (;;) {
        if (next > HIGHEST_NUMBER) throw refusal('save-failed');
        const name = `${next}-${base}.${kinds[index].type}`;
        const target = path.join(folder, name);
        next += 1;
        walk(root, target, 'save-failed');
        if (!writeLandsInside(target, [root])) throw refusal('save-failed');
        try {
          create(target, file.bytes);
        } catch (e) {
          if (e && (e.code === 'EEXIST' || e.code === 'ELOOP')) continue;
          throw e;
        }
        created.push(target);
        stored.push(describeFile(name, file, kinds[index]));
        break;
      }
    }
    current = files[0];
    walk(root, folder, 'save-failed');
    const entry = { id: crypto.randomUUID(), files: stored };
    const before = recordBytes(root, recordFile);
    writeWholeFile(recordFile, JSON.stringify({ messages: [...previous.messages, entry], sent: previous.sent }));
    if (!stored.every((described) => checkRecordedFile(root, id, described.file) === 'present')) {
      putBack(root, folder, recordFile, before);
      throw refusal('save-failed');
    }
    if (admitted) admitted(entry);
    return entry;
  } catch (e) {
    discard(root, folder, created);
    throw failure(e, current);
  }
}

/**
 * Store a message's files under `.rundock/attachments/<id>/`, each at a new
 * numbered name, then add their entry to the record; resolves the entry, or
 * null for no files. Refuses a bad ID and anything over a limit before
 * touching the disk. Once the record is written, still under the lock, each
 * new file is checked as checkRecordedFile checks it, and one that isn't
 * `present` fails the write with `save-failed`. A failure leaves the folder's
 * files and the record as they were. `admit(record)`, when given, is called
 * under the lock with the record as it is before the write, and refuses by
 * throwing, with nothing written; a function it answers is called with the
 * entry once the write has held, still under the lock. `create` is a seam for
 * tests; the server never passes it.
 */
async function writeMessageFiles(workspace, id, files, { create = writeFileExclusive, admit } = {}) {
  checkId(id);
  const kinds = checkFiles(files);
  if (kinds.length === 0) return null;
  const root = path.resolve(workspace);
  return withConversationLock(id, () => writeLocked(root, id, files, kinds, create, admit));
}

// The record's description of the stored file `file`, or undefined.
function listed(record, file) {
  for (const message of record.messages) {
    const files = message && Array.isArray(message.files) ? message.files : [];
    const found = files.find((described) => described && described.file === file);
    if (found) return found;
  }
  return undefined;
}

// Up to `most` bytes from the start of `fd`, fingerprinted as they are read,
// as `{ length, sum, bytes }`. Only with `keep` are the bytes held, so a file
// that won't be sent never takes more memory than one chunk.
function readAtMost(fd, most, keep) {
  const hash = crypto.createHash('sha256');
  const into = Buffer.alloc(keep ? most : Math.min(CHUNK, most));
  let length = 0;
  while (length < most) {
    const at = keep ? length : 0;
    const n = fs.readSync(fd, into, at, Math.min(CHUNK, most - length), length);
    if (n === 0) break;
    hash.update(into.subarray(at, at + n));
    length += n;
  }
  return { length, sum: hash.digest('hex'), bytes: keep ? into.subarray(0, length) : undefined };
}

// The file's state and the record's description of it, with the bytes the
// state was judged on when it is present and `keep` is set: one open, one
// read. A recorded size past LARGEST_FILE is not available, and nothing is
// opened.
function inspect(root, id, file, { keep = true } = {}) {
  const described = listed(loadRecord(root, id, 'record-unreadable'), file);
  if (!described) return { state: 'missing', described };
  if (typeof described.bytes === 'number' && described.bytes > LARGEST_FILE) return { state: 'missing', described };
  const target = path.join(attachmentsDir(root), id, file);
  walk(root, target, 'record-unreadable');
  let fd;
  try {
    fd = fs.openSync(target, READ_FLAGS);
  } catch (e) {
    return { state: 'missing', described };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { state: 'missing', described };
    if (stat.size !== described.bytes) return { state: 'changed', described };
    // One byte past the recorded size, so a file grown since the stat shows.
    const read = readAtMost(fd, described.bytes + 1, keep);
    if (read.length !== described.bytes) return { state: 'changed', described };
    if (read.sum !== described.sha256) return { state: 'changed', described };
    return keep ? { state: 'present', described, bytes: read.bytes } : { state: 'present', described };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Whether a stored file is still as the person sent it: `present`, `changed`
 * (its size or its fingerprint differs from the record's) or `missing` (a
 * name off the stored-name pattern, one the record doesn't list, an
 * unreadable record, a recorded size past any file the store writes, a link
 * on the way or at the name, anything but a regular file, or nothing there).
 * Throws only `bad-id`.
 */
function checkRecordedFile(workspace, id, file) {
  checkId(id);
  if (typeof file !== 'string' || !STORED_NAME.test(file)) return 'missing';
  try {
    return inspect(path.resolve(workspace), id, file, { keep: false }).state;
  } catch (e) {
    return 'missing';
  }
}

/**
 * A stored file as checkRecordedFile judges it, read in the same open:
 * `{ state, described, bytes }`, with `described` the record's description
 * when the record lists the file and `bytes` the file's contents only when
 * `state` is `present`. `options.keep` false leaves `bytes` out. Throws only
 * `bad-id`.
 */
function readRecordedFile(workspace, id, file, options) {
  checkId(id);
  if (typeof file !== 'string' || !STORED_NAME.test(file)) return { state: 'missing', described: undefined };
  try {
    return inspect(path.resolve(workspace), id, file, options);
  } catch (e) {
    return { state: 'missing', described: undefined };
  }
}

// Removes `<id>`: only the link when it is one, a dangling link included
// (which removeDownloadedFolder would leave, as its first check follows the
// link), the folder and everything in it otherwise, and nothing when nothing
// is there.
function removeEntry(target) {
  let found;
  try {
    found = fs.lstatSync(target);
  } catch (e) {
    if (e && e.code === 'ENOENT') return;
    throw e;
  }
  if (found.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  removeDownloadedFolder(target);
}

function deleteLocked(root, id) {
  const dir = attachmentsDir(root);
  const target = path.join(dir, id);
  if (path.dirname(target) !== dir) throw refusal('delete-refused');
  try {
    walk(root, dir, 'delete-refused');
    const deleted = loadDeleted(root, 'delete-refused');
    if (!deleted.includes(id)) {
      fs.mkdirSync(dir, { recursive: true });
      walk(root, dir, 'delete-refused');
      writeWholeFile(path.join(dir, DELETED_NAME), JSON.stringify([...deleted, id]));
    }
    walk(root, dir, 'delete-refused');
    removeEntry(target);
  } catch (e) {
    throw refusal('delete-refused');
  }
}

/**
 * Delete a conversation's attachments: list its ID in `deleted.json`, so no
 * later write recreates them, then remove `.rundock/attachments/<id>`.
 * Resolves undefined, also when there was nothing to remove. Throws `bad-id`
 * for a bad ID, and `delete-refused`, with nothing removed, for a link at
 * `.rundock` or `attachments`, an unreadable deleted list or any other
 * failure.
 */
async function deleteAttachments(workspace, id) {
  checkId(id);
  const root = path.resolve(workspace);
  return withConversationLock(id, () => deleteLocked(root, id));
}

// What a session was sent natively, as `sent` keeps it per session: the
// stored names, the sum of their recorded bytes and how many are images.
const isCount = (value) => Number.isInteger(value) && value >= 0;
function wellFormed(entry) {
  return isObject(entry) && isCount(entry.bytes) && isCount(entry.images)
    && Array.isArray(entry.files) && entry.files.every((file) => typeof file === 'string');
}
const NO_ENTRY = Object.freeze({ files: Object.freeze([]), bytes: 0, images: 0 });
// An entry of the wrong shape counts as the whole budget spent, so a session
// whose entry was edited is sent no native copy.
const SPENT = Object.freeze({ files: Object.freeze([]), bytes: Infinity, images: Infinity });

/**
 * The entry `sent` keeps for `session`, as counted against the budget: an
 * empty one when `session` isn't a string or names no own entry, and one
 * that is spent when the entry has the wrong shape.
 */
function sentEntry(sent, session) {
  if (typeof session !== 'string' || !isObject(sent) || !Object.prototype.hasOwnProperty.call(sent, session)) return NO_ENTRY;
  const entry = sent[session];
  if (!wellFormed(entry)) return SPENT;
  return entry;
}

/**
 * Add what `session` was just sent natively to its entry in the record's
 * `sent`: `bytes` and `images` added to its totals, each of `files` listed
 * once, and `instance` set when one is given. With `replace`, the entry
 * becomes `sent` and `instance` alone. Synchronous, so nothing else touches
 * the record between its read and its write, and walked as a write is.
 * Answers whether it wrote: nothing is written for a session that isn't a
 * non-empty string, a conversation with no record or a deleted one, a link
 * on the way, or an entry of the wrong shape.
 */
function recordSent(workspace, conversationId, session, sent, { instance, replace } = {}) {
  if (typeof session !== 'string' || session === '' || !wellFormed(sent)) return false;
  try {
    checkId(conversationId);
    const root = path.resolve(workspace);
    if (loadDeleted(root, 'save-failed').includes(conversationId)) return false;
    const folder = path.join(attachmentsDir(root), conversationId);
    walk(root, folder, 'save-failed');
    const recordFile = path.join(folder, RECORD_NAME);
    const record = readJsonFile(root, recordFile, 'save-failed');
    if (!isObject(record) || !Array.isArray(record.messages) || !isObject(record.sent)) return false;
    const own = Object.prototype.hasOwnProperty.call(record.sent, session);
    if (own && !wellFormed(record.sent[session])) return false;
    const before = own && !replace ? record.sent[session] : NO_ENTRY;
    const entry = replace ? {} : { ...before };
    entry.files = [...new Set([...before.files, ...sent.files])];
    entry.bytes = before.bytes + sent.bytes;
    entry.images = before.images + sent.images;
    if (typeof instance === 'string') entry.instance = instance;
    // Set as a property of its own, so a session named `__proto__` is an
    // entry like any other and never the object's prototype.
    const next = { ...record.sent };
    Object.defineProperty(next, session, { value: entry, enumerable: true, writable: true, configurable: true });
    walk(root, folder, 'save-failed');
    writeWholeFile(recordFile, JSON.stringify({ ...record, sent: next }));
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  ID_PATTERN, storedBase, withConversationLock, writeMessageFiles, readRecord, checkRecordedFile, deleteAttachments,
  STORED_NAME, readRecordedFile, sentEntry, recordSent,
};
