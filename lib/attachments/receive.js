'use strict';
// A chat message's attachments, from the page's payload to the record. The
// payload is the sender's, so its shape is checked in a fixed order before
// anything is decoded or written: a reference beside the files, the files'
// container, the conversation ID, the typed text, the count (before any
// element is read), each element's shape, then canonical base64. The store
// then checks every limit and writes all or nothing. From there the message
// carries the stored text and the record entry's ID, never the file data.
// For an agent on Codex, the files' types and sizes are checked once more
// before the write, against what Codex can be sent (codexRefusal).

const fs = require('fs');
const path = require('path');
const { ID_PATTERN, writeMessageFiles, readRecord, sentEntry } = require('./store.js');
const { LIMITS, checkFiles, withinBudget } = require('./detect.js');
const { getWorkspace } = require('../config.js');
const { formatSize, refusalWording } = require('../../public/attachment-wording.js');

// The largest WebSocket frame the server reads. 20,000,000 bytes of files is
// 26,666,668 bytes as base64, which leaves room for the text and the rest.
const MAX_PAYLOAD = 28000000;

// How a stored line names each type the store can keep.
const LABELS = Object.freeze({
  png: 'PNG image', jpg: 'JPEG image', gif: 'GIF image', webp: 'WebP image',
  pdf: 'PDF document', txt: 'text file', md: 'Markdown file', csv: 'CSV file',
});

// The types a Codex agent is sent as images of its own.
const IMAGE_TYPES = new Set(['png', 'jpg', 'gif', 'webp']);

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function refusal(code, fields) {
  return Object.assign(new Error(code), { code }, fields);
}

// The payload's files as `{ name, bytes }`, or the first refusal in order.
function decodePayload(msg) {
  if (own(msg, 'attachmentEntry')) throw refusal('bad-payload');
  const list = msg.attachments;
  if (!Array.isArray(list)) throw refusal('bad-payload');
  const id = msg.conversationId;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw refusal('bad-id');
  if (typeof msg.content !== 'string') throw refusal('bad-payload');
  const count = list.length;
  if (count > LIMITS.files) throw refusal('too-many-files', { count, limit: LIMITS.files });
  const elements = [];
  for (let i = 0; i < count; i++) {
    const element = list[i];
    if (!isPlainObject(element) || typeof element.name !== 'string' || typeof element.data !== 'string') throw refusal('bad-payload');
    elements.push(element);
  }
  return elements.map(({ name, data }) => {
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data) throw refusal('bad-payload');
    return { name, bytes };
  });
}

// The typed text, then one line per stored file; with no typed text, the
// first line starts the text.
function storedText(content, id, entry) {
  const lines = entry.files.map((f) => `[Attached: .rundock/attachments/${id}/${f.file} (${LABELS[f.type]}, ${formatSize(f.bytes)})]`);
  return content ? [content, ...lines].join('\n') : lines.join('\n');
}

// What a Codex agent can't be sent, refused before the write, once every
// limit has been checked: a PDF, which Codex can't read, then images that
// would take the session `msg.sessionId` names past the budget, counted with
// what its record entry says it was already sent (none when it names no
// entry, spent when the entry has the wrong shape). A message with no image
// is never refused for images. A record that can't be read is left to the
// write, which refuses it.
function codexRefusal(workspace, msg, files) {
  const kinds = checkFiles(files);
  const pdf = kinds.findIndex((kind) => kind.type === 'pdf');
  if (pdf !== -1) throw refusal('codex-pdf', { name: files[pdf].name });
  const images = files.filter((file, i) => IMAGE_TYPES.has(kinds[i].type));
  if (images.length === 0) return;
  let record;
  try { record = readRecord(workspace, msg.conversationId); } catch (e) { return; }
  const entry = sentEntry(record.sent, msg.sessionId);
  const bytes = images.reduce((sum, file) => sum + file.bytes.length, entry.bytes);
  if (!withinBudget({ bytes, images: entry.images + images.length })) throw refusal('codex-images');
}

/**
 * Check a chat message's `attachments`, store them and their record entry,
 * and resolve `{ content, entry }`: the text the message carries from now on
 * and the new entry, or `entry` null when the message sent no files. Rejects
 * with an Error carrying `code` (and the store's `name`, `bytes`, `limit` or
 * `count` where they apply), with nothing written. `create` is the store's
 * seam for tests; the server never passes it. `runtime` is what the agent the
 * message goes to runs on; for 'codex', a message Codex can't be sent is
 * refused before the write (codexRefusal).
 */
async function receiveAttachments(workspace, msg, { create, runtime } = {}) {
  const files = decodePayload(msg);
  if (runtime === 'codex') codexRefusal(workspace, msg, files);
  const entry = await writeMessageFiles(workspace, msg.conversationId, files, { create });
  if (!entry) return { content: msg.content, entry: null };
  return { content: storedText(msg.content, msg.conversationId, entry), entry };
}

// Whether a message's `attachmentEntry` is a string naming an entry of its
// own conversation's record. A bad ID or an unreadable record names none.
function checkReference(workspace, msg) {
  const ref = msg.attachmentEntry;
  if (typeof ref !== 'string') return false;
  try {
    return readRecord(workspace, msg.conversationId).messages.some((entry) => !!entry && entry.id === ref);
  } catch (e) {
    return false;
  }
}

// Whether a refused delete left anything of a conversation's attachments.
// `.rundock`, `attachments` and the conversation's folder are looked at in
// turn, following no link: one that is missing (or under a file) means
// nothing was left, unless a link came before it, which counts as something
// left. A look that fails for any other reason counts as something left too.
function filesLeft(workspace, id) {
  let at = path.resolve(workspace);
  for (const part of ['.rundock', 'attachments', id]) {
    at = path.join(at, part);
    let found;
    try { found = fs.lstatSync(at); } catch (e) { return e.code !== 'ENOENT' && e.code !== 'ENOTDIR'; }
    if (found.isSymbolicLink()) return true;
  }
  return true;
}

// The messages with files received and not yet handed on, by conversation:
// each is a promise that settles once the message is answered and, when
// stored, back through the chat handler. Kept for the module, so the
// conversation's delete can wait for them without a handle on the receiver.
const inFlight = new Map();

// Settles once every message with files for `conversationId` that was
// received before the call has been answered and, when stored, handed back
// into the chat handler and past its reference check.
function whenReceived(conversationId) {
  return Promise.all([...(inFlight.get(conversationId) || [])]).then(() => undefined);
}

// Settles once every message with files received before the call, in any
// conversation, has been answered and, when stored, handed back into the chat
// handler, which records and dispatches it in the same turn unless a hand-over
// queues it. A workspace switch waits for it, and then for any hand-over
// holding a chat (afterHandOver in lib/protocol/handlers/workspace.js), so a
// message is finished in the workspace that received it, as a text chat
// already in the handler is.
function whenAllReceived() {
  return Promise.all([...inFlight.values()].flatMap((set) => [...set])).then(() => undefined);
}

function receiving() {
  return inFlight.size > 0;
}

function track(key, done) {
  if (!inFlight.has(key)) inFlight.set(key, new Set());
  inFlight.get(key).add(done);
  done.then(() => {
    const set = inFlight.get(key);
    set.delete(done);
    if (set.size === 0) inFlight.delete(key);
  });
}

// The chat handler's first step. `takes(msg, ws, fromPage)` answers true when
// it has taken the message over: a message with `attachments` is stored, then
// answered with chat_stored and sent back into the handler carrying the stored
// text and its entry's ID, or answered with chat_refused and dropped; a
// reference to an entry the conversation's record doesn't hold is refused.
// While a message's files are being written, the conversation's later chats
// from the page wait behind it, so they reach the agent in the order sent. The
// server's own re-entries (the buffer's replay, the resume retries) are
// already in order and never wait, though their references are checked too.
// `findAgent(slug)` looks an agent up as the chat handler's routing does, so
// files meant for an agent on Codex are checked against what Codex can be
// sent before they are written.
function createReceiver({ clients, findAgent }) {
  const holds = new Map();
  const open = (ws) => ws.readyState === 1;
  const live = (ws) => (open(ws) ? ws : [...clients].find(open) || ws);
  const send = (ws, payload) => { if (open(ws)) ws.send(JSON.stringify(payload)); };

  function hold(key, step) {
    const tail = (holds.get(key) || Promise.resolve()).then(step)
      .catch((e) => console.error('[Attachments] a held message failed:', e && e.message));
    holds.set(key, tail);
    tail.then(() => { if (holds.get(key) === tail) holds.delete(key); });
    return tail;
  }

  function refuse(ws, msg, err, fileCount) {
    const code = err && typeof err.code === 'string' ? err.code : 'save-failed';
    const named = err && own(err, 'name') ? { name: err.name } : {};
    send(ws, { type: 'chat_refused', conversationId: msg.conversationId, code, ...refusalWording({ ...err, code }, fileCount), ...named });
  }

  function settle(ws, msg, fileCount, { ok, err }) {
    if (!ok) return refuse(ws, msg, err, fileCount);
    const next = { ...msg, content: ok.content };
    delete next.attachments;
    if (ok.entry) {
      next.attachmentEntry = ok.entry.id;
      send(ws, { type: 'chat_stored', conversationId: msg.conversationId, entry: ok.entry, content: ok.content });
    }
    live(ws).emit('message', JSON.stringify(next));
  }

  function takes(msg, ws, fromPage) {
    const key = msg.conversationId || 'default';
    if (own(msg, 'attachments')) {
      const fileCount = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
      const agent = findAgent ? findAgent(msg.agent || 'default') : null;
      const runtime = agent ? agent.runtime : undefined;
      // Started now, so conversations' writes take the lock in arrival order;
      // settled in turn behind anything this conversation already holds.
      const outcome = receiveAttachments(getWorkspace(), msg, { runtime }).then((ok) => ({ ok }), (err) => ({ err }));
      track(key, hold(key, () => outcome.then((o) => settle(ws, msg, fileCount, o))));
      return true;
    }
    // Every reference is checked: the page's on arrival, before it can wait
    // behind a hold, and each of the server's re-entries before dispatch,
    // since the record can change after the message was stored.
    if (own(msg, 'attachmentEntry') && !checkReference(getWorkspace(), msg)) {
      refuse(ws, msg, { code: 'bad-entry' }, 0);
      return true;
    }
    if (!fromPage) return false;
    if (holds.has(key)) {
      hold(key, () => live(ws).emit('message', JSON.stringify(msg)));
      return true;
    }
    return false;
  }

  return { takes };
}

module.exports = { MAX_PAYLOAD, LABELS, storedText, receiveAttachments, checkReference, filesLeft, whenReceived, whenAllReceived, receiving, createReceiver };
