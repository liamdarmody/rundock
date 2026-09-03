'use strict';
// Installing, updating and uninstalling an extension, as transactions over
// the acquired snapshot and the records file.
//
// CONSENT COMES BEFORE ANY WRITE. planExtensionInstall reads a snapshot and
// returns the manifest and the derived facts; it touches the workspace not
// at all, so a person who declines has declined an offer, not undone an
// action. installExtension is the first thing that writes, and it writes the
// extension's files and the updated records file as ONE unit through the
// same journaled transaction the content import uses, so a crash leaves
// either the workspace as it was or the install complete, never a directory
// without its record.
//
// AN UPDATE IS AN INSTALL. It reopens the trust step upstream (a second
// code-execution event is not a formality) and lands here as installExtension
// over the newer snapshot: the directory replacement and the record rewrite
// are the same transaction either way, which is what makes "update" honest
// rather than a special path with its own bugs.

const fs = require('node:fs');
const path = require('node:path');

const { writeAsUnit } = require('../workspace/atomic-write.js');
const { readExtensionManifest, deriveFacts, extensionFileSet } = require('./extension-manifest.js');
const {
  RECORDS_PATH, EXTENSIONS_ROOT, readExtensionRecords, serialiseRecords, recordFor,
} = require('./extension-record.js');

function refuse(message, code) {
  const error = new TypeError(`extension install refused: ${message}`);
  error.code = code || 'extension-install-refused';
  throw error;
}

/**
 * Read the snapshot into the offer the trust step renders. No writes, no
 * workspace reads beyond the records (to say whether this is an update).
 */
function planExtensionInstall(workspace, snapshotRoot, source) {
  if (!source || typeof source.url !== 'string' || typeof source.reference !== 'string') {
    refuse('source must carry url and reference');
  }
  const manifest = readExtensionManifest(snapshotRoot);
  const facts = deriveFacts(snapshotRoot, manifest);
  const existing = recordFor(readExtensionRecords(workspace), manifest.name);
  return {
    manifest,
    facts,
    source: { url: source.url, reference: source.reference },
    replaces: existing ? { version: existing.version, reference: existing.source.reference } : null,
  };
}

/**
 * Materialise the extension and record it, as one transaction. Returns the
 * record written. The extension's files live under the Rundock-owned root,
 * never loose in the workspace: what an install created must be exactly what
 * an uninstall can name and remove.
 */
function installExtension(workspace, snapshotRoot, plan, options = {}) {
  if (!plan || !plan.manifest || !plan.source) refuse('install needs the plan the trust step showed');
  const { manifest, source } = plan;
  const files = extensionFileSet(snapshotRoot, manifest.entry);
  const root = `${EXTENSIONS_ROOT}/${manifest.name}`;
  const record = {
    name: manifest.name,
    version: manifest.version,
    entry: manifest.entry,
    match: manifest.match,
    source: { url: source.url, reference: source.reference },
    installedAt: options.now || new Date().toISOString(),
    root,
  };
  const others = readExtensionRecords(workspace).filter((r) => r.name !== manifest.name);
  // The transaction takes absolute destinations; the record keeps them
  // relative, because a record that travels with the workspace must not name
  // the machine it was written on.
  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords([...others, record]) },
  ], {
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  });
  return record;
}

/**
 * Remove one installed extension: its directory and its record entry leave
 * together. What stays is named rather than implied, because agents and
 * skills imported from the same repository became ordinary workspace files
 * on arrival and are not this operation's to touch.
 */
function uninstallExtension(workspace, name) {
  const records = readExtensionRecords(workspace);
  const record = recordFor(records, name);
  if (!record) refuse(`no extension named "${name}" is installed`, 'not-installed');
  const remaining = records.filter((r) => r.name !== name);
  // The record leaves first, atomically: authority goes before the bytes, so
  // a crash between the two steps leaves an inert directory nothing reads,
  // never a recorded extension whose files are gone.
  writeAsUnit(workspace, [
    { path: path.join(workspace, ...RECORDS_PATH.split('/')), content: serialiseRecords(remaining) },
  ]);
  fs.rmSync(path.join(workspace, ...record.root.split('/')), { recursive: true, force: true });
  return {
    name,
    removed: record.root,
    untouched: 'Agents and skills imported from this package are ordinary workspace files and remain; delete them like any other file if you no longer want them.',
  };
}

module.exports = { planExtensionInstall, installExtension, uninstallExtension };
