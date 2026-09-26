'use strict';
// The server's half of the extension surface: what is installed, what each
// installation renders, and the bytes a mount needs, path-guarded.
//
// THE INSTALL STORE IS THE ONLY STORE. An installed extension is one record
// in `.rundock/extensions.json` (the file the install transaction writes,
// beside the receipts, in Rundock's own state directory alongside
// conversations and pins) and its files under
// `.rundock/extensions/<name>/`, with the `rundock.json` the extension
// shipped declaring `extension.entry` and `extension.match`. This module
// only ever reads; installing, updating and uninstalling are the install
// flow's transaction, and a registry that could write would be a second
// writer to fight it. The earlier layout of per-extension
// `.rundock/plugins/<id>/` directories with their own state file is read by
// nothing: two stores meant an installed extension the roster never saw.
// Because `.rundock/` stays local to the person and the machine, an install
// here is one this person chose on this machine, never one a shared
// workspace carried in.
//
// THE DECLARATION IS THE MANIFEST THE EXTENSION SHIPS, and the record's own
// `entry`, `match` and `styles` are the copy the install took of it. When
// the installed directory carries `rundock.json` that is what the roster
// reads; when it does not (the install materializes the declared paths' own
// top levels, which leaves a root-level manifest behind), the record's copy
// stands in. Either way the same claims are read, and nothing else about an
// extension is inferred.
//
// EVERY PAYLOAD PATH IS RESOLVED INSIDE THE EXTENSION'S OWN DIRECTORY, and a
// resolved path that escapes it is refused regardless of what the manifest
// or the client asked for. The contract document says the filesystem is not
// an extension's to reach; this guard is where the server keeps that word
// even against a hostile record.

const fs = require('fs');
const path = require('path');

// The store's layout is spelled once, by the writer: this reader imports the
// records path, the schema and the extensions root from the install flow's
// own record module rather than re-spelling them, because two copies of a
// store layout is how an installed extension comes to be seen by nothing.
const { RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT, readAllOff } = require('./extension-record.js');
// The parsing is the writer's too: the roster reads the store through the
// record module's one parser (a missing file is an empty list, an
// unreadable one a refusal) and keeps only the per-entry verdict for
// itself, because a record that has stopped parsing is a fact the manage
// surface reports as a broken row where the acting consumers refuse the
// whole file. The slug rule is the manifest reader's own, imported from
// where the install applies it, and checked again here because the records
// file is plain JSON anything can have edited and the name is what becomes
// a directory segment.
const { parseRecordsFile } = require('./extension-record.js');
const { SLUG, AGENT_ID, MAX_ASKS, isDisplayName } = require('./extension-manifest.js');
const MANIFEST_NAME = 'rundock.json';

// One renderer per extension, by the manifest's shape (one entry, one match
// rule), so the renderer id is a constant rather than a second name to
// spell. The roster names it and the payload serves it under this id.
const RENDERER_ID = 'view';

// The one match rule a renderer can claim: `*.<ext>`, which maps to the
// registry's single-segment target grammar. Case-insensitive on the
// extension because the registry lowercases targets and the lookup does
// too.
const SIMPLE_MATCH = /^\*\.([A-Za-z0-9][A-Za-z0-9-]*)$/;

// The markers core renders itself, per registry target. Kanban detects a
// board by the `kanban-plugin` frontmatter key, so an extension declaring
// that key over ".md" would be claiming the built-in board view's own
// files. The claim is refused here on the roster, where the manage page
// reads its problem lines, and refused again by the client registry at
// registration; the client cannot import this module (it is browser-side
// with no build step), so the table exists twice and a test holds the two
// copies equal.
const CORE_MARKERS = {
  '.md': { 'kanban-plugin': "Rundock's own board view" },
};

function extensionsRoot(workspace) {
  return path.join(workspace, ...EXTENSIONS_ROOT.split('/'));
}

function extensionDir(workspace, name) {
  return path.join(extensionsRoot(workspace), name);
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

// What one installed extension declares: its entry, its match rule, and any
// stylesheets, from the manifest in its directory when there is one, else
// from the record. The styles value is carried raw here and judged by the
// payload, because the records file and the manifest are plain JSON anything
// can have edited, and a malformed claim must become a named refusal at the
// point of serving rather than a silent shape-fix.
function declaration(workspace, record) {
  const manifest = readJson(path.join(extensionDir(workspace, record.name), MANIFEST_NAME));
  const shipped = manifest && manifest.extension && typeof manifest.extension === 'object'
    ? manifest.extension : null;
  const entry = shipped && typeof shipped.entry === 'string' ? shipped.entry : record.entry;
  const match = shipped && typeof shipped.match === 'string' ? shipped.match : record.match;
  const styles = shipped && shipped.styles !== undefined ? shipped.styles : record.styles;
  // The marker claim rides beside the match rule and takes the same
  // fallback: the shipped manifest when the installed directory carries
  // one, the record's copy when it does not, which is the path real
  // installs take.
  const declares = shipped && typeof shipped.declares === 'string' ? shipped.declares : record.declares;
  // The drawn language takes the same fallback as every other claim: the
  // shipped manifest where the installed directory carries one, the record's
  // copy where it does not, which is the path a real install takes.
  const draws = shipped && typeof shipped.draws === 'string' ? shipped.draws : record.draws;
  return {
    entry: typeof entry === 'string' && entry ? entry : null,
    match: typeof match === 'string' && match.trim() ? match.trim() : null,
    declares: typeof declares === 'string' && declares.trim() ? declares.trim() : null,
    draws: typeof draws === 'string' && draws.trim() ? draws.trim() : null,
    styles,
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

// The record's own facts, carried on the roster for the manage page: where
// it came from and when. The roster is the one read both surfaces share,
// so what the list shows as provenance is what the store says.
function provenance(record) {
  const source = record && record.source && typeof record.source === 'object' ? record.source : null;
  return {
    source: source && typeof source.url === 'string'
      ? { url: source.url, reference: typeof source.reference === 'string' ? source.reference : null }
      : null,
    installedAt: record && typeof record.installedAt === 'string' ? record.installedAt : null,
    // Plain JSON anything can have edited, so held to the manifest's rule
    // again rather than trusted.
    ...(record && isDisplayName(record.displayName) ? { displayName: record.displayName.trim() } : {}),
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
  const records = parseRecordsFile(workspace);
  // Every extension switched off at once. Each entry then reads as off, so
  // nothing registers or claims a file, and says why, so the manage page can
  // tell "off because of the switch" from "off because you turned it off".
  const allOff = readAllOff(workspace);
  for (const record of records) {
    const id = record && typeof record.name === 'string' ? record.name : '';
    if (!SLUG.test(id)) {
      out.push({
        id: id || '(unnamed)', broken: true, reason: 'The record carries no valid extension name.',
        enabled: false, renderers: [], refusals: [], resources: [], ...provenance(record),
      });
      continue;
    }
    const version = typeof record.version === 'string' ? record.version : null;
    const declared = declaration(workspace, record);
    // An entry is what makes an extension runnable at all, so its absence is
    // still broken. A CLAIM is what makes it useful, and a fenced language is
    // a claim: a region extension owns no file type on purpose, and a record
    // with an entry and a drawn language is complete.
    if (!declared.entry || (!declared.match && !declared.draws)) {
      out.push({
        id, name: id, version, broken: true,
        reason: 'Neither the record nor the extension\'s rundock.json declares an entry and something to claim.',
        enabled: false, renderers: [], refusals: [], resources: [], ...provenance(record),
      });
      continue;
    }
    // AN EXTENSION THAT CLAIMS NO FILE IS NOT AN EXTENSION THAT FAILED TO.
    // A region extension draws a fenced language and owns no file type, so it
    // has no match rule and must produce no renderer AND no refusal. Reading
    // an absent rule through targetForMatch would report it on the manage
    // page as broken for no reason anyone could see, which is the exact
    // failure that function's own comment exists to prevent, arrived at from
    // the other direction.
    const claimsAFile = typeof declared.match === 'string' && declared.match.trim() !== '';
    const mapped = claimsAFile ? targetForMatch(declared.match) : { target: null, absent: true };
    let renderers = mapped.target
      ? [{ id: RENDERER_ID, target: mapped.target,
        // The marker rides on the renderer only when one is declared, so a
        // marker-less roster keeps the exact shape every existing consumer
        // reads.
        ...(declared.declares ? { declares: declared.declares } : {}) }]
      : [];
    let refusals = (mapped.target || mapped.absent)
      ? [] : [{ match: declared.match, reason: mapped.refused }];
    // A record granting sources with no marker to claim notes by is refused
    // on the roster, as the install refuses the manifest: its view would
    // otherwise be handed the list of any note of its type.
    if (mapped.target && record.sources === true && !declared.declares) {
      renderers = [];
      refusals = [{ match: declared.match,
        reason: 'The extension declares sources but no frontmatter marker, so it cannot be told which notes are for it.' }];
    }
    // A declared marker outside the key grammar is refused rather than
    // dropped to a bare claim: silently widening "some files of this type"
    // into "every file of this type" is the overreach the marker exists to
    // prevent, and the records file is plain JSON anything can have edited.
    if (mapped.target && declared.declares && !SLUG.test(declared.declares)) {
      renderers = [];
      refusals = [{ match: declared.match, declares: declared.declares,
        reason: `The declared marker "${declared.declares}" is not a frontmatter key of lowercase letters, digits and dashes.` }];
    }
    out.push({
      id,
      name: id,
      version,
      // Absent means enabled: a record the install wrote carries no field
      // until something disables it, and an extension installed with consent
      // is on until it is turned off.
      enabled: record.enabled !== false && !allOff,
      // Only while the switch is on: that it is, and the extension's own
      // setting, which the switch never changes and turning it back off
      // restores. Absent otherwise, so the roster keeps the shape every
      // existing consumer reads.
      ...(allOff ? { allOff: true, ownEnabled: record.enabled !== false } : {}),
      renderers,
      refusals,
      // The fenced language this extension draws, if any. Carried beside the
      // renderers rather than inside them, because it claims no file and a
      // renderer is a claim on one: a consumer asking "who renders .csv" and
      // one asking "who draws mermaid" are asking different questions.
      ...(declared.draws ? { draws: declared.draws } : {}),
      // The manifest declares no resources; the field stays on the roster so
      // the shape the client reads is one shape.
      resources: [],
      ...provenance(record),
      // The exact build: the version and the commit it was installed at, so
      // an open view is swapped when a package update brings new code under
      // an unchanged version number. Absent without a commit.
      ...(record.source && typeof record.source.commit === 'string' ? { build: `${version}@${record.source.commit}` } : {}),
    });
  }
  const sorted = out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Marker precedence, settled on the roster so the losing claim reaches
  // the managed row as a problem line rather than being computed at the
  // client and dropped. Core beats an extension on the same marker, and two
  // extensions on one marker keep first-claim-wins in roster order, which
  // is this sorted order, the same order the client registers in. A refused
  // claim is removed from the entry's renderers: a claim the registry would
  // refuse anyway must not read as a working one here. Disabled entries
  // contest nothing, exactly as they register nothing.
  const holders = new Map();
  for (const entry of sorted) {
    if (entry.broken || entry.enabled === false) continue;
    entry.renderers = entry.renderers.filter((renderer) => {
      if (!renderer.declares) return true;
      const coreOwner = CORE_MARKERS[renderer.target] ? CORE_MARKERS[renderer.target][renderer.declares] : null;
      if (coreOwner) {
        entry.refusals.push({ match: renderer.target, declares: renderer.declares,
          reason: `Files marked "${renderer.declares}" are rendered by ${coreOwner}; the marker is Rundock's and cannot be claimed.` });
        return false;
      }
      const key = `${renderer.target} ${renderer.declares}`;
      const holder = holders.get(key);
      if (holder) {
        entry.refusals.push({ match: renderer.target, declares: renderer.declares,
          reason: `Files ending "${renderer.target}" and marked "${renderer.declares}" are already rendered by ${holder}.` });
        return false;
      }
      holders.set(key, entry.id);
      return true;
    });
  }
  return sorted;
}

/**
 * The bytes one renderer's mount needs: its entry script and any declared
 * stylesheets, each read from inside the extension's directory and nowhere
 * else. Every failure, an unreadable records file included, is a refusal
 * carrying its reason, never a throw: the payload path answers the same way
 * the roster path does. A declared stylesheet that does not resolve inside
 * the directory refuses the whole payload exactly as a bad entry does,
 * because a stylesheet silently dropped is an extension broken for no
 * reason anyone can see.
 *
 * `resources` stays a shape-only placeholder, always empty: resources are
 * not declared or served today, and the field is kept so the client reads
 * one shape now and when a resource transport ships.
 *
 * @returns {{ ok: true, entry: string, styles: string[], resources: [] }
 *   | { ok: false, reason: string }}
 */
function uiPayload(workspace, extensionId, rendererId) {
  // The id is a name under the same rule the roster applies, so the roster
  // and the payload agree on what an installed extension is, and a name that
  // is a path of its own never becomes a directory segment.
  if (typeof extensionId !== 'string' || !SLUG.test(extensionId)) {
    return { ok: false, reason: 'the extension id is not an installed extension name' };
  }
  let records;
  try { records = parseRecordsFile(workspace); } catch (e) {
    return { ok: false, reason: e && e.message ? e.message : String(e) };
  }
  const record = records.find((r) => r && r.name === extensionId) || null;
  if (!record) return { ok: false, reason: `no installed extension named "${extensionId}"` };
  // OFF IS ENFORCED HERE, where the bytes are served, and not only in the
  // windows that choose not to mount. A window holding a stale roster, or one
  // that never heard the change, still cannot fetch an extension that has
  // been turned off, whether by its own setting or by the switch for all.
  if (readAllOff(workspace)) return { ok: false, reason: 'every extension is switched off' };
  if (record.enabled === false) return { ok: false, reason: `"${extensionId}" is disabled` };
  const declared = declaration(workspace, record);
  // A REGION EXTENSION HAS NO RENDERER, AND ASKS WITHOUT NAMING ONE. It draws
  // a fenced language and claims no file, so there is no renderer id it could
  // name and none it should have to invent. Requiring one here meant its own
  // entry could never be served: every diagram failed with "declares no
  // renderer null" while the extension was correctly installed, enabled and
  // whole.
  //
  // So the question this asks is whether the caller named a renderer this
  // extension actually has. Naming one it does not have is still refused, and
  // naming none is only allowed where there is something else to serve.
  const asksForRenderer = rendererId !== undefined && rendererId !== null;
  // Naming the right id is not enough: the extension has to HAVE it. A
  // region extension declares no renderer at all, so asking it for `view`
  // names something that does not exist, and serving that would be the
  // registry agreeing to a claim nobody made.
  if (asksForRenderer && (rendererId !== RENDERER_ID || !declared.match)) {
    return { ok: false, reason: `"${extensionId}" declares no renderer "${rendererId}"` };
  }
  if (!asksForRenderer && !declared.draws) {
    return { ok: false, reason: `"${extensionId}" renders files, so a renderer must be named` };
  }
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
  // The declared stylesheets, under the same containment the entry just
  // passed. An absent declaration is an empty list; a declaration that is
  // not a list of paths is a named refusal, because the manifest and the
  // record are plain JSON anything can have edited.
  const declaredStyles = declared.styles === undefined || declared.styles === null ? [] : declared.styles;
  if (!Array.isArray(declaredStyles) || declaredStyles.some((s) => typeof s !== 'string' || !s)) {
    return { ok: false, reason: `"${extensionId}" declares styles that are not a list of relative paths` };
  }
  const styles = [];
  for (const declaredStyle of declaredStyles) {
    const stylePath = insideOrNull(dir, declaredStyle);
    if (!stylePath) {
      return { ok: false, reason: 'a declared stylesheet does not resolve inside the extension\'s own directory' };
    }
    try { styles.push(fs.readFileSync(stylePath, 'utf-8')); } catch (e) {
      return { ok: false, reason: 'a declared stylesheet could not be read' };
    }
  }
  // The write privilege comes from the RECORD, which is what was installed
  // and what the trust card was shown for, never from a manifest sitting in
  // the extension's directory now: that file is plain JSON anything can have
  // edited since, and the same reasoning already governs the styles above.
  // Sources and asks come from the record for the same reason, each held to
  // its rule again here because the records file is plain JSON: sources only
  // with a marker, asks only as valid agent ids, at most four.
  const asks = Array.isArray(record.asks)
    ? record.asks.filter((a) => typeof a === 'string' && AGENT_ID.test(a)).slice(0, MAX_ASKS) : [];
  return { ok: true, entry, styles, resources: [], writes: record.writes === true,
    sources: record.sources === true && !!declared.declares, asks };
}

// The file extensions an enabled, working roster entry claims, read off the
// targets this roster produced (each is the match rule's extension behind a
// dot, under SIMPLE_MATCH above), so the file tree takes its claims from the
// roster's own answer rather than re-parsing the target under a rule of its
// own.
function claimedExtensions(roster) {
  const exts = new Set();
  for (const ext of Array.isArray(roster) ? roster : []) {
    if (!ext || ext.enabled === false || ext.broken) continue;
    for (const r of ext.renderers || []) {
      const target = String((r && r.target) || '');
      if (target.length > 1 && target.startsWith('.')) exts.add(target.slice(1));
    }
  }
  return [...exts].sort();
}

module.exports = {
  listExtensions, uiPayload, extensionsRoot, claimedExtensions,
  RECORDS_PATH, RECORDS_SCHEMA, EXTENSIONS_ROOT, MANIFEST_NAME, RENDERER_ID, CORE_MARKERS,
};
