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

const RECORDS_PATH = '.claude/rundock/extensions.json';
const RECORDS_SCHEMA = 'rundock.extensions/v1';
const EXTENSIONS_ROOT = '.claude/rundock/extensions';

function recordsAbsolute(workspace) {
  return path.join(workspace, ...RECORDS_PATH.split('/'));
}

/**
 * Every installed extension this workspace records. A missing file is an
 * empty list; an unreadable one is a refusal, never treated as empty,
 * because "you have no extensions" and "your records are broken" are
 * different facts and only one of them is safe to act on.
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

/**
 * What a newer pin looks like, read from the record alone. `listRefs` is the
 * dependency that asks the remote (the default asks git); it receives the
 * record's own URL and returns reference names. Anything not equal to the
 * pinned reference is reported as available, newest-last order preserved
 * from the listing, because which of them is "the" upgrade is the person's
 * call, not a version-sort guess over strangers' tag schemes.
 */
function checkForUpdate(record, listRefs) {
  if (!record || !record.source || typeof record.source.url !== 'string' || typeof record.source.reference !== 'string') {
    throw new TypeError('update check needs an installed record carrying source.url and source.reference');
  }
  const refs = listRefs(record.source.url);
  if (!Array.isArray(refs)) throw new TypeError('listRefs must return an array of reference names');
  const newer = refs.filter((name) => typeof name === 'string' && name && name !== record.source.reference);
  return { name: record.name, current: record.source.reference, newer };
}

module.exports = {
  RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT,
  readExtensionRecords, serialiseRecords, recordFor, checkForUpdate,
};
