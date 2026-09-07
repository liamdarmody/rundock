'use strict';
// The installed-extension records: which extensions this workspace has, where
// each came from, and the update check that reads nothing but the record.
//
// THE RECORD CARRIES THE SOURCE, BY REQUIREMENT. An installed extension
// persists the GitHub URL and the pinned reference it came from at install
// time, mirroring what pack receipts already do with source id and
// reference, so no update ever asks the person to re-enter the URL. That is
// why checkForUpdate takes a record and a ref-listing dependency and nothing
// else: an update check that needed the URL typed again would be the gap
// this file exists to close.
//
// Unlike a receipt, this record is authority: the host and the manage screen
// read it to know what is installed. It lives beside the receipts in the
// Rundock-owned area of .claude, and it travels with the workspace.

const fs = require('node:fs');
const path = require('node:path');

const { SLUG } = require('./extension-manifest.js');

const RECORDS_PATH = '.claude/rundock/extensions.json';
const RECORDS_SCHEMA = 'rundock.extensions/v1';
const EXTENSIONS_ROOT = '.claude/rundock/extensions';

function recordsAbsolute(workspace) {
  return path.join(workspace, ...RECORDS_PATH.split('/'));
}

// What every record must carry before any consumer reads it. The records
// file travels with the workspace, so a shared or copied one can hold
// anything; validated here, once, so no consumer (the update check, the
// uninstall, the update plan) has its own copy of these rules to drift.
function recordDefect(record) {
  if (!record || typeof record !== 'object') return 'an entry is not an object';
  if (typeof record.name !== 'string' || !SLUG.test(record.name)) return 'an entry carries an invalid name';
  if (typeof record.version !== 'string' || !record.version) return `"${record.name}" has no version`;
  if (!record.source || typeof record.source.url !== 'string' || !record.source.url) return `"${record.name}" carries no source url`;
  if (typeof record.source.reference !== 'string' || !record.source.reference) return `"${record.name}" carries no pinned reference`;
  if (typeof record.root !== 'string' || !record.root) return `"${record.name}" has no root`;
  return null;
}

/**
 * Every installed extension this workspace records. A missing file is an
 * empty list; an unreadable one, or one holding a record that lacks what
 * every record must carry, is a refusal, never treated as empty, because
 * "you have no extensions" and "your records are broken" are different
 * facts and only one of them is safe to act on.
 */
function readExtensionRecords(workspace) {
  let raw;
  try {
    raw = fs.readFileSync(recordsAbsolute(workspace), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new TypeError(`extension records unreadable: ${e.message}`);
  }
  if (!parsed || parsed.schema !== RECORDS_SCHEMA || !Array.isArray(parsed.extensions)) {
    throw new TypeError('extension records unreadable: not a recognised records file');
  }
  for (const record of parsed.extensions) {
    const defect = recordDefect(record);
    if (defect) {
      throw Object.assign(new TypeError(`extension records unreadable: ${defect}; refusing to act on any of them`), { code: 'invalid-record' });
    }
  }
  return parsed.extensions;
}

function serialiseRecords(extensions) {
  return JSON.stringify({
    schema: RECORDS_SCHEMA,
    extensions: [...extensions].sort((a, b) => (a.name < b.name ? -1 : 1)),
  }, null, 2) + '\n';
}

function recordFor(records, name) {
  return records.find((r) => r.name === name) || null;
}

// A plain vX.Y.Z tag, which is the only shape this file will call ordered.
// Anything else, on either side of a comparison, is left alone rather than
// guessed at: a wrong "newer" is a downgrade offered as an update, and that
// is worse than reporting nothing for a tag scheme this cannot read.
const SEMVER_TAG = /^v?(\d+)\.(\d+)\.(\d+)$/;

function semverParts(ref) {
  const m = SEMVER_TAG.exec(ref);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

// The one ordering. Both callers below go through it: the "newer than the
// pin" filter and the sort of what it kept.
function compareSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/**
 * What a newer pin looks like, read from the record alone. `listRefs` is the
 * dependency that asks the remote (the default asks git); it receives the
 * record's own URL and returns reference names. Only a reference this
 * function can actually show comes after the pinned one is reported: a name
 * ls-remote happens to return that is merely DIFFERENT from the pin, older
 * than it, or not comparable at all (this file reads only vX.Y.Z tags) is
 * left out, because "newer" is a claim about order and a listing is not
 * ordered by the meaning of its entries. What is reported is sorted here,
 * oldest first, because ls-remote's own order is lexicographic and would put
 * v10.0.0 before v2.0.0.
 *
 * The outcome is named, because "nothing newer" has two different causes: a
 * pin that is the newest tag, and a pin (a commit, a codename) this file
 * cannot place against a tag listing at all. Reporting the second as "up to
 * date" would be a claim the code cannot make.
 */
function checkForUpdate(record, listRefs) {
  const refs = listRefs(record.source.url);
  if (!Array.isArray(refs)) throw new TypeError('listRefs must return an array of reference names');
  const pin = semverParts(record.source.reference);
  const newer = pin === null ? [] : refs
    .map((name) => [name, typeof name === 'string' ? semverParts(name) : null])
    .filter(([, parts]) => parts && compareSemver(parts, pin) > 0)
    .sort(([, a], [, b]) => compareSemver(a, b))
    .map(([name]) => name);
  const outcome = pin === null ? 'unorderable-pin' : (newer.length ? 'newer-available' : 'up-to-date');
  return { name: record.name, current: record.source.reference, newer, outcome };
}

module.exports = {
  RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT,
  readExtensionRecords, serialiseRecords, recordFor, checkForUpdate,
};
