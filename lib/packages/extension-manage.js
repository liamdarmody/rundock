'use strict';
// The manage page's server half: the one write it needs, enablement onto
// the installed record, and the one read the roster does not already
// answer, the receipts of what packages added.
//
// ONE STORE. Enablement is a field on the record in the install store, the
// same file the install transaction writes and the roster reads, so the
// list a person manages and the roster the host mounts from cannot
// disagree about whether an extension is on. There is no state file beside
// it; a second store is how an installed extension went unseen once.
//
// RECEIPTS ARE HISTORY, NEVER AUTHORITY. The reader lists the directory
// and parses what it finds; a file that is gone is a row that is gone, and
// a file that cannot be read is skipped rather than recreated or repaired,
// because nothing here may write what only a completed import may write.

const fs = require('node:fs');
const path = require('node:path');

const { writeAsUnit } = require('../workspace/atomic-write.js');
const { RECORDS_PATH, readExtensionRecords, serialiseRecords, recordFor } = require('./extension-record.js');

const RECEIPTS_DIR = '.claude/rundock/receipts';
const RECEIPT_SCHEMA = 'rundock.package-import-receipt/v1';

function refuse(message, code) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

/**
 * Write `enabled` on one record and nothing else. Other records are
 * carried byte for byte; the write goes through the same transaction the
 * install uses, so a crash leaves the file as it was or as asked.
 */
function setExtensionEnabled(workspace, name, enabled) {
  if (typeof enabled !== 'boolean') refuse('enabled must be true or false', 'invalid-state');
  const records = readExtensionRecords(workspace);
  if (!recordFor(records, name)) refuse(`no extension named "${name}" is installed`, 'not-installed');
  const next = records.map((r) => (r.name === name ? { ...r, enabled } : r));
  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords(next) },
  ]);
  return { name, enabled };
}

function readReceipt(dir, file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  } catch (e) {
    return null;
  }
  if (!parsed || parsed.schema !== RECEIPT_SCHEMA || typeof parsed.appliedAt !== 'string' || !Array.isArray(parsed.items)) return null;
  return {
    file,
    source: parsed.source && typeof parsed.source === 'object'
      ? { id: typeof parsed.source.id === 'string' ? parsed.source.id : null, reference: typeof parsed.source.reference === 'string' ? parsed.source.reference : null }
      : null,
    appliedAt: parsed.appliedAt,
    items: parsed.items.filter((i) => i && typeof i === 'object').map((i) => ({
      id: typeof i.id === 'string' ? i.id : '', kind: typeof i.kind === 'string' ? i.kind : '',
      destination: typeof i.destination === 'string' ? i.destination : '', outcome: typeof i.outcome === 'string' ? i.outcome : '',
    })),
  };
}

/**
 * Every readable receipt, newest first. A missing directory is an empty
 * history. Nothing is written, moved or repaired.
 */
function listReceipts(workspace) {
  const dir = path.join(workspace, ...RECEIPTS_DIR.split('/'));
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return [];
    throw e;
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => readReceipt(dir, n)).filter(Boolean)
    .sort((a, b) => (a.appliedAt < b.appliedAt ? 1 : a.appliedAt > b.appliedAt ? -1 : (a.file < b.file ? 1 : -1)));
}

module.exports = { setExtensionEnabled, listReceipts, RECEIPTS_DIR };
