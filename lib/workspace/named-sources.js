'use strict';
// Named sources on the server: the files a note lists, resolved on disk for
// the view mounted on that note, and the one write a view may make to one of
// them.
//
// THE SERVER IS THE AUTHORITY. The page asks with the note's path and nothing
// else; the list is read from the note as it is on disk now; and a write to a
// source is resolved again here at write time. Neither the frame nor the page
// can hand this module a path of its own choosing.
//
// Every file, the note included, is held to the one extension file rule
// (extension-file.js): no hidden segment, no link anywhere on the way, exactly
// one name. What this adds is the grammar of the list, the note refusing
// itself as a source under any spelling, duplicates, and the total cap.

const fs = require('fs');
const path = require('path');
const model = require('../../public/named-sources-model.js');
const { extensionFileRefusal, writeExtensionFile } = require('./extension-file.js');

const REASONS = {
  self: 'a note cannot list itself as a source',
  duplicate: 'listed twice',
  overCap: `the note and its sources together are over the ${model.MAX_TOTAL_CHARS} character limit an extension view may receive`,
  unlisted: 'the note does not list that file as a source',
};

function relParts(rel) { return rel.split('/').filter(Boolean); }

// A file's identity: device and inode, never its spelling. On a
// case-insensitive disk `DASH.md` and `dash.md` are one file and compare
// unequal as strings, and realpath keeps whichever spelling it was handed.
function identity(workspace, rel) {
  const st = fs.statSync(path.join(workspace, ...relParts(rel)));
  return `${st.dev}:${st.ino}`;
}

/**
 * The sources of the note at `notePath`, resolved against `workspace`: each
 * `{ path, content }` or `{ path, refused }`, in the note's order, with the
 * name as the note wrote it and never a real path, a size or anything else.
 * @returns {{ ok: true, sources: Array<{path: string, content?: string, refused?: string}> }
 *   | { ok: false, reason: string, sources: [] }}
 */
function resolveSources(workspace, notePath) {
  const noteRefusal = typeof notePath === 'string' ? extensionFileRefusal(workspace, notePath) : 'no note was named';
  if (noteRefusal) return { ok: false, reason: `the note cannot be read: ${noteRefusal}`, sources: [] };
  const noteText = fs.readFileSync(path.join(workspace, ...relParts(notePath)), 'utf8');
  const listed = model.listedSources(noteText);
  if (listed.error) return { ok: false, reason: listed.error, sources: [] };
  const noteId = identity(workspace, notePath);
  const out = [];
  const seen = new Set();
  let total = noteText.length;
  for (const name of listed.names) {
    if (seen.has(name)) { out.push({ path: name, refused: REASONS.duplicate }); continue; }
    seen.add(name);
    const byName = model.nameRefusal(name);
    if (byName) { out.push({ path: name, refused: byName }); continue; }
    const onDisk = extensionFileRefusal(workspace, name);
    if (onDisk) { out.push({ path: name, refused: onDisk }); continue; }
    // The note itself, under any spelling: a write to it as a source would
    // bypass the rule that a view may not change its own list.
    if (identity(workspace, name) === noteId) { out.push({ path: name, refused: REASONS.self }); continue; }
    const content = fs.readFileSync(path.join(workspace, ...relParts(name)), 'utf8').replace(/\r\n?/g, '\n');
    if (total + content.length > model.MAX_TOTAL_CHARS) { out.push({ path: name, refused: REASONS.overCap }); continue; }
    total += content.length;
    out.push({ path: name, content });
  }
  return { ok: true, sources: out };
}

/**
 * Write `content` to `source` for the view mounted on `notePath`, only if the
 * note lists it now and it resolves now. Resolved again here at write time,
 * so a file swapped for a link, or a name taken off the list, since the view
 * was handed it is refused; the write itself opens without following a link
 * and may not change the source's own `sources` list.
 * @returns {null | string} null when written, else the reason it was not.
 */
function saveSource(workspace, notePath, source, content) {
  if (typeof source !== 'string' || typeof content !== 'string') return REASONS.unlisted;
  const resolved = resolveSources(workspace, notePath);
  if (!resolved.ok) return resolved.reason;
  const hit = resolved.sources.find((s) => s.path === source);
  if (!hit) return REASONS.unlisted;
  if (typeof hit.refused === 'string') return hit.refused;
  return writeExtensionFile(workspace, source, content);
}

module.exports = { resolveSources, saveSource, REASONS };
