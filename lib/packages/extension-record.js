'use strict';
// The installed-extension records: which extensions this workspace has and
// where each came from, and the one version order the package update check
// (package-check.js) and the latest-tag pin share.
//
// THE RECORD CARRIES THE SOURCE, BY REQUIREMENT. An installed extension
// persists the GitHub URL and the pinned reference it came from at install
// time, mirroring what pack receipts already do with source id and
// reference, so no update ever asks the person to re-enter the URL: an
// update that needed the URL typed again would be the gap this file exists
// to close.
//
// Unlike a receipt, this record is authority: the host and the manage screen
// read it to know what is installed. It lives beside the receipts in
// .rundock/, which is Rundock's own state directory, beside conversations
// and pins: .claude/ is Claude Code's convention and holds agents and
// skills, so Rundock keeping its bookkeeping there would be one tool's state
// inside another tool's directory. Because .rundock/ is excluded from
// shared-workspace syncing, an install is local to the person and the
// machine, and that is deliberate: an extension is code that executes, and
// the trust step is a decision each person makes for themselves, so a
// record that travelled with a shared workspace would let the workspace
// tell someone else's Rundock about code to fetch.

const fs = require('node:fs');
const path = require('node:path');

const { SLUG } = require('./extension-manifest.js');

const RECORDS_PATH = '.rundock/extensions.json';
const RECORDS_SCHEMA = 'rundock.extensions/v1';
const EXTENSIONS_ROOT = '.rundock/extensions';

function recordsAbsolute(workspace) {
  return path.join(workspace, ...RECORDS_PATH.split('/'));
}

// What every record must carry before any consumer reads it. The records
// file is plain JSON on disk, so a hand-edited or copied one can hold
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
 * The records file as its entry list, with no verdict yet on what each
 * entry carries. A missing file is an empty list; an unreadable one, or one
 * of another schema, is a refusal, never treated as empty, because "you
 * have no extensions" and "your records are broken" are different facts and
 * only one of them is safe to act on. Exported for the roster, which reads
 * the store through this one parser and then reports a defective entry as
 * a broken row a person can see, where the acting consumers below refuse
 * the whole file: two parsers of one store is how an installed extension
 * comes to be seen by nothing.
 */
function parseRecordsFile(workspace) {
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
  return parsed.extensions;
}

/**
 * Every installed extension this workspace records, for the consumers that
 * ACT on a record: the update check, the update plan, the uninstall, the
 * install's own rewrite. A record that lacks what every record must carry
 * makes the whole file a refusal here, because acting on a sibling of a
 * broken record is not safe either.
 */
function readExtensionRecords(workspace) {
  const records = parseRecordsFile(workspace);
  for (const record of records) {
    const defect = recordDefect(record);
    if (defect) {
      throw Object.assign(new TypeError(`extension records unreadable: ${defect}; refusing to act on any of them`), { code: 'invalid-record' });
    }
  }
  return records;
}

// THE SWITCH THAT TURNS EVERY EXTENSION OFF lives in the same file as the
// records, beside them rather than on any of them: turning it on changes no
// extension's own `enabled`, so turning it off restores exactly the states
// that were set before. Written only while it is on, so a records file that
// never used it is byte-for-byte what it was.
function readAllOff(workspace) {
  let raw;
  try { raw = fs.readFileSync(recordsAbsolute(workspace), 'utf8'); } catch (e) { return false; }
  try { const parsed = JSON.parse(raw); return !!(parsed && parsed.allOff === true); } catch (e) { return false; }
}

function serialiseRecords(extensions, opts) {
  const allOff = !!(opts && opts.allOff === true);
  return JSON.stringify({
    schema: RECORDS_SCHEMA,
    ...(allOff ? { allOff: true } : {}),
    extensions: [...extensions].sort((a, b) => (a.name < b.name ? -1 : 1)),
  }, null, 2) + '\n';
}

// The one way a writer rewrites the records: the entries it was handed, and
// the switch exactly as the file already has it, so a writer that knows
// nothing about the switch (an install, an uninstall, a per-extension toggle)
// can never turn it off by rewriting the file.
function recordsWrite(workspace, extensions, opts) {
  const allOff = opts && typeof opts.allOff === 'boolean' ? opts.allOff : readAllOff(workspace);
  return { path: recordsAbsolute(workspace), content: serialiseRecords(extensions, { allOff }) };
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

// The one check on what a ref lister hands back.
function requireRefListing(refs) {
  if (!Array.isArray(refs)) throw new TypeError('listRefs must return an array of reference names');
  return refs;
}

/**
 * The newest tag in a listing, for deriving a pin when a link names none.
 * "Latest" is a claim about order, and the listing itself carries no order
 * worth trusting: ls-remote's own order is lexicographic, which puts
 * v10.0.0 before v2.0.0, and publication dates are not in a listing at all.
 * So the claim is made only over tags this file can actually order, the
 * plain vX.Y.Z shape SEMVER_TAG reads, through the same comparison the
 * update check reports with, so "latest" here and "newer" there can never
 * disagree. Two spellings of one version ("1.2.0" and "v1.2.0") compare
 * equal; the bytewise-greater name wins the tie, so the choice is a stated
 * rule rather than an accident of listing order.
 *
 * A repository with no tags at all, and one whose tags this cannot order,
 * are distinct named refusals rather than guesses: deriving a pin from a
 * listing the code cannot order would be a guess presented as a promise,
 * and the person can always name the tag in the link instead.
 */
function latestTag(refs) {
  requireRefListing(refs);
  if (refs.length === 0) {
    throw Object.assign(new TypeError('this repository publishes no tags; an extension is installed at an exact tag, '
      + 'so paste a link that names a release, tag or commit'), { code: 'no-tags' });
  }
  const orderable = refs.filter((name) => typeof name === 'string' && semverParts(name) !== null);
  if (orderable.length === 0) {
    throw Object.assign(new TypeError('none of this repository\'s tags are versions that can be ordered, '
      + 'so there is no latest to pin to; paste a link that names the tag itself'), { code: 'unorderable-tags' });
  }
  let best = orderable[0];
  for (const name of orderable.slice(1)) {
    const order = compareSemver(semverParts(name), semverParts(best));
    if (order > 0 || (order === 0 && name > best)) best = name;
  }
  return best;
}

module.exports = {
  RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT,
  parseRecordsFile, readExtensionRecords, serialiseRecords, recordsWrite, readAllOff, recordFor, latestTag,
  semverParts, compareSemver,
};
