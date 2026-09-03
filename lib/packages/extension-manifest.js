'use strict';
// The extension manifest, and the facts the trust step shows.
//
// CODE REQUIRES A MANIFEST, ALWAYS. An entry point and a match rule are
// claims rather than facts, so nothing infers an extension: a repository
// without a valid `rundock.json` declaring one has no extension to install,
// whatever else it carries. The manifest is read strictly and refused by
// name, never patched, because a half-understood claim about code is worse
// than none.
//
// THE FACTS SHOWN ARE DERIVED, NEVER DECLARED. Self-declared permissions are
// theatre when nothing enforces them; Rundock reads the package and states
// what installing it will actually do. Everything deriveFacts returns is
// computed from bytes in the snapshot, and the manifest contributes only the
// claims that ARE the extension (its entry and match rule), never a count or
// a capability.

const fs = require('node:fs');
const path = require('node:path');

const { discoverPackage } = require('./import-plan.js');

const MANIFEST_NAME = 'rundock.json';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function refuse(message, code) {
  const error = new TypeError(`extension manifest refused: ${message}`);
  error.code = code || 'extension-manifest-refused';
  throw error;
}

// A relative path inside the snapshot: no traversal, no absolutes, and the
// file it names must exist as a regular file reached without following a
// symlink anywhere along it.
function assertEntryPath(root, relative) {
  if (typeof relative !== 'string' || !relative) refuse('extension.entry must be a relative path');
  if (path.isAbsolute(relative)) refuse('extension.entry must not be absolute');
  const normal = path.normalize(relative).split(path.sep).join('/');
  if (normal === '..' || normal.startsWith('../')) refuse('extension.entry must stay inside the package');
  const segments = normal.split('/');
  let walked = root;
  for (const segment of segments) {
    walked = path.join(walked, segment);
    let stat;
    try {
      stat = fs.lstatSync(walked);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') refuse(`extension.entry names ${normal}, which does not exist in the package`);
      throw e;
    }
    if (stat.isSymbolicLink()) refuse(`extension.entry passes through a symlink at ${segment}`);
  }
  if (!fs.lstatSync(walked).isFile()) refuse(`extension.entry ${normal} is not a regular file`);
  return normal;
}

/**
 * Read and validate the snapshot's manifest, requiring the extension half.
 * Returns { name, version, entry, match }. Refusals are named; a repository
 * with no manifest is a named refusal with its own code, because the install
 * screen treats "not an extension" differently from "a broken one".
 */
function readExtensionManifest(snapshotRoot) {
  const manifestPath = path.join(snapshotRoot, MANIFEST_NAME);
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') {
      refuse(`the package has no ${MANIFEST_NAME}; code requires a manifest, always`, 'not-an-extension');
    }
    throw e;
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    refuse(`${MANIFEST_NAME} is not valid JSON: ${e.message}`);
  }
  if (!manifest || typeof manifest !== 'object') refuse(`${MANIFEST_NAME} must be an object`);
  if (typeof manifest.name !== 'string' || !SLUG.test(manifest.name)) {
    refuse('name must be a lowercase slug');
  }
  if (typeof manifest.version !== 'string' || !manifest.version.trim()) {
    refuse('version must be a non-empty string');
  }
  const extension = manifest.extension;
  if (!extension || typeof extension !== 'object') {
    refuse(`${MANIFEST_NAME} declares no extension; code requires a manifest, always`, 'not-an-extension');
  }
  const entry = assertEntryPath(snapshotRoot, extension.entry);
  if (typeof extension.match !== 'string' || !extension.match.trim()) {
    refuse('extension.match must be a non-empty match rule');
  }
  return { name: manifest.name, version: manifest.version.trim(), entry, match: extension.match.trim() };
}

// The extension's own files: the entry file when it sits at the root, or the
// whole top-level directory the entry lives under. One rule, stated here,
// so what the install materialises is decided by where the author put the
// entry rather than by anything self-declared.
function extensionFileSet(snapshotRoot, entry) {
  const top = entry.split('/')[0];
  const topPath = path.join(snapshotRoot, top);
  const files = [];
  const walk = (absolute, relative) => {
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) refuse(`${relative} is a symlink`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute)) walk(path.join(absolute, name), `${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push({ rel: relative, content: fs.readFileSync(absolute) });
    } else {
      refuse(`${relative} is an unsupported entry type`);
    }
  };
  if (fs.lstatSync(topPath).isFile()) {
    files.push({ rel: top, content: fs.readFileSync(topPath) });
  } else {
    for (const name of fs.readdirSync(topPath)) walk(path.join(topPath, name), `${top}/${name}`);
  }
  return files;
}

/**
 * Everything the trust step says, computed from the snapshot. Counts come
 * from the same discovery the content import runs, so the screen and the
 * import can never disagree about what the package holds.
 */
function deriveFacts(snapshotRoot, manifest) {
  let agents = 0;
  let skills = 0;
  try {
    for (const item of discoverPackage(snapshotRoot)) {
      if (item.kind === 'agent') agents += 1;
      else skills += 1;
    }
  } catch (e) {
    // A pure extension carries no agents and no skills; that absence is a
    // fact worth showing, not a refusal here.
    if (e.code !== 'empty-package') throw e;
  }
  const files = extensionFileSet(snapshotRoot, manifest.entry);
  return {
    agents,
    skills,
    shipsView: true,
    entry: manifest.entry,
    match: manifest.match,
    files: files.map((f) => f.rel).sort(),
  };
}

module.exports = { MANIFEST_NAME, readExtensionManifest, deriveFacts, extensionFileSet };
