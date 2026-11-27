'use strict';
// The turn a runtime is handed for a person's message. Every stored line in
// the text is checked against the conversation's record as the turn is
// built: a file still as the person sent it keeps its line, written from the
// record; any other file's line says it isn't there or has changed, and
// names no path. A line naming another conversation's folder is never
// trusted. Every file is read through the store, never here.
//
// A Claude Code turn also carries the images and PDFs of the message's own
// record entry as base64 blocks, from the bytes the check read. A file of
// another entry gets its line and no block, so an earlier image is never
// sent again because a later text quotes its line.

const store = require('./store.js');
const { ID_PATTERN, STORED_NAME, readRecord } = store;
const { LIMITS } = require('./detect.js');
const { storedText } = require('./receive.js');

// A pattern's body, without its anchors.
const body = (pattern) => pattern.source.replace(/^\^/, '').replace(/\$$/, '');
// A stored line as storedText writes it. STORED_NAME holds a group of its
// own, so the parts are named.
const LINE = new RegExp(
  `\\[Attached: \\.rundock/attachments/(?<id>${body(ID_PATTERN)})/(?<file>${body(STORED_NAME)}) \\((?<details>[^)\\]\\r\\n\\u2028\\u2029]*)\\)\\]`,
  'g',
);

const notAvailable = (file) => `[Attached file not available: ${file}]`;
const changed = (file) => `[Attached file changed since it was attached, so it isn't shown: ${file}]`;
const extension = (file) => file.slice(file.lastIndexOf('.') + 1);

// The most a turn reads of the stored files, in all: five messages' files at
// their limit. A file past it is not available on that turn, so a text
// naming many large files can't hold the server for long.
const READ_BUDGET = 5 * LIMITS.messageBytes;

// Reads each stored file of the conversation once per turn, so a file's
// line and anything sent with it come from the same open. Only a file in
// `keep` has its bytes kept, and the turn's reads share READ_BUDGET.
function reader(workspace, conversationId, keep) {
  const reads = new Map();
  const budget = { left: READ_BUDGET };
  return (file) => {
    if (!reads.has(file)) {
      let read = store.readRecordedFile(workspace, conversationId, file, { keep: keep.has(file), budget });
      // A description whose type isn't its name's is not one the store wrote.
      if (read.described && read.described.type !== extension(file)) read = { state: 'missing', described: undefined };
      reads.set(file, read);
    }
    return reads.get(file);
  };
}

// The record's own line for a file still as it was sent, otherwise the form
// that says why it isn't shown.
function lineFor(conversationId, file, read) {
  if (read.state === 'present') return storedText('', conversationId, { files: [read.described] });
  return read.state === 'changed' ? changed(file) : notAvailable(file);
}

const IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });
const within = (n, limit) => Number.isSafeInteger(n) && n >= 0 && n <= limit;

// The files the record lists for the message `entryId`, or none.
function entryFiles(workspace, conversationId, entryId) {
  if (typeof entryId !== 'string') return [];
  let record;
  try { record = readRecord(workspace, conversationId); } catch (e) { return []; }
  const entry = record.messages.find((message) => message && message.id === entryId);
  return entry && Array.isArray(entry.files) ? entry.files : [];
}

// The stored names of an entry's files, each once, in the entry's order.
function entryNames(files) {
  const names = [];
  for (const f of files) {
    const file = f && f.file;
    if (typeof file === 'string' && STORED_NAME.test(file) && !names.includes(file)) names.push(file);
  }
  return names;
}

// Whether an entry is inside the limits a message's files are sent under.
// Past them, none of its files is sent.
function entryFits(files) {
  if (files.length > LIMITS.files) return false;
  let total = 0;
  for (const f of files) {
    if (!f || !within(f.bytes, LIMITS.messageBytes)) return false;
    total += f.bytes;
  }
  return total <= LIMITS.messageBytes;
}

// Whether a file so described is an image or a PDF inside its limits.
function blockable(described) {
  const { type, bytes, width, height } = described || {};
  if (type === 'pdf') return within(bytes, LIMITS.pdfBytes);
  if (!Object.prototype.hasOwnProperty.call(IMAGE_TYPES, type)) return false;
  return within(bytes, LIMITS.imageBytes) && within(width, LIMITS.imagePixels) && within(height, LIMITS.imagePixels);
}

// The entry's files whose bytes a block needs: none for an entry past a
// message's limits, otherwise its images and PDFs inside theirs.
function keptFiles(files) {
  return new Set(entryFits(files) ? files.filter(blockable).map((f) => f.file) : []);
}

// The block for a present file whose bytes were kept and which is inside
// its limits, or null.
function blockFor(read) {
  if (read.state !== 'present' || !read.bytes || !blockable(read.described)) return null;
  const data = read.bytes.toString('base64');
  if (read.described.type === 'pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  return { type: 'image', source: { type: 'base64', media_type: IMAGE_TYPES[read.described.type], data } };
}

/**
 * The turn for `text`, a message in conversation `conversationId`, as
 * `{ content, extraItems }`: the text with each stored line checked against
 * the record as it is now. For a runtime other than Codex, the files of the
 * record entry `entryId` the text doesn't name get their lines appended, and
 * its present images and PDFs follow the text as blocks, in the entry's
 * order. Synchronous.
 */
function buildTurn({ workspace, conversationId, runtime, text, entryId } = {}) {
  if (typeof text !== 'string') return { content: text, extraItems: [] };
  const files = runtime === 'codex' ? [] : entryFiles(workspace, conversationId, entryId);
  const names = entryNames(files);
  const read = reader(workspace, conversationId, keptFiles(files));
  // The entry's own files are read first, so lines the text quotes from
  // earlier turns never take the budget they need.
  for (const file of names) read(file);
  const named = new Set();
  let checked = text.replace(LINE, (...match) => {
    const { id, file } = match[match.length - 1];
    if (id !== conversationId) return notAvailable(file);
    named.add(file);
    return lineFor(conversationId, file, read(file));
  });
  if (runtime === 'codex') return { content: checked, extraItems: [] };

  const appended = [];
  const blocks = [];
  for (const file of names) {
    const one = read(file);
    if (!named.has(file)) appended.push(lineFor(conversationId, file, one));
    const block = blockFor(one);
    if (block) blocks.push(block);
  }
  if (appended.length) checked = checked ? [checked, ...appended].join('\n') : appended.join('\n');
  return { content: blocks.length ? [{ type: 'text', text: checked }, ...blocks] : checked, extraItems: [] };
}

module.exports = { buildTurn };
