#!/usr/bin/env node
'use strict';
// Break each of the routines list's guards in turn and report which tests
// notice.
//
// WHY THIS EXISTS SEPARATELY FROM THE SUITE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards. Most of what this list is judged on is a TONE
// or a piece of COPY, and a copy assertion is the easiest kind of test to
// write so that it cannot fail: assert a string is absent and the test passes
// against a module that returns nothing at all.
//
// THE TWO THIS FILE EXISTS FOR, and they are the two the card warned about
// before a line of it was written.
//
// The first is in the scheduler. `routineState.lastRun` is the only input to
// double-fire suppression; the slot store holds when a routine was due. This
// view is the first consumer the slot store has ever had, and feeding its
// `due` back into the suppression would type-check and would read as a tidy
// simplification. The mutation below writes exactly that line and requires a
// test to go red for it.
//
// The second is the missed row's next-run value. It is CONSTRAINED, not copy:
// a slot missed today is caught up within a minute by an open Rundock, so a
// missed row can only ever pair with a next run today. Two design frames wrote
// "tomorrow" there and both were rejected. The mutation writes the literal in
// and requires a test to go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-routines-guards.js            # report
//   node test/tools/mutate-routines-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routine-editor-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/routines-model.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view.test.js' };
const RAIL = { src: path.join(ROOT, 'public', 'rail-presence.js'), suite: 'test/unit/routines-view.test.js' };
// THE STYLESHEET IS A MUTATION TARGET, and that is the point of it being one.
// The three-tone ruling is about what a reader SEES, and what they see is
// resolved from these rules, not from any table in a module. An earlier
// version of this card asserted the ruling against a constant in the model
// that nothing rendered, so giving Missed the danger colour moved the page and
// moved no test. These break the rules a browser actually applies.
const STYLES = { src: path.join(ROOT, 'public', 'styles', 'views', 'routines.css'), suite: 'test/unit/routines-view.test.js' };
// The scheduler, where the two stores meet and must not.
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-next-run.test.js' };
// The roster, which is how a row ever sees any of it, watched by the walk that
// goes from real agent files through the real stores to the rendered page.
// Watched from anywhere else, these lines can be deleted with every test green
// while Missed and Caught up become unreachable in the product.
const DISCOVERY = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The same walk watches the instant the row measures lateness from, because
// that is a claim about what a real routine's real state renders as.
const END_TO_END = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-end-to-end.test.js' };
const VIEW_E2E = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The handlers behind the row's two controls, and the data model they write
// through.
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/routine-actions.test.js' };
const ROUTINES = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/routine-actions.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== THE SEPARATION =====
  // THE ONE THIS FILE EXISTS FOR, in its exact form. The slot store's `due` is
  // today's slot; read as the suppression's argument it says "already ran
  // today", and the catch-up run the routine is still owed never happens.
  [SCHEDULER, 'the suppression reads the run state and never the slot store',
    '        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);',
    '        const nextRun = getNextRun(routine.schedule, routineSlots.routines[key]?.due);'],
  [SCHEDULER, 'a period the last run already served is stepped over',
    '  for (let step = 0; served && served >= slot && step < MAX_SLOTS_PER_WAKE; step++) {\n    slot = stepSlots(parsed, slot, 1);\n  }',
    ''],
  [SCHEDULER, 'the anchor is the slot store\'s own due instant',
    '  let slot = new Date(entry.due);\n  if (isNaN(slot.getTime())) return null;',
    '  let slot = stepSlots(parsed, new Date(entry.due), 1);\n  if (isNaN(slot.getTime())) return null;'],
  [SCHEDULER, 'the walk is bounded rather than counting every day since the anchor',
    'step < MAX_SLOTS_PER_WAKE; step++',
    'step < 100000; step++'],
  [SCHEDULER, 'the slot the last run served is named',
    '    lastSlot: started ? slotFor(parsed, started).toISOString() : null,\n',
    '    lastSlot: null,\n'],
  [SCHEDULER, 'the most recent recorded miss is the one reported',
    '  const missed = entry && entry.missed.length ? entry.missed[entry.missed.length - 1].slot : null;',
    '  const missed = null;'],
  [DISCOVERY, 'the roster carries when a routine runs next',
    '        r.nextRun = facts.nextRun;\n',
    ''],
  [DISCOVERY, 'the roster carries when the last run began',
    '        r.lastStart = facts.lastStart;\n',
    ''],
  [DISCOVERY, 'the roster carries the slot the last run served',
    '        r.lastSlot = facts.lastSlot;\n',
    ''],
  [DISCOVERY, 'the roster carries the slot that passed unserved',
    '        r.missedSlot = facts.missedSlot;\n',
    ''],

  // ===== WHICH INSTANT LATENESS IS MEASURED FROM =====
  // The second one this file exists for. routineState.lastRun is the moment a
  // finished run ENDED, and an agent run routinely takes longer than the
  // catch-up boundary, so measuring from it would put the quieter tone on
  // almost every ordinary row: the ruling inverted in the commonest case.
  [END_TO_END, 'lateness is measured from when the run began, not when it ended',
    '  return new Date(ended.getTime() - seconds * 1000);',
    '  return ended;'],
  [SCHEDULER, 'a stamp with no duration is already the start',
    "  if (typeof seconds !== 'number' || !isFinite(seconds)) return ended;\n",
    ''],
  [SCHEDULER, 'the slot a run served is the one on the day it started',
    '    lastSlot: started ? slotFor(parsed, started).toISOString() : null,',
    '    lastSlot: lastRunStartedAt(key) ? slotFor(parsed, new Date(routineState[key].lastRun)).toISOString() : null,'],
  [VIEW_E2E, 'the row asks the roster for the instant the run began',
    '    lastStart: r.lastStart,',
    '    lastStart: r.state ? r.state.lastRun : null,'],

  // ===== WHICH ROUTINE OF ITS NAME =====
  [VIEW, 'a row says which routine of its name it is',
    '      out.push({ routine, agent, occurrence });',
    '      out.push({ routine, agent, occurrence: 0 });'],
  [VIEW, 'a delete says which routine of its name it means',
    '  const entry = allRoutines()[pendingDelete];',
    '  const entry = allRoutines()[0];'],
  [VIEW, 'a pause says which routine of its name it means',
    "    occurrence: entry.occurrence, paused,",
    "    occurrence: 0, paused,"],
  [HANDLER, 'which routine of a name is required rather than assumed to be the first',
    '  if (!Number.isInteger(occurrence) || occurrence < 0) {\n    fail(\'Which routine of that name is required.\');\n    return null;\n  }',
    '  if (false) { return null; }'],
  [HANDLER, 'the routine is found on the roster before anything is read or written',
    '  const namesakes = (target.routines || []).filter(r => r.name === name);\n  if (!namesakes[occurrence]) { fail(`Routine "${name}" is not in that agent.`); return null; }\n',
    ''],
  [HANDLER, 'the delete tells the writer which block',
    '  const next = removeRoutineBlock(before, found.name, found.occurrence);',
    '  const next = removeRoutineBlock(before, found.name);'],
  [HANDLER, 'the pause tells the writer which block',
    '  const next = updateRoutineBlock(before, found.name, { paused }, found.occurrence);',
    '  const next = updateRoutineBlock(before, found.name, { paused });'],

  // ===== THE THREE TONES, AS THE PAGE RESOLVES THEM =====
  [STYLES, 'a late run keeps the success colour, and no state is amber',
    '.run-status.ok-quiet { font-weight: 500; color: var(--success); }',
    '.run-status.ok-quiet { font-weight: 500; color: var(--attention); }'],
  [STYLES, 'a late run is quieter than a punctual one',
    '.run-status.ok { font-weight: 600; color: var(--success); }',
    '.run-status.ok { font-weight: 500; color: var(--success); }'],
  [STYLES, 'a slot nobody served is not dressed as a failure',
    '.run-status.neutral { font-weight: 500; color: var(--idle); }',
    '.run-status.neutral { font-weight: 500; color: var(--danger); }'],
  [STYLES, 'a failure is not dressed as a success',
    '.run-status.failed { font-weight: 600; color: var(--danger); }',
    '.run-status.failed { font-weight: 600; color: var(--success); }'],

  // ===== THE VALUE THAT IS CONSTRAINED, NOT COPY =====
  // The second one this file exists for: the literal two design frames wrote.
  [MODEL, 'the next-run label renders the instant it is handed, with no value of its own',
    '    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);',
    "    const words = 'tomorrow, 7:00am, London time';"],

  // ===== THE THREE TONES =====
  [MODEL, 'each outcome carries its own leading word',
    "    'caught-up': { tone: 'ok-quiet', lead: 'Caught up' },",
    "    'caught-up': { tone: 'ok-quiet', lead: 'Ran' },"],
  [MODEL, 'a late run is told from a punctual one by more than a moment',
    '  const CATCH_UP_AFTER_MS = 5 * 60 * 1000;',
    '  const CATCH_UP_AFTER_MS = 0;'],
  [MODEL, 'a run still going names no outcome',
    "    if (statusWord === 'running') return null;",
    ''],
  [MODEL, 'a miss later than the last run is what happened last',
    '    if (missedSlot && (!started || missedSlot > started)) return \'missed\';',
    '    if (missedSlot) return \'missed\';'],
  [MODEL, 'a run the process died inside is a failure',
    "    if (statusWord === 'failed' || statusWord === 'interrupted') return 'failed';",
    "    if (statusWord === 'failed') return 'failed';"],

  // ===== THE WORDS =====
  [MODEL, 'a missed row names the cause rather than the routine',
    "      text = `Missed: Rundock was closed at ${place ? `${when}, ${place} time` : when}`;",
    '      text = `Missed: the routine did not run at ${when}`;'],
  [MODEL, 'a caught-up row names the time it was due as well as the time it ran',
    '      text = `Caught up: ran ${timeWords(input.lastStart, now, zone)}, due ${clockWords(input.lastSlot)}`;',
    '      text = `Caught up: ran ${timeWords(input.lastStart, now, zone)}`;'],
  [MODEL, 'a punctual row reads as the time, with no label in front of it',
    '      text = `Ran ${timeWords(input.lastStart, now, zone)}`;',
    '      text = `Ran on time: ${timeWords(input.lastStart, now, zone)}`;'],
  [MODEL, 'a day near now is a word rather than a date',
    "    if (gap === 1) return 'tomorrow';",
    "    if (gap === 1) return DAYS[when.getDay()];"],
  [MODEL, 'a day word counts calendar days, not hours',
    '    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());\n    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());\n    return Math.round((b - a) / 86400000);',
    '    return Math.round((to - from) / 86400000);'],
  [MODEL, 'midnight and noon read as twelve rather than zero',
    '    const hour12 = hour % 12 === 0 ? 12 : hour % 12;',
    '    const hour12 = hour % 12;'],
  [MODEL, 'the zone reaches the words as a place',
    '    return place ? `${day}, ${clock}, ${place} time` : `${day}, ${clock}`;',
    '    return `${day}, ${clock}`;'],
  [MODEL, 'a paused routine says so where its next run would be',
    "    if (input && input.paused) return { text: 'Paused', className: 'next-run paused-label' };",
    ''],
  [MODEL, 'both halves of the schedule are looked up, never formatted from the string',
    '    if (!freq || !time) return null;\n    return `Every ${freq.label} at ${time.label}`;',
    '    return `Every ${parts[1]} at ${parts[2]}`;'],
  [MODEL, 'the execution target reads off the option rather than a string built here',
    '      runsOn: option ? `Runs on ${option.sentence}` : null,',
    "      runsOn: 'Runs on this computer',"],
  [MODEL, 'delete names what stops',
    '      ? `This stops ${agentName} running ${name}, ${words.charAt(0).toLowerCase()}${words.slice(1)}. `',
    "      ? 'This stops the routine. '"],
  [MODEL, 'delete names what does NOT stop',
    "      body: `${what}The file it last updated stays exactly as it is. This can't be undone.`,",
    "      body: `${what}This can't be undone.`,"],
  [MODEL, 'the empty state speaks of agents rather than an agent',
    "    body: 'Pick a tested skill and give it a schedule. Your agents take it from there.',",
    "    body: 'Pick a tested skill and give it a schedule. Piper takes it from there.',"],

  // ===== THE RENDER =====
  // The defect in its other form: a model with the right words and a view that
  // prints something else.
  [VIEW, 'the row reads its tone off the model',
    '      + `<span class="run-status ${row.status.tone}">${esc(row.status.text)}</span>`',
    '      + `<span class="run-status ok">${esc(row.status.text)}</span>`'],
  [VIEW, 'the next-run fact survives on a row that also has a status',
    "      + (nextRun ? `${sep}${nextRun}` : '')",
    "      + ''"],
  [VIEW, 'a row with nothing to report keeps its next run on the meta line',
    '  if (!row.status && nextRun) meta += `${sep}${nextRun}`;',
    ''],
  [VIEW, 'the second line appears only once there is something to say',
    '  if (row.status) {',
    '  if (true) {'],
  [VIEW, 'the rail entry is gated on the first routine',
    "  railPresence('routines', list.length > 0);\n",
    ''],
  [VIEW, 'a paused row offers resume rather than pause again',
    "    actions += r.paused\n      ? iconButton('resume', 'Resume', ICONS.play, `routinesSetPaused(${index}, false)`, false)\n      : iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);",
    "    actions += iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);"],
  [VIEW, 'delete asks before it acts',
    'function routinesAskDelete(index) {\n  pendingDelete = index;',
    'function routinesAskDelete(index) {\n  pendingDelete = null;'],
  [VIEW, 'a delete names the routine that was confirmed',
    "      type: 'delete_routine', agentId: entry.agent.id, name: entry.routine.name, occurrence: entry.occurrence,",
    "      type: 'delete_routine', agentId: entry.agent.id, name: 'anything', occurrence: entry.occurrence,"],
  [VIEW, 'the empty state offers something to press',
    '    + \'<button class="settings-btn-primary" type="button" data-routines-action="add"\'',
    '    + \'<button class="settings-btn-primary" type="button" data-routines-action="nothing"\''],
  [VIEW, 'a routine name reaches the page as text, not as markup',
    '`<div class="rr-sentence">${esc(sentence)}</div>',
    '`<div class="rr-sentence">${sentence}</div>'],
  [RAIL, 'a withdrawn rail entry comes back',
    "    entry.style.display = present ? '' : 'none';",
    "    entry.style.display = 'none';"],

  // ===== THE TWO CONTROLS =====
  // The byte check in the delete handler is a backstop against a WRITER that
  // silently removes nothing, which the roster check above it cannot see: the
  // roster and the block addresser are different parsers. So the mutation
  // breaks the writer rather than the check, which is the only way to reach it.
  [ROUTINES, 'a removal that removes nothing is not announced as a deletion',
    '  lines.splice(from, target.end - from);\n',
    ''],
  [HANDLER, 'the roster is invalidated before it is rebroadcast',
    "  ws.send(JSON.stringify(message));\n  ctx.agents.invalidateAgentCache();\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));",
    "  ws.send(JSON.stringify(message));\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));"],
  [HANDLER, 'an agent file outside the workspace is refused',
    "  if (!ctx.workspace.isInsideWorkspace(filePath)) { fail('That agent is outside the workspace.'); return null; }\n",
    ''],
  [ROUTINES, 'the last routine takes the routines key with it',
    '  const from = items.length === 1 ? section.start : target.start;',
    '  const from = target.start;'],
  [ROUTINES, 'a removal takes the block it was asked for and no other',
    '  })[occurrence];\n  if (!target) return content;\n\n  const from',
    '  })[0];\n  if (!target) return content;\n\n  const from'],
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
  const targets = [MODEL, VIEW, VIEW_E2E, RAIL, STYLES, SCHEDULER, END_TO_END, DISCOVERY, HANDLER, ROUTINES];
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
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      results.push({ label, applied: true, red: redTests(target.suite) });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    for (const [target, original] of originals) fs.writeFileSync(target.src, original);
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous } of results) {
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

if (require.main === module) {
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
