'use strict';
// The turn a runtime is handed for a person's message. Every stored line in
// the text is checked against the conversation's record as the turn is
// built: a file still as the person sent it keeps its line, written from the
// record; any other file's line says it isn't there or has changed, and
// names no path. A line naming another conversation's folder is never
// trusted. Every file is read through the store, never here.

const { ID_PATTERN, STORED_NAME, readRecordedFile } = require('./store.js');
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

// Reads each stored file of the conversation once per turn, so a file's
// line and anything sent with it come from the same open.
function reader(workspace, conversationId) {
  const reads = new Map();
  return (file) => {
    if (!reads.has(file)) {
      let read = readRecordedFile(workspace, conversationId, file);
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

/**
 * The turn for `text`, a message in conversation `conversationId`, as
 * `{ content, extraItems }`: the text with each stored line checked against
 * the record as it is now. Synchronous.
 */
function buildTurn({ workspace, conversationId, runtime, text, entryId } = {}) {
  if (typeof text !== 'string') return { content: text, extraItems: [] };
  const read = reader(workspace, conversationId);
  const content = text.replace(LINE, (...match) => {
    const { id, file } = match[match.length - 1];
    if (id !== conversationId) return notAvailable(file);
    return lineFor(conversationId, file, read(file));
  });
  return { content, extraItems: [] };
}

module.exports = { buildTurn };
