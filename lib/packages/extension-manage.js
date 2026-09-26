'use strict';
// The manage page's server half: enablement written onto the installed
// record, and the receipts read.
//
// ONE STORE. Enablement is a field on the record in the install store, the
// file the install transaction writes and the roster reads, so the list a
// person manages and the roster the host mounts from cannot disagree. No
// state file sits beside it; a second store is how an installed extension
// went unseen once.
//
// RECEIPTS ARE HISTORY, NEVER AUTHORITY. A file that is gone is a row that
// is gone; one that cannot be read is skipped, never recreated or repaired.

const fs = require('node:fs');
const path = require('node:path');

const { writeAsUnit } = require('../workspace/atomic-write.js');
const { parseRecordsFile, readExtensionRecords, recordsWrite, readAllOff, recordFor } = require('./extension-record.js');
const { isDisplayName } = require('./display-name.js');

// The receipts directory and schema are the writer's, imported the way the
// records path is, so a receipt written under a moved directory or a new
// schema is read from there rather than silently read as no history.
const { RECEIPTS_DIR, RECEIPT_SCHEMA } = require('./import-apply.js');

function refuse(message, code) {
  const error = new TypeError(message);
  error.code = code;
  throw error;
}

// Write `enabled` on one record and nothing else, through the same
// transaction the install uses.
function setExtensionEnabled(workspace, name, enabled) {
  if (typeof enabled !== 'boolean') refuse('enabled must be true or false', 'invalid-state');
  const records = readExtensionRecords(workspace);
  if (!recordFor(records, name)) refuse(`no extension named "${name}" is installed`, 'not-installed');
  const next = records.map((r) => (r.name === name ? { ...r, enabled } : r));
  writeAsUnit(workspace, [recordsWrite(workspace, next)]);
  return { name, enabled };
}

// Turn every installed extension off, or back on, without touching any
// extension's own `enabled`. Off is enforced where the bytes are served
// (uiPayload) and where the roster is built (listExtensions), so a window
// that ignores the roster still cannot mount one. The switch acts on no
// record, so it reads the store the way the roster does rather than the
// acting read: a record the page shows as one that could not load must not
// refuse the pause a person reaches for when something is wrong. Each entry
// is written back as it was; an unreadable file still refuses.
function setExtensionsAllOff(workspace, off) {
  if (typeof off !== 'boolean') refuse('off must be true or false', 'invalid-state');
  const records = parseRecordsFile(workspace);
  writeAsUnit(workspace, [recordsWrite(workspace, records, { allOff: off })]);
  return { allOff: readAllOff(workspace) };
}

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const LEADER = /^[^\r\n]+$/;
function transformOf(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.adoptUnder === 'string' && LEADER.test(value.adoptUnder)) return { adoptUnder: value.adoptUnder };
  if (typeof value.attachTo === 'string' && LEADER.test(value.attachTo)) return { attachTo: value.attachTo };
  return null;
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
      ? {
        id: typeof parsed.source.id === 'string' ? parsed.source.id : null,
        reference: typeof parsed.source.reference === 'string' ? parsed.source.reference : null,
        ...(COMMIT.test(parsed.source.commit) ? { commit: parsed.source.commit } : {}),
      }
      : null,
    appliedAt: parsed.appliedAt,
    ...(isDisplayName(parsed.displayName) ? { displayName: parsed.displayName.trim() } : {}),
    items: parsed.items.filter((i) => i && typeof i === 'object').map((i) => {
      const item = {
        id: typeof i.id === 'string' ? i.id : '', kind: typeof i.kind === 'string' ? i.kind : '',
        destination: typeof i.destination === 'string' ? i.destination : '', outcome: typeof i.outcome === 'string' ? i.outcome : '',
      };
      // An item an update's new version no longer carries. Honoured
      // only on a kept entry: every other outcome is one the version offered.
      if (item.outcome === 'kept' && i.inPackage === false) item.inPackage = false;
      // What a package update reads: the digests and the transform the
      // bytes were written with, each kept only in its one valid shape.
      for (const key of ['fingerprint', 'authored']) if (DIGEST.test(i[key])) item[key] = i[key];
      const transform = transformOf(i.transform);
      if (transform) item.transform = transform;
      // Routines recorded on an arrived agent survive the read, kept to
      // exactly the fields the row discloses; an item without them keeps
      // the shape every existing receipt has, so absence stays honest.
      if (Array.isArray(i.routines)) {
        const routines = i.routines.filter((r) => r && typeof r === 'object' && typeof r.name === 'string')
          .map((r) => ({
            name: r.name,
            schedule: typeof r.schedule === 'string' ? r.schedule : null,
            enabled: r.enabled === true,
          }));
        if (routines.length) item.routines = routines;
      }
      return item;
    }),
  };
}

// Every readable receipt, newest first; a missing directory is an empty history.
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

module.exports = { setExtensionsAllOff, setExtensionEnabled, listReceipts, RECEIPTS_DIR };
