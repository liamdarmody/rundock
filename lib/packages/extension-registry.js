'use strict';
// The server's half of the extension surface: what is installed, what each
// installation renders, and the bytes a mount needs, path-guarded.
//
// THE INSTALLED LAYOUT IS THE STORE. An installed extension lives at
// `.rundock/plugins/<id>/` with a manifest.json, and its enablement lives in
// `.rundock/plugin-state.json`. This module only ever reads; installing and
// uninstalling are the install flow's transaction, and a registry that could
// write would be a second writer to fight it.
//
// EVERY PAYLOAD PATH IS RESOLVED INSIDE THE EXTENSION'S OWN DIRECTORY, and a
// resolved path that escapes it is refused regardless of what the manifest
// or the client asked for. The contract document says the filesystem is not
// an extension's to reach; this guard is where the server keeps that word
// even against a hostile manifest.

const fs = require('fs');
const path = require('path');

function pluginsRoot(workspace) {
  return path.join(workspace, '.rundock', 'plugins');
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

// One definition of what a declared resource projects to, so the roster and
// the mount cannot disagree about what an extension declared.
function projectResources(manifest) {
  return Array.isArray(manifest.resources)
    ? manifest.resources
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({ id: r.id, maximumBytes: r.maximumBytes }))
    : [];
}

/**
 * Every installed extension, with what it declares and whether it is on.
 * A directory whose manifest cannot be read is reported as broken rather
 * than skipped: an installation that has stopped parsing is a fact the
 * manage surface needs, not a blank.
 */
function listExtensions(workspace) {
  const root = pluginsRoot(workspace);
  let ids = [];
  try { ids = fs.readdirSync(root).filter((n) => !n.startsWith('.')); } catch (e) { return []; }
  const state = readJson(path.join(workspace, '.rundock', 'plugin-state.json')) || { plugins: {} };
  const out = [];
  for (const id of ids.sort()) {
    const manifest = readJson(path.join(root, id, 'manifest.json'));
    const record = (state.plugins || {})[id] || {};
    if (!manifest) {
      out.push({ id, broken: true, reason: 'the manifest could not be read', enabled: false, renderers: [] });
      continue;
    }
    out.push({
      id,
      name: manifest.name || id,
      version: manifest.version || null,
      enabled: record.enabled !== false,
      renderers: Array.isArray(manifest.renderers)
        ? manifest.renderers
          .filter((r) => r && typeof r.id === 'string' && typeof r.target === 'string')
          .map((r) => ({ id: r.id, target: r.target }))
        : [],
      resources: projectResources(manifest),
    });
  }
  return out;
}

/**
 * The bytes one renderer's mount needs: its entry script and styles, read
 * from inside the extension's directory and nowhere else.
 *
 * @returns {{ ok: true, entry: string, styles: string[], resources: Array }
 *   | { ok: false, reason: string }}
 */
function uiPayload(workspace, extensionId, rendererId) {
  // Reject only what makes an id unsafe as a single directory segment:
  // path separators and traversal. listExtensions reports every directory
  // that does not start with a dot, so a narrower spelling rule here would
  // list an extension and then refuse its mount with a false reason. The
  // containment guarantee is kept by insideOrNull below, not by the id
  // spelling, so this only has to keep the id from being a path of its own.
  if (typeof extensionId !== 'string' || extensionId === ''
      || extensionId === '.' || extensionId === '..'
      || /[\\/]/.test(extensionId)) {
    return { ok: false, reason: 'the extension id is not a single directory name' };
  }
  const dir = path.join(pluginsRoot(workspace), extensionId);
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (!manifest) return { ok: false, reason: `no readable manifest for "${extensionId}"` };
  // A manifest whose renderers is not an array is a corrupt or hostile
  // manifest, and the same Array.isArray discipline listExtensions applies
  // holds here: the server refuses rather than raising on `.find` of a
  // non-array.
  if (!Array.isArray(manifest.renderers)) {
    return { ok: false, reason: 'the manifest declares no renderers array' };
  }
  const renderer = manifest.renderers.find((r) => r && r.id === rendererId);
  if (!renderer) return { ok: false, reason: `"${extensionId}" declares no renderer "${rendererId}"` };
  const entryPath = insideOrNull(dir, typeof renderer.entry === 'string' ? renderer.entry : '');
  if (!entryPath) {
    return { ok: false, reason: 'the renderer entry does not resolve inside the extension\'s own directory' };
  }
  let entry;
  try { entry = fs.readFileSync(entryPath, 'utf-8'); } catch (e) {
    return { ok: false, reason: 'the renderer entry could not be read' };
  }
  // Styles are optional, but a styles field that is present and not an array
  // of strings is a broken manifest, refused rather than coerced.
  const styleNames = renderer.styles === undefined ? [] : renderer.styles;
  if (!Array.isArray(styleNames) || styleNames.some((n) => typeof n !== 'string')) {
    return { ok: false, reason: 'the renderer styles must be an array of file names' };
  }
  const styles = [];
  for (const name of styleNames) {
    const stylePath = insideOrNull(dir, name);
    if (!stylePath) return { ok: false, reason: 'a stylesheet does not resolve inside the extension\'s own directory' };
    try { styles.push(fs.readFileSync(stylePath, 'utf-8')); } catch (e) {
      return { ok: false, reason: 'a declared stylesheet could not be read' };
    }
  }
  return { ok: true, entry, styles, resources: projectResources(manifest) };
}

module.exports = { listExtensions, uiPayload, pluginsRoot };
