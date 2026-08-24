#!/usr/bin/env node
'use strict';
// Break each of the run detail screen's guards in turn and report which tests
// notice.
//
// WHY THIS EXISTS SEPARATELY FROM THE SUITE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards. Most of what this screen is judged on is a
// piece of COPY or an ABSENCE, and both are the easiest kinds of test to write
// so that they cannot fail: assert a string is absent and the test passes
// against a module that returns nothing at all.
//
// THE ONE THIS FILE EXISTS FOR, and it had its own card on the board before a
// line of the screen was written.
//
// A run record keeps two answers apart: `filesStatus: 'known'` with
// `files: []` is a run that changed nothing, and `filesStatus: 'unknown'` with
// `files: null` and a named reason is a run whose changes nobody can read. A
// routine that changed nothing is working normally; a routine whose changes
// are unknown is one where the observation is broken, and the difference
// decides whether somebody trusts an unattended run or reverts it.
//
// The collapse is one line: `record.files || []`. It type-checks, it reads as
// tidiness, and it erases the distinction silently and permanently. The first
// two mutations below write exactly that line, by both of its doors, and
// require a test to go red for each.
//
// THE SECOND ONE. No raw status word may reach the page, `interrupted`
// included, because that word is written only by the startup close and means
// the ending never ran rather than that the run failed. The mutations below
// pass the record's own word through, and give a run whose ending never ran
// the words and the colour written for one that failed.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-run-detail-guards.js            # report
//   node test/tools/mutate-run-detail-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'run-detail-model.js'), suite: 'test/unit/run-detail-model.test.js' };
// The same module watched by the file that drives records through the REAL
// render, because a distinction preserved in a model and lost in a template is
// a distinction the reader never gets.
const MODEL_VIEW = { src: path.join(ROOT, 'public', 'run-detail-model.js'), suite: 'test/unit/run-detail-view.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'run-detail.js'), suite: 'test/unit/run-detail-view.test.js' };
// THE STYLESHEET IS A MUTATION TARGET, and that is the point of it being one.
// The three tones are about what a reader SEES, and what they see is resolved
// from these rules, not from any table in a module. Asserting the ruling
// against a constant nothing renders means giving a run whose ending never ran
// the danger colour moves the page and moves no test.
const STYLES = { src: path.join(ROOT, 'public', 'styles', 'views', 'run-detail.css'), suite: 'test/unit/run-detail-view.test.js' };
// The transport, where a record could be rebuilt on the way past and lose the
// distinction before the screen ever sees it.
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'runs.js'), suite: 'test/unit/run-detail-transport.test.js' };
// The reader's admission check, which is the whole reason the resolver may
// dereference a record without guarding. Watched from the transport's suite
// because that is where the claim is made and where a record the reader let
// through would throw before anything was sent.
const READER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/run-detail-transport.test.js' };
// The way in and the way back, watched by the file that presses them rather
// than by the file that calls what they call.
const ROUTINES_VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/run-detail-doors.test.js' };
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/run-detail-doors.test.js' };
const VIEW_DOORS = { src: path.join(ROOT, 'public', 'views', 'run-detail.js'), suite: 'test/unit/run-detail-doors.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== UNKNOWN IS NOT EMPTY =====
  // THE ONE THIS FILE EXISTS FOR, in its exact form: the default that turns
  // "nobody could tell" into "it changed nothing".
  [MODEL, 'an unknown file list is never read through a default',
    '    if (!record || record.filesStatus !== \'known\') {\n      // NO RECORD NAMES ITSELF. Falling through to the catch-all here would\n      // tell a reader the record gives a reason this version cannot read,\n      // when the truth is there is no record to give one.\n      return { known: false, lead: UNKNOWN_FILES_LEAD, reason: unknownWords(record ? record.filesReason : \'no-record\') };\n    }',
    '    if (!record) return { known: false, lead: UNKNOWN_FILES_LEAD, reason: FILES_UNKNOWN_FALLBACK };'],
  // The same erasure by its second door: a record claiming to know while
  // carrying no list, read as a run that changed nothing.
  [MODEL, 'a record that claims a known list and carries none is unknown, not empty',
    '    if (!Array.isArray(record.files)) {\n      return { known: false, lead: UNKNOWN_FILES_LEAD, reason: FILES_UNKNOWN_FALLBACK };\n    }',
    '    if (!Array.isArray(record.files)) return { known: true, label: FILES_LABELS.complete, empty: NO_FILES_CHANGED, entries: [] };'],
  // The distinction has to survive the render, not only the model.
  [MODEL_VIEW, 'the distinction survives the render, not only the model',
    "    if (!record || record.filesStatus !== 'known') {\n      // NO RECORD NAMES ITSELF.",
    "    if (!record || (record.files && record.files.length === 0)) {\n      // NO RECORD NAMES ITSELF."],
  [VIEW, 'the unknown answer draws its own block rather than an empty list',
    '  if (!files.known) {\n    return `<div class="rd-files-label">${escText(\'What it changed\')}</div>`',
    '  if (false) {\n    return `<div class="rd-files-label">${escText(\'What it changed\')}</div>`'],
  [MODEL, 'the reason a list is unknown is looked up, never printed as its code',
    '    return FILES_UNKNOWN_WORDS[reason] || FILES_UNKNOWN_FALLBACK;',
    '    return FILES_UNKNOWN_WORDS[reason] || String(reason);'],
  [VIEW, 'a record that has not arrived is not a run that changed nothing',
    '  if (record === undefined) {',
    '  if (false) {'],
  // ORDERING IS WHAT THIS HANDLER ADDS, so it is what has to be guarded. The
  // reader promises no order and says so; taking the first record it hands
  // over returns whichever run the filesystem happened to list first.
  [HANDLER, 'the newest record is the one resolved to, not the first the reader hands over',
    '    if (best === null || when > bestAt) { best = record; bestAt = when; }',
    '    if (best === null) { best = record; bestAt = when; }'],
  // The stated reason the resolver carries no null guard. Removing the
  // admission check lets a parsed null reach the filter, which throws before
  // the reply is sent.
  [READER, 'the reader admits only records a caller can dereference',
    "      if (record && typeof record.id === 'string') records.push(record);",
    '      records.push(record);'],
  [HANDLER, 'the record crosses the wire whole rather than rebuilt from named fields',
    '    run,\n  }));',
    '    run: run ? { ...run, files: run.files || [] } : null,\n  }));'],

  // ===== NO RAW STATUS WORD =====
  [MODEL, 'the state is looked up, never taken from the record',
    "      : (Object.prototype.hasOwnProperty.call(RUN_STATES, record.status) ? RUN_STATES[record.status] : UNRECOGNISED_STATE);",
    '      : (RUN_STATES[record.status] || { tone: \'bad\', chip: record.status, headline: `This run is ${record.status}.`, guidance: null });'],
  // A run whose ending never ran, given the words written for one that failed.
  // Nobody witnessed the outcome, and this is the reading that costs a user
  // work they did not need to revert.
  [MODEL, 'a run whose ending never ran carries its own words',
    "    interrupted: {\n      tone: 'unwitnessed',",
    "    interrupted: {\n      tone: 'bad',"],
  [MODEL, 'a run that ran and one that ran and got through do not share a headline',
    "      headline: 'This run got to the end and did what it was asked to.',",
    "      headline: 'This run ran.',"],
  // The same ruling where a reader actually resolves it.
  [STYLES, 'a run whose ending never ran is not painted as a failure',
    '.rd-chip.unwitnessed { color: var(--idle); font-weight: 500; }',
    '.rd-chip.unwitnessed { color: var(--danger); font-weight: 600; }'],
  // A run with no record on file is a third absence, and it has its own
  // sentence: blaming a reason code nobody can read describes a record that
  // does not exist.
  [MODEL, 'a run with no record on file says which absence this is',
    "reason: unknownWords(record ? record.filesReason : 'no-record') };",
    'reason: FILES_UNKNOWN_FALLBACK };'],
  [VIEW, 'the chip carries its tone, so the states are told apart at a glance',
    '`<div class="settings-row"><span class="rd-chip ${escText(view.state.tone)}" data-run-detail="chip">`',
    '`<div class="settings-row"><span class="rd-chip" data-run-detail="chip">`'],

  // ===== WHAT THE RUN CHANGED =====
  [MODEL, 'a file created is told apart from a file edited',
    "        changeLabel: CHANGE_LABELS[entry && entry.change] || CHANGE_FALLBACK,",
    '        changeLabel: CHANGE_FALLBACK,'],
  [MODEL, 'a list from a run that stopped partway says so',
    '      label: stopped ? FILES_LABELS.partial : FILES_LABELS.complete,',
    '      label: FILES_LABELS.complete,'],
  [VIEW, 'the screen says plainly that it cannot open a changed file',
    '    + `<p class="settings-caption rd-cannot-open">${escText(CANNOT_OPEN)}</p>`;',
    ';'],

  // ===== THE WAY IN AND THE WAY BACK =====
  [ROUTINES_VIEW, 'a row with a last run carries a way into that run',
    "        ? `${sep}<button class=\"btn-link rr-view-run\" type=\"button\" data-routines-action=\"view-run\"`\n          + ` onclick=\"routinesViewLastRun(${index})\">View last run</button>`",
    "        ? ''"],
  [ROUTINES_VIEW, 'the way in names the routine the row is for',
    '  const entry = allRoutines()[index];\n  if (!entry) return;\n  if (typeof openRunDetail === \'function\') openRunDetail(entry.agent.id, entry.routine.name);',
    '  const entry = allRoutines()[0];\n  if (!entry) return;\n  if (typeof openRunDetail === \'function\') openRunDetail(entry.agent.id, entry.routine.name);'],
  [VIEW_DOORS, 'opening the screen asks the server for the record',
    "  if (typeof ws !== 'undefined' && ws) ws.send(JSON.stringify({ type: 'get_run', agentId, routine }));",
    ''],
  [APP, 'the record arriving is dispatched into this screen',
    "    case 'run': runArrived(d); break;\n",
    ''],
  // AIMED AT THE SUITE THAT CARRIES THE TEST. This one was first pointed at
  // the doors file, where nothing drives a late reply, and it reported green
  // by turning nothing red: a mutation aimed at the wrong suite is a proof
  // that cannot fail wearing the shape of one that can.
  [VIEW, 'a reply for another routine is not drawn on this screen',
    '  if (reply.agentId !== asked.agentId || reply.routine !== asked.routine) return;',
    '  if (!reply.run && !asked) return;'],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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
    throw new Error(
      'the suite failed but its output carries no "failing tests:" summary, so no '
      + 'test names could be read. The spec reporter\'s format is what this parses; '
      + 'if it changed, fix this parser rather than trusting the empty result.');
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [MODEL, MODEL_VIEW, VIEW, VIEW_DOORS, STYLES, HANDLER, READER, ROUTINES_VIEW, APP];
  const originals = new Map();
  for (const target of targets) originals.set(target, fs.readFileSync(target.src, 'utf8'));
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
      // FIRST. String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red. Make the search text unique,
      // usually by including a neighbouring line.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      results.push({ label, applied: true, red: redTests(target.suite) });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    for (const target of targets) fs.writeFileSync(target.src, originals.get(target));
  }
  return results;
}

function report(results, markdown) {
  let bad = 0;
  if (markdown) {
    console.log('| guard | tests that turned red |');
    console.log('| --- | --- |');
  }
  for (const r of results) {
    if (!r.applied) {
      bad++;
      const why = r.ambiguous
        ? `AMBIGUOUS: the guard text matches ${r.ambiguous} places`
        : 'THE GUARD TEXT WAS NOT FOUND';
      console.log(markdown ? `| ${r.label} | **${why}** |` : `  ${why}: ${r.label}`);
      continue;
    }
    if (r.red.length === 0) {
      bad++;
      console.log(markdown ? `| ${r.label} | **NOTHING TURNED RED** |` : `  NOTHING TURNED RED: ${r.label}`);
      continue;
    }
    console.log(markdown
      ? `| ${r.label} | ${r.red.join('<br>')} |`
      : `  ok  ${r.label}\n      red: ${r.red.join(', ')}`);
  }
  return bad;
}

function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  // Check and stop. Exists so the test that proves this entry point runs the
  // preflight does not have to let a harness loose to prove it. The flag is
  // read after the check, so deleting the check still fails that test rather
  // than passing it.
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const bad = report(run(), process.argv.includes('--markdown'));
  if (bad) {
    console.error(`\n${bad} guard(s) could not be shown to be guarded. `
      + 'A mutation that turns nothing red is an unexecuted experiment.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
