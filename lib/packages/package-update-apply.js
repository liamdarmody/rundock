'use strict';
// WHAT A PACKAGE UPDATE WRITES BESIDE ITS ITEMS, computed from the ready
// evaluation and handed to applyImport as `extra`, so all of it lands in the
// one transaction with the items and the receipt:
//
// - the extension's files and its record, when the package carries one;
// - the author's new version of every item kept because the person changed
//   it, saved for review under .rundock/package-updates/<owner>-<repo>/<to>/;
// - a backup of every item the update replaces, under .../<from>/.
//
// The review folder is hidden on purpose: a visible copy of a data file
// would be claimed and rendered by its extension, make wikilinks ambiguous
// and be found by agents searching the workspace (spec section 10).

const fs = require('node:fs');
const path = require('node:path');

const { extensionWrites } = require('./extension-install.js');
const { itemSourcePath } = require('./import-apply.js');
const { ABSENT_DIGEST } = require('./import-evaluate.js');

const UPDATES_DIR = '.rundock/package-updates';

// One folder segment from a repository or a release name.
const segment = (value) => String(value || 'unversioned').replace(/[^A-Za-z0-9._-]/g, '-');

function packageFolder(workspace, pkgId) {
  const [owner, repo] = pkgId.replace(/^https:\/\/github\.com\//, '').split('/');
  return path.join(workspace, ...UPDATES_DIR.split('/'), segment(`${owner}-${repo}`));
}

// Where the author's version of an item is saved for review, relative to
// the workspace: the one spelling the review, the prompt and the write share.
function reviewPath(pkgId, reference, destination) {
  const [owner, repo] = pkgId.replace(/^https:\/\/github\.com\//, '').split('/');
  return `${UPDATES_DIR}/${segment(`${owner}-${repo}`)}/${segment(reference)}/${destination}`;
}

// Every file of an item at `absolute`, as { rel, content }: one file, or a
// skill's whole folder.
function filesOf(absolute) {
  const stat = fs.lstatSync(absolute);
  if (stat.isFile()) return [{ rel: '', content: fs.readFileSync(absolute) }];
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), child);
      else if (entry.isFile()) out.push({ rel: child, content: fs.readFileSync(path.join(dir, entry.name)) });
    }
  };
  walk(absolute, '');
  return out;
}

function copies(fromAbsolute, toFolder, destination) {
  return filesOf(fromAbsolute).map(({ rel, content }) => ({
    path: path.join(toFolder, ...destination.split('/'), ...(rel ? rel.split('/') : [])),
    content,
  }));
}

function updateExtras(workspace, snapshot, pending, evaluation) {
  const folder = packageFolder(workspace, pending.pkg.id);
  const writes = [];
  const replaceDirs = [];
  if (pending.extension) {
    const ext = extensionWrites(workspace, snapshot, pending.extension);
    writes.push(...ext.writes);
    replaceDirs.push(...ext.replaceDirs);
  }
  if (pending.update) {
    for (const entries of Object.values(pending.update.groups)) {
      for (const entry of entries) {
        if (!entry.saveAuthor) continue;
        writes.push(...copies(path.join(snapshot, ...itemSourcePath(entry.kind, entry.slug).split('/')), workspace,
          reviewPath(pending.pkg.id, pending.source.reference, entry.destination)));
      }
    }
    const fromFolder = path.join(folder, segment(pending.pkg.reference));
    const planned = new Map(pending.update.approval.items.map((item) => [item.id, item.plannedDigest]));
    for (const write of evaluation.writes) {
      if (planned.get(write.id) === ABSENT_DIGEST) continue;
      writes.push(...copies(path.join(workspace, ...write.destination.split('/')), fromFolder, write.destination));
    }
  }
  return { writes, replaceDirs };
}

// The folder's size, for the Packages page. A link or anything that is not
// a folder is reported as empty and never walked.
function updatesFolderSize(workspace) {
  const root = path.join(workspace, ...UPDATES_DIR.split('/'));
  let stat;
  try { stat = fs.lstatSync(root); } catch (e) { return { bytes: 0, files: 0 }; }
  if (!stat.isDirectory()) return { bytes: 0, files: 0 };
  const files = filesOf(root);
  return { bytes: files.reduce((n, f) => n + f.content.length, 0), files: files.length };
}

// Clear: the folder and only the folder, and only when the person asks.
// Refused when it is a link, so a clear can never reach outside the workspace.
function clearUpdatesFolder(workspace) {
  const root = path.join(workspace, ...UPDATES_DIR.split('/'));
  let stat;
  try { stat = fs.lstatSync(root); } catch (e) { return; }
  if (!stat.isDirectory()) throw new Error(`${UPDATES_DIR} is not a folder Rundock made; nothing was removed`);
  fs.rmSync(root, { recursive: true, force: true });
}

module.exports = { updateExtras, reviewPath, updatesFolderSize, clearUpdatesFolder, UPDATES_DIR };
