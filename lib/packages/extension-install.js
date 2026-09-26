'use strict';
// Installing and updating an extension, as transactions over the acquired
// snapshot and the records file. Removing one is a package uninstall
// (package-uninstall.js), which takes the extension with the rest of its
// package in one transaction.
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

const path = require('node:path');

const { writeAsUnit } = require('../workspace/atomic-write.js');
const { readExtensionManifest, deriveFacts, extensionFileSet } = require('./extension-manifest.js');
const {
  EXTENSIONS_ROOT, readExtensionRecords, recordsWrite, recordFor,
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
  // WHO IT IS, not only what it is called. The name is the manifest's own
  // choice, so a package from another repository can declare the name of one
  // already installed. Said on the card rather than framed as an update.
  return {
    manifest,
    facts,
    source: { url: source.url, reference: source.reference, ...(source.commit ? { commit: source.commit } : {}) },
    replaces: existing
      ? { version: existing.version, reference: existing.source.reference, url: existing.source.url, sameSource: existing.source.url === source.url }
      : null,
  };
}

/**
 * Materialise the extension and record it, as one transaction. Returns the
 * record written. The extension's files live under the Rundock-owned root,
 * never loose in the workspace: what an install created must be exactly what
 * an uninstall can name and remove.
 */
function installExtension(workspace, snapshotRoot, plan, options = {}) {
  const { record, writes, replaceDirs } = extensionWrites(workspace, snapshotRoot, plan, options);
  writeAsUnit(workspace, writes, { replaceDirs });
  return record;
}

/**
 * What installing the extension writes, without writing it: the records
 * file with this record in it, and the extension's directory. A package
 * update hands these to the one transaction that also carries its agents,
 * skills and receipt; an install writes them on their own.
 */
function extensionWrites(workspace, snapshotRoot, plan, options = {}) {
  if (!plan || !plan.manifest || !plan.source) refuse('install needs the plan the trust step showed');
  const { manifest, source } = plan;
  const styles = Array.isArray(manifest.styles) ? manifest.styles : [];
  const files = extensionFileSet(snapshotRoot, manifest.entry, styles);
  const root = `${EXTENSIONS_ROOT}/${manifest.name}`;
  const record = {
    name: manifest.name,
    // What the package calls itself, when it says: the Packages and
    // Extensions pages show it in place of the title-cased name.
    ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
    version: manifest.version,
    entry: manifest.entry,
    match: manifest.match,
    // Recorded beside the match rule, because the host reads the privilege
    // from what was installed rather than from whatever manifest happens to
    // be on disk under the extension's directory now. Only true is stored:
    // an extension that did not ask keeps the record shape every existing
    // record already has, and reads as no.
    ...(manifest.writes === true ? { writes: true } : {}),
    // The two privileges the trust card names beside writes, recorded the
    // same way and for the same reason: only a claim that exists is stored.
    ...(manifest.sources === true ? { sources: true } : {}),
    ...(Array.isArray(manifest.asks) && manifest.asks.length ? { asks: manifest.asks.slice() } : {}),
    // The drawn language, recorded beside the match rule for the same reason:
    // the host reads what was installed rather than whatever manifest is on
    // disk under the extension's directory now. Only a real claim is stored,
    // so an extension that draws nothing keeps the record shape every
    // existing record already has.
    ...(typeof manifest.draws === 'string' && manifest.draws ? { draws: manifest.draws } : {}),
    // The commit the reference resolved to when the bytes were fetched, so the
    // record says what was installed, not only what it was called.
    source: { url: source.url, reference: source.reference, ...(source.commit ? { commit: source.commit } : {}) },
    installedAt: options.now || new Date().toISOString(),
    root,
  };
  // The styles claim is copied the way entry and match are, so the payload
  // can serve it when the installed directory carries no manifest of its
  // own. Only a claim that exists is copied: an extension declaring none
  // keeps the record shape every existing record already has.
  if (styles.length) record.styles = styles;
  // The marker claim is copied the way entry and match are, and only when
  // it exists, so a marker-less record keeps the shape every existing
  // record has.
  if (manifest.declares) record.declares = manifest.declares;
  const records = readExtensionRecords(workspace);
  const existing = recordFor(records, manifest.name);
  // Whether the extension runs is the person's decision at the manage page,
  // and the record is the only place that decision lives. The snapshot knows
  // nothing about it, so a replaced record carries the old one's disabled
  // flag forward: an update that silently re-enabled a disabled extension
  // would widen the original install's consent after the fact. An absent
  // flag means enabled, so only the disabled state has anything to carry.
  if (existing && existing.enabled === false) record.enabled = false;
  const others = records.filter((r) => r.name !== manifest.name);
  // The transaction takes absolute destinations; the record keeps them
  // relative, because a workspace can be moved or renamed and a record that
  // named an absolute path would break on the first such move.
  return {
    record,
    writes: [recordsWrite(workspace, [...others, record])],
    replaceDirs: [{ path: path.join(workspace, ...root.split('/')), files }],
  };
}

module.exports = { planExtensionInstall, installExtension, extensionWrites };
