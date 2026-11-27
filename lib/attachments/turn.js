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
//
// A Codex turn stays a string, and each image it shows follows it as a
// `localImage` item, the path Codex opens itself; a PDF gets a line saying
// Codex can't read it, and a short text file of the message's own entry
// follows as a text item. On both runtimes, what a session has been sent
// natively is counted against NATIVE_BUDGET, and a file it was sent is not
// sent to it again.

const path = require('node:path');
const store = require('./store.js');
const { ID_PATTERN, STORED_NAME, readRecord } = store;
const { LIMITS, withinBudget } = require('./detect.js');
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
// line and anything sent with it come from the same open. Only a file in
// `keep` has its bytes kept.
function reader(workspace, conversationId, keep) {
  const reads = new Map();
  return (file) => {
    if (!reads.has(file)) {
      let read = store.readRecordedFile(workspace, conversationId, file, { keep: keep.has(file) });
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
// The store refuses a message past them, so such an entry is not one it
// wrote: none of its files is read for it or sent.
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
 * `{ content, extraItems, sent }`: the text with each stored line checked
 * against the record as it is now. For a runtime other than Codex, the files
 * of the record entry `entryId` the text doesn't name get their lines
 * appended, and its present images and PDFs follow the text as blocks, in
 * the entry's order; for an entry past a message's limits, each such line is
 * the not-available form and no file follows. A Codex turn is built by
 * codexTurn below. `session` names the session or thread the turn goes to
 * and `unrecorded` what it was sent but not yet recorded; a file it was sent
 * gets no copy again, and a copy past the budget gets its line alone. `sent`,
 * which is not enumerable, holds the copies the turn carries, for recordSent.
 * Synchronous.
 */
function buildTurn({ workspace, conversationId, runtime, text, entryId, session, instance, resumed, unrecorded } = {}) {
  if (typeof text !== 'string') return withSent({ content: text, extraItems: [] }, nothingTaken());
  if (runtime === 'codex') return codexTurn({ workspace, conversationId, text, entryId, session, instance, resumed, unrecorded });
  const files = runtime === 'codex' ? [] : entryFiles(workspace, conversationId, entryId);
  const names = entryNames(files);
  const read = reader(workspace, conversationId, keptFiles(files));
  const named = new Set();
  let checked = text.replace(LINE, (...match) => {
    const { id, file } = match[match.length - 1];
    if (id !== conversationId) return notAvailable(file);
    named.add(file);
    return lineFor(conversationId, file, read(file));
  });

  const fits = entryFits(files);
  const budget = budgetFor(sessionEntry(workspace, conversationId, session), unrecorded);
  const appended = [];
  const blocks = [];
  for (const file of names) {
    if (!fits) {
      if (!named.has(file)) appended.push(notAvailable(file));
      continue;
    }
    const one = read(file);
    if (!named.has(file)) appended.push(lineFor(conversationId, file, one));
    const block = blockFor(one);
    if (block && !alreadySent(budget, file) && take(budget, file, one.described)) blocks.push(block);
  }
  if (appended.length) checked = checked ? [checked, ...appended].join('\n') : appended.join('\n');
  return withSent({ content: blocks.length ? [{ type: 'text', text: checked }, ...blocks] : checked, extraItems: [] }, budget.taken);
}

// ===== What a session has been sent, and what it may still be sent =====

const nothingTaken = () => ({ files: [], bytes: 0, images: 0 });
const NOTHING_HELD = Object.freeze({ files: Object.freeze([]), bytes: 0, images: 0 });
// A record that can't be read counts as the whole budget spent.
const UNREADABLE = Object.freeze({ files: Object.freeze([]), bytes: Infinity, images: Infinity });

// The answer with the copies it carries as `sent`, kept out of its
// enumerable keys so the answer reads as `{ content, extraItems }`. On a
// cold resume `replace` is set too, as recordSent takes it.
function withSent(answer, taken, replace = false) {
  Object.defineProperty(answer, 'sent', { value: taken });
  if (replace) Object.defineProperty(answer, 'replace', { value: true });
  return answer;
}

// The record's entry for `session`, counted as spent when the record can't
// be read.
function sessionEntry(workspace, conversationId, session) {
  try {
    return store.sentEntry(readRecord(workspace, conversationId).sent, session);
  } catch (e) {
    return UNREADABLE;
  }
}

// A session's recorded entry, plus what it was sent but not yet recorded,
// plus the copies this turn takes.
function budgetFor(recorded, unrecorded) {
  const held = unrecorded || NOTHING_HELD;
  return {
    sent: new Set([...recorded.files, ...held.files]),
    bytes: recorded.bytes + held.bytes,
    images: recorded.images + held.images,
    taken: nothingTaken(),
  };
}

// Whether the session was sent the file natively before.
function alreadySent(budget, file) {
  return budget.sent.has(file);
}

// Takes a native copy of `file` when it keeps the session within the budget.
function take(budget, file, described) {
  const { taken } = budget;
  const image = Object.prototype.hasOwnProperty.call(IMAGE_TYPES, described.type) ? 1 : 0;
  const total = { bytes: budget.bytes + taken.bytes + described.bytes, images: budget.images + taken.images + image };
  if (!withinBudget(total)) return false;
  taken.files.push(file);
  taken.bytes += described.bytes;
  taken.images += image;
  return true;
}

// ===== A Codex turn =====

const INLINE_BYTES = 100000;
const READ_FIRST = ' (read it before answering)';
const TEXT_TYPES = new Set(['txt', 'md', 'csv']);
const pdfForm = (file) => `[Attached PDF you can't read on Codex: ${file}. Tell the person you can't open PDFs, and ask for a screenshot of the page or its text.]`;
const shownEarlier = (file) => `[Attached image shown to you earlier in this conversation: ${file}]`;
const notShown = (file) => `[Attached image not shown to you: ${file}. If you need it, tell the person you can't see it.]`;
// Search leaves out a part that begins with this header (search.js).
const inlineItem = (file, bytes) => ({ type: 'text', text: `[Text of attached file ${file}]\n${bytes.toString('utf8')}` });

// Whether a resumed thread is on an app-server process other than the one
// its entry was last sent images through, so it may have lost them.
function isCold(entry, instance, resumed) {
  return resumed === true && entry.instance !== instance;
}

/**
 * A Codex turn, as buildTurn answers it: each line takes the first form that
 * fits (not available or changed; a PDF's; a text file of the entry, inlined
 * up to INLINE_BYTES and otherwise to be read first; an image the thread was
 * sent; an image shown with its item; an image not shown), so each image
 * line in `content` has its `localImage` item and each item its line. On a
 * cold resume the thread's entry counts as empty and its images are sent
 * again, last listed first, after the turn's own.
 */
function codexTurn({ workspace, conversationId, text, entryId, session, instance, resumed, unrecorded }) {
  const files = entryFiles(workspace, conversationId, entryId);
  const ownFits = entryFits(files);
  const own = ownFits ? entryNames(files) : [];
  const unread = ownFits ? [] : entryNames(files);
  const inline = new Set(files
    .filter((f) => f && own.includes(f.file) && TEXT_TYPES.has(extension(f.file)) && within(f.bytes, INLINE_BYTES))
    .map((f) => f.file));
  const read = reader(workspace, conversationId, inline);
  const recorded = sessionEntry(workspace, conversationId, session);
  // An entry counted as spent stays spent, cold or not.
  const cold = Number.isFinite(recorded.bytes) && isCold(recorded, instance, resumed);
  const budget = budgetFor(cold ? NOTHING_HELD : recorded, unrecorded);
  const folder = path.join(path.resolve(workspace), '.rundock', 'attachments', conversationId);

  const decided = new Map();
  const decide = (file, ofEntry) => {
    const one = read(file);
    const line = lineFor(conversationId, file, one);
    if (one.state !== 'present') return { line };
    const { type } = one.described;
    if (type === 'pdf') return { line: pdfForm(file) };
    if (TEXT_TYPES.has(type)) {
      if (!ofEntry) return { line };
      if (one.bytes && within(one.described.bytes, INLINE_BYTES)) return { line, item: inlineItem(file, one.bytes) };
      return { line, readFirst: true };
    }
    if (alreadySent(budget, file)) return { line: shownEarlier(file) };
    if (blockable(one.described) && take(budget, file, one.described)) return { line, item: { type: 'localImage', path: path.join(folder, file) } };
    return { line: notShown(file) };
  };
  for (const file of own) decided.set(file, decide(file, true));
  const named = new Set();
  const others = [];
  for (const m of text.matchAll(LINE)) {
    const { id, file } = m.groups;
    if (id !== conversationId) continue;
    named.add(file);
    if (!decided.has(file)) {
      decided.set(file, decide(file, false));
      others.push(file);
    }
  }

  const withReadFirst = (one, followed) => (one.readFirst && !followed ? one.line + READ_FIRST : one.line);
  let checked = text.replace(LINE, (...match) => {
    const { id, file } = match[match.length - 1];
    if (conversationId !== id) return notAvailable(file);
    const after = match[match.length - 3] + match[0].length;
    return withReadFirst(decided.get(file), text.startsWith(READ_FIRST, after));
  });
  const appended = [];
  for (const file of own) if (!named.has(file)) appended.push(withReadFirst(decided.get(file), false));
  for (const file of unread) if (!named.has(file)) appended.push(notAvailable(file));
  const extraItems = [...own, ...others].map((file) => decided.get(file).item).filter(Boolean);

  if (cold) {
    for (const file of [...new Set(recorded.files)].reverse()) {
      if (budget.taken.files.includes(file)) continue;
      const one = read(file);
      if (one.state !== 'present' || !Object.prototype.hasOwnProperty.call(IMAGE_TYPES, one.described.type)) continue;
      if (!blockable(one.described) || !take(budget, file, one.described)) continue;
      appended.push(lineFor(conversationId, file, one));
      extraItems.push({ type: 'localImage', path: path.join(folder, file) });
    }
  }
  if (appended.length) checked = checked ? [checked, ...appended].join('\n') : appended.join('\n');
  return withSent({ content: checked, extraItems }, budget.taken, cold);
}

module.exports = { buildTurn };
