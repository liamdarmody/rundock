#!/usr/bin/env node
'use strict';
// Break each of the extension install flow's guards in turn and report which
// tests notice.
//
// The rules this change leaves behind are all promises to a person deciding
// whether to trust code: the pin is required, the trust step tells the
// truth, no is really no, the record remembers the source so they never
// retype it, one transaction carries the install, and uninstall removes
// exactly what install created. Every one can be deleted with the product
// still installing SOMETHING, which is why each is broken on purpose here
// and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-extension-install-guards.js            # report
//   node test/tools/mutate-extension-install-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. The
// harness is the same shape as its siblings and deliberately a separate
// copy, for the reason recorded in mutate-routines-guards.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
// Every row names its suite as a string literal beside its target: the
// scoped gate (scripts/mutation-scope.js) reads both statically, and a suite
// reached through a constant is a suite the selector cannot see.
const SOURCE = { src: path.join(ROOT, 'lib', 'packages', 'extension-source.js'), suite: 'test/unit/extension-install.test.js' };
const MANIFEST = { src: path.join(ROOT, 'lib', 'packages', 'extension-manifest.js'), suite: 'test/unit/extension-install.test.js' };
const RECORD = { src: path.join(ROOT, 'lib', 'packages', 'extension-record.js'), suite: 'test/unit/extension-install.test.js' };
// The reader's name check is what stands between a package uninstall and a
// path built from a tampered name, so its suite is the uninstall's.
const RECORD_FOR_UNINSTALL = { src: path.join(ROOT, 'lib', 'packages', 'extension-record.js'), suite: 'test/unit/package-uninstall.test.js' };
const INSTALL = { src: path.join(ROOT, 'lib', 'packages', 'extension-install.js'), suite: 'test/unit/extension-install.test.js' };
const HANDLERS = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'packages.js'), suite: 'test/unit/extension-install.test.js' };
const MODEL = { src: path.join(ROOT, 'public', 'packages-install-model.js'), suite: 'test/unit/extension-install.test.js' };
const SETTINGS_VIEW = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/extension-install.test.js' };
// Removing a downloaded package folder: the Windows-safe removal itself, and
// the acquirer's use of it.
const REMOVE_FOLDER = { src: path.join(ROOT, 'lib', 'packages', 'remove-folder.js'), suite: 'test/unit/package-folder-remove.test.js' };
const SOURCE_REMOVE = { src: path.join(ROOT, 'lib', 'packages', 'extension-source.js'), suite: 'test/unit/package-folder-remove.test.js' };

const MUTATIONS = [
  // ===== WHAT IS INSTALLED, WHO IT IS, AND WHAT IT CLAIMS (0.15.0 review) =====
  [MODEL, 'an extension that draws states its language, never "matching: null"',
    "    if (f.draws) return `It draws \\`\\`\\`${f.draws} blocks where they sit in a note, and claims no file type.`;\n", ''],
  [MODEL, 'a tag names the commit it resolved to',
    "    return `From ${state.link}, pinned to ${state.reference} (commit ${short}).`;", "    return `From ${state.link}, pinned to ${state.reference}.`;"],
  [MODEL, 'an exact commit is named once, short',
    "    if (EXACT_COMMIT.test(String(state.reference || ''))) return", '    if (false) return'],
  [MODEL, 'the same name from another repository is said plainly',
    '    if (r.sameSource === false) {', '    if (false) {'],
  [SOURCE, 'the acquirer records the commit it fetched',
    '    if (/^[0-9a-f]{40}$/.test(commit)) acquiredCommits.set(dir, commit);\n', ''],
  // ===== THE PIN IS REQUIRED =====
  // Let the well-known moving names through and "pinned at main" becomes a
  // promise about whatever main means tomorrow.
  [SOURCE, 'a moving branch name is refused as not a pin',
    `  if (MOVING_NAMES.has(reference.toLowerCase().replace(/^refs\\/heads\\//, '').replace(/^heads\\//, ''))) {
    refuse(\`"\${reference}" is a branch, and \${BRANCH_REFUSED}\`, 'unpinned-reference');
  }`,
    ''],
  // Compare the raw spelling and "refs/heads/main" walks through as a pin.
  [SOURCE, 'a moving branch name is refused in its qualified spelling too',
    "  if (MOVING_NAMES.has(reference.toLowerCase().replace(/^refs\\/heads\\//, '').replace(/^heads\\//, ''))) {",
    "  if (MOVING_NAMES.has(reference.toLowerCase())) {"],
  // Default the absent pin and the refusal's whole reason is inverted: the
  // repository's head, read only to classify, would be installed as code.
  [SOURCE, 'an absent reference is refused for code, never defaulted to a branch',
    `  if (!source || typeof source.reference !== 'string' || !source.reference) {
    refuse('this repository is an extension, and installing one needs an exact tag, release or commit; '
      + 'an install is a promise about exact bytes, and a moving branch cannot keep it', 'unpinned-reference');
  }`,
    `  if (!source || typeof source.reference !== 'string' || !source.reference) {
    return { ...source, reference: 'main' };
  }`],
  // ===== NEVER FROM A BRANCH (decided 2026-09-23) =====
  // Drop the check and any branch that is not one of the well-known names
  // installs at whatever its tip is today.
  [HANDLERS, 'an extension fetched at a branch is refused before the trust step',
    '    requireFixedPin(source, extensionDeps.pinKindOf(snapshot));\n', ''],
  // Accept any recorded kind and "other" (a branch) passes as a pin.
  [SOURCE, 'only a tag or an exact commit passes as a pin',
    "  if (kind !== 'tag' && kind !== 'commit') {", '  if (!kind) {'],
  // Fetch the bare name first and a branch sharing a tag's name arrives in
  // the tag's place, recorded as whatever the fallback says.
  [SOURCE, 'a named reference is tried as a tag before its bare name',
    "      try { fetch(tagRefFor(source.reference)); kind = 'tag'; } catch { fetch(source.reference); }",
    "      try { fetch(source.reference); kind = 'tag'; } catch { fetch(tagRefFor(source.reference)); }"],
  // Call every full hex name a commit without fetching it as one and the
  // record no longer says what arrived.
  [SOURCE, 'a full commit name is fetched and recorded as a commit',
    "    else if (COMMIT.test(source.reference)) { fetch(source.reference); kind = 'commit'; }\n", ''],
  // Keep the record past the bytes and a later snapshot at the same path
  // could inherit a kind it never earned.
  [SOURCE, 'discarding a snapshot forgets what it was',
    '    acquiredKinds.delete(dir);\n', ''],
  // Let a reference beginning with "-" through and it lands in a git argv
  // position as an option rather than as the thing to fetch.
  [SOURCE, 'a reference beginning with "-" is refused, not fed to a git argv',
    `  if (reference.startsWith('-')) {
    refuse(\`"\${reference}" is not a reference; a pin cannot begin with "-"\`, 'unpinned-reference');
  }`,
    ''],
  // Skip the cleanup on a failed fetch and the temporary directory
  // acquireWithGit created leaks for the life of the process on every
  // refused reference.
  [SOURCE, 'a failed fetch removes the temporary directory acquireWithGit created',
    '    discardAcquisition(dir);',
    ''],

  // ===== THE PIN IS DERIVED, AND "LATEST" IS AN ORDERED CLAIM =====
  // Take the listing's first entry instead of ordering it and the derived
  // pin is whatever ls-remote happened to return first, which for the real
  // lister is lexicographic: v9.0.0 offered as newer than v10.0.0.
  [RECORD, 'the derived pin is the newest orderable tag, never whichever the listing returned first',
    '    if (order > 0 || (order === 0 && name > best)) best = name;',
    ''],
  // Drop the no-tags refusal and a repository with no tags falls through to
  // the wrong named reason, so the person is told their tags cannot be
  // ordered when the truth is there are none.
  [RECORD, 'a repository publishing no tags is refused with exactly that as the reason',
    `  if (refs.length === 0) {
    throw Object.assign(new TypeError('this repository publishes no tags; an extension is installed at an exact tag, '
      + 'so paste a link that names a release, tag or commit'), { code: 'no-tags' });
  }`,
    ''],
  // Default the derived pin to a branch name and the resolution path makes
  // exactly the promise the whole pin rule exists to refuse: "pinned at
  // main", a claim about whatever main means tomorrow.
  // Repointed when the resolution moved into newestRelease and the binding
  // was renamed: the rule is unchanged and only the line moved.
  [HANDLERS, 'the derived pin comes from the tag listing, never a defaulted branch name',
    '      const release = newestRelease(extensionDeps.listRefs(source.url));',
    "      const release = 'main';"],
  // Refuse the tagless repository and an extension with no releases cannot
  // be installed at all, when the exact commit in hand is a pin that keeps
  // the promise.
  [HANDLERS, 'a repository with no version tags installs the exact commit it fetched',
    '      source = { ...source, reference: fetched };',
    "      throw Object.assign(new Error('this repository publishes no tags'), { code: 'no-tags' });"],

  // ===== CODE REQUIRES A MANIFEST, AND THE BYTES DECIDE THE KIND =====
  // Wave a manifest-less snapshot through as an extension and inference has
  // quietly grown the one thing it must never infer.
  [MANIFEST, 'a snapshot without a manifest is not an extension',
    `      refuse(\`the package has no \${MANIFEST_NAME}; code requires a manifest, always\`, 'not-an-extension');`,
    `      return { name: 'inferred', version: '0.0.0', entry: 'index.html', match: '*' };`],
  // Each strict refusal of the manifest reader, one row per branch: with the
  // guard gone the input is either accepted or refused by a later guard with
  // a different reason, and the suite asserts the reason.
  [MANIFEST, 'a manifest that is not valid JSON is refused by name',
    "    refuse(`${MANIFEST_NAME} is not valid JSON: ${e.message}`);", ''],
  [MANIFEST, 'a manifest that is not an object is refused by name',
    "  if (!manifest || typeof manifest !== 'object') refuse(`${MANIFEST_NAME} must be an object`);", ''],
  [MANIFEST, 'a name that is not a lowercase slug is refused',
    "    refuse('name must be a lowercase slug');", ''],
  [MANIFEST, 'a blank version is refused',
    "    refuse('version must be a non-empty string');", ''],
  [MANIFEST, 'a manifest without an extension block is not an extension',
    "    refuse(`${MANIFEST_NAME} declares no extension; code requires a manifest, always`, 'not-an-extension');", ''],
  [MANIFEST, 'an entry that is not a path is refused before it is walked',
    "  if (typeof relative !== 'string' || !relative) refuse('extension.entry must be a relative path');", ''],
  [MANIFEST, 'an absolute entry is refused',
    "  if (path.isAbsolute(relative)) refuse('extension.entry must not be absolute');", ''],
  [MANIFEST, 'an entry escaping the package is refused',
    "  if (normal === '..' || normal.startsWith('../')) refuse('extension.entry must stay inside the package');", ''],
  [MANIFEST, 'an entry that does not exist is refused by name',
    "      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') refuse(`extension.entry names ${normal}, which does not exist in the package`);", ''],
  [MANIFEST, 'an entry that is not a regular file is refused',
    "  if (!fs.lstatSync(walked).isFile()) refuse(`extension.entry ${normal} is not a regular file`);", ''],
  [MANIFEST, 'a blank match rule is refused',
    "    refuse('extension.match must be a non-empty match rule');", ''],
  // Invert the classification and a repository of agents and skills is
  // answered with a trust step for code it does not carry, while a real
  // extension is offered as content and its view never installs.
  [MANIFEST, 'the kind of a snapshot is read from its bytes: an extension block means the trust step, its absence the offer',
    "    if (e && e.code === 'not-an-extension') return { kind: 'content', manifest: null };",
    "    if (e && e.code === 'not-an-extension') return { kind: 'extension', manifest: { name: 'inferred', version: '0.0.0', entry: 'index.html', match: '*' } };"],
  // Skip the symlink check on the entry path and a path segment linking
  // outside the snapshot is walked straight through instead of refused.
  [MANIFEST, 'extension.entry is refused when a path segment is a symlink',
    '    if (stat.isSymbolicLink()) refuse(`extension.entry passes through a symlink at ${segment}`);',
    ''],
  // Skip the symlink check inside the mounted directory and a file linking
  // outside the snapshot is read and materialised as if it were the
  // package's own bytes.
  [MANIFEST, 'a file inside the mounted directory is refused when it is a symlink',
    '    if (stat.isSymbolicLink()) refuse(`${relative} is a symlink`);',
    ''],
  // The stylesheet claims are validated by the same rules as the entry,
  // with their own refusals; each guard broken lets a claim through that
  // the serving side would then be the only thing standing against.
  [MANIFEST, 'a declared stylesheet escaping the package is refused',
    "  if (normal === '..' || normal.startsWith('../')) refuse('extension.styles paths must stay inside the package');",
    ''],
  [MANIFEST, 'a declared stylesheet that is a symlink is refused by name, before its bytes are read',
    '    if (stat.isSymbolicLink()) refuse(`extension.styles passes through a symlink at ${segment}`);',
    ''],
  [MANIFEST, 'a styles field that is not an array is refused',
    "    if (!Array.isArray(extension.styles)) refuse('extension.styles must be an array of relative paths');",
    "    if (!Array.isArray(extension.styles)) extension.styles = [extension.styles];"],

  // ===== NO IS REALLY NO =====
  // Keep the snapshot after a decline and "nothing left behind" is false in
  // the one place the person cannot see.
  [HANDLERS, 'declining discards the acquired snapshot',
    '  discardPending(msg.token);\n  ws.send(JSON.stringify({ type: \'package_install_declined\'',
    '  releasePending(msg.token);\n  ws.send(JSON.stringify({ type: \'package_install_declined\''],
  // Skip the discard in beginPackagePlan's own catch and a snapshot that
  // was fetched but then failed to plan (a fetch that fails after acquiring
  // some bytes; a repository with no rundock.json) leaks its temporary
  // directory instead of leaving nothing behind, the same promise a decline
  // makes for an offer the person actually saw.
  [HANDLERS, 'a failed plan discards whatever the acquirer already fetched',
    '    discardAcquisition(snapshot);\n    installFail(ws, \'plan\', null, e);',
    '    installFail(ws, \'plan\', null, e);'],

  // ===== A PERSISTED RECORD IS NOT TRUSTED INPUT =====
  [RECORD, 'a record missing its own source is refused by name, once, at the reader',
    "  if (!record.source || typeof record.source.url !== 'string' || !record.source.url) return `\"${record.name}\" carries no source url`;\n",
    ''],

  // ===== CONSENT BINDS TO THE WORKSPACE IT WAS SHOWN AGAINST =====
  // Skip the workspace check and a confirm answered after the server moved
  // to another workspace installs into whatever is current now, replacing
  // that workspace's files under a trust card that described a different one.
  [HANDLERS, 'a confirm is refused when the server\'s workspace has changed since the plan',
    '  if (pending.workspace !== workspace) {\n    discardAcquisition(pending.snapshot);',
    '  if (false) {\n    discardAcquisition(pending.snapshot);'],

  // ===== AN UNANSWERED OFFER DOES NOT LIVE FOREVER =====
  // Skip the close release and a dropped connection leaves the fetched
  // snapshot and its token alive for the life of the process.
  [HANDLERS, 'a dropped connection releases the pending offer',
    `  if (typeof ws.once === 'function') {
    pending.onClose = () => discardPending(token);
    ws.once('close', pending.onClose);
  }`,
    ''],
  // Skip the supersede release and a second plan on the same connection
  // leaves the first offer's snapshot and token alive, unreachable and
  // unanswerable, for the life of the process.
  [HANDLERS, 'a second plan on the same connection supersedes the first, unanswered one',
    `  const previousToken = pendingBySocket.get(ws);
  if (previousToken) discardPending(previousToken);`,
    ''],
  // Let the extension confirm also write the content half and the trust
  // card's sentence about that half ("not added by this step") is false on
  // disk: agents land under a card that said they would not.
  [HANDLERS, 'confirming the extension writes the extension half only; the content half waits for its own answer',
    '    const record = installExtension(workspace, pending.snapshot, pending.plan);',
    `    const record = installExtension(workspace, pending.snapshot, pending.plan);
    if (pending.content) applyImport(workspace, pending.snapshot, require('../../../public/packages-install-model.js').allAddApproval(pending.content), {});`],

  // ===== A REPLY IS MATCHED TO THE REQUEST THAT PRODUCED IT =====
  // Restore type-only routing and an uninstall's error, arriving while an
  // install is in flight, is read as that install's answer and drives its
  // state machine into failed.
  [MODEL, 'a reply is matched by operation and token, never by type alone',
    '    if (!correlated(state, msg)) return { state };\n',
    ''],
  // Ignore the served workspace and a trust step read against this window's
  // workspace stays on screen after another window moved the server, with a
  // confirm the server would refuse.
  [SETTINGS_VIEW, 'a switch announced from another window returns the flow to its start',
    "  if (typeof currentWorkspacePath === 'undefined' || servingPath === currentWorkspacePath) return;",
    '  return;'],

  // ===== THE TRUST STEP TELLS THE TRUTH =====
  // Drop the no-review sentence and the screen implies a vetting nobody did.
  [MODEL, 'the trust step says Rundock does not review extensions',
    "      reviewLine: 'Rundock does not review extensions; what you install is your choice.',",
    "      reviewLine: '',"],
  // Narrow the fact table below what the host allows and the card claims the
  // frame cannot ask Rundock to open a file, which the closed table permits:
  // a safety claim wider than the fact behind it.
  // Repointed when `save` joined the closed table: the rule is unchanged and
  // only the line grew a member. Narrowing the fact table still has to be
  // caught, and narrowing it by dropping `save` now also hides a privilege
  // rather than merely a capability, which is the worse half of the same
  // defect.
  [MODEL, 'every claim on the trust card is backed by the host table it is computed from',
    "    messages: ['ready', 'resize', 'error', 'open', 'save', 'change', 'openExternal', 'saveSource', 'changeSource', 'ask', 'setState'],",
    "    messages: ['ready', 'resize', 'error', 'open', 'save', 'change', 'openExternal', 'saveSource', 'changeSource', 'ask'],"],
  // Drop the sentence about the opened file and the card no longer says the
  // frame receives the file's path and text, read-only.
  [MODEL, 'the trust card states that the frame receives the opened file read-only',
    "      `It receives the opened file's ${listWords(facts.init.filter((f) => f !== 'sources' && f !== 'state'))}, read-only, ${env.sources ? 'and the named sources below, ' : ''}and nothing else about your workspace. Hidden files, files in hidden folders and linked files, such as your agents' instructions and your keys, are never given to it.`,",
    ''],
  // Make the content half's sentence claim the agents land with the
  // extension and the card lies about what confirm does: the disk says
  // otherwise, and the suite holds the two together.
  [MODEL, 'the trust card says the content half is not added by the extension confirm, which is what the disk shows',
    'in this repository are not added by this step. `',
    'in this repository are added by this step. `'],

  // ===== THE RECORD REMEMBERS THE SOURCE =====
  // Forget the pin and every update check needs the URL and reference typed
  // again, which is the exact gap the record exists to close.
  [INSTALL, 'the record carries the pinned reference',
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };`,
    `    installedAt: options.now || new Date().toISOString(),
    root,
  };
  record.source = { url: source.url, reference: null };`],
  // Each strict refusal of the records reader, one row
  // per branch, for the same reason as the manifest rows above.
  [RECORD, 'a records file that is not valid JSON is refused by name',
    "    throw new TypeError(`extension records unreadable: ${e.message}`);", '    throw e;'],
  [RECORD, 'a records file of another schema is refused',
    "  if (!parsed || parsed.schema !== RECORDS_SCHEMA || !Array.isArray(parsed.extensions)) {",
    '  if (!parsed || !Array.isArray(parsed.extensions)) {'],
  [RECORD, 'a records entry that is not an object is refused by name',
    "  if (!record || typeof record !== 'object') return 'an entry is not an object';\n", ''],
  [RECORD, 'a record without a version is refused by name',
    "  if (typeof record.version !== 'string' || !record.version) return `\"${record.name}\" has no version`;\n", ''],
  [RECORD, 'a record without a pinned reference is refused by name',
    "  if (typeof record.source.reference !== 'string' || !record.source.reference) return `\"${record.name}\" carries no pinned reference`;\n", ''],
  [RECORD, 'a ref-lister that returns no array is refused by name',
    "  if (!Array.isArray(refs)) throw new TypeError('listRefs must return an array of reference names');\n", ''],

  // ===== AN UPDATE NEVER CHANGES WHETHER AN EXTENSION IS ENABLED =====
  // Rebuild the record from the manifest alone and updating a disabled
  // extension silently re-enables it: third-party code the person stopped
  // starts running again, through a path the managed row never shows.
  [INSTALL, 'an update carries the existing record\'s disabled flag forward',
    '  if (existing && existing.enabled === false) record.enabled = false;\n',
    ''],
  // Materialize the entry's top level alone and a stylesheet declared in a
  // sibling directory installs missing, so the payload later refuses an
  // extension the trust step approved whole.
  [INSTALL, 'the install materializes the declared stylesheets with the entry',
    '  const files = extensionFileSet(snapshotRoot, manifest.entry, styles);',
    '  const files = extensionFileSet(snapshotRoot, manifest.entry);'],
  // Drop the copy and an installed directory without a root manifest has no
  // styles claim anything can serve.
  [INSTALL, 'the record takes a copy of the styles claim',
    '  if (styles.length) record.styles = styles;\n',
    ''],

  // ===== A FAILURE AFTER THE INSTALL LANDED NEITHER LIES NOR LEAKS A
  //       TOKEN =====
  // Issue the content token before the roster read and a roster read that
  // throws is caught below as an install failure: the person is told an
  // install that succeeded did not, and the token points at a snapshot the
  // failure path has discarded.
  [HANDLERS, 'the roster is read before the content offer takes a token, and a roster failure still reports the install as done',
    `    let extensions = null;
    let rosterError = null;
    try {
      extensions = listExtensions(workspace);
    } catch (e) {
      rosterError = e && e.message ? e.message : String(e);
    }
    // The content half, when there is one, becomes the next offer under a
    // token of its own: the snapshot stays held until that answer arrives.
    let content = null;
    if (rosterError === null && pending.content) {`,
    `    let rosterError = null;
    let content = null;
    if (pending.content) {
      const token = holdPending(ws, { kind: 'content', snapshot: pending.snapshot, plan: pending.content, workspace });
      content = { token, plan: pending.content };
    }
    const extensions = listExtensions(workspace);
    if (false) {`],

  // ===== ONE TRANSACTION CARRIES THE INSTALL =====
  // Split the record from the files and a crash between them leaves a
  // directory nothing knows about, or a record whose files never landed.
  [INSTALL, 'the files and the record land as one unit',
    '  writeAsUnit(workspace, writes, { replaceDirs });',
    `  writeAsUnit(workspace, [], { replaceDirs });
  writeAsUnit(workspace, writes);`],

  // ===== A RECORD THAT ARRIVED MALFORMED IS REFUSED AT THE READER =====
  // Skip the missing-root check at the reader and a record with no root is
  // half-read instead of refused by name.
  [RECORD, 'a record with no root is refused by name',
    "  if (typeof record.root !== 'string' || !record.root) return `\"${record.name}\" has no root`;\n",
    ''],
  // Skip the name-validation and a records file carrying a name shaped like
  // a traversal ("../../etc") is joined straight into a package uninstall's
  // removal target instead of being refused before it is ever used.
  [RECORD_FOR_UNINSTALL, 'a record with an invalid name is refused before it is joined into a path',
    "  if (typeof record.name !== 'string' || !SLUG.test(record.name)) return 'an entry carries an invalid name';\n",
    ''],
  // Leave the close listener on the socket after its offer was answered and
  // a long-lived connection grows one listener per install.
  [HANDLERS, 'the close listener leaves with the offer it guarded',
    "  if (pending.onClose && typeof pending.ws.off === 'function') pending.ws.off('close', pending.onClose);\n",
    ''],

  // ===== THE TRUST CARD SHOWS THE FACT IT DERIVED =====
  // Drop the rendered file list and the trust card prints its own lead-in
  // sentence ("read from the package itself") followed by nothing that was
  // actually read from the package.
  [SETTINGS_VIEW, 'the trust card renders the derived file list',
    '        <ul class="extension-facts-files">${copy.files.map((f) => `<li>${esc(f)}</li>`).join(\'\')}</ul>',
    ''],
  // ===== A MARKER CLAIM IS READ, COPIED, AND STATED =====
  // Accept any declares and an unreadable marker is patched into a claim
  // rather than refused by name.
  [MANIFEST, 'a declares outside the key grammar is refused, never patched',
    "    if (typeof extension.declares !== 'string' || !SLUG.test(extension.declares.trim())) {",
    '    if (false) {'],
  // Drop the marker from the manifest read and every downstream copy (the
  // record, the facts, the roster) loses the claim. Repointed when the same
  // return grew the writes declaration: the rule is unchanged and only the
  // line moved, so the row follows the line rather than being retired.
  [MANIFEST, 'the manifest carries the declares claim it read',
    "  return { name: manifest.name, ...(displayName ? { displayName } : {}), version: manifest.version.trim(), entry, match: hasMatch ? extension.match.trim() : null, declares, draws, writes, sources, asks, styles, rundockUi };",
    "  return { name: manifest.name, ...(displayName ? { displayName } : {}), version: manifest.version.trim(), entry, match: hasMatch ? extension.match.trim() : null, declares: null, draws, writes, sources, asks, styles, rundockUi };"],
  // Drop the marker from the facts and the trust card can only state the
  // whole container: consent to more than the extension can receive.
  [MANIFEST, 'the derived facts carry the marker beside the match rule',
    '  return { agents, skills, routines, match: manifest.match, declares: manifest.declares || null, draws: manifest.draws || null, writes: manifest.writes === true,',
    '  return { agents, skills, routines, match: manifest.match, declares: null, draws: manifest.draws || null, writes: manifest.writes === true,'],
  // The trust step can name a schedule only because the facts parse one: a
  // deriveFacts that stops reading the routines block is exactly the defect
  // the disclosure work fixed, and it must not come back silently.
  [MANIFEST, 'the derived facts carry the routines the bundled agents declare',
    '        for (const routine of routinesCarried(text, item.slug)) routines.push({ agent: item.slug, ...routine });',
    ''],
  // Skip the record's copy and the roster over a real install (which
  // materializes no manifest) reads no marker at all.
  [INSTALL, 'the record copies the declares claim as it copies entry and match',
    '  if (manifest.declares) record.declares = manifest.declares;',
    ''],
  // State the bare match rule whatever the facts carry and the trust step
  // asks consent for every file of the container type.
  [MODEL, 'the trust step narrows the match sentence when a marker is declared',
    '    if (f.match && f.declares) return `It asks to render files matching: ${f.match}, and only those marked "${f.declares}" in their frontmatter.`;\n',
    ''],

  // Drop packagesReplyArrived from the exported surface and every server
  // reply for this flow resolves against `window` in a browser and throws,
  // while every test that calls the handler directly stays green.
  [SETTINGS_VIEW, 'the install flow\'s reply entry is on the module\'s exported surface',
    '  packagesReplyArrived, packagesWorkspaceChanged, packagesServingWorkspaceChanged, packagesConnectionLost,',
    '  packagesWorkspaceChanged, packagesServingWorkspaceChanged, packagesConnectionLost,'],

  // A redraw that arrives while a link is being typed (an update answer,
  // say) puts back what was typed. Without the restore call, or without the
  // value it restores, the field is redrawn empty under the person's hands.
  [SETTINGS_VIEW, 'a redraw of the packages section restores the link being typed',
    '    packagesTypingRestore(el, typing);\n',
    ''],
  [SETTINGS_VIEW, 'the typed link is what the restore puts back',
    '  field.value = typing.value;\n',
    ''],
  // A link typed for one workspace is never carried into the next.
  [SETTINGS_VIEW, 'a change of workspace empties the typed link',
    "  if (field) field.value = '';\n",
    ''],
  // ===== A DOWNLOADED PACKAGE FOLDER IS REMOVED ON EVERY PLATFORM =====
  [REMOVE_FOLDER, "Package folder removal: files and folders are not made writable",
    "  try { fs.chmodSync(dir, st.isDirectory() ? 0o700 : 0o600); } catch (e) { /* the remove will say */ }",
    "  /* not made writable */"],
  [REMOVE_FOLDER, "Package folder removal: a briefly held file is not retried",
    "      if (attempt >= attempts || !HELD.has(e && e.code)) throw e;",
    "      throw e;"],
  [SOURCE_REMOVE, "Package clean-up: a failed removal throws over the real error",
    "      console.warn(`[Packages] Could not remove the downloaded package folder ${dir}: ${e && e.message ? e.message : e}`);",
    "      throw e;"],
  [SOURCE_REMOVE, "Package clean-up: the fetched .git is removed without the Windows-safe removal",
    "    removeAcquired(path.join(dir, '.git'));",
    "    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });"],
  [SOURCE_REMOVE, "Package clean-up: discarding a snapshot bypasses the Windows-safe removal",
    "let removeAcquired = (dir) => removeDownloadedFolder(dir);",
    "let removeAcquired = (dir) => fs.rmSync(dir, { recursive: true, force: true });"],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [SOURCE, MANIFEST, RECORD, RECORD_FOR_UNINSTALL, INSTALL, HANDLERS, MODEL, SETTINGS_VIEW];
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A guard matching more than once is refused rather than taking the
      // first: the replacement would break whichever came first and report
      // on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
