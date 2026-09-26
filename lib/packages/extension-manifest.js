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
// claims that ARE the extension (its entry, its match rule, its declared
// stylesheets), never a count or a capability.

const fs = require('node:fs');
const path = require('node:path');

const { discoverPackage } = require('./import-plan.js');
const { routinesCarried } = require('./import-apply.js');
const { rundockUiCompatible } = require('./rundock-ui-version.js');
const { isDisplayName, DISPLAY_NAME_MAX } = require('./display-name.js');

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

// The same walk for a declared stylesheet, with its own refusals so a broken
// styles claim is named as what it is rather than blamed on the entry. Kept
// as a sibling of assertEntryPath instead of a shared parameterised walker
// because each refusal string is a guard the mutation harness breaks by
// name, and a template would take those names away.
function assertStylePath(root, relative) {
  if (typeof relative !== 'string' || !relative) refuse('every extension.styles item must be a relative path');
  if (path.isAbsolute(relative)) refuse('extension.styles paths must not be absolute');
  const normal = path.normalize(relative).split(path.sep).join('/');
  if (normal === '..' || normal.startsWith('../')) refuse('extension.styles paths must stay inside the package');
  const segments = normal.split('/');
  let walked = root;
  for (const segment of segments) {
    walked = path.join(walked, segment);
    let stat;
    try {
      stat = fs.lstatSync(walked);
    } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') refuse(`extension.styles names ${normal}, which does not exist in the package`);
      throw e;
    }
    if (stat.isSymbolicLink()) refuse(`extension.styles passes through a symlink at ${segment}`);
  }
  if (!fs.lstatSync(walked).isFile()) refuse(`extension.styles ${normal} is not a regular file`);
  return normal;
}

/**
 * Read and validate the snapshot's manifest, requiring the extension half.
 * Returns { name, version, entry, match, styles }. Refusals are named; a repository
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
  // Checked before the extension block, so a package of agents and skills
  // that names itself is held to the same rule as one that ships code.
  const displayName = readDisplayName(manifest.displayName);
  const extension = manifest.extension;
  if (!extension || typeof extension !== 'object') {
    refuse(`${MANIFEST_NAME} declares no extension; code requires a manifest, always`, 'not-an-extension');
  }
  const entry = assertEntryPath(snapshotRoot, extension.entry);
  // A MATCH RULE IS NOT THE ONLY WAY TO CLAIM SOMETHING. An extension that
  // only draws a fenced language claims no file at all: the document stays
  // the editor's and one block inside it is delegated. Requiring `match`
  // would force such an extension to name a file type it cannot render, and
  // registering a renderer for files it never draws is exactly the quiet
  // shadowing the claim registry exists to prevent.
  //
  // So the rule is that an extension must claim SOMETHING, and either kind
  // of claim satisfies it. An extension carrying neither is refused by name
  // rather than installed as an inert entry nobody can explain.
  const hasMatch = typeof extension.match === 'string' && extension.match.trim() !== '';
  const hasDraws = typeof extension.draws === 'string' && extension.draws.trim() !== '';
  if (!hasMatch && !hasDraws) {
    refuse('extension.match must be a non-empty match rule, unless extension.draws names a fenced language');
  }
  if (extension.match !== undefined && !hasMatch) {
    refuse('extension.match must be a non-empty match rule');
  }
  // The marker claim: an optional frontmatter key that narrows the match
  // rule to the files carrying it, so an extension can own a kind of
  // markdown file without claiming every note in the workspace. The grammar
  // is the slug grammar, which kanban's own `kanban-plugin` key fits,
  // because the marker convention this mirrors is kanban's. Refused rather
  // than patched when it is unreadable, like every other claim here.
  let declares = null;
  if (extension.declares !== undefined) {
    if (typeof extension.declares !== 'string' || !SLUG.test(extension.declares.trim())) {
      refuse('extension.declares must be a frontmatter marker key of lowercase letters, digits and dashes');
    }
    declares = extension.declares.trim();
  }
  // Styles are an optional claim: an extension may ship its palette inlined
  // in the entry and declare none. When declared they are validated exactly
  // as the entry is, because a stylesheet is bytes the host will inline into
  // the frame, and a half-understood claim about those is worse than none.
  const styles = [];
  if (extension.styles !== undefined) {
    if (!Array.isArray(extension.styles)) refuse('extension.styles must be an array of relative paths');
    for (const declared of extension.styles) styles.push(assertStylePath(snapshotRoot, declared));
  }
  // The Rundock UI version the extension was built against, when it names
  // one. Optional, because an extension that draws its own controls makes no
  // promise to check; when present it is held to the compatibility rule in
  // rundock-ui-version.js and refused by name, because an extension that
  // calls a component this Rundock does not have, or one that now behaves
  // differently, would install cleanly and then fail in front of the person.
  let rundockUi = null;
  if (extension.rundockUi !== undefined) {
    if (typeof extension.rundockUi !== 'string') refuse('extension.rundockUi must be a version string of the form MAJOR.MINOR, such as "1.0"');
    // Exactly as declared: " 1.0" is not a version, it is a typo that a trim
    // would quietly install as one.
    const verdict = rundockUiCompatible(extension.rundockUi);
    if (!verdict.ok) refuse(verdict.reason, 'rundock-ui-incompatible');
    rundockUi = extension.rundockUi;
  }
  // The fenced language this extension draws, if it draws one. A
  // region extension claims no file and registers no renderer: the document
  // stays the editor's and only the block inside the fence is delegated, so
  // this is its own claim rather than a shape of `match`. Null when absent,
  // for the same reason `writes` is false when absent: a reader downstream
  // should never have to decide what a missing key meant.
  //
  // The grammar is the slug grammar, which is what a fence's own info string
  // is in practice (`mermaid`, `dataview`). Refused rather than normalised:
  // an extension declaring `Mermaid` would draw nothing and be told nothing,
  // which is the silent half of a claim that cannot fire.
  let draws = null;
  if (extension.draws !== undefined) {
    if (typeof extension.draws !== 'string' || !SLUG.test(extension.draws.trim())) {
      refuse('extension.draws must be a fenced language of lowercase letters, digits and dashes');
    }
    draws = extension.draws.trim();
  }
  // Read-only is the default, and writing is the exception an
  // extension has to ask for. Absence is an answer rather than a gap, so this
  // resolves to false rather than undefined: every reader downstream, the
  // trust card included, asks a boolean and never has to decide what a
  // missing key meant. Anything other than a literal true or false is
  // refused by name, because a manifest that half-claims a privilege is
  // worse than one that does not claim it: "true" the string would coerce to
  // a yes in any careless read.
  let writes = false;
  if (extension.writes !== undefined) {
    if (typeof extension.writes !== 'boolean') {
      refuse('extension.writes must be true or false');
    }
    writes = extension.writes;
  }
  // NAMED SOURCES: the view may be handed the files a note it claims lists
  // under `sources:`. Only a literal boolean, like writes, and only together
  // with a marker: `sources` is a common frontmatter key (people use it for
  // citations), so an extension claiming every note of a type would
  // otherwise harvest every note's list. The marker is the person saying
  // "this note is for that view", which is what makes its list for it.
  let sources = false;
  if (extension.sources !== undefined) {
    if (typeof extension.sources !== 'boolean') refuse('extension.sources must be true or false');
    sources = extension.sources;
  }
  if (sources && !declares) {
    refuse('extension.sources requires extension.declares: a view is handed a note\'s sources only when it claims that note by a frontmatter marker');
  }
  // ASK AN AGENT: the agents this extension may draft a message to, named in
  // the manifest so the trust card can name them and so a view can never
  // probe the team for others. One to four agent ids, no repeats.
  let asks = [];
  if (extension.asks !== undefined) {
    if (!Array.isArray(extension.asks) || extension.asks.length < 1 || extension.asks.length > MAX_ASKS) {
      refuse(`extension.asks must list one to ${MAX_ASKS} agent ids`);
    }
    for (const id of extension.asks) {
      if (typeof id !== 'string' || !AGENT_ID.test(id)) {
        refuse('every extension.asks item must be an agent id of lowercase letters, digits, dashes and underscores, at most 64 characters');
      }
    }
    if (new Set(extension.asks).size !== extension.asks.length) refuse('extension.asks names an agent twice');
    asks = extension.asks.slice();
  }
  return { name: manifest.name, ...(displayName ? { displayName } : {}), version: manifest.version.trim(), entry, match: hasMatch ? extension.match.trim() : null, declares, draws, writes, sources, asks, styles, rundockUi };
}

// WHAT A PACKAGE CALLS ITSELF, where a slug would read badly ("csv-table" is
// "Csv Table"). Optional; when present it is shown on the install card, the
// Packages page and the Extensions page, so it is held to one rule: plain
// text, trimmed, at most DISPLAY_NAME_MAX characters, with no markup, no
// line break and no control character. Refused by name rather than cleaned,
// because a name the author did not write is a name nobody chose.
function readDisplayName(value) {
  if (value === undefined) return null;
  if (!isDisplayName(value)) {
    refuse(`displayName must be plain text of 1 to ${DISPLAY_NAME_MAX} characters, with no markup or line breaks`);
  }
  return value.trim();
}

/**
 * The display name a package's own rundock.json gives, for a package of
 * agents and skills that ships no extension; null when it has no manifest or
 * names nothing. Read after the snapshot was classified, which has already
 * refused a malformed one.
 */
function readPackageDisplayName(snapshotRoot) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(snapshotRoot, MANIFEST_NAME), 'utf8')); } catch (e) { return null; }
  return manifest && isDisplayName(manifest.displayName) ? manifest.displayName.trim() : null;
}

// The agent id grammar an ask names. Shared with the host's table and the
// payload, which each hold it again at their own boundary.
const AGENT_ID = /^[a-z0-9_-]{1,64}$/;
const MAX_ASKS = 4;

/**
 * What a snapshot is, decided from its bytes: an extension when a valid
 * manifest declares one, content otherwise. Only the two "not an extension"
 * refusals (no manifest, or a manifest without an extension block) mean
 * content; a manifest that claims an extension and gets it wrong is a
 * refusal in its own right, because a half-understood claim about code is
 * worse than none.
 */
function classifySnapshot(snapshotRoot) {
  try {
    return { kind: 'extension', manifest: readExtensionManifest(snapshotRoot) };
  } catch (e) {
    if (e && e.code === 'not-an-extension') return { kind: 'content', manifest: null };
    throw e;
  }
}

// The extension's own files: for each declared path (the entry, and any
// stylesheets), the file itself when it sits at the root, or the whole
// top-level directory it lives under. One rule, stated here, so what the
// install materializes is decided by where the author put the declared
// files rather than by anything self-declared beyond the manifest's claims.
function extensionFileSet(snapshotRoot, entry, styles = []) {
  const tops = [...new Set([entry, ...styles].map((declared) => declared.split('/')[0]))].sort();
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
  for (const top of tops) {
    const topPath = path.join(snapshotRoot, top);
    if (fs.lstatSync(topPath).isFile()) {
      files.push({ rel: top, content: fs.readFileSync(topPath) });
    } else {
      for (const name of fs.readdirSync(topPath)) walk(path.join(topPath, name), `${top}/${name}`);
    }
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
  // The routines the bundled agents carry, read by the scheduler's own
  // parser from the same bytes the counts come from. A routine is something
  // installing the content half will start, so the trust step must be able
  // to name it, and an empty list is the stated absence rather than a
  // missing fact.
  const routines = [];
  try {
    for (const item of discoverPackage(snapshotRoot)) {
      if (item.kind === 'agent') {
        agents += 1;
        const text = fs.readFileSync(path.join(snapshotRoot, '.claude', 'agents', `${item.slug}.md`), 'utf8');
        for (const routine of routinesCarried(text, item.slug)) routines.push({ agent: item.slug, ...routine });
      } else if (item.kind === 'skill') skills += 1;
    }
  } catch (e) {
    // A pure extension carries no agents and no skills; that absence is a
    // fact worth showing, not a refusal here.
    if (e.code !== 'empty-package') throw e;
  }
  const files = extensionFileSet(snapshotRoot, manifest.entry, manifest.styles);
  // The marker rides with the match rule because the two are one claim: a
  // trust step shown "*.md" alone would be asking consent for every
  // markdown file when the extension can only ever receive the marked ones.
  // writes rides to the trust step from the same read as the match rule, so
  // the card states what the host will actually allow rather than a second
  // opinion about it. Defaulted here too: deriveFacts is called with
  // manifests from more than one path.
  return { agents, skills, routines, match: manifest.match, declares: manifest.declares || null, draws: manifest.draws || null, writes: manifest.writes === true,
    sources: manifest.sources === true, asks: Array.isArray(manifest.asks) ? manifest.asks.slice() : [],
    files: files.map((f) => f.rel).sort() };
}

module.exports = {
  isDisplayName, readPackageDisplayName, DISPLAY_NAME_MAX, MANIFEST_NAME, SLUG, AGENT_ID, MAX_ASKS, readExtensionManifest, classifySnapshot, deriveFacts, extensionFileSet };
