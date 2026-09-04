#!/usr/bin/env node
'use strict';
// Break each of the approval and connectors guards in turn and report which
// tests notice.
//
// The rules this lane leaves behind are consent rules: a plan runs unattended
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
// The routines model, where the approval line is decided.
const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/approve-once.test.js' };
// The settings view's pure half, where the connectors file is parsed and merged.
const SETTINGS = { src: path.join(ROOT, 'public', 'views', 'settings.js'), suite: 'test/unit/approve-once.test.js' };

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
    "  if (!planApproved(routine)) return 'approval';\n",
    ''],

  // ===== THE GRANDFATHER LINE =====
  // Stamp migrated routines pending instead and the upgrade re-questions
  // every plan on every machine: the predating-routines defect in mirror
  // image, work halted by a release.
  [ROUTINES, 'a pre-existing routine carries its consent over the upgrade',
    '        updates[key] = fileHasApproval ? APPROVAL_PENDING : computePlanHash(routine);\n        continue;',
    '        updates[key] = APPROVAL_PENDING;\n        continue;'],
  // A freshly created routine arriving pre-approved is a first run that
  // never asks.
  [ROUTINES, 'a new routine arrives pending, not approved',
    '    planApprovedHash: APPROVAL_PENDING,',
    '    planApprovedHash: computePlanHash(normalized),'],

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
    "        updates[key] = fileHasApproval ? APPROVAL_PENDING : computePlanHash(routine);",
    '        updates[key] = computePlanHash(routine);'],

  // ===== THE CONNECTORS FILE IS EDITED, NEVER CLOBBERED =====
  // Render a read-failed state as the empty state and the next Add writes over
  // a file we merely could not read.
  [SETTINGS, 'a read that failed draws its error, never the empty state',
    "  if (state.error && state.readFailed) {\n    return `<div class=\"settings-section-title\">Connectors</div><div class=\"settings-card\"><div class=\"settings-row\"><span class=\"settings-value\">${connectorsEsc(state.error)}</span></div></div>`;\n  }",
    ''],
  // Let connectorsAdd proceed after a failed read and it merges from null,
  // dropping the real file's servers.
  [SETTINGS, 'the Add refuses when the file was never successfully read',
    "  if (connectorsReadFailed) {",
    '  if (false) {'],
  // Let the merge replace an existing name and adding a connector can
  // silently rewrite one somebody configured.
  [SETTINGS, 'the merge refuses to replace an existing connector',
    '  if (parsed.mcpServers[name]) return { next: null, reason: `A connector named "${name}" already exists; edit .mcp.json to change it.` };\n',
    ''],
  // Render a broken config as an empty state and a person with a corrupt
  // file is reassured instead of told.
  [SETTINGS, 'a config that cannot be parsed is an error, never an empty state',
    "    return { servers: [], missing: false, error: '.mcp.json could not be read as JSON, so nothing here is trustworthy until it is fixed.' };",
    "    return { servers: [], missing: true, error: null };"],
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
  const targets = [ROUTINES, SCHEDULER, MODEL, SETTINGS];
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
