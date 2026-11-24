'use strict';
// A chat message's attachments, from the page's payload to the record. The
// payload is the sender's, so its shape is checked in a fixed order before
// anything is decoded or written: a reference beside the files, the files'
// container, the conversation ID, the typed text, the count (before any
// element is read), each element's shape, then canonical base64. The store
// then checks every limit and writes all or nothing. From there the message
// carries the stored text and the record entry's ID, never the file data.

const { ID_PATTERN, writeMessageFiles, readRecord } = require('./store.js');
const { LIMITS } = require('./detect.js');
const { formatSize } = require('../../public/attachment-wording.js');

// The largest WebSocket frame the server reads. 20,000,000 bytes of files is
// 26,666,668 bytes as base64, which leaves room for the text and the rest.
const MAX_PAYLOAD = 28000000;

// How a stored line names each type the store can keep.
const LABELS = Object.freeze({
  png: 'PNG image', jpg: 'JPEG image', gif: 'GIF image', webp: 'WebP image',
  pdf: 'PDF document', txt: 'text file', md: 'Markdown file', csv: 'CSV file',
});

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

/**
 * Check a chat message's `attachments`, store them and their record entry,
 * and resolve `{ content, entry }`: the text the message carries from now on
 * and the new entry, or `entry` null when the message sent no files. Rejects
 * with an Error carrying `code` (and the store's `name`, `bytes`, `limit` or
 * `count` where they apply), with nothing written. `create` is the store's
 * seam for tests; the server never passes it.
 */
async function receiveAttachments(workspace, msg, { create } = {}) {
  const files = decodePayload(msg);
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

module.exports = { MAX_PAYLOAD, LABELS, receiveAttachments, checkReference };
