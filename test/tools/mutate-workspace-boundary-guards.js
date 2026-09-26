#!/usr/bin/env node
'use strict';
// Break each of the boundary's guards in turn and report which tests notice.
//
// Every rule here is a rule about a card that fires or stays quiet, and both
// failure directions are quiet ones: a guard deleted leaves inside paths
// carding (the storm this change exists to end) or outside paths sliding by.
// A green suite proves nothing about either until each rule is broken on
// purpose and a test goes red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-workspace-boundary-guards.js            # report
//   node test/tools/mutate-workspace-boundary-guards.js --markdown # as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as the sibling harnesses, deliberately a separate copy: see
// mutate-routines-guards.js for the reason.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/workspace-boundary.test.js' };
const SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/workspace-boundary.test.js' };
const BOUNDARY = { src: path.join(ROOT, 'lib', 'workspace', 'boundary.js'), suite: 'test/unit/workspace-boundary.test.js' };
const CHAT_VIEW = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/boundary-card.test.js' };
// Same file as HOOK, a different suite: the attach site this target's own
// mutation breaks is never called by the unit suite (which tests
// classifyFileAccess and card rendering each in isolation), only by the
// real hook process the integration suite spawns.
const HOOK_INTEGRATION = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/integration/boundary-permissions.test.js' };
// Same file as HOOK again, a third suite: the outright refusals are pure
// predicates tested on their own, away from the classifier corpus the
// workspace-boundary suite drives, so a mutation to either is invisible
// there and only this suite can notice it.
const HOOK_REFUSAL = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/permission-agent-guard.test.js' };
// The classifier's own suite. The hook is paired with several suites because
// different guards in it are driven from different places, and a mutation is
// only proved by the suite that actually exercises it: pointing a row at the
// wrong one reports that nothing broke, which reads exactly like a guard
// nothing tests. That is how the credential-folder rows first came back empty.
const HOOK_CLASSIFIER = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: 'test/unit/boundary.test.js' };
// The read-only definition the hook reads, and the client risk grader with
// it. It moved out of the hook when the two graders stopped keeping separate
// answers to the same question; the rows below still drive the hook's suite,
// because that is where breaking a read-only rule shows up as a crossing that
// cards or one that stops carding.
const READ_ONLY = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/workspace-boundary.test.js' };
// Same file, the other suite. Not every rule in the shared module is proven by
// the boundary corpus: the package-runner rules, the vocabulary's size, and the
// subshell guard are all driven from test/unit/permissions.test.js, which is
// where the tests that drive BOTH graders over one command live. A row here
// belongs to the suite that actually notices it, not to the file's usual one.
const READ_ONLY_CLIENT = { src: path.join(ROOT, 'public', 'read-only-shell.js'), suite: 'test/unit/permissions.test.js' };
// The mode-persisted-before-scaffold ordering guard lives in the protocol
// handler, not the scaffold layer, and is reachable only through the real
// workspace-open path (the scaffold-layer tests call scaffoldWorkspace
// directly and so never see this file's own ordering at all).
const WORKSPACE_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/integration/ws-handler-edges.test.js' };
// Same file as WORKSPACE_HANDLER, a different suite: the mode-switch
// atomicity guards are proven by protocol-handlers-lib.test.js's own
// read-back, not anything ws-handler-edges.test.js asserts.
const WORKSPACE_HANDLER_UNIT = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The switch that keeps agents inside the workspace: where it is read from, the
// new-workspace default, and the open-path reconcile that honours it.
const SCAFFOLD_SWITCH = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/sandbox-switch.test.js' };
const WORKSPACE_HANDLER_SWITCH = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/sandbox-switch.test.js' };
// What the Permissions row reports as in force, and the switch's own writes.
const SANDBOX_STATUS = { src: path.join(ROOT, 'lib', 'workspace', 'sandbox-status.js'), suite: 'test/unit/sandbox-status.test.js' };
// Bringing a person's own rules in: the review, the digest, the import.
const SANDBOX_IMPORT = { src: path.join(ROOT, 'lib', 'workspace', 'sandbox-status.js'), suite: 'test/unit/sandbox-import.test.js' };
// The one normalizer every reader of the stored mode goes through.
const MODE = { src: path.join(ROOT, 'lib', 'workspace', 'mode.js'), suite: 'test/unit/workspace-mode-values.test.js' };
// The Permissions pane: the label, the turn-off question, and the row model.
const NOTES_LABEL = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/notes-mode-label.test.js' };
const PERMISSIONS_PANE = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/permissions-pane.test.js' };
const SANDBOX_ROW = { src: path.join(ROOT, 'public', 'sandbox-row-model.js'), suite: 'test/unit/sandbox-row-model.test.js' };
// A block a person wrote is never rewritten by any path but bringing it in.
// Every class the panes render has a rule behind it.
const SETTINGS_SURFACE = { src: path.join(ROOT, 'public', 'styles', 'views', 'settings.css'), suite: 'test/unit/settings-surface.test.js' };
const SCAFFOLD_FOREIGN = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: 'test/unit/foreign-sandbox-notice.test.js' };
// The desktop app's own wiring, watched by the run that launches the shipped
// entrypoint beside the browser and compares the Permissions row. A
// suite under test/electron/ is that run: its JSON report names each
// expectation that failed (see redTests).
const DESKTOP = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/electron/settings-parity.cjs' };
// The profile the desktop run starts on, and the entrypoint's use of it.
const USER_DATA = { src: path.join(ROOT, 'electron', 'user-data.js'), suite: 'test/unit/user-data.test.js' };
const DESKTOP_PROFILE = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/unit/user-data.test.js' };
// The same entrypoint, watched by the run that launches it with an absolute
// and then a relative RUNDOCK_USER_DATA_DIR and reads what the running app
// reports and leaves on disk.
const DESKTOP_PROFILE_RUN = { src: path.join(ROOT, 'electron', 'main.js'), suite: 'test/electron/user-data-entrypoint.cjs' };

const MUTATIONS = [
  // ===== ONE DIRECTORY UNDER TWO NAMES IS ONE IDENTITY =====
  // Compare unresolved again and every symlink, alias and case spelling of
  // an inside path reads as outside: the false-positive half of the storm.
  [HOOK, 'file targets are canonicalised before the comparison',
    '  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target), path, resolvedPathFoldsCase);',
    '  const resolvedPath = path.resolve(workspaceRoot, target);'],
  // The refusal and the tier classifier decide the same paths, so they must
  // decide them the same way. Drop the folding here and only here, and a
  // variant spelling misses the refusal, falls through, and is offered as an
  // ordinary approvable card: the two answers disagree about one path, which
  // is how the escape existed in the first place. The enclosing line is part
  // of the guard because the comparison itself is written identically in the
  // classifier, and a guard that matches twice proves nothing about either.
  [HOOK, 'the outright refusal folds case exactly as the tier classifier does',
    '  return REFUSED_CLAUDE_EDIT_DIRS.some(d => {\n'
    + '    const dir = foldCase(canonicalize(path.join(root, d)), foldsCase);\n',
    '  return REFUSED_CLAUDE_EDIT_DIRS.some(d => {\n'
    + '    const dir = canonicalize(path.join(root, d));\n'],
  // Drop the refusal and a write to commands/, hooks/, plugins/ or
  // settings.json is offered an "Approve always" the runtime overrules
  // underneath, which is the false promise this rule removes.
  [HOOK_REFUSAL, 'a persistence-surface write under the runtime home is refused, not carded',
    '  return isPersistenceSurface(resolved, home, foldsCase);',
    '  return false;'],
  // Cover reads as well and listing the global agents and skills breaks,
  // which is the capability the freeing tier exists to give.
  [HOOK_REFUSAL, 'the runtime-home surface refusal covers edits only, never reads',
    'function isRuntimeHomeSurfaceEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (!CLAUDE_EDIT_TOOLS.has(toolName)) return false;',
    'function isRuntimeHomeSurfaceEdit(toolName, toolInput, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (false) return false;'],
  // Put either refusal back behind Code mode and the hole returns: a refused
  // edit is tagged as no crossing at all, Code mode auto-approves anything not
  // tagged outside, and a write to the GLOBAL agents folder is allowed, lands
  // where the app never reads, and reports success.
  // Drop the workspace exemption and anyone who opens a workspace under the
  // runtime home has every ordinary write in it refused outright, with no card
  // and no way past.
  [HOOK_INTEGRATION, 'a target inside the open workspace is never refused, even under the runtime home',
    '  const targetInsideWorkspace = refusalTarget !== null\n'
    + '    && insideWorkspaceRoot(refusalTarget, wsRoot);',
    '  const targetInsideWorkspace = false;'],
  // THE OTHER DIRECTION OF THE SAME LINE, and the one that protects a tier
  // rather than a capability. Widen the exemption back to the named folders
  // and someone who names `~` has both refusals stop looking at the runtime
  // home entirely: a write to the global agents folder is allowed, lands where
  // the app never reads, and reports success, which is the silent failure the
  // refusals exist to prevent.
  // The mutation deliberately bypasses namedFolderCovers rather than calling
  // it. Calling it proves NOTHING, measured: that function stops at the runtime
  // home itself, so a refusal target under `~/.claude` is false either way and
  // the mutated build behaves identically. The two rules are defence in depth
  // over the same paths, which is worth having and makes each harder to test
  // alone. So this row widens the exemption the way a careless edit actually
  // would, by comparing against the named folders raw.
  [HOOK_INTEGRATION, 'a named working folder never exempts the refusals, only the open workspace does',
    '    && insideWorkspaceRoot(refusalTarget, wsRoot);',
    '    && (insideWorkspaceRoot(refusalTarget, wsRoot) || extraDirs.some(d => isUnder(refusalTarget, canonicalize(d))));'],
  // Only the surface refusal is mutated for this rule, and deliberately so.
  // `agents/` and `skills/` are persistence surfaces as well, so gating the
  // agents-and-skills refusal alone changes no verdict: the surface refusal
  // below it catches the same paths and still denies. The overlap is real
  // protection, but it means that mutation proves nothing on its own, and a
  // row that proves nothing is worse than no row because it reads as coverage.
  // The ordering rule these two share is proven by the one that can move a
  // verdict.
  [HOOK_INTEGRATION, 'Code mode cannot answer the runtime-home surface refusal',
    '  if (!targetInsideWorkspace && isRuntimeHomeSurfaceEdit(data.tool_name, data.tool_input)) {',
    "  if (process.env.RUNDOCK_CODE_MODE !== '1' && !targetInsideWorkspace && isRuntimeHomeSurfaceEdit(data.tool_name, data.tool_input)) {"],
  [HOOK, 'the workspace root is canonicalised, or a symlink-opened workspace denies its own files',
    '  return isUnder(resolvedPath, canonicalize(workspaceRoot, pmod), pmod);',
    '  return isUnder(resolvedPath, pmod.resolve(workspaceRoot), pmod);'],
  // The same rule for a named folder, which reaches the boundary by a
  // different route and so needs its own row: a folder named through a symlink
  // (a Dropbox or iCloud path, routinely) would otherwise cover nothing at all,
  // and the storm this card exists to end would carry on with the setting
  // apparently configured.
  [HOOK, 'a named folder is canonicalised too, or naming a symlinked folder covers nothing',
    '  return extraDirs.some(d => isUnder(resolvedPath, canonicalize(d, pmod), pmod));',
    '  return extraDirs.some(d => isUnder(resolvedPath, pmod.resolve(d), pmod));'],
  // THE LOAD-BEARING ROW OF THIS CARD. Remove the runtime-home stop and a
  // single named ancestor, `~` above all, makes `.credentials.json` compare as
  // inside and be allowed outright: not carded, not graded, the secrets tier
  // never consulted. One folder named for an unrelated reason would switch off
  // the tier protecting the one thing most worth protecting.
  // THE THIRD THING THE CRITERIA NAME, and the four rows above did not cover it:
  // a named folder must not reach an UNNAMED sibling. Widened to always true, a
  // named folder covers the whole machine; widened to a bare string prefix,
  // `/Projects-old` falls inside `/Projects` because the separator stops being
  // part of the comparison. Both are the classic way this check goes wrong and
  // neither was proven to turn anything red.
  [HOOK, 'a named folder covers only what it names, never an unnamed sibling',
    '  return extraDirs.some(d => isUnder(resolvedPath, canonicalize(d, pmod), pmod));',
    '  return true;'],
  [HOOK, 'the separator is part of the comparison, or a lookalike sibling reads as inside',
    '  return extraDirs.some(d => isUnder(resolvedPath, canonicalize(d, pmod), pmod));',
    '  return extraDirs.some(d => resolvedPath.startsWith(canonicalize(d, pmod)));'],
  // The stop compares BOTH SIDES resolved. Drop the canonicalisation of the home
  // root and a runtime home whose .claude is a link elsewhere stops being
  // recognised as the runtime home at all, so a named ancestor of its real
  // target reaches the secrets tier through the back door.
  [HOOK, 'the runtime-home root in the stop is canonicalised, like the folders it is compared against',
    'function agentHomeRoot(home = os.homedir()) {\n  return canonicalize(path.join(home, \'.claude\'));',
    'function agentHomeRoot(home = os.homedir()) {\n  return path.join(home, \'.claude\');'],
  [HOOK, 'a named folder stops at EITHER runtime home, so the tiers still decide there',
    '  if (homeFor(resolvedPath, home, foldsCase)) return false;',
    '  if (false) return false;'],
  // A grant stored under one spelling must cover the other, both directions.
  [BOUNDARY, 'grants are canonicalised on write and on read',
    '  const t = canonicalize(targetPath);',
    '  const t = path.resolve(targetPath);'],
  // The two calls mask each other in a fixture that only ever writes through
  // addBoundaryGrant (which already canonicalises on write): removing the
  // read-side call alone needs a grant stored under its raw, uncanonicalised
  // spelling to notice, which is exactly what the dedicated read-side test
  // writes directly to the grants file.
  [BOUNDARY, 'a stored grant is canonicalised again on read, for the ones written before write-side canonicalisation existed',
    '    const g = canonicalize(d);',
    '    const g = d;'],

  // ===== THE BLOCK NAMES THE MEASURED PLUMBING =====
  // Drop the runtime home from the measured roots and the field storm is
  // back; the shape test and the doc binding both have to notice.
  [SCAFFOLD, 'the runtime home is a measured writable root',
    "    path.posix.join(home, '.claude'),\n",
    ''],
  // Refuse the legacy shape and every workspace the two-root release wrote
  // treats its own block as a person's edit, denying the plumbing forever.
  [SCAFFOLD, 'the two-root release\'s block is still recognised as ours',
    '  if (sameSandbox(block, legacySandboxSettings(claimedWorkspace, claimedHome))) return true;\n',
    ''],
  // Demand this machine's exact temp tail and a workspace opened on another
  // machine is never recognised, so it never reconciles.
  [SCAFFOLD, 'another machine\'s temp tail is ours to reconcile, not a stranger\'s edit',
    "  if (!tail.every(t => typeof t === 'string' && t.length > 0)) return false;",
    '  if (JSON.stringify(tail) !== JSON.stringify(tempRoots())) return false;'],
  // Drop the pairing check and a root a person appends, sitting in the
  // second tail slot, is structurally indistinguishable from a legitimate
  // temp-directory real path: the block is read as ours and their root is
  // rewritten away on the next reconcile. The pairing check itself is a
  // general real-path-spelling test (ends-with), not only the literal
  // /private case, so a non-/private relocation is recognised too.
  // The real-path pairing guard is GONE, and its mutation with it. It read a
  // second tail entry as a temp root only when it ended with the first, which
  // was how an appended root was told from ours. The list now carries the
  // folders a person named, so a second entry is as likely to be one of those
  // as a temp spelling, and no rule separates them. What replaced it is the
  // head: six entries in fixed positions, rebuilt from the block's own claimed
  // workspace and home, and mutated by the zero-tail entry below. The cost is
  // recorded in lib/workspace/scaffold.js beside the check that remains.
  // A corrupt or unreadable settings.local.json must not be silently
  // replaced with {}. Only ENOENT may start empty; drop that distinction and
  // every other read/parse failure quietly overwrites the file instead of
  // being surfaced.
  [SCAFFOLD, 'only a genuinely absent settings file may start the reconcile from {}',
    "    if (e.code !== 'ENOENT') throw new Error(`could not read ${settingsLocalPath}: ${e.message}`);\n",
    ''],

  // ===== THE BLOCK IS DRIVEN BY MODE, AND ONLY BY MODE =====
  // Ignore the mode and the switch writes the block for code mode too.
  [SCAFFOLD, 'the mode switch really drops the enable in code mode, rather than writing the enabled shape',
    "  const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), mode);",
    "  const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'knowledge');"],
  // ===== THE SWITCH IS STORED, AND THE MODE DOES NOT DECIDE IT =====
  // The next open must write the stored switch. Hard-wire the on shape and a
  // workspace whose switch is off has it turned back on every time it opens.
  [SCAFFOLD_SWITCH, 'the next open writes the stored switch, not a fixed shape',
    "    const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), sandboxShapeFor(dir));",
    "    const desired = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'on');"],
  // A stored switch wins over the mode. Drop the stored branch and every
  // workspace falls back to what its mode implies, which is the coupling this
  // switch exists to end.
  [SCAFFOLD_SWITCH, 'a stored switch wins over what the mode implies',
    "  if (st.sandboxSwitch === 'on' || st.sandboxSwitch === 'off') return { on: st.sandboxSwitch === 'on', stored: true };\n",
    ''],
  // Absent, the switch is what the mode always implied. Read it as always on
  // and every Code-mode workspace that predates the switch has its block
  // rewritten on the next open.
  [SCAFFOLD_SWITCH, 'an absent switch reads as what the mode implied, so no existing block is rewritten',
    "  return { on: normalizeWorkspaceMode(st.workspaceMode) !== 'code', stored: false };",
    "  return { on: true, stored: false };"],
  // The new-workspace default is on, in one named place.
  [SCAFFOLD_SWITCH, 'a workspace new to Rundock starts with the switch on',
    "const NEW_WORKSPACE_SANDBOX_SWITCH = 'on';",
    "const NEW_WORKSPACE_SANDBOX_SWITCH = 'off';"],
  // A first open must record the switch, not only the mode, or a later mode
  // change is free to move it.
  [WORKSPACE_HANDLER, 'a first open records the switch before scaffolding, not only the mode',
    "  const state = recordFirstOpen(dir);\n\n  try { scaffoldWorkspace(dir); }",
    "  const state = readState();\n\n  try { scaffoldWorkspace(dir); }"],

  // ===== THE ROW SAYS WHAT IS IN FORCE =====
  // Read the stored preference instead of the disk and a switch that says on
  // beside a block that says off is reported On.
  [SANDBOX_STATUS, 'the effective state is read from the files on disk, not the stored switch',
    '    on: available && effective,',
    '    on: available && sandboxSwitchFor(dir).on,'],
  // The shipped runtime ORs the enable across layers: count only Rundock's
  // block and a sandbox the user's own settings turn on is reported Off.
  [SANDBOX_STATUS, 'any layer that turns the sandbox on keeps the row On',
    '  const effective = blockOn || managedOn || enabledElsewhere.length > 0;',
    '  const effective = blockOn;'],
  // Managed settings that turn it on are shown as the organisation's.
  [SANDBOX_STATUS, 'managed settings that turn it on are named as the organisation\'s',
    "  const setBy = managedOn ? 'managed' :",
    "  const setBy = false ? 'managed' :"],
  // Drop the restore and a failed flip leaves the stored switch and the block
  // disagreeing.
  [SANDBOX_STATUS, 'a failed switch write restores both files',
    "    reconcileSandboxForMode(dir, on ? 'on' : 'off', platform);\n  } catch (e) {\n    restore(snaps);\n    throw e;",
    "    reconcileSandboxForMode(dir, on ? 'on' : 'off', platform);\n  } catch (e) {\n    throw e;"],
  // Drop the ownership refusal and the switch writes over a block a person wrote.
  [SANDBOX_STATUS, 'the switch refuses a hand-authored block',
    "  if (!status.managed) throw new Error('this workspace\\'s sandbox was set up outside Rundock.');\n",
    ''],
  // A hand-authored block never gets the notice: mode never moved it.
  [SANDBOX_STATUS, 'no one-time notice for a hand-authored block',
    '    notice: available && present && managed && !stored ?',
    '    notice: available && present && !stored ?'],

  // ===== A PERSON'S OWN RULES COME IN ONLY AS REVIEWED =====
  // Drop the digest check and a file edited after the review is brought in
  // unseen.
  [SANDBOX_IMPORT, 'only the file the person reviewed is brought in',
    "  if (digest !== review.digest) throw new Error('your settings file has changed since you reviewed it. Review it again.');\n",
    ''],
  // Drop the restore and a failed import leaves the folders added and the
  // person's block in place, or the block replaced and no folders.
  [SANDBOX_IMPORT, 'a failed import restores both files',
    '    fs.writeFileSync(settingsFile(dir), JSON.stringify(settings, null, 2));\n  } catch (e) {\n    restore(snaps);\n    throw e;',
    '    fs.writeFileSync(settingsFile(dir), JSON.stringify(settings, null, 2));\n  } catch (e) {\n    throw e;'],
  // Drop the folder write and the folders the review promised are lost.
  [SANDBOX_IMPORT, 'the folders the review listed become working folders',
    '    writeWorkingFolders([...readWorkingFolders(), ...review.folders]);\n',
    ''],
  // Write the on shape regardless and an off block is switched on by the import.
  [SANDBOX_IMPORT, 'bringing rules in keeps what was in force',
    "    settings.sandbox = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), review.on ? 'on' : 'off');",
    "    settings.sandbox = sandboxSettings(dir, platform, os.homedir(), tempRoots(), workingFoldersFor(dir), 'on');"],
  // A rule Rundock cannot represent must be named, not silently skipped.
  [SANDBOX_IMPORT, 'every rule that cannot come is named in the review',
    "    if (key !== 'filesystem' || !value || typeof value !== 'object') { drop(key, value); continue; }",
    "    if (key !== 'filesystem' || !value || typeof value !== 'object') { continue; }"],

  // ===== THE STORED MODE IS READ ONE WAY =====
  // Let an unrecognised value lift the restriction and a garbled or future
  // value reaches every reader as Code. Red only if the readers really go
  // through the normalizer.
  [MODE, 'anything but code reads as the restrictive mode, at every reader',
    "  return raw === 'code' ? 'code' : 'notes';",
    "  return raw === 'notes' || raw === 'knowledge' || raw == null ? 'notes' : 'code';"],
  // A third writable value would be read by v0.9.0 to v0.14.0 as Notes
  // without anyone deciding it.
  [MODE, 'this build can write only notes and code',
    "const WRITABLE_MODES = Object.freeze(['notes', 'code']);",
    "const WRITABLE_MODES = Object.freeze(['notes', 'code', 'knowledge']);"],

  // ===== THE PERMISSIONS PANE =====
  // Let the reconcile overwrite a block it did not write and a person's own
  // rules are replaced without their acting.
  [SCAFFOLD_FOREIGN, 'the reconcile never rewrites a block a person wrote',
    '  if (ours && desired && !sameSandbox(settingsLocal.sandbox, desired)) {',
    '  if (desired && !sameSandbox(settingsLocal.sandbox, desired)) {'],
  // Delete a rule a rendered class needs and the element is left to inherit.
  [SETTINGS_SURFACE, 'every class the Permissions pane renders has a rule',
    '.sandbox-caption { margin-top: 4px; }',
    '.sandbox-captions { margin-top: 4px; }'],
  // ===== THE DESKTOP APP SHOWS THE SAME ROW =====
  // The shipped wiring the desktop run depends on, broken in electron/main.js
  // itself. Lose the main window's preload and the page is a browser page in
  // a desktop frame; unregister the storage handler and the preload's
  // snapshot never comes back.
  [DESKTOP, "the desktop main window loads the app's preload",
    "    ...chromeWindowOptions(),\n    webPreferences: {\n      preload: path.join(__dirname, 'preload.js'),",
    "    ...chromeWindowOptions(),\n    webPreferences: {\n      preload: path.join(__dirname, 'preload-missing.js'),"],
  [DESKTOP, "the desktop main process answers the preload's storage snapshot",
    "ipcMain.on('rundock-storage-snapshot', (event) => {",
    "ipcMain.on('rundock-storage-snapshot-unregistered', (event) => {"],
  // The desktop run's own profile: a value that cannot be used is refused,
  // and the refusal stops the app, rather than either falling back to the
  // person's real profile.
  [USER_DATA, 'a relative RUNDOCK_USER_DATA_DIR is refused, never read against the working directory',
    "  if (!path.isAbsolute(raw)) return { kind: 'invalid',",
    "  if (false) return { kind: 'invalid',"],
  [DESKTOP_PROFILE, 'a refused RUNDOCK_USER_DATA_DIR stops the app before it starts',
    "  process.exit(1);\n}\nif (userData.kind === 'path') {",
    "}\nif (userData.kind === 'path') {"],
  // The same two rules, proved on the running app rather than its source. The
  // resolved folder never applied leaves the app on the default profile;
  // the refusal printed but not acted on lets the app carry on to a window
  // and a profile of its own.
  [DESKTOP_PROFILE_RUN, 'the desktop app runs on the RUNDOCK_USER_DATA_DIR folder it resolved',
    "  app.setPath('userData', userData.path);",
    "  void userData.path;"],
  [DESKTOP_PROFILE_RUN, 'a relative RUNDOCK_USER_DATA_DIR stops the running app before a window, the server or any profile state',
    "Not starting.`);\n  process.exit(1);",
    "Not starting.`);"],
  // The mode is called Notes wherever a person reads it.
  [NOTES_LABEL, 'the Notes tab never reads Knowledge mode again',
    ">Notes</button>",
    ">Knowledge mode</button>"],
  // Turning off asks first. Skip the question and a click sends the write.
  [PERMISSIONS_PANE, 'turning the switch off asks before anything is sent',
    '  if (sandboxStatus && sandboxStatus.on) {\n    sandboxUi.confirming = true;',
    '  if (false) {\n    sandboxUi.confirming = true;'],
  // Escape answers the question the safe way.
  [PERMISSIONS_PANE, 'Escape keeps the switch on',
    "  if (event.key !== 'Escape') return;\n  event.preventDefault();\n  if (panel === 'confirm') sandboxKeepOn();",
    "  if (event.key !== 'Escape') return;\n  event.preventDefault();\n  if (panel === 'confirm') return;"],
  // A block a person wrote is read-only: nothing switch-shaped.
  [SANDBOX_ROW, 'a hand-authored block renders as a read-only status, not a switch',
    "      return row(state, 'lock', {\n        captions,\n        ownership: [{ text: 'Set up outside Rundock, in ' }",
    "      return row(state, 'switch', {\n        captions,\n        ownership: [{ text: 'Set up outside Rundock, in ' }"],
  // Windows has no sandbox to switch.
  [SANDBOX_ROW, 'Windows shows Unavailable with nothing to press',
    "  if (host === 'win32') return row('unavailable', 'none',",
    "  if (host === 'win32') return row('unavailable', 'switch',"],
  // A sentence about what Codex does only where Rundock detected it.
  [SANDBOX_ROW, 'the Codex sentence appears only where the config was read',
    "    const captions = cx.windowsSandbox === false ?",
    "    const captions = true ?"],
  // The folders' sentence must name the mode's real behaviour: Code mode only
  // asks about a command it can see reaching outside.
  [SANDBOX_ROW, 'the folders sentence for Code with the switch off says what Code mode really asks',
    "      return mode === 'code'\n",
    "      return false\n"],
  // Another file turning it on locks the row: Rundock's switch cannot turn it off.
  [SANDBOX_ROW, 'a sandbox another file turns on is read-only, not a switch',
    "      return row(state, 'lock', { captions, ownership, folders });",
    "      return row(state, 'switch', { captions, ownership, folders });"],
  // A workspace using both runtimes shows both rows.
  [SANDBOX_ROW, 'a Codex row joins the Claude Code row when both runtimes are in use',
    "    if (hasCodex) rows.push(",
    "    if (hasCodex && !hasClaude) rows.push("],

  // ===== THE AGENT'S OWN FOLDER: THREE TIERS, ONE REGISTRY =====
  // Drop the write gate and a persistence-surface write becomes free, the storm this tiering exists to end.
  [HOOK, 'a write to a persistence surface is not free the way a read is',
    '  if (tags.agentHome && !tags.secret && !(isWrite && tags.persistenceSurface)) {',
    '  if (tags.agentHome && !tags.secret) {'],
  // Both tags must come from the registry, not a hardcoded literal.
  [HOOK, 'a crossing\'s secret and persistence-surface tags come from the registry, not a hardcoded false',
    '    ? { agentHome: true, secret: isSecretPath(resolvedPath, home, foldsCase), persistenceSurface: isPersistenceSurface(resolvedPath, home, foldsCase) }',
    '    ? { agentHome: true, secret: false, persistenceSurface: false }'],
  // Drop tier three's exemption and a shell command merely touching scratch is reported as a crossing.
  [HOOK, 'a shell crossing into tier three (neither secret nor a persistence surface) is not reported at all',
    '    if (tags.agentHome && !tags.secret && (!tags.persistenceSurface || readOnly)) continue;',
    '    if (false) continue;'],
  // Drop the read-only re-grading and a command built entirely from `ls`,
  // `cat` and their neighbours cards against a persistence surface again,
  // the two-card storm this row exists to end.
  [HOOK, 'a persistence-surface shell crossing is freed by a read-only command, not only by staying in tier three',
    '(!tags.persistenceSurface || readOnly)',
    '(!tags.persistenceSurface)'],
  // Stop treating a lone `&` as a separator and `ls x & rm -rf x` is judged by
  // its leading word again, freeing the removal against a persistence surface.
  [READ_ONLY, 'a lone & separates commands, so the second cannot ride the first',
    "      if (ch === ';' || ch === '|' || ch === '&' || ch === '\\n' || ch === '\\r') {",
    "      if (ch === ';' || ch === '|' || ch === '\\n' || ch === '\\r') {"],
  // Stop stripping the discarding redirects and one `2>/dev/null` appended
  // to `ls` grades the whole command a WRITE again, which is the card a real
  // session was shown for a command that writes nothing.
  [READ_ONLY, 'a redirection that discards output does not disqualify a read-only command',
    "    var str = String(command).replace(DISCARDING_REDIRECT_RE, ' ');",
    '    var str = String(command);'],
  // Widen the exemption to any redirect target and the fail-safe inverts:
  // `ls x > x/listing.txt` writes into the surface and would read as free.
  [READ_ONLY, 'only /dev/null and descriptor duplication are exempt, never an arbitrary redirect target',
    'var DISCARDING_REDIRECT_RE = /\\d*>>?\\s*(?:\\/dev\\/null|&\\s*\\d+)/g;',
    'var DISCARDING_REDIRECT_RE = /\\d*>>?\\s*\\S+/g;'],
  // A command is read-only only if every leading word is actually in the
  // registry: drop the check and any command (a bare `rm`, included) reads
  // as free against a persistence surface.
  [READ_ONLY, 'a command is read-only only when the registry actually names its leading word',
    '    if (READ_ONLY_SHELL_COMMANDS.indexOf(first) >= 0) return true;\n'
    + '    if (NO_TARGET_COMMANDS.indexOf(first) >= 0) return true;\n'
    + '    if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0) return true;\n'
    + '    return false;',
    '    return true;'],
  // A subshell the segmenter cannot see into hides whatever it runs. Drop the
  // test and `cd $(rm -rf ~/.claude/agents/x)` reads as a bare `cd`, and the
  // removal is exempted from its crossing rather than reported.
  [READ_ONLY_CLIENT, 'structure the segmenter cannot see into is never a read',
    '    if (HIDES_SUBCOMMAND.test(str)) return false;',
    ''],
  // The vocabulary grew by exactly one word. Put the card grader's old private
  // list back into it and `sort -o <persistence surface> payload` is graded a
  // read and exempted from its crossing, which is the write nobody sees.
  // `find` sat on the read-only registry with its flags unexamined. Drop the
  // allowlist and `find ~/.claude/hooks -delete` is graded a read again, its
  // crossing skipped, and in Code mode the hook scripts go with no card.
  [READ_ONLY_CLIENT, 'find is judged by its flags at all',
    "    if (first === 'find') return findOnlyReads(words.slice(1));",
    ''],
  // THE SHAPE, not the contents. Return true for an unrecognised flag and the
  // allowlist becomes a denylist of nothing: every write action this file does
  // not name, on every platform it does not run on, is waved through again.
  [READ_ONLY_CLIENT, 'a find flag nobody recognised fails closed rather than passing',
    '      return false;\n    }\n    return true;\n  }',
    '      continue;\n    }\n    return true;\n  }'],
  // Consume an operand after a flag that does not take one and an action is
  // swallowed as data: `find . -depth -delete` reads as a bare search again.
  [READ_ONLY_CLIENT, 'only a flag that always takes an operand consumes the word after it',
    '      if (FIND_READ_FLAGS_NO_OPERAND.indexOf(w) >= 0) continue;',
    '      if (FIND_READ_FLAGS_NO_OPERAND.indexOf(w) >= 0) { i++; continue; }'],
  [READ_ONLY_CLIENT, 'the shared vocabulary adds only the word the reported command needs',
    "  var NO_TARGET_COMMANDS = ['cd'];",
    "  const NO_TARGET_COMMANDS = ['cd', 'pushd', 'popd', 'true', 'date', 'diff',\n"
    + "    'printenv', 'sort', 'uniq', 'which', 'whoami'];"],
  // Drop the PowerShell half and Windows keeps the storm this release ended
  // on macOS: every Get-ChildItem under the runtime home grades as a write.
  [READ_ONLY, 'the read-only registry answers for PowerShell as well as the Unix shells',
    '    if (READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0) return true;',
    ''],
  // Compare case-sensitively and half the spellings agents actually write
  // (get-childitem, GCI) stop being reads, because PowerShell is not.
  [READ_ONLY, 'PowerShell commands are compared case-insensitively, because PowerShell is',
    'READ_ONLY_POWERSHELL_COMMANDS.indexOf(first.toLowerCase()) >= 0',
    'READ_ONLY_POWERSHELL_COMMANDS.indexOf(first) >= 0'],
  // Every segment of a compound command must qualify, not merely one of
  // them: drop `every` for `some` and `ls x && rm -rf x` reads as free
  // because its first segment alone is a read.
  [READ_ONLY, 'every segment of a compound command must be read-only, not merely one of them',
    'segments.every(segmentReads)',
    'segments.some(segmentReads)'],
  // A write-shaped redirection makes an otherwise read-only leading command
  // write anyway: drop the check and `echo x > ~/.claude/hooks/y` reads as
  // free because `echo` alone is on the registry.
  [READ_ONLY, 'a write-shaped redirection disqualifies a command as read-only, whatever its leading words are',
    "    if (/>>?|\\btee\\b/.test(str)) return false;",
    ''],
  // The two rows that stood here guarded a package-runner exemption keyed on one
  // third-party tool's name and subcommand. The exemption is gone, so there is
  // nothing left to mutate: a runner is not a read, and the row below proves
  // that by the only thing that can, which is the fall-through answering false.
  // A registry path is recognised however it is spelled, including before it
  // exists: drop the fold on the CANDIDATE side (the fold on the registry's
  // own, already-lowercase names changes nothing, which is why this targets
  // the side that actually carries the variance) and a case variant of an
  // unborn registry folder escapes the comparison on a case-folding host.
  [HOOK, 'the case-fold seam actually folds the candidate before it is compared against the registry',
    'function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (typeof candidate !== \'string\' || !candidate) return false;\n'
    + '  const c = foldCase(canonicalize(candidate), foldsCase);',
    'function isPersistenceSurface(candidate, home = os.homedir(), foldsCase = hostFoldsCase()) {\n'
    + '  if (typeof candidate !== \'string\' || !candidate) return false;\n'
    + '  const c = canonicalize(candidate);'],
  // The registry is fail-loud in the code direction: a literal folder name
  // hardcoded alongside the registry's own, rather than reasoned from it,
  // must make an unregistered neighbour classify as governed.
  [HOOK, 'no folder is a persistence surface unless its own home\'s registry says so',
    '  return h.dirs.some(d => {',
    '  return [...h.dirs, \'projects\'].some(d => {'],
  // The registry is fail-loud in the doc direction too: a name removed from
  // the registry while the boundary passage still cites it must be caught,
  // not just the reverse.
  [HOOK, 'every persistence-surface directory the registry declares is bound to the architecture doc',
    'const PERSISTENCE_SURFACE_DIRS = [\'agents\', \'skills\', \'plugins\', \'commands\', \'hooks\'];',
    'const PERSISTENCE_SURFACE_DIRS = [\'agents\', \'skills\', \'commands\', \'hooks\'];'],
  // settings.json is the one persistence-surface FILE, so the folder beside
  // its card is the runtime home root itself: drop the exclusion and
  // approving that card's "Always allow this folder" would silence every
  // later write to agents/, skills/, plugins/, commands/ and hooks/ too.
  [HOOK, 'no standing folder grant is offered when the grant directory would be the root of EITHER runtime home',
    '    || (tags.agentHome && runtimeHomes(home).some(h => grantDir === h.root))',
    '    || false'],
  // The credential-folder rule, mutated on its own so it is guarded by a test
  // rather than by the one beside it. Breaking it would put the one-click
  // blanket grant back on ~/.ssh and its kin, which is the whole point of it.
  [HOOK_CLASSIFIER, 'a hidden folder under home is never offered as a standing grant, on either card',
    '    || underHiddenHomeDir(grantDir, home);',
    '    || false;'],
  [HOOK_CLASSIFIER, 'and the shell card refuses it too, so the two cards cannot disagree',
    '  if (underHiddenHomeDir(dir, home)) return null;',
    '  if (false) return null;'],
  // The one production site carrying classifyFileAccess's tags onto the emitted request.
  // Moved into boundaryCrossingsFor when that was extracted as a seam, so the
  // payload's own shape could be asserted rather than the classifier's return.
  // The guard follows the code: drop the tags and the request carries none.
  [HOOK_INTEGRATION, 'a file crossing\'s tags reach the request the hook actually emits',
    '    path: access.resolvedPath, grantDir: access.grantDir,\n'
    + '    agentHome: access.agentHome, secret: access.secret,\n'
    + '    persistenceSurface: access.persistenceSurface, answerFile: access.answerFile,\n'
    + '  }];',
    '    path: access.resolvedPath, grantDir: access.grantDir,\n'
    + '  }];'],
  // Drop the registry check and a broad grant silences the credential file inside it.
  [BOUNDARY, 'a secrets-registry crossing is covered by no stored grant, however broad',
    '  if (isSecretPath(crossing.path, home)) return false;',
    '  if (false) return false;'],
  [CHAT_VIEW, 'the whole-folder button is never offered for a secrets-tier crossing, nor where an answer file is among the places reached',
    '  const wholeFolderOffered = grantable\n'
    + '    && !(flaggedCrossing && (flaggedCrossing.secret || flaggedCrossing.answerFile))\n'
    + '    && !crossings.some(c => c && c.answerFile);',
    '  const wholeFolderOffered = grantable;'],
  [CHAT_VIEW, 'the agent-home copy is applied to the card\'s context',
    '    if (stakesCopy) context = crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;',
    '    if (false) context = crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;'],
  // The multi-crossing warning is COMPOSED with the stakes copy, not
  // replaced by it: dropping the ternary back to a plain overwrite is the
  // exact regression an earlier version shipped, where approving a command
  // that reached several places was no longer told it was approving all of them.
  [CHAT_VIEW, 'the multi-crossing warning survives alongside the agent-home stakes copy, rather than being overwritten by it',
    'crossings.length > 1 ? `${context} ${stakesCopy}` : stakesCopy;',
    'stakesCopy;'],

  // ===== MODE NEVER REACHES THE BLOCK =====
  // Re-couple the block to mode inside the mode handler and a mode change
  // rewrites the settings file, which is the coupling the switch ends.
  [WORKSPACE_HANDLER_UNIT, 'a mode change never rewrites the sandbox block',
    '    state.workspaceMode = mode;\n    writeState(state);\n',
    "    state.workspaceMode = mode;\n    writeState(state);\n    if (getWorkspace()) reconcileSandboxForMode(getWorkspace(), mode, platform);\n"],
  // Drop the pin and a workspace with no switch stored has it moved by the
  // mode on the next open.
  [WORKSPACE_HANDLER_SWITCH, 'the first mode change pins the switch the old mode implied',
    "    if (!current.stored) state.sandboxSwitch = current.on ? 'on' : 'off';\n",
    ''],

  // The lower length bound is the one that survives. The upper bound is gone
  // with the fixed-length tail: the list now carries the folders the user
  // named, so its length proves nothing. A block with NO tail at all is still
  // refused, and that is what stops a block a person trimmed the temp roots
  // out of being read as ours and regenerated over their edit.
  [SCAFFOLD, 'a tail of zero entries is rejected, so a block trimmed of its temp roots is not read as ours',
    '  if (roots.length < expectedHead.length + 1) return false;',
    ''],
  // The shape is read from the block, not assumed. Pinned because it is the
  // branch that lets a workspace which changed mode still recognise what it
  // wrote before: assume one shape and the other reads as a stranger's block,
  // which is a block Rundock can never rewrite or withdraw.
  [SCAFFOLD, 'which shape a block claims is read from the block, not assumed to be the enabled one',
    "  const claimedMode = block.enabled === true ? 'knowledge' : 'code';",
    "  const claimedMode = 'knowledge';"],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  // A suite under test/electron/ is a run of the shipped desktop app, not a
  // node:test file: it prints one JSON report whose `failures` names every
  // expectation that did not hold, and exits 1 when there are any.
  if (String(suite || '').startsWith('test/electron/')) {
    try {
      out = execFileSync('node', [suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000 });
    } catch (e) {
      failed = true;
      out = e.stdout || '';
    }
    try {
      const report = JSON.parse(out.slice(out.indexOf('{\n'), out.lastIndexOf('}') + 1));
      if (Array.isArray(report.failures) && (report.failures.length > 0) === failed) return report.failures;
    } catch (e) { /* no report: no verdict */ }
    return { unparsable: true };
  }
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
    // of a stack trace that names nothing.
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
  const targets = [HOOK, SCAFFOLD, BOUNDARY, CHAT_VIEW, HOOK_INTEGRATION, HOOK_REFUSAL, HOOK_CLASSIFIER, WORKSPACE_HANDLER, WORKSPACE_HANDLER_UNIT, SCAFFOLD_SWITCH, WORKSPACE_HANDLER_SWITCH, SANDBOX_STATUS, SANDBOX_IMPORT, MODE, NOTES_LABEL, PERMISSIONS_PANE, SANDBOX_ROW, SCAFFOLD_FOREIGN, SETTINGS_SURFACE, READ_ONLY, READ_ONLY_CLIENT, DESKTOP, USER_DATA, DESKTOP_PROFILE, DESKTOP_PROFILE_RUN];
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
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
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
