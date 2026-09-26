'use strict';
// Extension view state: a view's own preferences (the widths someone
// dragged, a tab they chose), kept by Rundock for one extension and one note,
// never in the person's notes. The frame asks through the host's closed
// message table (`setState`); the host names the extension and the note from
// its mount, never from the message; this file stores and reads it.
//
// ONE FILE PER EXTENSION PER NOTE:
//   .rundock/extension-state/<extension>/<sha256 of the note path>.json
//   { "path": "<note path>", "state": { ... }, "updatedAt": "<ISO time>" }
// The extension must be an installed one, by its record's name (a slug); the
// file name is a hash, so no part of the path is anything a view sent. The
// resolved file is still checked to sit inside that extension's folder before
// any read or write.
//
// EVERY LIMIT IS HELD HERE AS WELL AS IN THE HOST. Plain JSON only (objects
// with string keys, arrays, strings, finite numbers, booleans, null), at most
// 16 levels deep and 64 KB serialised per note, and per extension at most
// 1 MB and 1,000 notes in all. A write that shrinks or removes state is
// always allowed. A stored file that fails any of this reads as null, so a
// hand-edited or corrupt file never reaches a view.
//
// Kept on update and disable; removed, whole, on uninstall.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { SLUG } = require('./extension-manifest.js');
const { readExtensionRecords, recordFor } = require('./extension-record.js');

const STATE_ROOT = '.rundock/extension-state';
const LIMITS = Object.freeze({ noteBytes: 64 * 1024, depth: 16, extensionBytes: 1024 * 1024, extensionNotes: 1000 });

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

// The note as a workspace-relative path in one spelling, or a refusal.
function notePathOf(note) {
  if (typeof note !== 'string' || !note || note.includes('\\') || note.startsWith('/') || /^[A-Za-z]:/.test(note) || note.endsWith('/')) {
    refuse('invalid-path', 'the note must be a workspace-relative file path');
  }
  const normal = path.posix.normalize(note);
  if (normal === '.' || normal.startsWith('../') || normal === '..') refuse('invalid-path', 'the note must be inside the workspace');
  return normal;
}

/**
 * The one folder that holds an extension's state, absolute. The package
 * uninstall hands it to its transaction as a removal, so the state leaves
 * with the extension or not at all.
 */
function stateFolderFor(workspace, extension) {
  if (typeof extension !== 'string' || !SLUG.test(extension)) refuse('invalid-name', 'not an extension name');
  return path.join(workspace, ...STATE_ROOT.split('/'), extension);
}

// A link anywhere on the way (.rundock, the state root, the extension's
// folder, the file) would carry a read or a write out of Rundock's folder, so
// each is looked at on disk before it is used. Absent is fine: it is made.
function refuseLinks(workspace, file) {
  const steps = [path.join(workspace, '.rundock'), path.join(workspace, ...STATE_ROOT.split('/')), path.dirname(file), file];
  for (const step of steps) {
    let stat = null;
    try { stat = fs.lstatSync(step); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stat && stat.isSymbolicLink()) refuse('invalid-path', 'the view state folder is a link, so nothing is read or written through it');
  }
}

function fileOf(workspace, extension, note) {
  if (typeof extension !== 'string' || !SLUG.test(extension) || !recordFor(readExtensionRecords(workspace), extension)) {
    refuse('not-installed', `no extension named "${extension}" is installed`);
  }
  const folder = stateFolderFor(workspace, extension);
  const file = path.join(folder, `${crypto.createHash('sha256').update(notePathOf(note)).digest('hex')}.json`);
  if (path.dirname(path.resolve(file)) !== path.resolve(folder)) refuse('invalid-path', 'the state file would sit outside its folder');
  refuseLinks(workspace, file);
  return file;
}

const withArticle = (word) => `${/^[AEIO]/.test(word) ? 'an' : 'a'} ${word}`;
const INDEX = /^(0|[1-9][0-9]*)$/;

// Why a value is not plain JSON within the depth limit, naming where, or null.
// Named in the host's own words. Nothing is left for JSON.stringify to change
// quietly: an array is walked by index, so a hole is refused as undefined,
// and any key on it that is not an index is refused; an object's every own
// key is looked at, so a symbol key, a hidden entry (a non-enumerable toJSON)
// or a getter is refused rather than dropped or run.
function jsonProblem(value, depth, where, seen) {
  const at = where ? ` at ${where}` : '';
  const not = (reason) => ({ code: 'not-json', reason: `${reason}${at}` });
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? null : not('a number that is not finite');
  if (typeof value !== 'object') return not(value === undefined ? 'undefined' : withArticle(typeof value));
  if (seen.has(value)) return not('a cycle');
  const isArray = Array.isArray(value);
  const proto = Object.getPrototypeOf(value);
  if (isArray && proto !== Array.prototype) return not('an array that is not plain');
  if (!isArray && proto !== Object.prototype && proto !== null) {
    const tag = Object.prototype.toString.call(value).slice(8, -1);
    return not(tag === 'Object' ? 'an object that is not plain' : withArticle(tag));
  }
  const own = Reflect.ownKeys(value);
  if (isArray && own.some((key) => key !== 'length' && (typeof key !== 'string' || !INDEX.test(key) || Number(key) >= value.length))) {
    return not('an array with named entries');
  }
  if (!isArray && own.some((key) => typeof key === 'symbol')) return not('a symbol key');
  if (depth >= LIMITS.depth) return { code: 'too-deep', reason: `more than ${LIMITS.depth} levels deep${at}` };
  seen.add(value);
  const keys = isArray ? Array.from({ length: value.length }, (_, i) => String(i)) : own;
  for (const key of keys) {
    const inner = where ? `${where}.${key}` : key;
    const entry = Object.getOwnPropertyDescriptor(value, key);
    if (entry && (!('value' in entry) || !entry.enumerable)) return { code: 'not-json', reason: `an entry JSON would not keep as it is at ${inner}` };
    const problem = jsonProblem(entry ? entry.value : undefined, depth + 1, inner, seen);
    if (problem) return problem;
  }
  seen.delete(value);
  return null;
}

// The state as the bytes it would be stored as, or a refusal.
function checked(state, limits) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) refuse('not-object', 'the view state must be an object');
  const problem = jsonProblem(state, 0, '', new Set());
  if (problem) refuse(problem.code, `the view state is not plain JSON: ${problem.reason}`);
  const text = JSON.stringify(state);
  if (Buffer.byteLength(text) > limits.noteBytes) refuse('too-large', `the view state is larger than ${limits.noteBytes / 1024} KB`);
  return text;
}

function readState(workspace, extension, note) {
  let file;
  try {
    file = fileOf(workspace, extension, note);
    const kept = JSON.parse(fs.readFileSync(file, 'utf8'));
    checked(kept && kept.state, LIMITS);
    return kept.state;
  } catch (e) {
    return null;
  }
}

function writeState(workspace, extension, note, state, limits = LIMITS) {
  const file = fileOf(workspace, extension, note);
  if (state === null || state === undefined) {
    fs.rmSync(file, { force: true });
    return;
  }
  // Checked before it is judged empty: a Date, a Map or an object whose only
  // keys are hidden has no enumerable keys either, and is refused rather than
  // taken as a removal. Past the check it is a plain object, so no own key at
  // all means empty.
  const text = checked(state, limits);
  if (Reflect.ownKeys(state).length === 0) {
    fs.rmSync(file, { force: true });
    return;
  }
  const record = JSON.stringify({ path: notePathOf(note), state: JSON.parse(text), updatedAt: new Date().toISOString() });
  // The extension's total, counting this note at its new size.
  const folder = path.dirname(file);
  const others = fs.existsSync(folder) ? fs.readdirSync(folder).filter((name) => name.endsWith('.json') && name !== path.basename(file)) : [];
  const before = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const bytes = others.reduce((sum, name) => sum + fs.statSync(path.join(folder, name)).size, 0) + Buffer.byteLength(record);
  const grows = Buffer.byteLength(record) > before;
  if (grows && (bytes > limits.extensionBytes || others.length + 1 > limits.extensionNotes)) {
    refuse('over-limit', "this extension's view state is over its limit");
  }
  fs.mkdirSync(folder, { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, record);
  fs.renameSync(temporary, file);
}

// Every note's state for one extension, on uninstall.
function removeStateFor(workspace, extension) {
  fs.rmSync(stateFolderFor(workspace, extension), { recursive: true, force: true });
}

module.exports = { STATE_ROOT, LIMITS, readState, writeState, removeStateFor, stateFolderFor };
