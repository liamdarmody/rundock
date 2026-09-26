'use strict';
// INSTALLED PACKAGES, DERIVED. A package has no record of its own: what it
// installed is the receipts written under its source, and whether it carries
// an extension is the extension records. Folding those two here, with no
// store beside them, means the Packages page and an update can never
// disagree with the history and the records they are read from.
//
// A receipt is history, never authority, so what this returns is only ever
// the BASE an update compares against: the bytes each item had when this
// package last wrote it. An update still reads the workspace as it is now.

const fs = require('node:fs');
const path = require('node:path');

const { listReceipts } = require('./extension-manage.js');
const { parseRecordsFile } = require('./extension-record.js');
const { isDisplayName } = require('./display-name.js');
const { digestFile, digestDirectory } = require('./import-apply.js');
const { authoredDigest } = require('./package-fingerprint.js');

// Only a package that came from a GitHub link can be checked for updates;
// one added from a local folder is listed, and says it cannot be.
const LINK_SOURCE = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+$/;

function blank(id) {
  return { id, updatable: LINK_SOURCE.test(id), reference: null, commit: null, appliedAt: null, displayName: null, extension: null, items: {} };
}

function installedPackages(workspace) {
  const byId = new Map();
  const pkg = (id) => { if (!byId.has(id)) byId.set(id, blank(id)); return byId.get(id); };
  // Oldest first, so each later receipt overrides what an earlier one said.
  const receipts = listReceipts(workspace).filter((r) => r.source && r.source.id).reverse();
  for (const receipt of receipts) {
    const entry = pkg(receipt.source.id);
    entry.reference = receipt.source.reference;
    entry.commit = receipt.source.commit || null;
    entry.appliedAt = receipt.appliedAt;
    entry.displayName = receipt.displayName || null;
    // What the newest receipt offered is what the package carries now. An
    // update's receipt lists every item of the new version (written,
    // unchanged, skipped or blocked, each one the version offered), and
    // also each item it no longer carries, as kept with inPackage false
    // on the update. Listed is therefore not carried: a kept entry is marked, and
    // an item only an older receipt names is one it no longer carries either.
    for (const known of Object.values(entry.items)) known.carried = false;
    for (const item of receipt.items) {
      const known = entry.items[item.id] || { kind: item.kind, destination: item.destination, base: null, transform: null, lastOutcome: null };
      known.lastOutcome = item.outcome;
      known.carried = item.inPackage !== false;
      // A skipped or blocked entry wrote nothing, so the last bytes this
      // package actually wrote remain the base.
      if (item.fingerprint) {
        known.base = { fingerprint: item.fingerprint, authored: item.authored || null };
        known.transform = item.transform || null;
        known.routines = Array.isArray(item.routines) ? item.routines.map((r) => r.name) : [];
      }
      entry.items[item.id] = known;
    }
  }
  // The extension record is authority for the extension half, and the only
  // trace of a package that brought an extension and nothing else.
  for (const record of parseRecordsFile(workspace)) {
    if (!record || !record.source || typeof record.source.url !== 'string') continue;
    const entry = pkg(record.source.url);
    entry.extension = record.name;
    if (isDisplayName(record.displayName)) entry.displayName = record.displayName.trim();
    if (!entry.appliedAt) {
      entry.reference = record.source.reference || null;
      entry.commit = record.source.commit || null;
    }
  }
  return [...byId.values()];
}

// What an item of a package is now: absent, as this package last wrote it,
// or changed since (by the person, or by anything else). Read from the
// workspace, never from the receipt, and compared on the authored digest so
// Rundock's own routine bookkeeping is not a change.
function itemState(workspace, item) {
  const absolute = path.join(workspace, ...item.destination.split('/'));
  let stat;
  try { stat = fs.lstatSync(absolute); } catch (e) { return 'absent'; }
  if (!item.base) return 'present';
  let now;
  if (stat.isFile()) {
    const bytes = fs.readFileSync(absolute);
    now = item.kind === 'agent' ? authoredDigest('agent', bytes) : digestFile(bytes);
  } else if (stat.isDirectory()) {
    // A folder holding a link or a special file was never written by a
    // package (digestDirectory refuses to follow either), so it is the
    // person's now: kept, never walked.
    try { now = digestDirectory(absolute); } catch (e) { if (e instanceof TypeError) return 'changed'; throw e; }
  } else return 'changed';
  const base = item.kind === 'agent' ? item.base.authored : item.base.fingerprint;
  return base && now === base ? 'as-installed' : 'changed';
}

const LINKS = { agent: 'agent', skill: 'skill', starter: 'file' };

// What the page calls a package: its manifest name (the extension's, where it
// has one; otherwise the repository's), title-cased the way an agent's slug
// is ("investment-partner" is "Investment Partner").
function titleCase(slug) {
  return String(slug).split(/[-_\s]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/**
 * One card per installed package, for the Packages page: its name and
 * source, the release or commit it is at, its extension and whether that is
 * on, a count per kind, and every item it brought with a link to where it
 * lives and whether it is still as installed. Whether a newer release exists
 * is the check's answer, not this read's (package-check.js).
 */
function packageCards(workspace) {
  const records = new Map(parseRecordsFile(workspace).filter((r) => r && r.source).map((r) => [r.source.url, r]));
  return installedPackages(workspace).map((pkg) => {
    const repo = pkg.updatable ? pkg.id.replace(/^https:\/\/github\.com\//, '') : pkg.id;
    const items = Object.entries(pkg.items)
      .filter(([, item]) => item.base)
      .map(([id, item]) => {
        const slug = id.slice(item.kind.length + 1);
        return {
          id, kind: item.kind, label: slug, destination: item.destination,
          open: LINKS[item.kind] || 'file', target: item.kind === 'agent' || item.kind === 'skill' ? slug : item.destination,
          state: itemState(workspace, item), routines: item.routines || [], carried: item.carried !== false,
        };
      });
    const record = records.get(pkg.id) || null;
    const counts = { agent: 0, skill: 0, routine: 0, starter: 0, extension: record ? 1 : 0 };
    for (const item of items) {
      if (item.state === 'absent') continue;
      counts[item.kind] = (counts[item.kind] || 0) + 1;
      counts.routine += item.routines.length;
    }
    const name = repo.split('/').pop();
    return {
      id: pkg.id, name, title: pkg.displayName || titleCase(record ? record.name : name), repo, updatable: pkg.updatable,
      reference: pkg.reference, commit: pkg.commit, appliedAt: pkg.appliedAt,
      extension: record ? { name: record.name, version: record.version || null, enabled: record.enabled !== false } : null,
      counts, items,
    };
  });
}

module.exports = { installedPackages, packageCards };
