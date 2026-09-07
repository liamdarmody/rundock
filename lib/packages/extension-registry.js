'use strict';
// The server's half of the extension surface: what is installed, what each
// installation renders, and the bytes a mount needs, path-guarded.
//
// THE INSTALL STORE IS THE ONLY STORE. An installed extension is one record
// in `.claude/rundock/extensions.json` (the file the install transaction
// writes, beside the receipts, travelling with the workspace) and its files
// under `.claude/rundock/extensions/<name>/`, with the `rundock.json` the
// extension shipped declaring `extension.entry` and `extension.match`. This
// module only ever reads; installing, updating and uninstalling are the
// install flow's transaction, and a registry that could write would be a
// second writer to fight it. The earlier per-directory layout under a
// `.rundock` folder with its own state file is read by nothing: two stores
// meant an installed extension the roster never saw.
//
// THE DECLARATION IS THE MANIFEST THE EXTENSION SHIPS, and the record's own
// `entry` and `match` are the copy the install took of it. When the installed
// directory carries `rundock.json` that is what the roster reads; when it
// does not (the install materialises the entry's own top-level path, which
// leaves a root-level manifest behind), the record's copy stands in. Either
// way the same two claims are read, and nothing else about an extension is
// inferred.
//
// EVERY PAYLOAD PATH IS RESOLVED INSIDE THE EXTENSION'S OWN DIRECTORY, and a
// resolved path that escapes it is refused regardless of what the manifest
// or the client asked for. The contract document says the filesystem is not
// an extension's to reach; this guard is where the server keeps that word
// even against a hostile record.

const fs = require('fs');
const path = require('path');

// The store's layout, spelled once. The same strings the install flow writes
// under; a change on either side without the other is an extension that
// installs and never mounts.
const RECORDS_PATH = '.claude/rundock/extensions.json';
const RECORDS_SCHEMA = 'rundock.extensions/v1';
const EXTENSIONS_ROOT = '.claude/rundock/extensions';
const MANIFEST_NAME = 'rundock.json';

// One renderer per extension, by the manifest's shape (one entry, one match
// rule), so the renderer id is a constant rather than a second name to
// spell. The roster names it and the payload serves it under this id.
const RENDERER_ID = 'view';

// An installed name is a lowercase slug, the same rule the manifest reader
// applies at install time. Checked again here because the records file
// travels with the workspace and can carry anything, and the name is what
// becomes a directory segment.
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// The one match rule a renderer can claim: `*.<ext>`, which maps to the
// registry's single-segment target grammar. Case-insensitive on the
// extension because the registry lowercases targets and the lookup does
// too.
const SIMPLE_MATCH = /^\*\.([A-Za-z0-9][A-Za-z0-9-]*)$/;

function extensionsRoot(workspace) {
  return path.join(workspace, ...EXTENSIONS_ROOT.split('/'));
}

function extensionDir(workspace, name) {
  return path.join(extensionsRoot(workspace), name);
}

// The records file, read the way the install flow reads it back: a missing
// file is an empty list, an unreadable one is a refusal, never treated as
// empty, because "nothing installed" and "the records are broken" are
// different facts and only one of them is safe to act on.
function readRecords(workspace) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(workspace, ...RECORDS_PATH.split('/')), 'utf8');
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

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return null; }
}

// A path inside `root`, or nothing. Canonicalised on both sides so a symlink
// spelling cannot walk out; a target that does not exist reads as escaped,
// because a payload file that is not there has nothing safe to say.
function insideOrNull(root, candidate) {
  let realRoot;
  let real;
  try {
    realRoot = fs.realpathSync(path.resolve(root));
    real = fs.realpathSync(path.resolve(root, candidate));
  } catch (e) { return null; }
  if (real === realRoot || real.startsWith(realRoot + path.sep)) return real;
  return null;
}

// What one installed extension declares: its entry and its match rule, from
// the manifest in its directory when there is one, else from the record.
function declaration(workspace, record) {
  const manifest = readJson(path.join(extensionDir(workspace, record.name), MANIFEST_NAME));
  const shipped = manifest && manifest.extension && typeof manifest.extension === 'object'
    ? manifest.extension : null;
  const entry = shipped && typeof shipped.entry === 'string' ? shipped.entry : record.entry;
  const match = shipped && typeof shipped.match === 'string' ? shipped.match : record.match;
  return {
    entry: typeof entry === 'string' && entry ? entry : null,
    match: typeof match === 'string' && match.trim() ? match.trim() : null,
  };
}

// The registry target a match rule maps to, or the reason it maps to none.
// Only `*.<ext>` is a claim; every other rule is reported on the roster as a
// refusal that names it, because a rule silently dropped reads as an
// extension that is broken for no reason anyone can see.
function targetForMatch(match) {
  const m = SIMPLE_MATCH.exec(match);
  if (m) return { target: `.${m[1].toLowerCase()}` };
  return {
    refused: `the match rule "${match}" is not of the form "*.<ext>", the only rule a renderer can claim`,
  };
}

/**
 * Every installed extension, with what it declares and whether it is on.
 * One roster entry per record. A record that cannot be read as an extension
 * is reported as broken rather than skipped: an installation that has
 * stopped parsing is a fact the manage surface needs, not a blank. An
 * unreadable records file throws, and the handler turns that into a roster
 * error carrying the reason.
 */
function listExtensions(workspace) {
  const out = [];
  for (const record of readRecords(workspace)) {
    const id = record && typeof record.name === 'string' ? record.name : '';
    if (!SLUG.test(id)) {
      out.push({
        id: id || '(unnamed)', broken: true, reason: 'the record carries no valid extension name',
        enabled: false, renderers: [], refusals: [], resources: [],
      });
      continue;
    }
    const version = typeof record.version === 'string' ? record.version : null;
    const declared = declaration(workspace, record);
    if (!declared.entry || !declared.match) {
      out.push({
        id, name: id, version, broken: true,
        reason: 'neither the record nor the extension\'s rundock.json declares an entry and a match rule',
        enabled: false, renderers: [], refusals: [], resources: [],
      });
      continue;
    }
    const mapped = targetForMatch(declared.match);
    out.push({
      id,
      name: id,
      version,
      // Absent means enabled: a record the install wrote carries no field
      // until something disables it, and an extension installed with consent
      // is on until it is turned off.
      enabled: record.enabled !== false,
      renderers: mapped.target ? [{ id: RENDERER_ID, target: mapped.target }] : [],
      refusals: mapped.target ? [] : [{ match: declared.match, reason: mapped.refused }],
      // The manifest declares no resources; the field stays on the roster so
      // the shape the client reads is one shape.
      resources: [],
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * The bytes one renderer's mount needs: its entry script, read from inside
 * the extension's directory and nowhere else.
 *
 * @returns {{ ok: true, entry: string, styles: string[], resources: Array }
 *   | { ok: false, reason: string }}
 */
function uiPayload(workspace, extensionId, rendererId) {
  // The id is a name under the same rule the roster applies, so the roster
  // and the payload agree on what an installed extension is, and a name that
  // is a path of its own never becomes a directory segment.
  if (typeof extensionId !== 'string' || !SLUG.test(extensionId)) {
    return { ok: false, reason: 'the extension id is not an installed extension name' };
  }
  const record = readRecords(workspace).find((r) => r && r.name === extensionId) || null;
  if (!record) return { ok: false, reason: `no installed extension named "${extensionId}"` };
  if (rendererId !== RENDERER_ID) {
    return { ok: false, reason: `"${extensionId}" declares no renderer "${rendererId}"` };
  }
  const declared = declaration(workspace, record);
  if (!declared.entry) return { ok: false, reason: `"${extensionId}" declares no entry` };
  const dir = extensionDir(workspace, extensionId);
  const entryPath = insideOrNull(dir, declared.entry);
  if (!entryPath) {
    return { ok: false, reason: 'the renderer entry does not resolve inside the extension\'s own directory' };
  }
  let entry;
  try { entry = fs.readFileSync(entryPath, 'utf-8'); } catch (e) {
    return { ok: false, reason: 'the renderer entry could not be read' };
  }
  return { ok: true, entry, styles: [], resources: [] };
}

module.exports = {
  listExtensions, uiPayload, extensionsRoot,
  RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT, MANIFEST_NAME, RENDERER_ID,
};
