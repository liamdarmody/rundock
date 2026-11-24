'use strict';
// The files a person attaches to a conversation, kept under
// `.rundock/attachments/<id>/` exactly as they were sent, beside a record of
// each message's files and a fingerprint of each. An agent can write anything
// in the workspace, so every path here is walked with lstat and refused at a
// link, every file is created only where nothing is, and the record and the
// deleted list are read as untrusted.

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_DEVICE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const BASE_LENGTH = 60;

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

module.exports = { ID_PATTERN, storedBase, withConversationLock };
