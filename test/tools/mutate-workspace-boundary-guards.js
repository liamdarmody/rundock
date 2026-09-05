#!/usr/bin/env node
'use strict';
// Break each of the boundary's guards in turn and report which tests notice.
//
// Every rule here is a rule about a card that fires or stays quiet, and both
// failure directions are quiet ones: a guard deleted leaves inside paths
// carding (the storm this lane exists to end) or outside paths sliding by.
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
// The mode-persisted-before-scaffold ordering guard lives in the protocol
// handler, not the scaffold layer, and is reachable only through the real
// workspace-open path (the scaffold-layer tests call scaffoldWorkspace
// directly and so never see this file's own ordering at all).
const WORKSPACE_HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/integration/ws-handler-edges.test.js' };
// Same file as WORKSPACE_HANDLER, a different suite: the mode-switch
// atomicity guards are proven by protocol-handlers-lib.test.js's own
// read-back, not anything ws-handler-edges.test.js asserts.
const WORKSPACE_HANDLER_UNIT = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };

const MUTATIONS = [
  // ===== ONE DIRECTORY UNDER TWO NAMES IS ONE IDENTITY =====
  // Compare unresolved again and every symlink, alias and case spelling of
  // an inside path reads as outside: the false-positive half of the storm.
  [HOOK, 'file targets are canonicalised before the comparison',
    '  const resolvedPath = canonicalize(path.resolve(workspaceRoot, target), path, resolvedPathFoldsCase);',
    '  const resolvedPath = path.resolve(workspaceRoot, target);'],
  [HOOK, 'the roots are canonicalised too, or a symlink-opened workspace denies its own files',
    '  return [canonicalize(workspaceRoot, pmod), ...extraDirs.map(d => canonicalize(d, pmod))];',
    '  return [pmod.resolve(workspaceRoot), ...extraDirs.map(d => pmod.resolve(d))];'],
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
  [SCAFFOLD, 'a second tail entry must be a real-path spelling of the first, or it is somebody\'s edit',
    '  if (tail.length === 2 && !tail[1].endsWith(tail[0])) return false;\n',
    ''],
  // A corrupt or unreadable settings.local.json must not be silently
  // replaced with {}. Only ENOENT may start empty; drop that distinction and
  // every other read/parse failure quietly overwrites the file instead of
  // being surfaced.
  [SCAFFOLD, 'only a genuinely absent settings file may start the reconcile from {}',
    "    if (e.code !== 'ENOENT') throw new Error(`could not read ${settingsLocalPath}: ${e.message}`);\n",
    ''],

  // ===== THE BLOCK IS DRIVEN BY MODE, AND ONLY BY MODE =====
  // Ignore the mode and the switch writes the block for code mode too.
  [SCAFFOLD, 'the mode switch really withdraws the block in code mode',
    "  const desired = mode === 'code' ? null : sandboxSettings(dir, platform);",
    '  const desired = sandboxSettings(dir, platform);'],
  // Ignore the mode on the NEXT OPEN specifically, not through the switch:
  // scaffoldWorkspace's own reconcile has to read the persisted mode too, or
  // a code-mode workspace has its block silently rewritten the next time it
  // is opened.
  [SCAFFOLD, 'the next open honours the persisted mode, not only the switch',
    "    const desired = workspaceModeFor(dir) === 'code' ? null : sandboxSettings(dir, platform);",
    '    const desired = sandboxSettings(dir, platform);'],
  // The mode must be PERSISTED before scaffoldWorkspace runs, because
  // scaffoldWorkspace's own reconcile reads the mode back off disk, not from
  // this function's local variable. Swap the order and a never-before-opened
  // code-signal workspace gets the block written on its first open anyway,
  // catching up only on the next one.
  [WORKSPACE_HANDLER, 'the mode is persisted before scaffoldWorkspace runs, not after',
    "  const state = readState();\n"
    + "  if (!state.workspaceMode) {\n"
    + "    state.workspaceMode = detectWorkspaceMode(dir);\n"
    + "    writeState(state);\n"
    + "    console.log(`  Workspace mode auto-detected: ${state.workspaceMode}`);\n"
    + "  }\n"
    + "\n"
    + "  try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }",
    "  try { scaffoldWorkspace(dir); } catch (e) { console.warn('Scaffold warning:', e.message); }\n"
    + "\n"
    + "  const state = readState();\n"
    + "  if (!state.workspaceMode) {\n"
    + "    state.workspaceMode = detectWorkspaceMode(dir);\n"
    + "    writeState(state);\n"
    + "    console.log(`  Workspace mode auto-detected: ${state.workspaceMode}`);\n"
    + "  }"],

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
    '    if (tags.agentHome && !tags.secret && !tags.persistenceSurface) continue;',
    '    if (false) continue;'],
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
  [HOOK, 'no folder is a persistence surface unless PERSISTENCE_SURFACE_DIRS says so',
    '  return PERSISTENCE_SURFACE_DIRS.some(d => {',
    '  return [...PERSISTENCE_SURFACE_DIRS, \'projects\'].some(d => {'],
  // The registry is fail-loud in the doc direction too: a name removed from
  // the registry while the boundary passage still cites it must be caught,
  // not just the reverse.
  [HOOK, 'every persistence-surface directory the registry declares is bound to the architecture doc',
    'const PERSISTENCE_SURFACE_DIRS = [\'agents\', \'skills\', \'plugins\', \'commands\', \'hooks\'];',
    'const PERSISTENCE_SURFACE_DIRS = [\'agents\', \'skills\', \'commands\', \'hooks\'];'],
  // The one production site carrying classifyFileAccess's tags onto the emitted request.
  [HOOK_INTEGRATION, 'a file crossing\'s tags reach the request the hook actually emits',
    '        path: access.resolvedPath, grantDir: access.grantDir,\n'
    + '        agentHome: access.agentHome, secret: access.secret, persistenceSurface: access.persistenceSurface,\n'
    + '      }])',
    '        path: access.resolvedPath, grantDir: access.grantDir,\n'
    + '      }])'],
  // Drop the registry check and a broad grant silences the credential file inside it.
  [BOUNDARY, 'a secrets-registry crossing is covered by no stored grant, however broad',
    '  if (isSecretPath(crossing.path, home)) return false;',
    '  if (false) return false;'],
  [CHAT_VIEW, 'the whole-folder button is never offered for a secrets-tier crossing',
    '  const wholeFolderOffered = grantable && !(flaggedCrossing && flaggedCrossing.secret);',
    '  const wholeFolderOffered = grantable;'],
  [CHAT_VIEW, 'the agent-home copy is applied to the card\'s context',
    '    if (homeCopy) context = crossings.length > 1 ? `${context} ${homeCopy}` : homeCopy;',
    '    if (false) context = crossings.length > 1 ? `${context} ${homeCopy}` : homeCopy;'],
  // The multi-crossing warning is COMPOSED with the stakes copy, not
  // replaced by it: dropping the ternary back to a plain overwrite is the
  // exact regression an earlier version shipped, where approving a command
  // that reached several places was no longer told it was approving all of them.
  [CHAT_VIEW, 'the multi-crossing warning survives alongside the agent-home stakes copy, rather than being overwritten by it',
    'crossings.length > 1 ? `${context} ${homeCopy}` : homeCopy;',
    'homeCopy;'],

  // ===== A MODE CHANGE IS ALL OR NOTHING, IN EVERY FAILURE, IN BOTH DIRECTIONS =====
  [WORKSPACE_HANDLER_UNIT, 'the block is reconciled before the mode is persisted, not after',
    '    if (dir) reconcileSandboxForMode(dir, mode, platform);\n'
    + '    const state = readState();\n'
    + '    state.workspaceMode = mode;\n'
    + '    writeState(state);',
    '    const state = readState();\n'
    + '    state.workspaceMode = mode;\n'
    + '    writeState(state);\n'
    + '    if (dir) reconcileSandboxForMode(dir, mode, platform);'],
  // A failed mode change restores the settings file to its exact pre-request
  // bytes, not just refuses to commit the new mode. Drop the restore write
  // and a reconcile that genuinely changed the file leaves that change in
  // place even though the state write after it failed.
  [WORKSPACE_HANDLER_UNIT, 'a failed mode change restores the settings file\'s pre-request bytes, not just leaves the mode uncommitted',
    '      try {\n'
    + '        if (existedBefore) fs.writeFileSync(settingsLocalPath, preRequestBytes);\n'
    + "        else if (preRequestReadErrorCode === 'ENOENT' && fs.existsSync(settingsLocalPath)) fs.unlinkSync(settingsLocalPath);\n"
    + '      } catch (restoreErr) {',
    '      try {\n'
    + '      } catch (restoreErr) {'],
  // Delete only when the capture proved the file absent (ENOENT).
  [WORKSPACE_HANDLER_UNIT, 'the rollback may only delete the settings file when the capture proved it absent, not for any other read failure',
    "        else if (preRequestReadErrorCode === 'ENOENT' && fs.existsSync(settingsLocalPath)) fs.unlinkSync(settingsLocalPath);",
    '        else if (fs.existsSync(settingsLocalPath)) fs.unlinkSync(settingsLocalPath);'],
  // The delete branch alone, not paired with the restore write above.
  [WORKSPACE_HANDLER_UNIT, 'a mode change that creates settings.local.json where none existed removes it again on failure, not just restores bytes when a file was already there',
    "        else if (preRequestReadErrorCode === 'ENOENT' && fs.existsSync(settingsLocalPath)) fs.unlinkSync(settingsLocalPath);\n",
    ''],
  // The lower length bound is load-bearing too, not only the upper one.
  [SCAFFOLD, 'a tail of zero entries is rejected by the lower length bound, not only by the upper one',
    '  if (roots.length < expectedHead.length + 1 || roots.length > expectedHead.length + 2) return false;',
    '  if (roots.length > expectedHead.length + 2) return false;'],
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
  const targets = [HOOK, SCAFFOLD, BOUNDARY, CHAT_VIEW, HOOK_INTEGRATION, WORKSPACE_HANDLER, WORKSPACE_HANDLER_UNIT];
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
