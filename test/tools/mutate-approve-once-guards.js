#!/usr/bin/env node
'use strict';
// Break each of the approval and connectors guards in turn and report which
// tests notice.
//
// The rules this change leaves behind are consent rules: a plan runs unattended
// only after its one tap, the tap covers exactly what the routine DOES, an
// upgrade never stops work already consented to, and the connectors tab
// never silently replaces a connector somebody configured. Every one of them
// can be deleted with the product still rendering something, which is why
// each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-approve-once-guards.js            # report
//   node test/tools/mutate-approve-once-guards.js --markdown # the same, as a table
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

// The data model, where the hash and the approval predicate live.
const ROUTINES = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/approve-once.test.js' };
// The scheduler, whose refusal is the gate the row consumes.
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/approve-once.test.js' };
// Where an approval counts (lib/agents/approval-store.js and its workspace
// side), each guard paired with the suite that notices it.
const LOCALITY_ATTACK_SUITE = 'test/integration/attack/routine-approvals.test.js';
const SCHEDULER_ATTACK = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: LOCALITY_ATTACK_SUITE };
const STORE = { src: path.join(ROOT, 'lib', 'agents', 'approval-store.js'), suite: 'test/unit/approval-store.test.js' };
const LOCALITY = { src: path.join(ROOT, 'lib', 'agents', 'approval-locality.js'), suite: 'test/unit/approval-store.test.js' };
const LOCALITY_ATTACK = { src: path.join(ROOT, 'lib', 'agents', 'approval-locality.js'), suite: LOCALITY_ATTACK_SUITE };
const MIGRATION_ATTACK = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: LOCALITY_ATTACK_SUITE };
const TEAM_ATTACK = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: LOCALITY_ATTACK_SUITE };
const TEAM_SAVE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/integration/run-now.test.js' };
const IMPORT_ATTACK = { src: path.join(ROOT, 'lib', 'packages', 'import-apply.js'), suite: LOCALITY_ATTACK_SUITE };
const HELD_ATTACK = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'held-routines.js'), suite: LOCALITY_ATTACK_SUITE };
const HEAL_ATTACK = { src: path.join(ROOT, 'server.js'), suite: LOCALITY_ATTACK_SUITE };
const HELD_MODEL = { src: path.join(ROOT, 'public', 'held-routines-model.js'), suite: 'test/unit/approval-store.test.js' };
const HELD_VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/approval-store.test.js' };
// The routines model, where the approval line is decided.
const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/approve-once.test.js' };
// The settings view's pure half, where the connectors file is parsed and merged.
const SETTINGS = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/approve-once.test.js' };
// Same file as SETTINGS, a different suite: the read-failed WIRING is only
// reachable through connectorsLoad against a real non-ok response, which the
// unit suite (which drives the pure renderer with a state it builds itself)
// cannot see.
const SETTINGS_WIRING = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/integration/http-api.test.js' };

const MUTATIONS = [
  // ===== APPROVAL IS THE HASH, MATCHED, NOT A FLAG =====
  // Treat any recorded hash as approval regardless of match and an edited
  // plan keeps its lapsed consent: the exact falsehood the comparison
  // exists to remove.
  [ROUTINES, 'approval means the current plan matches the approved hash',
    '  return routine.planApprovedHash === computePlanHash(routine);',
    '  return routine.planApprovedHash !== APPROVAL_PENDING;'],
  // Shrink the hash inputs and editing the skill stops invalidating the
  // approval, which the card names as the line that must hold.
  [ROUTINES, 'the skill is part of what approval covers',
    "const PLAN_FIELDS = ['prompt', 'skill', 'runOn'];",
    "const PLAN_FIELDS = ['prompt', 'runOn'];"],

  // ===== THE GATE, AND ITS PLACE IN THE ORDER =====
  // Delete the refusal and an unapproved plan runs unattended.
  [SCHEDULER, 'an unapproved plan is refused by the tick',
    "  if (!approvalStore.approvedHere(getWorkspace(), routine, computePlanHash(routine))) return 'approval';\n",
    ''],

  // ===== AN APPROVAL COUNTS ONLY WHERE IT WAS GIVEN =====
  // Each breaks one part of the install's own record of approvals, and the
  // suite that notices it is the one named on its target.
  [SCHEDULER_ATTACK, 'allowing never runs a routine on the click: an earlier slot is not owed',
    '        if (nextRun && consentAt && nextRun < consentAt) continue;\n',
    ''],
  [STORE, 'an approval covers the plan it was given over, not any plan',
    '  return !!record && typeof currentHash === \'string\' && record.hash === currentHash;',
    '  return !!record;'],
  [STORE, 'a workspace is kept under its real path',
    '    try { return path.join(fs.realpathSync.native(current), ...rest.reverse()); } catch (e) { /* not there */ }',
    '    return path.resolve(dir);'],
  [STORE, 'the moment of an approval is kept',
    '  entry.approvals.push({ file, name, occurrence, hash, at: at || null });',
    '  entry.approvals.push({ file, name, occurrence, hash, at: null });'],
  [LOCALITY, 'only a workspace opened at this path before is adopted',
    '    seenHere: previousPath === dir && store.wasRecentBeforeStore(dir),',
    '    seenHere: store.wasRecentBeforeStore(dir),'],
  [LOCALITY_ATTACK, 'a state file the workspace carries cannot adopt it on its own',
    '    seenHere: previousPath === dir && store.wasRecentBeforeStore(dir),',
    '    seenHere: previousPath === dir,'],
  [STORE, 'the recent-workspaces history is taken only when the record is first made',
    '  if (storeFile && !fs.existsSync(storeFile)) {',
    '  if (storeFile) {'],
  [LOCALITY_ATTACK, 'Allow approves the plan the strip named, never one changed since',
    "    if (!e || typeof h.hash !== 'string' || computePlanHash(e.routine) !== h.hash) continue;",
    '    if (!e) continue;'],
  [LOCALITY_ATTACK, 'a package update records only what its card said runs itself',
    '    if (!granted.some((g) => g.name === e.name && g.occurrence === e.occurrence)) continue;\n',
    ''],
  [LOCALITY, 'a copy is not a move: the old path must be gone',
    "  if (previousPath && previousPath !== dir && !fs.existsSync(previousPath) && store.moveWorkspace(previousPath, dir)) {",
    "  if (previousPath && previousPath !== dir && store.moveWorkspace(previousPath, dir)) {"],
  [LOCALITY, 'the strip names only routines that would have run',
    '  return routine.enabled === true && !routine.paused && !!unquote(routine.schedule)',
    '  return !!unquote(routine.schedule)'],
  [LOCALITY, 'a package install records only approvals that match the plan',
    '    if (e.file !== relFile || !planApproved(e.routine)) continue;',
    '    if (e.file !== relFile) continue;'],
  [MIGRATION_ATTACK, 'a workspace never seen here is never grandfathered',
    "\n    || require('./approval-store.js').workspaceState(workspace) !== 'adopted';",
    ';'],
  [TEAM_ATTACK, 'the approve tap records the approval here',
    '    written: () => recordApproval(getWorkspace(), {',
    '    written: () => ({}) || recordApproval(getWorkspace(), {'],
  [TEAM_SAVE, 'a routine made here is approved here',
    '  if (blocks.length) {\n    recordApproval(',
    '  if (false) {\n    recordApproval('],
  [IMPORT_ATTACK, 'agreeing to an install card approves its routines here',
    '    if (write.kind !== \'agent\') continue;',
    '    continue;'],
  [HELD_ATTACK, 'Allow approves what the strip names',
    "  locality.allowHeld(dir, require('../../scheduler.js').schedulerNow().toISOString());",
    '  store.closeStrip(dir);'],
  [HELD_ATTACK, 'closing the strip keeps it closed',
    '  store.closeStrip(dir);\n  announce(ctx);\n}\n\nmodule.exports',
    '  announce(ctx);\n}\n\nmodule.exports'],
  [HEAL_ATTACK, 'every workspace opened is decided before its routines are read',
    '  try { approvalLocality.noteWorkspaceOpened(dir, previous); }',
    '  try { (() => {})(dir, previous); }'],
  [HELD_VIEW, 'a routine\'s name on the strip is text, never markup',
    '  text.textContent = view.text;',
    '  text.innerHTML = view.text;'],
  [HELD_MODEL, 'the strip\'s button fits the count',
    "    const allowLabel = one ? 'Allow it' : held.length === 2 ? 'Allow both' : 'Allow all';",
    "    const allowLabel = 'Allow both';"],

  // ===== THE GRANDFATHER LINE =====
  // Stamp migrated routines pending instead and the upgrade re-questions
  // every plan on every machine: the predating-routines defect in mirror
  // image, work halted by a release.
  [ROUTINES, 'a pre-existing routine carries its consent over the upgrade',
    '        updates[key] = featureHasRun ? APPROVAL_PENDING : computePlanHash(routine);',
    '        updates[key] = APPROVAL_PENDING;'],
  // Put a new routine back to pending and the row that was just created says
  // "Waiting for your approval" beside a pause icon implying it is already
  // live, which is the state a reader could not read either way. Writing a
  // routine is consenting to it; the consent that still has to be collected is
  // consent to a CHANGE, and that is the row above and the edit case below.
  [ROUTINES, 'a new routine is born carrying consent to the plan it was created with',
    '    planApprovedHash: computePlanHash(normalized),',
    '    planApprovedHash: APPROVAL_PENDING,'],

  // ===== THE ROW'S ONE TAP =====
  // Show the approval line for every refusal and the reader is asked to
  // approve plans that are blocked by something else entirely.
  [MODEL, 'the approval line is drawn only for the approval word',
    "    if (!input || input.refusal !== 'approval') return null;",
    '    if (!input || !input.refusal) return null;'],

  // The file-level discriminator: grandfather only a wholly key-less file.
  // Approve every key-less block regardless of siblings and a later addition
  // (or a lost record) inherits consent nobody gave.
  [ROUTINES, 'a key-less block beside an approved sibling meets the step',
    '        updates[key] = featureHasRun ? APPROVAL_PENDING : computePlanHash(routine);',
    '        updates[key] = computePlanHash(routine);'],

  // ===== THE CONNECTORS FILE IS EDITED, NEVER CLOBBERED =====
  // Drop the flag the failing read sets and the panel falls through to the
  // sourceErrors path with no rows, drawing "No connectors configured in this
  // workspace yet." beside the error: the two opposite claims about one
  // workspace, which is the confusion the panel must never create.
  [SETTINGS_WIRING, 'a failing read is recorded as a failed read, not as an absent file',
    '      if (res.error) return { servers: [], missing: false, readFailed: true, error: res.error };',
    '      if (res.error) return { servers: [], missing: false, error: res.error };'],
  // Render a read-failed state as the empty state and a workspace whose
  // connector file could not be read looks like a workspace with none, which
  // is the one confusion this panel must never create.
  [SETTINGS, 'a read that failed draws its error, never the empty state',
    "  if (state.error && state.readFailed) {\n    return `<div class=\"settings-section-title\">Connectors</div><div class=\"settings-card\"><div class=\"settings-row\"><span class=\"settings-prose\">${connectorsEsc(state.error)}</span></div></div>`;\n  }",
    ''],
  // Draw the guide button unconditionally and a workspace with no platform
  // agent gets a control that opens nothing.
  [SETTINGS, 'the add affordance is omitted when the workspace has no guide',
    "  const addHtml = guide\n",
    '  const addHtml = true\n'],
  // Render a broken config as an empty state and a person with a corrupt
  // file is reassured instead of told.
  [SETTINGS, 'a config that cannot be parsed is an error, never an empty state',
    "    return { servers: [], missing: false, error: '.mcp.json could not be read as JSON, so nothing here is trustworthy until it is fixed.' };",
    "    return { servers: [], missing: true, error: null };"],

  // ===== FOUR SOURCES MERGED INTO ONE ROW PER NAME =====
  // Skip the shape comparison and a connector defined differently by the two
  // runtimes (a URL for one, a local command for the other) merges silently
  // into whichever definition happened to be picked, with nothing on the
  // page ever saying the two disagree.
  [SETTINGS, 'a connector defined differently by the two runtimes is flagged as drift',
    "    if (claudeDef && codexDef && (claudeDef.transport !== codexDef.transport || claudeDef.target !== codexDef.target)) {",
    '    if (false) {'],
  // Read env values instead of just their keys and a credential VALUE, not
  // only its name, reaches the rendered page: the one thing this tab must
  // never do, worse here than for .mcp.json alone because ~/.claude.json can
  // carry live OAuth tokens.
  [SETTINGS, 'a connector\'s credential keys are named, and their values are never read',
    "      envKeys: entry.env && typeof entry.env === 'object' ? Object.keys(entry.env) : [],",
    "      envKeys: entry.env && typeof entry.env === 'object' ? Object.values(entry.env) : [],"],
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
  // Derived from the rows, never kept by hand: a hand-kept list went stale three
  // times (the boundary, extension-install and this harness), crashing on the
  // first row that named a target it didn't hold.
  const targets = [...new Set(MUTATIONS.map(([target]) => target))];
  for (const [target, label] of MUTATIONS) {
    if (!target || typeof target.src !== 'string' || typeof target.suite !== 'string') {
      throw new Error(`mutation row "${label}" names a target with no source file or suite`);
    }
  }
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
